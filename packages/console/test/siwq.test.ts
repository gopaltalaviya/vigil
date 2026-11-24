import {
  addressFromPublicKey,
  deriveCanonicalPqKey,
  deriveClassicalKey,
  signMessage,
  signSiwq,
} from "@qorechain/qoresign";
import { describe, expect, it } from "vitest";
import { createLogger } from "@vigil/core";
import { signLogin } from "@vigil/wallet";
import { Sessions, SiwqSignIn, createConsoleRoutes, type Operator } from "../src/index.js";

// BIP-39's public test mnemonic: throwaway keys, never registered anywhere.
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const classicalKey = deriveClassicalKey({ mnemonic: MNEMONIC });
const ADDRESS = addressFromPublicKey(classicalKey.publicKey, classicalKey.type).bech32;
const pqKey = deriveCanonicalPqKey({ mnemonic: MNEMONIC, address: ADDRESS });
const CHAIN = "qorechain-diana";

function gate(
  options: { possessionProven?: boolean; registered?: boolean; clock?: { now: number } } = {},
) {
  const clock = options.clock ?? { now: 1_795_500_000 };
  return new SiwqSignIn({
    domain: "127.0.0.1:8090",
    uri: "http://127.0.0.1:8090/",
    chainId: CHAIN,
    rest: "http://unused",
    allowed: () => Promise.resolve([ADDRESS]),
    now: () => clock.now,
    registeredKey: () =>
      Promise.resolve(
        options.registered === false
          ? {}
          : { publicKey: pqKey.publicKey, possessionProven: options.possessionProven ?? true },
      ),
  });
}

describe("Sign In With QoreChain", () => {
  it("accepts the operator's hybrid SIWQ signature once", async () => {
    const siwq = gate();
    const { message } = await siwq.challenge(ADDRESS);
    expect(message).toContain("Sign in to the Vigil Watchtower operator console.");
    const signed = signLogin({ message, mnemonic: MNEMONIC });
    expect(await siwq.verify(signed)).toEqual({ ok: true, address: ADDRESS, format: "siwq" });
    expect(await siwq.verify(signed)).toMatchObject({ ok: false, reason: /unknown or expired/ });
  });

  it("accepts QoreX's message-signing v1 form over the same text", async () => {
    const siwq = gate();
    const { message } = await siwq.challenge(ADDRESS);
    const signature = signMessage({
      chainId: CHAIN,
      signer: ADDRESS,
      data: message,
      classicalKey,
      pqKey,
    });
    expect(await siwq.verify({ message, signature })).toEqual({
      ok: true,
      address: ADDRESS,
      format: "message-v1",
    });
  });

  it("refuses classical-only, tampered, expired and foreign sign-ins", async () => {
    const clock = { now: 1_795_500_000 };
    const siwq = gate({ clock });
    const classicalOnly = await siwq.challenge(ADDRESS);
    expect(
      await siwq.verify({
        message: classicalOnly.message,
        signature: signSiwq({ message: classicalOnly.message, classicalKey }),
      }),
    ).toMatchObject({ ok: false, reason: /ML-DSA-87 signature is required/ });

    const tampered = await siwq.challenge(ADDRESS);
    const signed = signLogin({ message: tampered.message, mnemonic: MNEMONIC });
    const edited = signed.message.replace("operator console", "operator consolE");
    expect(await siwq.verify({ ...signed, message: edited })).toMatchObject({ ok: false });

    const late = await siwq.challenge(ADDRESS);
    clock.now += 301;
    expect(
      await siwq.verify(signLogin({ message: late.message, mnemonic: MNEMONIC })),
    ).toMatchObject({ ok: false, reason: /expired/ });

    await expect(siwq.challenge("qor1hnfd8kf8kjegp8eyjm3shklydy443z7yw6fmuk")).rejects.toThrow(
      /may not sign in/,
    );
    await expect(siwq.challenge("not an address")).rejects.toThrow(/not a valid address/);
    expect(await siwq.verify({ message: "hello" })).toMatchObject({ ok: false });
    expect(await siwq.verify({ message: "hello", signature: signed.signature })).toMatchObject({
      ok: false,
      reason: /not a sign-in message/,
    });
  });

  it("refuses an account without a registered key or without proof of possession", async () => {
    for (const [options, reason] of [
      [{ registered: false }, /no registered ML-DSA-87 key/],
      [{ possessionProven: false }, /proof of possession/],
    ] as const) {
      const siwq = gate(options);
      const { message } = await siwq.challenge(ADDRESS);
      expect(await siwq.verify(signLogin({ message, mnemonic: MNEMONIC }))).toMatchObject({
        ok: false,
        reason,
      });
    }
  });

  it("signLogin refuses a message for another account", async () => {
    const other = new SiwqSignIn({
      domain: "d",
      uri: "http://d/",
      chainId: CHAIN,
      rest: "http://unused",
      allowed: () => Promise.resolve(["qor1hnfd8kf8kjegp8eyjm3shklydy443z7yw6fmuk"]),
    });
    const { message } = await other.challenge("qor1hnfd8kf8kjegp8eyjm3shklydy443z7yw6fmuk");
    expect(() => signLogin({ message, mnemonic: MNEMONIC })).toThrow(/not for this account/);
    expect(() => signLogin({ message: "hi", mnemonic: MNEMONIC })).toThrow(/not a sign-in/);
  });

  it("signs in over the console routes and counts failures towards the lock-out", async () => {
    const siwq = gate();
    const sessions = new Sessions({ password: "a long enough password", maxAttempts: 2 });
    const routes = createConsoleRoutes({
      operator: {} as Operator,
      sessions,
      siwq,
      log: createLogger({ service: "test", level: "silent" }),
    });
    const post = (path: string, body: unknown, client = "c1") =>
      routes({ method: "POST", path, body, cookies: {}, client });
    const session = await routes({
      method: "GET",
      path: "/api/session",
      body: undefined,
      cookies: {},
      client: "c1",
    });
    expect(JSON.parse(session?.body ?? "{}")).toMatchObject({ siwq: true, signedIn: false });

    const challenge = await post("/api/siwq/challenge", { address: ADDRESS });
    const { message } = JSON.parse(challenge?.body ?? "{}") as { message: string };
    const ok = await post("/api/siwq/verify", signLogin({ message, mnemonic: MNEMONIC }));
    expect(ok?.status).toBe(200);
    expect(ok?.headers?.["set-cookie"]).toMatch(/vigil_session=[0-9a-f]{64}/);

    expect((await post("/api/siwq/challenge", { address: "nope" }))?.status).toBe(400);
    expect((await post("/api/siwq/verify", {}, "c2"))?.status).toBe(401);
    expect((await post("/api/siwq/verify", {}, "c2"))?.status).toBe(401);
    expect((await post("/api/siwq/verify", {}, "c2"))?.status).toBe(429);
    expect((await post("/api/siwq/challenge", { address: ADDRESS }, "c2"))?.status).toBe(429);
  });
});
