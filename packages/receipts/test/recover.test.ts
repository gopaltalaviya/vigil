import { describe, expect, it } from "vitest";
import { Store, type StoredBatch } from "@vigil/core";
import { recoverReceiptHashes, type AnchorLog, type AnchorLogSource } from "../src/recover.js";

const CONTRACT = "0xabc";
const rootA = "aa".repeat(32);
const rootB = "bb".repeat(32);

const batch = (batchIndex: number, stateRoot: string, submittedAt: number): StoredBatch => ({
  batchIndex,
  stateRoot,
  prevStateRoot: "00".repeat(32),
  dataHash: "11".repeat(32),
  withdrawalsRoot: "22".repeat(32),
  inboxStart: batchIndex,
  inboxEnd: batchIndex + 1,
  txCount: 1,
  status: "finalized",
  submittedAt,
  submittedTime: 1,
  finalizedAt: submittedAt + 10,
});

function source(logs: AnchorLog[], latest = 35_000n) {
  const ranges: [bigint, bigint][] = [];
  const reader: AnchorLogSource = {
    latestBlock: () => Promise.resolve(latest),
    anchorLogs(from, to) {
      ranges.push([from, to]);
      return Promise.resolve(logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to));
    },
    blockTime: (block) => Promise.resolve(Number(block) + 1_000),
  };
  return { reader, ranges };
}

function store() {
  const s = Store.open(":memory:");
  s.upsertBatch("r1", batch(0, rootA, 12_000));
  s.upsertBatch("r1", batch(1, rootA, 22_000));
  for (const batchIndex of [0, 1]) {
    s.saveReceipt("r1", {
      batchIndex,
      stateRoot: rootA,
      contract: CONTRACT,
      txHash: "",
      recordedAt: 5,
    });
  }
  return s;
}

const log = (over: Partial<AnchorLog>): AnchorLog => ({
  txHash: "0x01",
  blockNumber: 12_100n,
  layerId: "r1",
  layerHeight: 0n,
  stateRoot: rootA,
  ...over,
});

describe("recoverReceiptHashes", () => {
  it("restores hashes, telling apart two batches with the same state root", async () => {
    const s = store();
    const { reader } = source([
      log({}),
      log({ txHash: "0x02", blockNumber: 22_100n, layerHeight: 1n }),
    ]);
    const report = await recoverReceiptHashes({
      store: s,
      rollupId: "r1",
      contract: CONTRACT,
      source: reader,
    });
    expect(report).toEqual({ missing: 2, recovered: 2, unresolved: [] });
    expect(s.receipts("r1").map((r) => [r.batchIndex, r.txHash, r.recordedAt])).toEqual([
      [0, "0x01", 13_100],
      [1, "0x02", 23_100],
    ]);
  });

  it("queries in spans the node accepts, from the first batch, and stops when done", async () => {
    const { reader, ranges } = source([
      log({}),
      log({ txHash: "0x02", blockNumber: 22_100n, layerHeight: 1n }),
    ]);
    await recoverReceiptHashes({
      store: store(),
      rollupId: "r1",
      contract: CONTRACT,
      source: reader,
    });
    expect(ranges).toEqual([
      [12_000n, 21_999n],
      [22_000n, 31_999n],
    ]);
  });

  it("ignores another rollup's anchor and a different root, and reports what is left", async () => {
    const s = store();
    const { reader } = source([
      log({ layerId: "other" }),
      log({ stateRoot: rootB }),
      log({ txHash: "0x09", blockNumber: 22_100n, layerHeight: 1n }),
    ]);
    const report = await recoverReceiptHashes({
      store: s,
      rollupId: "r1",
      contract: CONTRACT,
      source: reader,
    });
    expect(report).toEqual({ missing: 2, recovered: 1, unresolved: [0] });
  });

  it("does nothing when no hash is missing", async () => {
    const s = Store.open(":memory:");
    const { reader, ranges } = source([]);
    const report = await recoverReceiptHashes({
      store: s,
      rollupId: "r1",
      contract: CONTRACT,
      source: reader,
    });
    expect(report).toEqual({ missing: 0, recovered: 0, unresolved: [] });
    expect(ranges).toEqual([]);
  });
});
