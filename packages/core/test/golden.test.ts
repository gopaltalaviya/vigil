import { QledgerLedger, qledgerEmptyRoot } from "@qorechain/rdk";
import { describe, expect, it } from "vitest";
import {
  InboxArchive,
  IntegrityError,
  Store,
  restoreLedger,
  serializeLedger,
  toBatchClaim,
  toHex,
  verifyBatch,
  type BatchVerdict,
} from "../src/index.js";
import { fixtureSource, loadGolden } from "./helpers.js";

const golden = loadGolden();
const env = { chainId: golden.chainId, rollupId: golden.rollupId };

function syncedArchive(chunkSize = 4): { archive: InboxArchive; store: Store } {
  const store = Store.open(":memory:");
  const archive = new InboxArchive({ ...env, store, source: fixtureSource(golden), chunkSize });
  return { archive, store };
}

function replay(archive: InboxArchive): BatchVerdict[] {
  let parent = new QledgerLedger();
  return golden.batches.map((batch) => {
    const verdict = verifyBatch(toBatchClaim(batch), {
      ...env,
      parent,
      entries: archive.range(batch.inboxStart, batch.inboxEnd),
      accFrom: archive.accAt(batch.inboxStart),
      accTo: archive.accAt(batch.inboxEnd),
    });
    parent = verdict.ledger;
    return verdict;
  });
}

describe("golden replay of a live rollup", () => {
  it("archives the inbox in chunks and matches the chain's accumulator", async () => {
    const { archive, store } = syncedArchive(4);
    await expect(archive.sync()).resolves.toEqual({ head: 9, added: 9 });
    expect(store.lastInboxEntry(golden.rollupId)?.acc).toBe(golden.head.acc);
    await expect(archive.sync()).resolves.toEqual({ head: 9, added: 0 });
  });

  it("reproduces the state root of every batch the chain finalized", async () => {
    const { archive } = syncedArchive();
    await archive.sync();
    const verdicts = replay(archive);

    expect(golden.batches).toHaveLength(2);
    expect(golden.batches[0]?.prevStateRoot).toBe(toHex(qledgerEmptyRoot()));
    expect(verdicts.map((v) => v.verdict)).toEqual(["valid", "valid"]);
    expect(verdicts[0]?.expectedStateRoot).toBe(
      "83274dd8c1e80acbe22bb5fb8bd054f08d5c020ecea632a3b650ffe685f387a7",
    );
    expect(verdicts[1]?.expectedStateRoot).toBe(golden.batches[1]?.stateRoot);
    expect(verdicts[1]?.expectedWithdrawalsRoot).toBe(golden.batches[1]?.withdrawalsRoot);
  });

  it("flags each forged commitment with the precise reason", async () => {
    const { archive } = syncedArchive();
    await archive.sync();
    const batch = golden.batches[0];
    if (batch === undefined) throw new Error("fixture has no batch");
    const context = {
      ...env,
      parent: new QledgerLedger(),
      entries: archive.range(batch.inboxStart, batch.inboxEnd),
      accFrom: archive.accAt(batch.inboxStart),
      accTo: archive.accAt(batch.inboxEnd),
    };
    const forged = "ab".repeat(32);
    const claim = toBatchClaim(batch);

    expect(verifyBatch({ ...claim, stateRoot: forged }, context).reasons).toEqual(["state_root"]);
    expect(verifyBatch({ ...claim, withdrawalsRoot: forged }, context).reasons).toEqual([
      "withdrawals_root",
    ]);
    expect(verifyBatch({ ...claim, dataHash: forged }, context).reasons).toEqual(["data_hash"]);
    expect(verifyBatch({ ...claim, prevStateRoot: forged }, context).reasons).toEqual([
      "prev_state_root",
    ]);

    const short = verifyBatch(claim, { ...context, entries: context.entries.slice(0, 3) });
    expect(short.verdict).toBe("invalid");
    expect(short.reasons).toContain("inbox_range");
    expect(short.reasons).toContain("state_root");
  });

  it("does not modify the parent ledger while judging", async () => {
    const { archive } = syncedArchive();
    await archive.sync();
    const parent = new QledgerLedger();
    const before = toHex(parent.root());
    const batch = golden.batches[0];
    if (batch === undefined) throw new Error("fixture has no batch");
    verifyBatch(toBatchClaim(batch), {
      ...env,
      parent,
      entries: archive.range(0, 4),
      accFrom: archive.accAt(0),
      accTo: archive.accAt(4),
    });
    expect(toHex(parent.root())).toBe(before);
  });

  it("round-trips the ledger through a snapshot and continues from it", async () => {
    const { archive, store } = syncedArchive();
    await archive.sync();
    const [first] = replay(archive);
    if (first === undefined) throw new Error("no verdict");

    const snapshot = serializeLedger(first.ledger);
    store.saveSnapshot(golden.rollupId, { inboxSequence: 4, ...snapshot });
    const stored = store.latestSnapshot(golden.rollupId, 8);
    expect(stored?.inboxSequence).toBe(4);
    if (stored === undefined) throw new Error("no snapshot");

    const second = golden.batches[1];
    if (second === undefined) throw new Error("fixture has one batch");
    const resumed = verifyBatch(toBatchClaim(second), {
      ...env,
      parent: restoreLedger(stored),
      entries: archive.range(second.inboxStart, second.inboxEnd),
      accFrom: archive.accAt(second.inboxStart),
      accTo: archive.accAt(second.inboxEnd),
    });
    expect(resumed.verdict).toBe("valid");
  });
});

describe("inbox archive integrity", () => {
  it("rejects a payload that was altered in transit and stores nothing from that chunk", async () => {
    const store = Store.open(":memory:");
    const source = fixtureSource(golden, {
      mutate: (entries) => {
        const last = entries.at(-1);
        if (last !== undefined) last.payload = last.payload.slice().fill(0, 0, 4);
      },
    });
    const archive = new InboxArchive({ ...env, store, source, chunkSize: 4 });
    await expect(archive.sync()).rejects.toBeInstanceOf(IntegrityError);
    expect(store.lastInboxEntry(golden.rollupId)?.sequence).toBe(8);
  });

  it("rejects a chain whose inbox is shorter than the archive", async () => {
    const { archive, store } = syncedArchive();
    await archive.sync();
    const shorter = new InboxArchive({
      ...env,
      store,
      source: fixtureSource(golden, { headSequence: 5 }),
    });
    await expect(shorter.sync()).rejects.toThrow(/shorter than the local archive/);
  });

  it("rejects a head accumulator that differs at the same height", async () => {
    const { archive, store } = syncedArchive();
    await archive.sync();
    const forked = new InboxArchive({
      ...env,
      store,
      source: fixtureSource(golden, { headAcc: "00".repeat(32) }),
    });
    await expect(forked.sync()).rejects.toBeInstanceOf(IntegrityError);
  });

  it("rejects a source that returns too few entries", async () => {
    const store = Store.open(":memory:");
    const source = fixtureSource(golden);
    source.entries = () => Promise.resolve([]);
    const archive = new InboxArchive({ ...env, store, source });
    await expect(archive.sync()).rejects.toThrow(/wrong number of entries/);
  });

  it("refuses ranges and positions it has not archived", () => {
    const { archive } = syncedArchive();
    expect(() => archive.range(0, 4)).toThrow(IntegrityError);
    expect(() => archive.accAt(3)).toThrow(IntegrityError);
  });

  it("resumes from the last stored entry after a partial sync", async () => {
    const store = Store.open(":memory:");
    const partial = fixtureSource(golden);
    const original = partial.entries.bind(partial);
    partial.entries = (from, to, acc) =>
      from >= 4 ? Promise.reject(new Error("endpoint down")) : original(from, to, acc);
    await expect(
      new InboxArchive({ ...env, store, source: partial, chunkSize: 4 }).sync(),
    ).rejects.toThrow("endpoint down");
    expect(store.lastInboxEntry(golden.rollupId)?.sequence).toBe(4);

    const healthy = fixtureSource(golden);
    const result = await new InboxArchive({ ...env, store, source: healthy, chunkSize: 4 }).sync();
    expect(result).toEqual({ head: 9, added: 5 });
    expect(healthy.calls[0]).toEqual([4, 8]);
  });
});
