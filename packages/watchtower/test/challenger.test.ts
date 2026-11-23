import {
  encodeQledgerTx,
  hexToBech32,
  qledgerKeypairFromSeed,
  signQledgerTx,
} from "@qorechain/rdk";
import { describe, expect, it } from "vitest";
import { InboxArchive, Store, createLogger, toHex } from "@vigil/core";
import { FAKE_CHAIN_ID, FAKE_ROLLUP_ID, FakeRollup } from "../../core/test/fake-rollup.js";
import { AlertDispatcher, Challenger, Watchtower } from "../src/index.js";

const log = createLogger({ service: "test", level: "silent" });
const QOR = 1_000_000n;
const WATCHER = hexToBech32("03".repeat(20), "qor");
const alice = qledgerKeypairFromSeed(new Uint8Array(32).fill(1));
const mallory = qledgerKeypairFromSeed(new Uint8Array(32).fill(2));

function signed(nonce: number, amount: bigint, target: { to: Uint8Array } | { recipient: string }) {
  return encodeQledgerTx(
    signQledgerTx({
      chainId: FAKE_CHAIN_ID,
      rollupId: FAKE_ROLLUP_ID,
      secretKey: alice.secretKey,
      publicKey: alice.publicKey,
      nonce,
      amount,
      ...target,
    }),
  );
}

function setup(options: { dryRun?: boolean } = {}) {
  const rollup = new FakeRollup();
  const store = Store.open(":memory:");
  const archive = new InboxArchive({
    chainId: FAKE_CHAIN_ID,
    rollupId: FAKE_ROLLUP_ID,
    store,
    source: rollup.source(),
  });
  const alerts = new AlertDispatcher({ store, sinks: [], log });
  const shared = { chainId: FAKE_CHAIN_ID, rollupId: FAKE_ROLLUP_ID, store, archive, alerts, log };
  const watchtower = new Watchtower({ ...shared, view: rollup.view() });
  const challenger = new Challenger({
    ...shared,
    sender: rollup.sender(WATCHER, store),
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
  });
  return { rollup, store, watchtower, challenger };
}

/** A submitter claims a state in which it received funds nobody sent it. */
function submitTheft(rollup: FakeRollup): void {
  const forgedLedger = rollup.ledgerAt(rollup.head);
  forgedLedger.set(mallory.accountId, 1_000n * QOR, 0n);
  const honest = rollup.plan(rollup.ledgerAt(rollup.consumed));
  rollup.acceptBatch({ ...honest.input, stateRoot: forgedLedger.root() });
}

describe("Challenger", () => {
  it("proves a forged state root to the chain, which rejects the batch", async () => {
    const { rollup, store, watchtower, challenger } = setup();
    rollup.deposit("qor1user", alice.accountId, 5n * QOR);
    rollup.submitHonestBatch();
    rollup.post("qor1user", signed(0, QOR, { to: mallory.accountId }));
    submitTheft(rollup);

    const report = await watchtower.tick();
    expect(report.challengeable.map((c) => c.batch.batchIndex)).toEqual([1]);

    const outcomes = await challenger.challengeAll(report.challengeable);
    expect(outcomes).toMatchObject([{ batchIndex: 1, action: "challenged" }]);
    expect(rollup.batches.map((b) => b.status)).toEqual(["submitted", "rejected"]);
    expect(store.recentAlerts(1)[0]?.title).toMatch(/Challenged invalid batch 1/);
    expect(store.recentTxs(1)[0]).toMatchObject({ label: "challenge-batch", status: "confirmed" });

    const after = await watchtower.tick();
    expect(after.challengeable).toEqual([]);
    rollup.submitHonestBatch();
    expect((await watchtower.tick()).judged.at(-1)).toMatchObject({ verdict: "valid" });
    expect(toHex(rollup.ledgerAt(2).root())).toBe(rollup.batches.at(-1)?.stateRoot);
  });

  it("proves a forged withdrawals root", async () => {
    const { rollup, watchtower, challenger } = setup();
    rollup.deposit("qor1user", alice.accountId, 5n * QOR);
    rollup.post("qor1user", signed(0, QOR, { recipient: WATCHER }));
    const honest = rollup.plan(rollup.ledgerAt(0));
    rollup.acceptBatch({ ...honest.input, withdrawalsRoot: new Uint8Array(32).fill(0xee) });

    const report = await watchtower.tick();
    expect(report.judged[0]?.reasons).toEqual(["withdrawals_root"]);
    await challenger.challengeAll(report.challengeable);
    expect(rollup.batches[0]?.status).toBe("rejected");
  });

  it("builds and checks the proof in dry-run mode without sending anything", async () => {
    const { rollup, watchtower, challenger } = setup({ dryRun: true });
    rollup.deposit("qor1user", alice.accountId, 5n * QOR);
    submitTheft(rollup);

    const report = await watchtower.tick();
    expect(await challenger.challengeAll(report.challengeable)).toEqual([
      { batchIndex: 0, action: "dry-run" },
    ]);
    expect(rollup.challenges).toEqual([]);
    expect(rollup.batches[0]?.status).toBe("submitted");
  });

  it("sends nothing when a node refuses the challenge in simulation", async () => {
    const { rollup, store, watchtower } = setup();
    rollup.deposit("qor1user", alice.accountId, 5n * QOR);
    submitTheft(rollup);
    const refusing = new Challenger({
      chainId: FAKE_CHAIN_ID,
      rollupId: FAKE_ROLLUP_ID,
      store,
      archive: new InboxArchive({
        chainId: FAKE_CHAIN_ID,
        rollupId: FAKE_ROLLUP_ID,
        store,
        source: rollup.source(),
      }),
      alerts: new AlertDispatcher({ store, sinks: [], log }),
      log,
      sender: {
        ...rollup.sender(WATCHER, store),
        simulate: () => Promise.reject(new Error("challenge refused")),
      },
    });

    const report = await watchtower.tick();
    expect(await refusing.challengeAll(report.challengeable)).toEqual([
      { batchIndex: 0, action: "skipped", reason: "simulation failed: challenge refused" },
    ]);
    expect(rollup.challenges).toEqual([]);
  });

  it("does not challenge once the window has closed", async () => {
    const { rollup, watchtower, challenger } = setup();
    rollup.deposit("qor1user", alice.accountId, 5n * QOR);
    submitTheft(rollup);
    rollup.time += 3_601;

    const report = await watchtower.tick();
    expect(await challenger.challengeAll(report.challengeable)).toEqual([
      { batchIndex: 0, action: "skipped", reason: "the challenge window has closed" },
    ]);
    expect(rollup.challenges).toEqual([]);
  });

  it("does not send a challenge that re-execution cannot prove", async () => {
    const { rollup, watchtower, challenger } = setup();
    rollup.deposit("qor1user", alice.accountId, 5n * QOR);
    const honest = rollup.plan(rollup.ledgerAt(0));
    rollup.acceptBatch({ ...honest.input, dataHash: new Uint8Array(32).fill(0x11) });

    const report = await watchtower.tick();
    expect(report.judged[0]?.reasons).toEqual(["data_hash"]);
    const outcomes = await challenger.challengeAll(report.challengeable);
    expect(outcomes[0]?.action).toBe("skipped");
    expect(rollup.challenges).toEqual([]);
  });

  it("resolves a challenge the chain left open, and tolerates one already settled", async () => {
    const { rollup, watchtower, challenger } = setup();
    rollup.statusAfterUpheldChallenge = "challenged";
    rollup.deposit("qor1user", alice.accountId, 5n * QOR);
    submitTheft(rollup);

    await challenger.challengeAll((await watchtower.tick()).challengeable);
    expect(rollup.batches[0]?.status).toBe("challenged");

    const open = (await watchtower.tick()).challengeable;
    expect(open).toHaveLength(1);
    rollup.failNextWith = 25;
    expect(await challenger.challengeAll(open)).toMatchObject([
      { action: "skipped", reason: "the challenge is already settled" },
    ]);
    expect(await challenger.challengeAll(open)).toMatchObject([{ action: "resolved" }]);
    expect(rollup.batches[0]?.status).toBe("rejected");
  });

  it("reports a rejected challenge transaction and still handles the other candidates", async () => {
    const { rollup, watchtower, challenger } = setup();
    rollup.deposit("qor1user", alice.accountId, 5n * QOR);
    submitTheft(rollup);
    const [candidate] = (await watchtower.tick()).challengeable;
    if (candidate === undefined) throw new Error("expected a candidate");

    rollup.failNextWith = 10;
    const outcomes = await challenger.challengeAll([candidate, candidate]);
    expect(outcomes.map((o) => o.action)).toEqual(["failed", "challenged"]);
    expect(JSON.stringify(outcomes[0])).toContain("challenge-batch");
    expect(rollup.batches[0]?.status).toBe("rejected");
  });

  it("judges a replacement batch on its own, even with the same index and state root", async () => {
    const { rollup, watchtower, challenger, store } = setup();
    rollup.deposit("qor1user", alice.accountId, 5n * QOR);
    rollup.post("qor1user", signed(0, QOR, { recipient: WATCHER }));

    // An honest batch is judged valid, then the chain rejects it for an unrelated reason.
    const honest = rollup.submitHonestBatch();
    expect((await watchtower.tick()).judged.map((j) => j.verdict)).toEqual(["valid"]);
    honest.status = "rejected";

    // Its replacement has the same index and the same state root, but forged withdrawals.
    const plan = rollup.plan(rollup.ledgerAt(0));
    rollup.batches.length = 0;
    rollup.acceptBatch({ ...plan.input, withdrawalsRoot: new Uint8Array(32).fill(0xee) });

    const report = await watchtower.tick();
    expect(report.judged).toMatchObject([{ verdict: "invalid", reasons: ["withdrawals_root"] }]);
    expect(report.challengeable).toHaveLength(1);
    await challenger.challengeAll(report.challengeable);
    expect(rollup.batches[0]?.status).toBe("rejected");
    expect(store.batches(FAKE_ROLLUP_ID).map((b) => b.status)).toContain("rejected");
  });

  it("does not carry an old 'invalid' verdict over to an honest replacement", async () => {
    const { rollup, watchtower } = setup();
    rollup.deposit("qor1user", alice.accountId, 5n * QOR);
    rollup.post("qor1user", signed(0, QOR, { recipient: WATCHER }));
    const plan = rollup.plan(rollup.ledgerAt(0));
    rollup.acceptBatch({ ...plan.input, withdrawalsRoot: new Uint8Array(32).fill(0xee) });
    expect((await watchtower.tick()).challengeable).toHaveLength(1);

    rollup.batches.length = 0;
    rollup.submitHonestBatch();
    const report = await watchtower.tick();
    expect(report.judged).toMatchObject([{ verdict: "valid" }]);
    expect(report.challengeable).toEqual([]);
  });

  it("never resolves a challenge against a batch its own proof does not condemn", async () => {
    const { rollup } = setup();
    rollup.deposit("qor1user", alice.accountId, 5n * QOR);
    const honest = rollup.submitHonestBatch({ status: "challenged" });

    const archive = new InboxArchive({
      chainId: FAKE_CHAIN_ID,
      rollupId: FAKE_ROLLUP_ID,
      store: Store.open(":memory:"),
      source: rollup.source(),
    });
    await archive.sync();
    const outcome = await new Challenger({
      chainId: FAKE_CHAIN_ID,
      rollupId: FAKE_ROLLUP_ID,
      store: Store.open(":memory:"),
      archive,
      sender: rollup.sender(WATCHER),
      alerts: new AlertDispatcher({ store: Store.open(":memory:"), sinks: [], log }),
      log,
    }).challenge({ batch: honest, secondsRemaining: 100 });
    expect(outcome).toMatchObject({ action: "skipped" });
    expect(honest.status).toBe("challenged");
  });

  it("skips a batch that was replaced between judging and challenging", async () => {
    const rollup = new FakeRollup();
    const store = Store.open(":memory:");
    const archive = new InboxArchive({
      chainId: FAKE_CHAIN_ID,
      rollupId: FAKE_ROLLUP_ID,
      store,
      source: rollup.source(),
    });
    const alerts = new AlertDispatcher({ store, sinks: [], log });
    const shared = {
      chainId: FAKE_CHAIN_ID,
      rollupId: FAKE_ROLLUP_ID,
      store,
      archive,
      alerts,
      log,
    };
    rollup.deposit("qor1user", alice.accountId, 5n * QOR);
    submitTheft(rollup);
    const report = await new Watchtower({ ...shared, view: rollup.view() }).tick();

    const challenger = new Challenger({
      ...shared,
      sender: rollup.sender(WATCHER, store),
      current: () => Promise.resolve(rollup.submitHonestBatch()),
    });
    expect(await challenger.challengeAll(report.challengeable)).toMatchObject([
      { action: "skipped", reason: "the batch changed since it was judged" },
    ]);
    expect(rollup.challenges).toEqual([]);
  });
});
