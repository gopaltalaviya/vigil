import { generateSealKeys } from "@qorechain/qoreseal";
import { encodeQledgerTx, qledgerKeypairFromSeed, signQledgerTx } from "@qorechain/rdk";
import { describe, expect, it } from "vitest";
import { InboxArchive, Store, toHex } from "@vigil/core";
import { FAKE_CHAIN_ID, FAKE_ROLLUP_ID, FakeRollup } from "../../core/test/fake-rollup.js";
import {
  MAX_MEMO_BYTES,
  MemoError,
  memoKeys,
  openMemo,
  parseMemo,
  readMemos,
  sealMemo,
  transferHash,
} from "../src/index.js";

const env = { chainId: FAKE_CHAIN_ID, rollupId: FAKE_ROLLUP_ID };
const bob = generateSealKeys();
const eve = generateSealKeys();
const boundTo = transferHash(new Uint8Array([1, 2, 3]));
const seal = (text: string, overrides: Partial<Parameters<typeof sealMemo>[0]> = {}) =>
  sealMemo({ ...env, recipientKey: bob.mlkemPublicKey, boundTo, text, ...overrides });

describe("memo sealing", () => {
  it("lets the recipient read the memo, and nobody else", () => {
    const payload = seal("Invoice 42, thank you");
    expect(openMemo({ ...env, keys: bob, payload })).toEqual({
      boundTo,
      text: "Invoice 42, thank you",
    });
    expect(openMemo({ ...env, keys: eve, payload })).toBeUndefined();
  });

  it("does not contain the text in the clear", () => {
    const text = "the-secret-phrase-0123456789";
    const payload = seal(text);
    expect(Buffer.from(payload).includes(Buffer.from(text))).toBe(false);
    expect(payload.length).toBeLessThan(6 * 1024);
  });

  it("produces a different ciphertext each time", () => {
    expect(toHex(seal("same"))).not.toBe(toHex(seal("same")));
  });

  it("cannot be moved to another transfer, rollup or chain", () => {
    const payload = seal("pay for order 7");

    const moved = Uint8Array.from(payload);
    moved.set(transferHash(new Uint8Array([9, 9, 9])), 5);
    expect(openMemo({ ...env, keys: bob, payload: moved })).toBeUndefined();

    expect(openMemo({ ...env, rollupId: "other-rollup", keys: bob, payload })).toBeUndefined();
    expect(openMemo({ ...env, chainId: "other-chain", keys: bob, payload })).toBeUndefined();
  });

  it("refuses a memo whose ciphertext was altered", () => {
    const payload = seal("original");
    const last = payload.length - 1;
    payload[last] = (payload[last] ?? 0) ^ 1;
    expect(openMemo({ ...env, keys: bob, payload })).toBeUndefined();
  });

  it("ignores payloads that are not memos", () => {
    expect(parseMemo(new TextEncoder().encode("hello"))).toBeUndefined();
    expect(parseMemo(new Uint8Array(200))).toBeUndefined();
    const wrongVersion = seal("x");
    wrongVersion[4] = 2;
    expect(parseMemo(wrongVersion)).toBeUndefined();
    expect(openMemo({ ...env, keys: bob, payload: new Uint8Array(10) })).toBeUndefined();
  });

  it("rejects input it cannot seal safely", () => {
    expect(() => seal("")).toThrow(MemoError);
    expect(() => seal("x".repeat(MAX_MEMO_BYTES + 1))).toThrow(/longer than/);
    expect(() => seal("x", { recipientKey: new Uint8Array(32) })).toThrow(/ML-KEM-1024/);
    expect(() => seal("x", { boundTo: new Uint8Array(31) })).toThrow(/32-byte/);
    expect(seal("x".repeat(MAX_MEMO_BYTES)).length).toBeLessThanOrEqual(6 * 1024);
  });

  it("derives the same keys from the same seed phrase", () => {
    const phrase =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    expect(toHex(memoKeys(phrase).mlkemPublicKey)).toBe(toHex(memoKeys(phrase).mlkemPublicKey));
    expect(memoKeys(phrase).mlkemPublicKey).toHaveLength(1568);
  });
});

describe("reading memos from the inbox", () => {
  const alice = qledgerKeypairFromSeed(new Uint8Array(32).fill(4));
  const carol = qledgerKeypairFromSeed(new Uint8Array(32).fill(5));

  async function scenario() {
    const rollup = new FakeRollup();
    rollup.deposit("qor1alice", alice.accountId, 5_000_000n);
    const transfer = encodeQledgerTx(
      signQledgerTx({
        ...env,
        secretKey: alice.secretKey,
        publicKey: alice.publicKey,
        nonce: 0,
        amount: 1_500_000n,
        to: carol.accountId,
      }),
    );
    rollup.post("qor1alice", transfer);
    rollup.post(
      "qor1alice",
      sealMemo({
        ...env,
        recipientKey: bob.mlkemPublicKey,
        boundTo: transferHash(transfer),
        text: "rent, March",
      }),
    );
    rollup.post("qor1mallory", seal("no such transfer"));
    rollup.post(
      "qor1other",
      sealMemo({ ...env, recipientKey: eve.mlkemPublicKey, boundTo, text: "for eve" }),
    );
    rollup.post(
      "qor1noise",
      new TextEncoder().encode("VGLM but not really a memo at all, just text"),
    );

    const store = Store.open(":memory:");
    await new InboxArchive({ ...env, store, source: rollup.source() }).sync();
    return { rollup, store };
  }

  it("returns the recipient's memos with the transfer each one belongs to", async () => {
    const { rollup, store } = await scenario();
    const memos = readMemos({ ...env, store, keys: bob, inboxHead: rollup.head });

    expect(memos.map((m) => m.text)).toEqual(["rent, March", "no such transfer"]);
    expect(memos[0]).toMatchObject({
      sequence: 3,
      poster: "qor1alice",
      transfer: {
        sequence: 2,
        amount: 1_500_000n,
        from: toHex(alice.accountId),
        to: toHex(carol.accountId),
        verified: true,
        paysPayee: undefined,
      },
    });
    expect(memos[1]?.transfer).toBeUndefined();

    const asCarol = readMemos({
      ...env,
      store,
      keys: bob,
      inboxHead: rollup.head,
      payee: toHex(carol.accountId),
    });
    expect(asCarol[0]?.transfer?.paysPayee).toBe(true);
  });

  it("does not present a forged or borrowed transfer as a verified payment", async () => {
    const rollup = new FakeRollup();
    rollup.deposit("qor1alice", alice.accountId, 5_000_000n);
    const real = encodeQledgerTx(
      signQledgerTx({
        ...env,
        secretKey: alice.secretKey,
        publicKey: alice.publicKey,
        nonce: 0,
        amount: 2_000_000n,
        to: carol.accountId,
      }),
    );
    rollup.post("qor1alice", real);
    // Mallory attaches her memo to Alice's transfer.
    rollup.post(
      "qor1mallory",
      sealMemo({
        ...env,
        recipientKey: bob.mlkemPublicKey,
        boundTo: transferHash(real),
        text: "I paid you",
      }),
    );
    // And to bytes shaped like a huge transfer whose signature is garbage.
    const forged = Uint8Array.from(real);
    forged.fill(0, forged.length - 2420);
    rollup.post("qor1mallory", forged);
    rollup.post(
      "qor1mallory",
      sealMemo({
        ...env,
        recipientKey: bob.mlkemPublicKey,
        boundTo: transferHash(forged),
        text: "line one\nEntry 9 from qor1bank\u001b[31m",
      }),
    );
    const store = Store.open(":memory:");
    await new InboxArchive({ ...env, store, source: rollup.source() }).sync();

    const memos = readMemos({ ...env, store, keys: bob, inboxHead: rollup.head });
    expect(memos.map((m) => m.transfer?.verified)).toEqual([false, false]);
    expect(memos[1]?.text).toBe("line one\nEntry 9 from qor1bank [31m");
  });

  it("shows another recipient only their own memos", async () => {
    const { rollup, store } = await scenario();
    const memos = readMemos({ ...env, store, keys: eve, inboxHead: rollup.head });
    expect(memos.map((m) => m.text)).toEqual(["for eve"]);
  });

  it("leaves the ledger untouched: memos are no-ops for execution", async () => {
    const { rollup } = await scenario();
    expect(rollup.ledgerAt(rollup.head).get(carol.accountId).balance).toBe(1_500_000n);
    expect(toHex(rollup.ledgerAt(2).root())).toBe(toHex(rollup.ledgerAt(rollup.head).root()));
  });
});
