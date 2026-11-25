import { readFileSync } from "node:fs";
import type { RollupView as ChainRollup } from "@qorechain/rdk";
import { describe, expect, it } from "vitest";
import {
  Store,
  createChain,
  createLogger,
  loadConfig,
  type Chain,
  type StoredBatch,
} from "@vigil/core";
import { goldenChainIndex } from "../../core/test/chain-index.js";
import { loadGolden, toEntries } from "../../core/test/helpers.js";
import { AlertDispatcher, RollupAuditor, notJudgeableReason, replayRollup } from "../src/index.js";

const golden = loadGolden();
const env = { chainId: golden.chainId, rollupId: golden.rollupId };
const entries = toEntries(golden);
const log = createLogger({ service: "test", level: "silent" });
const [first, second] = golden.batches;
if (first === undefined || second === undefined) throw new Error("fixture needs two batches");

const rollup = (over: Partial<ChainRollup>): ChainRollup =>
  ({
    rollupId: golden.rollupId,
    executionVm: "qledger-v1",
    settlementMode: "optimistic",
    vmType: "cosmwasm",
    status: "active",
    ...over,
  }) as ChainRollup;

function auditor(batches: StoredBatch[], list: ChainRollup[]) {
  const store = Store.open(":memory:");
  const alerts = new AlertDispatcher({ store, sinks: [], log, now: () => 1 });
  const chain = {
    rdk: {
      rest: {
        listRollups: () => Promise.resolve(list),
        listBatches: () =>
          Promise.resolve(
            batches.map((batch) => ({
              ...batch,
              rollupId: golden.rollupId,
            })),
          ),
        getInbox: () =>
          Promise.resolve({
            headSequence: golden.head.sequence,
            consumedSequence: golden.head.sequence,
            headAcc: golden.head.acc,
          }),
        searchTxs: () => Promise.reject(new Error("no index in this test")),
      },
    },
  } as unknown as Chain;
  return {
    store,
    auditor: new RollupAuditor({
      chain,
      chainId: golden.chainId,
      ownRollupId: "vigil-1",
      store,
      alerts,
      log,
      now: () => 7,
    }),
  };
}

describe("replayRollup", () => {
  it("matches every honest batch", () => {
    expect(replayRollup(env, golden.batches, entries)).toEqual({
      checked: 2,
      matched: 2,
      findings: [],
    });
  });

  it("proves a fraud that changes only the withdrawals root", () => {
    const forged = { ...second, withdrawalsRoot: "ab".repeat(32) };
    const result = replayRollup(env, [first, forged], entries);
    expect(result.matched).toBe(1);
    expect(result.findings).toMatchObject([
      { batchIndex: second.batchIndex, reasons: ["withdrawals_root"], proven: true },
    ]);
  });

  it("proves a forged state root", () => {
    const forged = { ...second, stateRoot: "cd".repeat(32) };
    expect(replayRollup(env, [first, forged], entries).findings[0]).toMatchObject({
      reasons: ["state_root"],
      proven: true,
    });
  });

  it("skips claims the chain already rejected", () => {
    const rejected = { ...second, stateRoot: "cd".repeat(32), status: "rejected" };
    expect(replayRollup(env, [first, rejected, second], entries).findings).toEqual([]);
  });

  it("replays the entries before the first batch on record when older records are pruned", () => {
    // The chain no longer lists batch 0: its entries are executed without a batch record.
    expect(replayRollup(env, [second], entries)).toEqual({ checked: 1, matched: 1, findings: [] });
  });

  it("still proves fraud in the first batch on record after the bootstrap", () => {
    const forged = { ...second, stateRoot: "cd".repeat(32) };
    expect(replayRollup(env, [forged], entries).findings[0]).toMatchObject({
      batchIndex: second.batchIndex,
      reasons: ["state_root"],
      proven: true,
    });
  });

  it("flags a first batch on record whose previous state root does not follow the inbox", () => {
    const wrongParent = { ...second, prevStateRoot: "ef".repeat(32) };
    expect(replayRollup(env, [wrongParent], entries).findings[0]?.reasons).toContain(
      "prev_state_root",
    );
  });

  it("refuses a batch list with a gap after the first batch instead of judging it", () => {
    expect(() =>
      replayRollup(env, [first, { ...second, inboxStart: second.inboxStart + 1 }], entries),
    ).toThrow(/does not continue/);
  });
});

describe("notJudgeableReason", () => {
  it("accepts an optimistic qledger-v1 rollup", () => {
    expect(notJudgeableReason(rollup({}))).toBeUndefined();
  });

  it("labels zk, custom VM and non-qledger rollups", () => {
    expect(
      notJudgeableReason(rollup({ executionVm: "", settlementMode: "zk", vmType: "custom" })),
    ).toContain("zk, custom VM");
    expect(notJudgeableReason(rollup({ executionVm: "", vmType: "evm" }))).toContain(
      "not a qledger",
    );
    expect(notJudgeableReason(rollup({ settlementMode: "zk" }))).toContain("no fraud proofs");
  });
});

describe("RollupAuditor", () => {
  it("skips our own rollup and records why another cannot be judged", async () => {
    const { auditor: a, store } = auditor(golden.batches, [
      rollup({ rollupId: "vigil-1" }),
      rollup({ rollupId: "zk-1", executionVm: "", settlementMode: "zk", vmType: "custom" }),
    ]);
    await a.runOnce();
    expect(store.rollupAudits()).toMatchObject([{ rollupId: "zk-1", status: "not_judgeable" }]);
  });

  it("keeps going and records the error when one rollup cannot be read", async () => {
    const { auditor: a, store } = auditor(golden.batches, [rollup({ rollupId: "broken" })]);
    await a.runOnce();
    expect(store.rollupAudits()[0]).toMatchObject({ rollupId: "broken", status: "error" });
  });

  it("audits from a persisted inbox archive after the chain pruned every posted-data record", async () => {
    const index = goldenChainIndex(golden, { pruned: () => true });
    const chain = createChain(
      loadConfig({ ROLLUP_ID: "vigil-1", HTTP_MAX_RETRIES: "0" }),
      index.transport,
    );
    const views = golden.batches.map((batch) => ({ ...batch, rollupId: golden.rollupId }));
    Object.assign(chain.rdk.rest, {
      listRollups: () => Promise.resolve([rollup({})]),
      listBatches: () => Promise.resolve(views),
    });
    const store = Store.open(":memory:");
    const alerts = new AlertDispatcher({ store, sinks: [], log, now: () => 1 });
    const a = new RollupAuditor({
      chain,
      chainId: golden.chainId,
      ownRollupId: "vigil-1",
      store,
      alerts,
      log,
    });

    await a.runOnce();
    expect(store.rollupAudits()[0]).toMatchObject({ status: "clean", batches: 2, matched: 2 });
    expect(store.lastInboxEntry(golden.rollupId)?.sequence).toBe(golden.head.sequence);

    // The next audit finds the archive at the head and searches nothing.
    const searchesBefore = index.urls.filter((u) => u.includes("/txs?")).length;
    await a.runOnce();
    expect(index.urls.filter((u) => u.includes("/txs?")).length).toBe(searchesBefore);
    expect(store.rollupAudits()[0]).toMatchObject({ status: "clean", matched: 2 });
  });

  it("has no way to challenge: the module imports no sender or challenge message", () => {
    const source = readFileSync(new URL("../src/audit.ts", import.meta.url), "utf8");
    const imports = source.slice(0, source.indexOf("/** Result of replaying"));
    expect(imports).not.toMatch(/challenge|TxSender|connectTxSender/i);
    expect(source).not.toMatch(/challengeBatch|sender\.send|\.simulate\(/);
  });
});
