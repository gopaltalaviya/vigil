import { describe, expect, it } from "vitest";
import {
  HttpClient,
  InboxArchive,
  Store,
  createLogger,
  type StoredAlert,
  type StoredBatch,
  type Transport,
} from "@vigil/core";
import { fixtureSource, loadGolden } from "../../core/test/helpers.js";
import {
  AlertDispatcher,
  Watchtower,
  formatAlert,
  runLoop,
  telegramSink,
  webhookSink,
  type AlertSink,
  type RollupView,
} from "../src/index.js";

const golden = loadGolden();
const log = createLogger({ service: "test", level: "silent" });
const WINDOW = 3_600;

interface Scenario {
  batches?: StoredBatch[];
  inboxHead?: number;
  consumed?: number;
  tipHeight?: number;
  tipTime?: number;
  sinks?: AlertSink[];
  store?: Store;
}

/** Accumulator value of the fixture's inbox after `sequence` entries. */
const reference = Store.open(":memory:");
await new InboxArchive({
  chainId: golden.chainId,
  rollupId: golden.rollupId,
  store: reference,
  source: fixtureSource(golden),
}).sync();
function accAt(sequence: number): string {
  const entry = reference.inboxEntry(golden.rollupId, sequence);
  if (entry === undefined) throw new Error("fixture has no such entry");
  return entry.acc;
}

function setup(scenario: Scenario = {}) {
  const store = scenario.store ?? Store.open(":memory:");
  const state = {
    batches: scenario.batches ?? golden.batches,
    consumed: scenario.consumed ?? golden.head.sequence,
    tipHeight: scenario.tipHeight ?? 10_200_000,
    tipTime: scenario.tipTime ?? 1_794_900_000,
  };
  const view: RollupView = {
    batches: () => Promise.resolve(state.batches.map((b) => ({ ...b }))),
    inbox: () => Promise.resolve({ head: golden.head.sequence, consumed: state.consumed }),
    tip: () => Promise.resolve({ height: state.tipHeight, timeSecs: state.tipTime }),
    challengeWindowSecs: () => Promise.resolve(WINDOW),
  };
  const alerts = new AlertDispatcher({ store, sinks: scenario.sinks ?? [], log, now: () => 100 });
  const watchtower = new Watchtower({
    chainId: golden.chainId,
    rollupId: golden.rollupId,
    store,
    archive: new InboxArchive({
      chainId: golden.chainId,
      rollupId: golden.rollupId,
      store,
      source: fixtureSource(
        golden,
        scenario.inboxHead === undefined
          ? {}
          : { headSequence: scenario.inboxHead, headAcc: accAt(scenario.inboxHead) },
      ),
    }),
    view,
    alerts,
    log,
    now: () => 100,
  });
  return { store, state, watchtower };
}

const [first, second] = golden.batches;
if (first === undefined || second === undefined) throw new Error("fixture needs two batches");
const forged: StoredBatch = { ...second, stateRoot: "ab".repeat(32), status: "submitted" };

describe("Watchtower", () => {
  it("judges every finalized batch of the live rollup as valid and raises nothing", async () => {
    const { watchtower, store } = setup();
    const report = await watchtower.tick();

    expect(report).toMatchObject({ inboxHead: 9, entriesAdded: 9, alertsRaised: 0 });
    expect(report.judged.map((j) => j.verdict)).toEqual(["valid", "valid"]);
    expect(report.challengeable).toEqual([]);
    expect(store.latestSnapshot(golden.rollupId, 9)?.stateRoot).toBe(second.stateRoot);
  });

  it("judges each batch once and resumes from stored state after a restart", async () => {
    const first = setup();
    await first.watchtower.tick();
    const again = await first.watchtower.tick();
    expect(again.judged).toEqual([]);
    expect(again.entriesAdded).toBe(0);

    const restarted = setup({ store: first.store });
    const report = await restarted.watchtower.tick();
    expect(report.judged).toEqual([]);
    expect(report.inboxHead).toBe(9);
  });

  it("flags a forged state root as challengeable while the window is open", async () => {
    const { watchtower, store } = setup({
      batches: [first, forged],
      tipTime: forged.submittedTime + 600,
    });
    const report = await watchtower.tick();

    expect(report.judged[1]).toMatchObject({ verdict: "invalid", reasons: ["state_root"] });
    expect(report.challengeable).toHaveLength(1);
    expect(report.challengeable[0]?.secondsRemaining).toBe(WINDOW - 600);
    const alert = store.recentAlerts(1)[0];
    expect(alert?.severity).toBe("critical");
    expect(alert?.body).toContain(second.stateRoot);
    expect(alert?.body).toContain("50 minutes");
    expect(store.latestSnapshot(golden.rollupId, 9)?.inboxSequence).toBe(4);
  });

  it("raises each condition once, then escalates near the deadline", async () => {
    const { watchtower, state, store } = setup({
      batches: [first, forged],
      tipTime: forged.submittedTime + 600,
    });
    expect((await watchtower.tick()).alertsRaised).toBe(1);
    expect((await watchtower.tick()).alertsRaised).toBe(0);

    state.tipTime = forged.submittedTime + WINDOW - 300;
    expect((await watchtower.tick()).alertsRaised).toBe(1);
    expect(store.recentAlerts(1)[0]?.title).toMatch(/about to close/);
  });

  it("reports an invalid batch that was finalized, and one that the chain rejected", async () => {
    const finalized = setup({
      batches: [first, { ...forged, status: "finalized" }],
    });
    const report = await finalized.watchtower.tick();
    expect(report.challengeable).toEqual([]);
    expect(finalized.store.recentAlerts(1)[0]?.title).toMatch(/was finalized/);

    const rejected = setup({
      batches: [first, { ...forged, status: "rejected" }, second],
    });
    const outcome = await rejected.watchtower.tick();
    expect(outcome.judged.map((j) => j.verdict)).toEqual(["valid", "invalid", "valid"]);
    expect(rejected.store.recentAlerts(1)[0]).toMatchObject({ severity: "info" });
  });

  it("defers a batch whose inbox range is not archived yet, then judges it", async () => {
    const store = Store.open(":memory:");
    const early = setup({ store, inboxHead: 4, consumed: 4 });
    const report = await early.watchtower.tick();
    expect(report.judged.map((j) => j.verdict)).toEqual(["valid", "undecidable"]);
    expect(report.alertsRaised).toBe(0);

    const later = setup({ store });
    const next = await later.watchtower.tick();
    expect(next.judged).toEqual([
      { batchIndex: 1, stateRoot: second.stateRoot, verdict: "valid", reasons: [] },
    ]);
  });

  it("warns when inbox entries wait too long for a batch", async () => {
    const waiting = golden.entries[4];
    if (waiting === undefined) throw new Error("fixture too short");
    const { watchtower, state, store } = setup({
      batches: [first],
      consumed: 4,
      tipHeight: waiting.height + 100,
    });
    expect((await watchtower.tick()).alertsRaised).toBe(0);

    state.tipHeight = waiting.height + 601;
    expect((await watchtower.tick()).alertsRaised).toBe(1);
    const alert = store.recentAlerts(1)[0];
    expect(alert).toMatchObject({ severity: "warning" });
    expect(alert?.body).toContain("5 inbox entries are waiting");
    expect((await watchtower.tick()).alertsRaised).toBe(0);
  });
});

describe("alert delivery", () => {
  const alert: StoredAlert = {
    id: 1,
    key: "k",
    severity: "critical",
    title: "Invalid batch 3",
    body: "details",
    createdAt: 1,
    deliveredAt: undefined,
  };

  function recordingTransport(status = 200): { transport: Transport; calls: unknown[][] } {
    const calls: unknown[][] = [];
    const transport: Transport = (url, init) => {
      calls.push([url, JSON.parse(init?.body ?? "null")]);
      return Promise.resolve({
        ok: status < 300,
        status,
        statusText: "",
        json: () => Promise.resolve({ ok: true }),
      });
    };
    return { transport, calls };
  }

  it("formats alerts and posts them to Telegram and to a webhook", async () => {
    const { transport, calls } = recordingTransport();
    const http = new HttpClient({ source: "alerts", transport, maxRetries: 0 });
    await telegramSink(http, "123:TOKEN", "-100").send(alert);
    await webhookSink(http, "https://hooks.example/vigil").send(alert);

    expect(formatAlert(alert)).toContain("Vigil critical: Invalid batch 3");
    expect(calls[0]?.[0]).toBe("https://api.telegram.org/bot123:TOKEN/sendMessage");
    expect(calls[0]?.[1]).toMatchObject({ chat_id: "-100" });
    expect(calls[1]?.[1]).toMatchObject({ key: "k", severity: "critical" });
  });

  it("never puts the bot token in an error", async () => {
    const { transport } = recordingTransport(401);
    const http = new HttpClient({ source: "alerts", transport, maxRetries: 0 });
    const error: unknown = await telegramSink(http, "123:TOKEN", "-100")
      .send(alert)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(JSON.stringify([(error as Error).message, error])).not.toContain("TOKEN");
  });

  it("keeps an alert until every sink has accepted it", async () => {
    const store = Store.open(":memory:");
    let failing = true;
    const sent: string[] = [];
    const sinks: AlertSink[] = [
      { name: "steady", send: (a) => Promise.resolve(void sent.push(`steady:${a.key}`)) },
      {
        name: "flaky",
        send: (a) =>
          failing ? Promise.reject(new Error("down")) : Promise.resolve(void sent.push(a.key)),
      },
    ];
    const dispatcher = new AlertDispatcher({ store, sinks, log, now: () => 5 });

    expect(dispatcher.raise({ key: "a", severity: "warning", title: "t", body: "b" })).toBe(true);
    expect(dispatcher.raise({ key: "a", severity: "warning", title: "t", body: "b" })).toBe(false);
    expect(await dispatcher.flush()).toBe(0);
    expect(store.undeliveredAlerts()).toHaveLength(1);

    failing = false;
    expect(await dispatcher.flush()).toBe(1);
    expect(store.undeliveredAlerts()).toEqual([]);
    expect(sent).toEqual(["steady:a", "steady:a", "a"]);
  });
});

describe("service loop", () => {
  it("backs off after failures, recovers, and stops when aborted", async () => {
    const controller = new AbortController();
    const pauses: number[] = [];
    const outcomes = ["fail", "fail", "ok", "ok"];
    let successes = 0;

    await runLoop({
      intervalMs: 1_000,
      maxBackoffMs: 3_000,
      signal: controller.signal,
      log,
      onSuccess: () => (successes += 1),
      tick: () => {
        const outcome = outcomes.shift();
        if (outcomes.length === 0) controller.abort();
        return outcome === "fail" ? Promise.reject(new Error("chain halted")) : Promise.resolve();
      },
      sleep: (ms) => {
        pauses.push(ms);
        return Promise.resolve();
      },
    });

    expect(pauses).toEqual([2_000, 3_000, 1_000, 1_000]);
    expect(successes).toBe(2);
  });

  it("wakes from its pause as soon as it is aborted", async () => {
    const controller = new AbortController();
    let ticks = 0;
    const done = runLoop({
      intervalMs: 60_000,
      signal: controller.signal,
      log,
      tick: () => {
        ticks += 1;
        setTimeout(() => {
          controller.abort();
        }, 5);
        return Promise.resolve();
      },
    });
    await done;
    expect(ticks).toBe(1);
  });
});
