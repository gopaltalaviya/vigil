import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Store, claimId, createLogger } from "@vigil/core";
import { Api, createApiServer } from "../src/index.js";

const log = createLogger({ service: "test", level: "silent" });
const NOW = 1_800_000_000;

function seeded() {
  const store = Store.open(":memory:");
  const batch = {
    batchIndex: 0,
    stateRoot: "aa".repeat(32),
    prevStateRoot: "00".repeat(32),
    dataHash: "bb".repeat(32),
    withdrawalsRoot: "",
    inboxStart: 0,
    inboxEnd: 3,
    txCount: 3,
    status: "finalized",
    submittedAt: 100,
    submittedTime: NOW - 4_000,
    finalizedAt: 200,
  };
  const rejected = {
    ...batch,
    batchIndex: 1,
    stateRoot: "cc".repeat(32),
    status: "rejected",
    inboxStart: 3,
    inboxEnd: 4,
  };
  store.upsertBatch("vigil-1", batch);
  store.upsertBatch("vigil-1", rejected);
  store.upsertBatch("vigil-1", {
    ...batch,
    batchIndex: 2,
    stateRoot: "dd".repeat(32),
    status: "submitted",
    inboxStart: 4,
    inboxEnd: 6,
  });
  const verdict = {
    claimId: claimId(batch),
    batchIndex: 0,
    stateRoot: batch.stateRoot,
    verdict: "valid" as const,
    expectedStateRoot: batch.stateRoot,
    expectedWithdrawalsRoot: "",
    reasons: [],
    checkedAt: NOW,
  };
  store.saveVerdict("vigil-1", verdict);
  store.saveVerdict("vigil-1", {
    ...verdict,
    claimId: claimId(rejected),
    batchIndex: 1,
    stateRoot: "cc".repeat(32),
    verdict: "invalid",
    reasons: ["state_root"],
  });
  store.saveReceipt("vigil-1", {
    batchIndex: 0,
    stateRoot: batch.stateRoot,
    contract: "0xced6",
    txHash: "0xa4e7",
    recordedAt: NOW,
  });
  store.saveReceipt("vigil-1", {
    batchIndex: 1,
    stateRoot: rejected.stateRoot,
    contract: "0xced6",
    txHash: "0xdead",
    recordedAt: NOW,
  });
  store.recordAlert({
    key: "k1",
    severity: "critical",
    title: "Invalid batch 1",
    body: "details",
    createdAt: NOW - 50,
  });
  store.saveMonitorSnapshot({
    network: "testnet",
    source: "tip",
    hash: "h",
    body: JSON.stringify({
      height: 10_240_000,
      tipTime: NOW - 2,
      measuredBlockTimeSecs: 1.42,
      halted: false,
    }),
    fetchedAt: NOW - 1,
    changedAt: NOW - 1,
    available: true,
  });
  store.saveMonitorSnapshot({
    network: "testnet",
    source: "rdk-params",
    hash: "h",
    body: "{}",
    fetchedAt: NOW - 1,
    changedAt: NOW - 900,
    available: true,
  });
  store.addChainEvent({
    network: "testnet",
    source: "rdk-params",
    severity: "warning",
    title: "Rollup module parameters changed on testnet",
    detail: "a: 1 -> 2",
    createdAt: NOW - 900,
  });
  const api = new Api({
    store,
    rollupId: "vigil-1",
    chainId: "qorechain-diana",
    receiptsContract: "0xced6",
    networks: ["testnet", "mainnet"],
    now: () => NOW,
  });
  return { store, api };
}

describe("Api", () => {
  it("summarises the rollup with verdicts and receipts, newest batch first", () => {
    const { api, store } = seeded();
    const overview = api.overview();

    expect(overview.rollup.summary).toEqual({
      batches: 3,
      valid: 1,
      invalid: 1,
      finalized: 1,
      receiptsRecorded: 1,
    });
    expect(overview.rollup.batches.map((b) => [b.index, b.verdict, b.status])).toEqual([
      [2, "pending", "submitted"],
      [1, "invalid", "rejected"],
      [0, "valid", "finalized"],
    ]);
    expect(overview.rollup.batches[2]).toMatchObject({
      entries: { from: 1, to: 3 },
      receipt: { txHash: "0xa4e7", contract: "0xced6" },
    });
    expect(overview.rollup.batches[1]?.receipt).toBeUndefined();
    expect(overview.rollup.batches[1]?.reasons).toEqual(["state_root"]);
    expect(overview.alerts).toHaveLength(1);

    store.recordAlert({
      key: "chain:mainnet:block-time:drift:slow",
      severity: "warning",
      title: "Mainnet block time differs",
      body: "x",
      createdAt: NOW,
    });
    expect(api.overview().alerts.map((a) => a.title)).toEqual(["Invalid batch 1"]);
  });

  it("does not show a receipt recorded for a different state root at the same index", () => {
    const { api, store } = seeded();
    store.saveReceipt("vigil-1", {
      batchIndex: 2,
      stateRoot: "99".repeat(32),
      contract: "0xced6",
      txHash: "0xold",
      recordedAt: NOW,
    });
    expect(api.overview().rollup.batches[0]).toMatchObject({ index: 2, receipt: undefined });
  });

  it("reports when each service was last seen", () => {
    const { api, store } = seeded();
    expect(api.overview().services).toEqual([]);
    store.heartbeat("watchtower", NOW - 30);
    expect(api.overview().services).toEqual([
      { service: "watchtower", lastSeen: NOW - 30, ageSecs: 30 },
    ]);
  });

  it("reports each network, including one with no data yet", () => {
    const { api } = seeded();
    const [testnet, mainnet] = api.overview().chain;
    expect(testnet).toMatchObject({
      network: "testnet",
      tipAvailable: true,
      tip: { height: 10_240_000, halted: false, measuredBlockTimeSecs: 1.42 },
    });
    expect(testnet?.sources).toEqual([
      { source: "rdk-params", available: true, checkedAt: NOW - 1, changedAt: NOW - 900 },
    ]);
    expect(mainnet).toMatchObject({
      network: "mainnet",
      tip: null,
      tipAvailable: false,
      sources: [],
    });
    expect(api.overview().chainEvents[0]?.detail).toBe("a: 1 -> 2");
  });

  it("never exposes secrets, keys or transaction logs", () => {
    const { api, store } = seeded();
    store.logTx({ label: "deposit", status: "confirmed", hash: "SECRETHASH", createdAt: NOW });
    const body = JSON.stringify(api.overview()) + api.metrics();
    expect(body).not.toContain("SECRETHASH");
    expect(body).not.toMatch(/mnemonic|passphrase|privateKey/i);
  });

  it("exposes Prometheus metrics", () => {
    const { api } = seeded();
    const text = api.metrics();
    expect(text).toContain('vigil_batches{rollup="vigil-1",verdict="valid"} 1');
    expect(text).toContain('vigil_batches{rollup="vigil-1",verdict="invalid"} 1');
    expect(text).toContain('vigil_batches{rollup="vigil-1",verdict="pending"} 1');
    expect(text).toContain('vigil_chain_height{network="testnet"} 10240000');
    expect(text).toContain('vigil_chain_halted{network="testnet"} 0');
    expect(text).toContain('vigil_chain_block_time_seconds{network="testnet"} 1.42');
    expect(text).toContain("vigil_alerts_undelivered 1");
    expect(text).not.toContain('network="mainnet"');
  });

  it("routes known paths and rejects unknown ones", () => {
    const { api } = seeded();
    expect(api.handle("/healthz")).toMatchObject({ status: 200 });
    expect(api.handle("/api/overview").contentType).toContain("application/json");
    expect(api.handle("/metrics").contentType).toContain("text/plain");
    expect(api.handle("/api/secrets")).toMatchObject({ status: 404 });
  });
});

describe("HTTP server", () => {
  const dir = mkdtempSync(join(tmpdir(), "vigil-static-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Vigil status</title>");
  writeFileSync(join(dir, "notes.txt"), "not served");
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(options: { requestsPerMinute?: number } = {}) {
    const { api } = seeded();
    const server = createApiServer({ api, staticDir: dir, log, ...options }).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${String(port)}`, close: () => server.close() };
  }

  it("serves the page, the API and metrics with security headers", async () => {
    const { base, close } = await start();
    try {
      const page = await fetch(`${base}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Vigil status");
      expect(page.headers.get("x-content-type-options")).toBe("nosniff");
      expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");

      const overview = await fetch(`${base}/api/overview?x=1`);
      expect(((await overview.json()) as { rollup: { id: string } }).rollup.id).toBe("vigil-1");
      expect(overview.headers.get("cache-control")).toBe("no-store");
      expect((await fetch(`${base}/metrics`)).status).toBe(200);
      expect((await fetch(`${base}/healthz`, { method: "HEAD" })).status).toBe(200);
    } finally {
      close();
    }
  });

  it("refuses writes, unknown files, other file types and path traversal", async () => {
    const { base, close } = await start();
    try {
      expect((await fetch(`${base}/api/overview`, { method: "POST" })).status).toBe(405);
      expect((await fetch(`${base}/missing.html`)).status).toBe(404);
      expect((await fetch(`${base}/notes.txt`)).status).toBe(404);
      expect((await fetch(`${base}/..%2f..%2fpackage.json`)).status).toBe(404);
      expect((await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd.html`)).status).toBe(404);
    } finally {
      close();
    }
  });

  it("does not let unknown paths grow the cache, and separates clients behind a trusted proxy", async () => {
    const { api } = seeded();
    const server = createApiServer({
      api,
      staticDir: dir,
      log,
      requestsPerMinute: 2,
      trustProxy: true,
    }).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    try {
      const from = (ip: string) =>
        fetch(`${base}/api/nope-${ip}`, { headers: { "x-forwarded-for": `1.1.1.1, ${ip}` } });
      expect([(await from("10.0.0.1")).status, (await from("10.0.0.1")).status]).toEqual([
        404, 404,
      ]);
      expect((await from("10.0.0.1")).status).toBe(429);
      expect((await from("10.0.0.2")).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it("rate limits a client that asks too often", async () => {
    const { base, close } = await start({ requestsPerMinute: 3 });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await fetch(`${base}/healthz`)).status);
      expect(statuses).toEqual([200, 200, 200, 429, 429]);
    } finally {
      close();
    }
  });
});
