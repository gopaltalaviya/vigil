import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hexToBech32 } from "@qorechain/rdk";
import { afterAll, describe, expect, it } from "vitest";
import { InboxArchive, IntegrityError, Store, toHex } from "@vigil/core";
import { FAKE_CHAIN_ID, FAKE_ROLLUP_ID, FakeRollup } from "../../core/test/fake-rollup.js";
import {
  InputError,
  Wallet,
  createKeystore,
  formatQor,
  keystoreAccountId,
  openKeystore,
  parseAccountId,
  parseQor,
  type WalletOptions,
} from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "vigil-wallet-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
const PASSPHRASE = "correct horse battery";
const QOR = 1_000_000n;
const L1 = hexToBech32("01".repeat(20), "qor");

let keystores = 0;
const newAccount = () => createKeystore(join(dir, `k${String(++keystores)}.json`), PASSPHRASE);

function setup(paidOut?: WalletOptions["paidOut"]) {
  const rollup = new FakeRollup();
  const store = Store.open(":memory:");
  const wallet = new Wallet({
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
    ...(paidOut === undefined ? {} : { paidOut }),
  });
  return { rollup, store, wallet, sender: rollup.sender(L1, store) };
}

describe("amounts", () => {
  it("converts QOR to uqor exactly", () => {
    expect(parseQor("1")).toBe(1_000_000n);
    expect(parseQor("0.000001")).toBe(1n);
    expect(parseQor(" 12.5 ")).toBe(12_500_000n);
    expect(parseQor("18446744073709.551615")).toBe(2n ** 64n - 1n);
  });

  it("rejects anything that is not a positive amount within range", () => {
    for (const bad of [
      "",
      "0",
      "0.0",
      "-1",
      "1.0000001",
      "1e6",
      "abc",
      "1,5",
      "18446744073709.551616",
    ]) {
      expect(() => parseQor(bad), bad).toThrow(InputError);
    }
  });

  it("formats uqor without trailing zeros", () => {
    expect(formatQor(1_500_000n)).toBe("1.5");
    expect(formatQor(1n)).toBe("0.000001");
    expect(formatQor(20_000_000n)).toBe("20");
    expect(formatQor(0n)).toBe("0");
  });
});

describe("keystore", () => {
  it("round-trips an account and exposes only the account id without the passphrase", () => {
    const path = join(dir, "roundtrip.json");
    const created = createKeystore(path, PASSPHRASE);
    const opened = openKeystore(path, PASSPHRASE);

    expect(toHex(opened.secretKey)).toBe(toHex(created.secretKey));
    expect(keystoreAccountId(path)).toBe(toHex(created.accountId));
    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).not.toContain(toHex(created.secretKey).slice(0, 32));
    expect(onDisk).not.toContain(PASSPHRASE);
  });

  it("refuses a wrong passphrase, a short passphrase and an overwrite", () => {
    const path = join(dir, "guarded.json");
    createKeystore(path, PASSPHRASE);
    expect(() => openKeystore(path, "wrong passphrase!")).toThrow(/wrong passphrase/);
    expect(() => createKeystore(path, PASSPHRASE)).toThrow(/will not be replaced/);
    expect(() => createKeystore(join(dir, "short.json"), "short")).toThrow(InputError);
  });

  it("detects a modified or malformed file", () => {
    const path = join(dir, "tampered.json");
    createKeystore(path, PASSPHRASE);
    const file = JSON.parse(readFileSync(path, "utf8")) as {
      accountId: string;
      cipher: { ciphertext: string };
    };

    writeFileSync(path, JSON.stringify({ ...file, accountId: "00".repeat(32) }));
    expect(() => openKeystore(path, PASSPHRASE)).toThrow(InputError);

    writeFileSync(path, JSON.stringify({ ...file, version: 2 }));
    expect(() => openKeystore(path, PASSPHRASE)).toThrow(IntegrityError);
    writeFileSync(path, "{not json");
    expect(() => keystoreAccountId(path)).toThrow(IntegrityError);
    expect(() => keystoreAccountId(join(dir, "missing.json"))).toThrow(/vigil keygen/);
  });
});

describe("wallet", () => {
  it("never re-sends a payout the chain already made, even with an empty database", async () => {
    const paid = {
      batchIndex: 0,
      withdrawalIndex: 0,
      recipient: L1,
      amountUqor: QOR.toString(),
      txHash: "PAID",
      height: 1,
    };
    const { rollup, wallet, sender, store } = setup(() => Promise.resolve([paid]));
    const alice = newAccount();
    await wallet.deposit(sender, alice.accountId, 5n * QOR);
    await wallet.withdraw(sender, alice, L1, QOR);
    rollup.submitHonestBatch();
    rollup.finalizeAll();

    expect(await wallet.claim(sender)).toEqual({ paid: [], failed: [] });
    expect(rollup.payouts).toEqual([]);
    expect(store.claim(FAKE_ROLLUP_ID, 0)?.txHash).toBe("PAID");
  });

  it("sends no payout when the chain's payout history cannot be read", async () => {
    const { rollup, wallet, sender } = setup(() => Promise.reject(new Error("unreachable")));
    const alice = newAccount();
    await wallet.deposit(sender, alice.accountId, 5n * QOR);
    await wallet.withdraw(sender, alice, L1, QOR);
    rollup.submitHonestBatch();
    rollup.finalizeAll();

    await expect(wallet.claim(sender)).rejects.toThrow("unreachable");
    expect(rollup.payouts).toEqual([]);
  });

  it("runs a full cycle: deposit, transfer, withdraw, batch, finalize, claim", async () => {
    const { rollup, wallet, sender, store } = setup();
    const alice = newAccount();
    const bob = newAccount();

    await wallet.deposit(sender, alice.accountId, 5n * QOR);
    expect((await wallet.state(alice.accountId)).pending.balance).toBe(5n * QOR);

    await wallet.transfer(sender, alice, toHex(bob.accountId), 2n * QOR);
    await wallet.withdraw(sender, alice, L1, QOR);

    const pending = await wallet.state(alice.accountId);
    expect(pending.pending).toEqual({ balance: 2n * QOR, nonce: 2n });
    expect(pending.batched.balance).toBe(0n);
    expect((await wallet.state(bob.accountId)).pending.balance).toBe(2n * QOR);
    expect(await wallet.claim(sender)).toEqual({ paid: [], failed: [] });

    rollup.submitHonestBatch();
    const open = await wallet.withdrawals(L1);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ amount: QOR, batchStatus: "submitted", claimed: false });
    expect(await wallet.claim(sender)).toEqual({ paid: [], failed: [] });

    rollup.finalizeAll();
    const { paid } = await wallet.claim(sender);
    expect(paid).toHaveLength(1);
    expect(rollup.payouts).toEqual([{ withdrawalIndex: 0n, recipient: L1, amount: QOR }]);
    expect(store.claim(FAKE_ROLLUP_ID, 0)?.txHash).toBe(paid[0]?.outcome.hash);

    expect(await wallet.claim(sender)).toEqual({ paid: [], failed: [] });
    expect(rollup.payouts).toHaveLength(1);
    expect((await wallet.state(alice.accountId)).batched.balance).toBe(2n * QOR);
    expect(store.recentTxs(10).map((t) => t.label)).toEqual([
      "claim",
      "withdraw",
      "transfer",
      "deposit",
    ]);
  });

  it("uses the next nonce for each transaction, including ones not batched yet", async () => {
    const { rollup, wallet, sender } = setup();
    const alice = newAccount();
    const bob = newAccount();
    await wallet.deposit(sender, alice.accountId, 3n * QOR);
    await wallet.transfer(sender, alice, toHex(bob.accountId), QOR);
    await wallet.transfer(sender, alice, toHex(bob.accountId), QOR);

    expect(rollup.ledgerAt(rollup.head).get(bob.accountId).balance).toBe(2n * QOR);
    expect(rollup.ledgerAt(rollup.head).get(alice.accountId).nonce).toBe(2n);
  });

  it("refuses invalid requests before anything is sent", async () => {
    const { rollup, wallet, sender } = setup();
    const alice = newAccount();
    await wallet.deposit(sender, alice.accountId, QOR);
    const sent = rollup.head;

    await expect(wallet.deposit(sender, alice.accountId, QOR - 1n)).rejects.toThrow(/smallest/);
    await expect(wallet.transfer(sender, alice, toHex(alice.accountId), 1n)).rejects.toThrow(
      /sending account/,
    );
    await expect(wallet.transfer(sender, alice, "abc", 1n)).rejects.toThrow(InputError);
    await expect(wallet.transfer(sender, alice, "11".repeat(32), 2n * QOR)).rejects.toThrow(
      /does not hold/,
    );
    await expect(
      wallet.withdraw(sender, alice, hexToBech32("01".repeat(20), "cosmos"), 1n),
    ).rejects.toThrow(/valid qor1 address/);
    expect(rollup.head).toBe(sent);
    expect(() => parseAccountId("0x" + "ab".repeat(32))).not.toThrow();
  });

  it("surfaces a chain rejection and records no claim for it", async () => {
    const { rollup, wallet, sender, store } = setup();
    const alice = newAccount();
    await wallet.deposit(sender, alice.accountId, 2n * QOR);
    await wallet.withdraw(sender, alice, L1, QOR);
    rollup.submitHonestBatch();
    rollup.finalizeAll();

    rollup.failNextWith = 54;
    const first = await wallet.claim(sender);
    expect(first.paid).toEqual([]);
    expect(first.failed).toHaveLength(1);
    expect(first.failed[0]?.reason).toContain("claim");
    expect(store.claim(FAKE_ROLLUP_ID, 0)).toBeUndefined();
    expect((await wallet.claim(sender)).paid).toHaveLength(1);
  });

  it("keeps claiming the other withdrawals when one fails, and can mark one as paid elsewhere", async () => {
    const { rollup, wallet, sender } = setup();
    const alice = newAccount();
    await wallet.deposit(sender, alice.accountId, 3n * QOR);
    await wallet.withdraw(sender, alice, L1, QOR);
    await wallet.withdraw(sender, alice, L1, QOR);
    rollup.submitHonestBatch();
    rollup.finalizeAll();

    rollup.failNextWith = 54;
    const result = await wallet.claim(sender);
    expect(result.failed).toHaveLength(1);
    expect(result.paid).toHaveLength(1);

    const [stuck] = result.failed;
    if (stuck === undefined) throw new Error("expected a failed claim");
    wallet.markClaimed(stuck.withdrawal);
    expect(await wallet.claim(sender)).toEqual({ paid: [], failed: [] });
  });

  it("ignores withdrawals in rejected batches and ones addressed to others", async () => {
    const { rollup, wallet, sender } = setup();
    const alice = newAccount();
    await wallet.deposit(sender, alice.accountId, 2n * QOR);
    await wallet.withdraw(sender, alice, L1, QOR);
    rollup.submitHonestBatch({ status: "rejected" });

    expect(await wallet.withdrawals(L1)).toEqual([]);
    rollup.submitHonestBatch();
    expect(await wallet.withdrawals(L1)).toHaveLength(1);
    expect(await wallet.withdrawals("qor1someoneelse")).toEqual([]);
  });
});
