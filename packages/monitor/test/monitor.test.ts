import { describe, expect, it } from "vitest";
import { HttpClient, Store, createLogger, type Transport } from "@vigil/core";
import { AlertDispatcher } from "@vigil/watchtower";
import {
  BaseChainMonitor,
  QORECHAIN_NETWORKS,
  canonicalJson,
  describeChange,
} from "../src/index.js";

const log = createLogger({ service: "test", level: "silent" });
const network = QORECHAIN_NETWORKS.testnet;
const NOW = 1_800_000_000;

interface World {
  height: number;
  tipAgeSecs: number;
  blockTimeSecs: number;
  bodies: Record<string, unknown>;
  down: Set<string>;
}

function setup(overrides: Partial<World> = {}) {
  const world: World = {
    height: 50_000,
    tipAgeSecs: 1,
    blockTimeSecs: 1.3,
    bodies: {
      current_plan: { plan: null },
      proposals: { proposals: [] },
      disable_list: { disabled_list: ["/cosmwasm.wasm.v1.MsgStoreCode"] },
      "evm/vm/v1/params": { params: { active_static_precompiles: ["0x0a01", "0x0a02"] } },
      "rdk/v1/params": { params: { min_stake_for_rollup: "10000000000" } },
      "multilayer/v1/params": { params: { max_sidechains: "64" } },
      "pqc/v1/params": { params: {} },
      "staking/v1beta1/params": { params: { max_validators: 100 } },
      "latest.json": { version: "3.2.8", binary: { sha256: "ead3" } },
    },
    down: new Set(),
    ...overrides,
  };
  const iso = (secs: number): string => new Date(secs * 1_000).toISOString();
  const transport: Transport = (url) => {
    const respond = (status: number, body: unknown) =>
      Promise.resolve({
        ok: status < 300,
        status,
        statusText: "",
        json: () => Promise.resolve(body),
      });
    const key = Object.keys(world.bodies).find((k) => url.includes(k));
    if ([...world.down].some((d) => url.includes(d))) return respond(503, {});
    if (url.endsWith("/status")) {
      return respond(200, {
        result: {
          sync_info: {
            latest_block_height: String(world.height),
            latest_block_time: iso(NOW - world.tipAgeSecs),
          },
        },
      });
    }
    if (url.includes("/header?height=")) {
      return respond(200, {
        result: { header: { time: iso(NOW - world.tipAgeSecs - 1_000 * world.blockTimeSecs) } },
      });
    }
    return key === undefined ? respond(404, {}) : respond(200, world.bodies[key]);
  };
  const store = Store.open(":memory:");
  const alerts = new AlertDispatcher({ store, sinks: [], log, now: () => NOW });
  const monitor = new BaseChainMonitor({
    network,
    http: new HttpClient({ source: "test", transport, maxRetries: 0, requestsPerMinute: 1_000 }),
    store,
    alerts,
    log,
    now: () => NOW,
  });
  return { world, store, monitor };
}

describe("BaseChainMonitor", () => {
  it("records a healthy network without raising anything", async () => {
    const { monitor, store } = setup();
    const report = await monitor.tick();

    expect(report).toMatchObject({
      network: "testnet",
      height: 50_000,
      halted: false,
      measuredBlockTimeSecs: 1.3,
      changed: [],
      unavailable: [],
    });
    expect(store.monitorSnapshots("testnet").map((s) => s.source)).toHaveLength(10);
    expect(store.recentChainEvents(5)).toEqual([]);
    expect(store.recentAlerts(5)).toEqual([]);
  });

  it("reports a halt once, when the tip stops moving", async () => {
    const { monitor, store } = setup({ tipAgeSecs: 600 });
    expect((await monitor.tick()).halted).toBe(true);
    await monitor.tick();

    const events = store.recentChainEvents(5);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ severity: "critical", source: "tip" });
    expect(events[0]?.detail).toContain("600 s old");
  });

  it("warns when the measured block time drifts from the documented value", async () => {
    const { monitor, store } = setup({ blockTimeSecs: 2.6 });
    const report = await monitor.tick();
    expect(report.measuredBlockTimeSecs).toBe(2.6);

    const event = store.recentChainEvents(1)[0];
    expect(event?.title).toMatch(/block time differs/);
    expect(event?.detail).toContain("+100%");
    await monitor.tick();
    expect(store.recentChainEvents(5)).toHaveLength(1);
  });

  it("tolerates a small drift", async () => {
    const { monitor, store } = setup({ blockTimeSecs: 1.5 });
    await monitor.tick();
    expect(store.recentChainEvents(5)).toEqual([]);
  });

  it("detects a silent setting change and says what changed", async () => {
    const { monitor, world, store } = setup();
    await monitor.tick();

    world.bodies["rdk/v1/params"] = { params: { min_stake_for_rollup: "50000000000" } };
    world.bodies["evm/vm/v1/params"] = { params: { active_static_precompiles: ["0x0a01"] } };
    const report = await monitor.tick();

    expect(report.changed.sort()).toEqual(["evm-params", "rdk-params"]);
    const details = store
      .recentChainEvents(5)
      .map((e) => e.detail)
      .join("\n");
    expect(details).toContain('params.min_stake_for_rollup: "10000000000" -> "50000000000"');
    expect(details).toContain("active_static_precompiles");

    expect((await monitor.tick()).changed).toEqual([]);
  });

  it("detects a scheduled upgrade appearing", async () => {
    const { monitor, world, store } = setup();
    await monitor.tick();
    world.bodies.current_plan = { plan: { name: "v3.2.9", height: "10300000" } };
    await monitor.tick();
    expect(store.recentChainEvents(1)[0]).toMatchObject({
      source: "upgrade-plan",
      title: "Scheduled upgrade changed on testnet",
    });
  });

  it("ignores key order, so a reshuffled answer is not a change", async () => {
    const { monitor, world } = setup();
    world.bodies["latest.json"] = { version: "3.2.8", binary: { sha256: "ead3", url: "u" } };
    await monitor.tick();
    world.bodies["latest.json"] = { binary: { url: "u", sha256: "ead3" }, version: "3.2.8" };
    expect((await monitor.tick()).changed).toEqual([]);
  });

  it("ignores the node manifest's state-sync checkpoint but reports a new release", async () => {
    const { monitor, world, store } = setup();
    const manifest = (version: string, trustHeight: number) => ({
      version,
      binary: { sha256: version },
      releasedAt: `2026-11-17T0${String(trustHeight % 10)}:00:00Z`,
      stateSync: { trustHeight, trustHash: `hash-${String(trustHeight)}` },
    });
    world.bodies["latest.json"] = manifest("3.2.8", 1);
    await monitor.tick();

    world.bodies["latest.json"] = manifest("3.2.8", 2);
    expect((await monitor.tick()).changed).toEqual([]);

    world.bodies["latest.json"] = manifest("3.2.9", 3);
    expect((await monitor.tick()).changed).toEqual(["node-manifest"]);
    expect(store.recentChainEvents(1)[0]?.detail).toContain('version: "3.2.8" -> "3.2.9"');
  });

  it("marks an unreachable source as unavailable instead of changed, and recovers", async () => {
    const { monitor, world, store } = setup();
    await monitor.tick();

    world.down.add("disable_list");
    world.down.add("/status");
    const report = await monitor.tick();
    expect(report.unavailable.sort()).toEqual(["circuit-breaker", "tip"]);
    expect(report.changed).toEqual([]);
    expect(store.monitorSnapshot("testnet", "circuit-breaker")).toMatchObject({ available: false });
    expect(store.monitorSnapshot("testnet", "circuit-breaker")?.body).toContain("MsgStoreCode");

    world.down.clear();
    const recovered = await monitor.tick();
    expect(recovered).toMatchObject({ changed: [], unavailable: [] });
    expect(store.monitorSnapshot("testnet", "circuit-breaker")?.available).toBe(true);
    expect(store.recentChainEvents(5)).toEqual([]);
  });

  it("does not report a change when a source is first seen after being down", async () => {
    const { monitor, world, store } = setup();
    world.down.add("latest.json");
    await monitor.tick();
    world.down.clear();
    expect((await monitor.tick()).changed).toEqual([]);
    expect(store.recentChainEvents(5)).toEqual([]);
  });
});

describe("helpers", () => {
  it("canonicalises JSON with sorted keys at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}',
    );
    expect(canonicalJson(undefined)).toBe("null");
  });

  it("describes changes by path, including added and removed fields", () => {
    const text = describeChange(
      '{"a":1,"b":{"c":"x"},"gone":true}',
      '{"a":2,"b":{"c":"x","new":[1]}}',
    );
    expect(text.split("\n")).toEqual(["a: 1 -> 2", "b.new: null -> [1]", "gone: true -> null"]);
    expect(describeChange("not json", "{}")).toBe("The content changed.");
  });
});
