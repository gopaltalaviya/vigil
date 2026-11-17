import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSealKeys } from "@qorechain/qoreseal";
import { hexToBech32 } from "@qorechain/rdk";
import { afterAll, describe, expect, it } from "vitest";
import { Api, createApiServer } from "@vigil/api";
import { InboxArchive, Store, createLogger, toHex } from "@vigil/core";
import { Wallet, createKeystore, openKeystore, type L2Account } from "@vigil/wallet";
import { FAKE_CHAIN_ID, FAKE_ROLLUP_ID, FakeRollup } from "../../core/test/fake-rollup.js";
import { Operator, SESSION_COOKIE, Sessions, createConsoleRoutes } from "../src/index.js";

const log = createLogger({ service: "test", level: "silent" });
const PASSWORD = "correct horse battery staple";
const OPERATOR = hexToBech32("0a".repeat(20), "qor");
const dir = mkdtempSync(join(tmpdir(), "vigil-console-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Sessions", () => {
  it("creates a session only for the right password and ends it on sign-out", () => {
    const sessions = new Sessions({ password: PASSWORD });
    expect(sessions.signIn("wrong", "c1")).toEqual({ ok: false, reason: "wrong-password" });
    expect(sessions.signIn(undefined, "c1")).toEqual({ ok: false, reason: "wrong-password" });

    const result = sessions.signIn(PASSWORD, "c1");
    if (!result.ok) throw new Error("expected a session");
    expect(result.cookie).toMatch(/HttpOnly; SameSite=Strict/);
    expect(result.cookie).not.toContain("Secure");
    const token = /=([0-9a-f]{64});/.exec(result.cookie)?.[1];

    expect(sessions.isSignedIn(token)).toBe(true);
    expect(sessions.isSignedIn("f".repeat(64))).toBe(false);
    expect(sessions.isSignedIn("not-a-token")).toBe(false);
    expect(sessions.isSignedIn(undefined)).toBe(false);

    expect(sessions.signOut(token)).toContain("Max-Age=0");
    expect(sessions.isSignedIn(token)).toBe(false);
  });

  it("locks a client out after repeated failures, then lets it back in", () => {
    let now = 1_000;
    const sessions = new Sessions({
      password: PASSWORD,
      maxAttempts: 3,
      lockSecs: 60,
      now: () => now,
    });
    for (let i = 0; i < 3; i++) sessions.signIn("guess", "attacker");
    expect(sessions.signIn(PASSWORD, "attacker")).toEqual({ ok: false, reason: "locked" });
    expect(sessions.signIn(PASSWORD, "someone-else").ok).toBe(true);
    now += 61;
    expect(sessions.signIn(PASSWORD, "attacker").ok).toBe(true);
  });

  it("expires sessions and marks cookies Secure when asked", () => {
    let now = 1_000;
    const sessions = new Sessions({
      password: PASSWORD,
      ttlSecs: 100,
      secureCookie: true,
      now: () => now,
    });
    const result = sessions.signIn(PASSWORD, "c1");
    if (!result.ok) throw new Error("expected a session");
    expect(result.cookie).toContain("; Secure");
    const token = /=([0-9a-f]{64});/.exec(result.cookie)?.[1];
    now += 101;
    expect(sessions.isSignedIn(token)).toBe(false);
  });
});

async function startConsole() {
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
  });
  const keystorePath = join(dir, `k-${String(Math.random()).slice(2)}.json`);
  const keys = generateSealKeys();
  const published = new Map<string, string>();
  let account: L2Account | undefined;
  const sender = rollup.sender(OPERATOR, store);
  const operator = new Operator({
    chainId: FAKE_CHAIN_ID,
    rollupId: FAKE_ROLLUP_ID,
    store,
    wallet,
    sender: () => Promise.resolve(sender),
    account: () => account,
    createAccount: () => {
      createKeystore(keystorePath, "a long enough passphrase");
      account = openKeystore(keystorePath, "a long enough passphrase");
      return account;
    },
    baseBalance: () => Promise.resolve(50_000_000n),
    kemKey: (address) => Promise.resolve(published.get(address)),
    memoKeys: () => keys,
    publishMemoKey: (from, publicKey) => {
      published.set(from.address, toHex(publicKey));
      return Promise.resolve("KEMTX");
    },
  });
  const api = new Api({ store, rollupId: FAKE_ROLLUP_ID, chainId: FAKE_CHAIN_ID, networks: [] });
  const server = createApiServer({
    api,
    staticDir: dir,
    log,
    routes: createConsoleRoutes({ operator, sessions: new Sessions({ password: PASSWORD }), log }),
    requestsPerMinute: 1_000,
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  let cookie = "";
  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined
          ? {}
          : { "content-type": "application/json", "x-vigil-request": "1" }),
        ...(cookie === "" ? {} : { cookie }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie !== null) cookie = setCookie.split(";")[0] ?? "";
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { rollup, store, call, base, close: () => server.close(), getAccount: () => account };
}

describe("operator console", () => {
  it("refuses everything about the wallet until the operator signs in", async () => {
    const { call, close } = await startConsole();
    try {
      expect((await call("/api/session")).body).toEqual({ console: true, signedIn: false });
      expect((await call("/api/wallet")).status).toBe(401);
      expect((await call("/api/wallet/deposit", { amount: "1" })).status).toBe(401);
      expect((await call("/api/session", { password: "nope" })).status).toBe(401);
      expect((await call("/api/wallet")).status).toBe(401);
      expect((await call("/api/overview")).status).toBe(200);
    } finally {
      close();
    }
  });

  it("rejects requests a cross-site page could forge", async () => {
    const { call, base, close } = await startConsole();
    try {
      await call("/api/session", { password: PASSWORD });
      const noHeader = await fetch(`${base}/api/wallet/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(noHeader.status).toBe(403);
      const form = await fetch(`${base}/api/wallet/claim`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-vigil-request": "1" },
        body: "a=b",
      });
      expect(form.status).toBe(415);
      const huge = await call("/api/wallet/deposit", { amount: "1", pad: "x".repeat(20_000) });
      expect(huge.status).toBe(400);
      expect((await call("/api/wallet/unknown", {})).status).toBe(404);
    } finally {
      close();
    }
  });

  it("runs the whole wallet flow: account, deposit, transfer with memo, withdraw, claim", async () => {
    const { call, rollup, close, getAccount, store } = await startConsole();
    try {
      expect((await call("/api/session", { password: PASSWORD })).status).toBe(200);
      expect((await call("/api/session")).body).toEqual({ console: true, signedIn: true });

      const empty = await call("/api/wallet");
      expect(empty.body).toMatchObject({
        baseAddress: OPERATOR,
        account: null,
        baseBalance: "50000000",
      });
      expect((await call("/api/wallet/deposit", { amount: "1" })).body).toEqual({
        error: "create an L2 account first",
      });

      const created = await call("/api/wallet/account", {});
      expect(created.status).toBe(200);
      expect((await call("/api/wallet/account", {})).status).toBe(400);

      expect((await call("/api/wallet/deposit", { amount: "5" })).status).toBe(200);
      expect((await call("/api/wallet/deposit", { amount: "0.5" })).body).toEqual({
        error: "the smallest deposit is 1 QOR",
      });
      expect((await call("/api/wallet/deposit", { amount: "lots" })).status).toBe(400);

      const other = "ab".repeat(32);
      // A memo to someone without a published key is refused before any transfer is sent.
      const sentBefore = rollup.head;
      const refused = await call("/api/wallet/transfer", {
        to: other,
        amount: "1",
        memo: "hello",
        memoRecipient: OPERATOR,
      });
      expect(refused.body.error).toMatch(/has not published an encryption key/);
      expect(rollup.head).toBe(sentBefore);

      expect((await call("/api/wallet/memo-key", {})).body).toEqual({ hash: "KEMTX" });
      expect((await call("/api/wallet/memo-key", {})).status).toBe(400);

      const sent = await call("/api/wallet/transfer", {
        to: other,
        amount: "1.5",
        memo: "for the invoice",
        memoRecipient: OPERATOR,
      });
      expect(sent.status).toBe(200);
      expect(sent.body.memoHash).not.toBeNull();
      expect(
        (await call("/api/wallet/transfer", { to: other, amount: "0.25" })).body.memoHash,
      ).toBeNull();
      expect((await call("/api/wallet/withdraw", { amount: "1" })).status).toBe(200);
      expect((await call("/api/wallet/withdraw", { amount: "100" })).body.error).toMatch(
        /does not hold/,
      );

      const account = getAccount();
      if (account === undefined) throw new Error("no account");
      expect(rollup.ledgerAt(rollup.head).get(account.accountId).balance).toBe(2_250_000n);

      const pending = await call("/api/wallet");
      expect(pending.body).toMatchObject({
        memoKeyPublished: true,
        account: { balance: "2250000", batchedBalance: "0", nonce: "3" },
        withdrawals: [],
      });
      expect(pending.body.memos).toMatchObject([
        {
          text: "for the invoice",
          transfer: { amount: "1500000", verified: true, paysThisAccount: false },
        },
      ]);

      rollup.submitHonestBatch();
      expect((await call("/api/wallet")).body.withdrawals).toMatchObject([
        { amount: "1000000", claimed: false, claimable: false },
      ]);
      rollup.finalizeAll();
      const claimed = await call("/api/wallet/claim", {});
      expect(claimed.body).toMatchObject({ paid: [{ amount: "1000000" }], failed: [] });
      expect(rollup.payouts).toHaveLength(1);
      expect((await call("/api/wallet")).body.withdrawals).toMatchObject([{ claimed: true }]);
      expect(store.recentTxs(20).length).toBeGreaterThanOrEqual(6);

      expect((await call("/api/session/logout", {})).status).toBe(200);
      expect((await call("/api/wallet")).status).toBe(401);
    } finally {
      close();
    }
  });

  it("reports a chain rejection without leaking internals, and never exposes the session cookie name in bodies", async () => {
    const { call, rollup, close } = await startConsole();
    try {
      await call("/api/session", { password: PASSWORD });
      await call("/api/wallet/account", {});
      rollup.failNextWith = 5;
      const failed = await call("/api/wallet/deposit", { amount: "2" });
      expect(failed.status).toBe(502);
      expect(String(failed.body.error)).toContain("deposit");
      expect(JSON.stringify(failed.body)).not.toContain(SESSION_COOKIE);
    } finally {
      close();
    }
  });
});

describe("read-only server", () => {
  it("has no console and refuses writes", async () => {
    const store = Store.open(":memory:");
    const api = new Api({ store, rollupId: "r", chainId: "c", networks: [] });
    const server = createApiServer({ api, staticDir: dir, log }).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    try {
      expect(await (await fetch(`${base}/api/session`)).json()).toEqual({
        console: false,
        signedIn: false,
      });
      const write = await fetch(`${base}/api/wallet/deposit`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-vigil-request": "1" },
        body: "{}",
      });
      expect(write.status).toBe(405);
      expect((await fetch(`${base}/api/wallet`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
