import {
  encodeQledgerTx,
  hexToBech32,
  qledgerKeypairFromSeed,
  signQledgerTx,
} from "@qorechain/rdk";
import { generateSealKeys } from "@qorechain/qoreseal";
import { describe, expect, it } from "vitest";
import { InboxArchive, Store, claimId, createLogger, toHex } from "@vigil/core";
import { sealMemo, transferHash } from "@vigil/memo";
import { AlertDispatcher, Watchtower } from "@vigil/watchtower";
import { FAKE_CHAIN_ID, FAKE_ROLLUP_ID, FakeRollup } from "../../core/test/fake-rollup.js";
import { Api } from "../src/index.js";

const log = createLogger({ service: "test", level: "silent" });
const env = { chainId: FAKE_CHAIN_ID, rollupId: FAKE_ROLLUP_ID };
const alice = qledgerKeypairFromSeed(new Uint8Array(32).fill(21));
const bob = qledgerKeypairFromSeed(new Uint8Array(32).fill(22));
const PAYEE = hexToBech32("0b".repeat(20), "qor");

async function scenario() {
  const rollup = new FakeRollup();
  const sign = (
    nonce: number,
    amount: bigint,
    target: { to: Uint8Array } | { recipient: string },
  ) =>
    encodeQledgerTx(
      signQledgerTx({
        ...env,
        secretKey: alice.secretKey,
        publicKey: alice.publicKey,
        nonce,
        amount,
        ...target,
      }),
    );
  rollup.deposit("qor1alice", alice.accountId, 5_000_000n);
  const transfer = sign(0, 1_500_000n, { to: bob.accountId });
  rollup.post("qor1alice", transfer);
  rollup.post(
    "qor1alice",
    sealMemo({
      ...env,
      recipientKey: generateSealKeys().mlkemPublicKey,
      boundTo: transferHash(transfer),
      text: "hi",
    }),
  );
  rollup.post("qor1alice", sign(1, 500_000n, { recipient: PAYEE }));
  const forged = Uint8Array.from(sign(2, 9_000_000n, { to: bob.accountId }));
  forged.fill(0, forged.length - 100);
  rollup.post("qor1mallory", forged);
  rollup.post("qor1noise", new TextEncoder().encode("hello\u0007world"));
  rollup.submitHonestBatch();

  const store = Store.open(":memory:");
  const archive = new InboxArchive({ ...env, store, source: rollup.source() });
  await new Watchtower({
    ...env,
    store,
    archive,
    view: rollup.view(),
    alerts: new AlertDispatcher({ store, sinks: [], log }),
    log,
  }).tick();
  const api = new Api({ store, ...env, networks: [] });
  return { rollup, store, api };
}

const body = (response: { body: string }): Record<string, never> =>
  JSON.parse(response.body) as Record<string, never>;

describe("explorer routes", () => {
  it("decodes every kind of inbox entry in a batch", async () => {
    const { api, rollup } = await scenario();
    const detail = api.batchDetail(0);
    expect(detail?.batch).toMatchObject({
      index: 0,
      verdict: "valid",
      expectedStateRoot: rollup.batches[0]?.stateRoot,
    });
    expect(detail?.entries.map((e) => [e.sequence, e.kind, e.amount, e.signatureValid])).toEqual([
      [1, "deposit", "5000000", undefined],
      [2, "transfer", "1500000", true],
      [3, "memo", undefined, undefined],
      [4, "withdrawal", "500000", true],
      [5, "transfer", "9000000", false],
      [6, "data", undefined, undefined],
    ]);
    expect(detail?.entries[0]?.to).toBe(toHex(alice.accountId));
    expect(detail?.entries[1]).toMatchObject({
      from: toHex(alice.accountId),
      to: toHex(bob.accountId),
    });
    expect(detail?.entries[3]?.recipient).toBe(PAYEE);
    expect(detail?.rejectedClaims).toEqual([]);
  });

  it("serves batches, accounts and recent entries over the router", async () => {
    const { api } = await scenario();
    expect(api.handle("/api/batches/0").status).toBe(200);
    expect(api.handle("/api/batches/7")).toMatchObject({ status: 404 });
    expect(api.handle("/api/batches/abc").status).toBe(404);

    const account = body(api.handle(`/api/accounts/${toHex(bob.accountId).toUpperCase()}`));
    expect(account).toEqual({
      accountId: toHex(bob.accountId),
      balance: "1500000",
      nonce: "0",
      asOfEntry: 6,
    });
    expect(body(api.handle(`/api/accounts/${"00".repeat(32)}`))).toMatchObject({ balance: "0" });
    expect(api.handle("/api/accounts/xyz").status).toBe(404);

    const recent = body(api.handle("/api/entries")) as unknown as {
      entries: { sequence: number }[];
    };
    expect(recent.entries.map((e) => e.sequence)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(body(api.handle("/api/session"))).toEqual({ console: false, signedIn: false });
  });

  it("lists withdrawals to a base-chain address given in either spelling, and refuses bad ones", async () => {
    const { api } = await scenario();
    const byBech32 = body(api.handle(`/api/withdrawals/${PAYEE}`)) as unknown as {
      recipient: string;
      withdrawals: { sequence: number; amount: string }[];
    };
    expect(byBech32.recipient).toBe(PAYEE);
    expect(byBech32.withdrawals.map((w) => [w.sequence, w.amount])).toEqual([[4, "500000"]]);
    const byHex = body(api.handle(`/api/withdrawals/0x${"0b".repeat(20)}`));
    expect(byHex).toEqual(byBech32);
    const nobody = hexToBech32("0c".repeat(20), "qor");
    expect(body(api.handle(`/api/withdrawals/${nobody}`))).toEqual({
      recipient: nobody,
      withdrawals: [],
    });

    const typo = `${PAYEE.slice(0, -1)}${PAYEE.endsWith("q") ? "p" : "q"}`;
    expect(api.handle(`/api/withdrawals/${typo}`)).toMatchObject({ status: 400 });
    expect(body(api.handle(`/api/withdrawals/${typo}`))).toMatchObject({ code: "BAD_CHECKSUM" });
    expect(body(api.handle(`/api/withdrawals/%20${PAYEE}`))).toMatchObject({ code: "WHITESPACE" });
    expect(body(api.handle("/api/withdrawals/%E0%A4%A"))).toMatchObject({ code: "BAD_ENCODING" });
    const validator = hexToBech32("0b".repeat(20), "qorvaloper");
    expect(body(api.handle(`/api/withdrawals/${validator}`))).toMatchObject({
      code: "KIND_NOT_ALLOWED",
    });
  });

  it("shows the live claim at an index and lists the ones the chain rejected", async () => {
    const { api, store, rollup } = await scenario();
    const live = rollup.batches[0];
    if (live === undefined) throw new Error("no batch");
    const rejected = {
      ...live,
      withdrawalsRoot: "ee".repeat(32),
      submittedAt: live.submittedAt - 5,
      status: "rejected",
    };
    store.upsertBatch(FAKE_ROLLUP_ID, rejected);
    expect(claimId(rejected)).not.toBe(claimId(live));

    const detail = api.batchDetail(0);
    expect(detail?.batch.withdrawalsRoot).toBe(live.withdrawalsRoot);
    expect(detail?.rejectedClaims).toMatchObject([
      { index: 0, status: "rejected", verdict: "pending" },
    ]);

    store.saveFraudEvent(FAKE_ROLLUP_ID, {
      txHash: "F1",
      claimId: claimId(rejected),
      batchIndex: 0,
      height: 9,
      time: 8,
      submitter: "qor1forger",
      challenger: "qor1watcher",
      slashedUqor: "1000",
      rewardUqor: "500",
      burnedUqor: "500",
      seenLive: false,
    });
    const after = api.batchDetail(0);
    expect(after?.rejectedClaims[0]?.rejection).toMatchObject({
      txHash: "F1",
      challenger: "qor1watcher",
      seenLive: false,
    });
    expect(after?.batch.rejection).toBeUndefined();
  });

  it("removes control characters from text taken from the chain", async () => {
    const { api } = await scenario();
    const posters = api.batchDetail(0)?.entries.map((e) => e.poster) ?? [];
    expect(posters.every((poster) => !/\p{Cc}/u.test(poster))).toBe(true);
  });
});
