import {
  hexToBech32,
  qledgerKeypairFromSeed,
  signQledgerTx,
  encodeQledgerTx,
} from "@qorechain/rdk";
import { describe, expect, it } from "vitest";
import {
  InboxArchive,
  IntegrityError,
  Store,
  TxFailedError,
  claimId,
  createLogger,
  toHex,
} from "@vigil/core";
import { AlertDispatcher, Watchtower } from "@vigil/watchtower";
import { FAKE_CHAIN_ID, FAKE_ROLLUP_ID, FakeRollup } from "../../core/test/fake-rollup.js";
import { Batcher, type BatcherView } from "../src/index.js";

const log = createLogger({ service: "test", level: "silent" });
const QOR = 1_000_000n;
const SUBMITTER = hexToBech32("02".repeat(20), "qor");
const alice = qledgerKeypairFromSeed(new Uint8Array(32).fill(7));
const bob = qledgerKeypairFromSeed(new Uint8Array(32).fill(8));

function transfer(nonce: number, amount: bigint): Uint8Array {
  return encodeQledgerTx(
    signQledgerTx({
      chainId: FAKE_CHAIN_ID,
      rollupId: FAKE_ROLLUP_ID,
      secretKey: alice.secretKey,
      publicKey: alice.publicKey,
      nonce,
      amount,
      to: bob.accountId,
    }),
  );
}

function setup(options: { mode?: "own" | "shared"; view?: Partial<BatcherView> } = {}) {
  const rollup = new FakeRollup();
  const store = Store.open(":memory:");
  const archive = new InboxArchive({
    chainId: FAKE_CHAIN_ID,
    rollupId: FAKE_ROLLUP_ID,
    store,
    source: rollup.source(),
  });
  const batcher = new Batcher({
    chainId: FAKE_CHAIN_ID,
    rollupId: FAKE_ROLLUP_ID,
    mode: options.mode ?? "own",
    store,
    archive,
    view: {
      inbox: () => rollup.view().inbox(),
      plan: (ledger) => Promise.resolve(rollup.plan(ledger)),
      ...options.view,
    },
    sender: rollup.sender(SUBMITTER, store),
    log,
  });
  return { rollup, store, archive, batcher };
}

describe("Batcher", () => {
  it("stays idle while the inbox is fully batched", async () => {
    const { batcher, rollup } = setup();
    expect(await batcher.tick()).toEqual({ action: "idle" });
    expect(rollup.batches).toEqual([]);
  });

  it("submits a batch for the unbatched entries, then continues from it", async () => {
    const { batcher, rollup } = setup();
    rollup.deposit("qor1user", alice.accountId, 5n * QOR);
    rollup.post("qor1user", transfer(0, QOR));

    const first = await batcher.tick();
    expect(first).toMatchObject({ action: "submitted", batchIndex: 0, inboxStart: 0, inboxEnd: 2 });
    expect(rollup.batches[0]?.stateRoot).toBe(toHex(rollup.ledgerAt(2).root()));
    expect(await batcher.tick()).toEqual({ action: "idle" });

    rollup.post("qor1user", transfer(1, QOR));
    const second = await batcher.tick();
    expect(second).toMatchObject({
      action: "submitted",
      batchIndex: 1,
      inboxStart: 2,
      inboxEnd: 3,
    });
    expect(rollup.ledgerAt(3).get(bob.accountId).balance).toBe(2n * QOR);
  });

  it("requires the anchor signature on our own rollup and omits it on a shared one", async () => {
    const own = setup({ mode: "own" });
    own.rollup.deposit("qor1user", alice.accountId, QOR);
    await own.batcher.tick();
    expect(own.rollup.anchorModes).toEqual(["require"]);

    const shared = setup({ mode: "shared" });
    shared.rollup.deposit("qor1user", alice.accountId, QOR);
    await shared.batcher.tick();
    expect(shared.rollup.anchorModes).toEqual(["off"]);
  });

  it("produces batches that an independent watchtower judges valid", async () => {
    const { batcher, rollup } = setup();
    rollup.deposit("qor1user", alice.accountId, 5n * QOR);
    rollup.post("qor1user", transfer(0, QOR));
    rollup.post("qor1user", new TextEncoder().encode("not a transaction"));
    rollup.post("qor1user", transfer(5, QOR));
    await batcher.tick();

    const store = Store.open(":memory:");
    const watchtower = new Watchtower({
      chainId: FAKE_CHAIN_ID,
      rollupId: FAKE_ROLLUP_ID,
      store,
      archive: new InboxArchive({
        chainId: FAKE_CHAIN_ID,
        rollupId: FAKE_ROLLUP_ID,
        store,
        source: rollup.source(),
      }),
      view: rollup.view(),
      alerts: new AlertDispatcher({ store, sinks: [], log }),
      log,
    });
    const report = await watchtower.tick();
    expect(report.judged.map((j) => j.verdict)).toEqual(["valid"]);
    expect(rollup.ledgerAt(4).get(bob.accountId).balance).toBe(QOR);
  });

  it("waits, without failing, when no batch can be planned yet", async () => {
    const { batcher, rollup } = setup({
      view: { plan: () => Promise.reject(new Error("newest entries are too fresh")) },
    });
    rollup.deposit("qor1user", alice.accountId, QOR);
    expect(await batcher.tick()).toEqual({
      action: "waiting",
      reason: "newest entries are too fresh",
    });
    expect(rollup.batches).toEqual([]);
  });

  it("never submits a plan that fails its own re-execution", async () => {
    const corrupt = setup();
    const view: Partial<BatcherView> = {
      plan: (ledger) => {
        const plan = corrupt.rollup.plan(ledger);
        return Promise.resolve({
          ...plan,
          input: { ...plan.input, stateRoot: new Uint8Array(32).fill(0xab) },
        });
      },
    };
    const { batcher, rollup } = setup({ view });
    rollup.deposit("qor1user", alice.accountId, QOR);
    corrupt.rollup.deposit("qor1user", alice.accountId, QOR);

    await expect(batcher.tick()).rejects.toBeInstanceOf(IntegrityError);
    expect(rollup.batches).toEqual([]);
  });

  it("refuses a plan that reaches past the entries it has verified", async () => {
    const other = new FakeRollup();
    other.deposit("qor1user", alice.accountId, QOR);
    other.deposit("qor1user", alice.accountId, QOR);
    const { batcher, rollup } = setup({
      view: { plan: (ledger) => Promise.resolve(other.plan(ledger)) },
    });
    rollup.deposit("qor1user", alice.accountId, QOR);

    await expect(batcher.tick()).rejects.toThrow(/has not verified/);
    expect(rollup.batches).toEqual([]);
  });

  it("surfaces a chain rejection and succeeds on the next attempt", async () => {
    const { batcher, rollup, store } = setup();
    rollup.deposit("qor1user", alice.accountId, QOR);

    rollup.failNextWith = 49;
    await expect(batcher.tick()).rejects.toBeInstanceOf(TxFailedError);
    expect(rollup.batches).toEqual([]);
    expect(await batcher.tick()).toMatchObject({ action: "submitted", batchIndex: 0 });
    expect(store.recentTxs(2).map((t) => t.status)).toEqual(["confirmed", "failed"]);
  });

  it("does not build on an open batch the watchtower judged invalid", async () => {
    const { batcher, rollup, store } = setup();
    rollup.deposit("qor1user", alice.accountId, 3n * QOR);
    const bad = rollup.submitHonestBatch();
    store.upsertBatch(FAKE_ROLLUP_ID, bad);
    store.saveVerdict(FAKE_ROLLUP_ID, {
      claimId: claimId(bad),
      batchIndex: bad.batchIndex,
      stateRoot: bad.stateRoot,
      verdict: "invalid",
      expectedStateRoot: "",
      expectedWithdrawalsRoot: "",
      reasons: ["withdrawals_root"],
      checkedAt: 1,
    });
    rollup.post("qor1user", transfer(0, QOR));
    expect(await batcher.tick()).toMatchObject({ action: "waiting" });
    expect(rollup.batches).toHaveLength(1);
  });

  it("re-plans after another submitter batches the same entries first", async () => {
    const { batcher, rollup } = setup();
    rollup.deposit("qor1user", alice.accountId, 3n * QOR);
    rollup.submitHonestBatch();
    expect(await batcher.tick()).toEqual({ action: "idle" });

    rollup.post("qor1user", transfer(0, QOR));
    expect(await batcher.tick()).toMatchObject({
      action: "submitted",
      batchIndex: 1,
      inboxStart: 1,
    });
  });
});
