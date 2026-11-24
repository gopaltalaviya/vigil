import {
  AuthenticatorExecutionError,
  evmAuthSignBytesV2,
  qorechainTypes,
  verifyAuthenticatorLinkProof,
  type BroadcastResult,
} from "@qorechain/sdk";
import type { EncodeObject } from "@cosmjs/proto-signing";
import { bytesToHex, hexToBytes, recoverMessageAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  RECEIPT_SELECTORS,
  RELAY_OVERHEAD_GAS,
  buildLinkMsgs,
  buildRevokeMsg,
  executeRecord,
  localProvider,
  receiptsRule,
  smartAccountReady,
  type Relayer,
  type SmartAccount,
} from "../src/smart-account.js";

const CHAIN = "qorechain-diana";
const OWNER = "qor1x2jpzzxspw9yl59uwgxyjtxnx8clehnwt2yt0c";
const CONTRACT: Hex = "0xced683ad4319a34873e2c1aa90d18e2fcf1af1d1";
const HOT_KEY: Hex = `0x${"42".repeat(32)}`;
const HOT = privateKeyToAccount(HOT_KEY).address.toLowerCase();
const REST = "https://rest.test";
const NOW = 1_800_000_000n;

const EXECUTE_EVM_RESPONSE = "/qorechain.abstractaccount.v1.MsgExecuteEVMResponse";

function response(success: boolean): { typeUrl: string; value: Uint8Array } {
  const msg = qorechainTypes.abstractaccount.MsgExecuteEVMResponse;
  return {
    typeUrl: EXECUTE_EVM_RESPONSE,
    value: msg
      .encode(msg.fromPartial({ success, gasUsed: "90000", vmError: success ? "" : "reverted" }))
      .finish(),
  };
}

interface Chain {
  nonce?: { nonce: string; linked: boolean };
  authenticators?: unknown[];
  rules?: unknown[];
  fail?: boolean;
}

function fakeFetch(chain: Chain): typeof fetch {
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));
  return ((url: string) => {
    if (chain.fail === true) return json({ code: 5, message: "not found" }, 404);
    if (url.includes("/applied_plan/")) return json({ height: "100" });
    if (url.includes("/auth_nonce/")) return json(chain.nonce ?? { nonce: "0", linked: false });
    if (url.endsWith("/authenticators"))
      return json({ authenticators: chain.authenticators ?? [] });
    if (url.endsWith("/spending_rules")) return json({ rules: chain.rules ?? [] });
    return json({}, 404);
  }) as typeof fetch;
}

const linkedKey = (overrides: Record<string, unknown> = {}) => ({
  scheme: "secp256k1",
  pubkey_hex: HOT.slice(2),
  permissions: ["evm"],
  expiry_unix: String(NOW + 86_400n),
  label: "vigil-receipts",
  created_at_unix: String(NOW - 10n),
  revoked: false,
  ...overrides,
});
const rule = (calls: string[]) => ({
  id: "receipts",
  daily_limit: "1",
  per_tx_limit: "1",
  allowed_denoms: ["uqor"],
  enabled: true,
  allowed_evm_calls: calls,
  denom_limits: [],
});
const fullRule = rule(RECEIPT_SELECTORS.map((s) => `${CONTRACT}/${s}`));

function relayer(
  result: Partial<BroadcastResult>,
): Relayer & { sent: { messages: readonly EncodeObject[]; gas: bigint }[] } {
  const sent: { messages: readonly EncodeObject[]; gas: bigint }[] = [];
  return {
    address: OWNER,
    sent,
    broadcast(messages, gas) {
      sent.push({ messages, gas });
      return Promise.resolve({
        transactionHash: "ABCD",
        code: 0,
        events: [],
        msgResponses: [],
        ...result,
      });
    },
  };
}

const smart = (chain: Chain, r: Relayer = relayer({})): SmartAccount => ({
  rest: REST,
  chainId: CHAIN,
  account: OWNER,
  hotKey: HOT_KEY,
  relayer: r,
  fetch: fakeFetch(chain),
});

describe("receipts rule", () => {
  it("pins exactly recordAnchor and recordAttestation on the contract, with no value", () => {
    expect(RECEIPT_SELECTORS).toEqual(["0x6bc29f02", "0xfdccffe8"]);
    expect(receiptsRule(CONTRACT)).toEqual({
      id: "receipts",
      enabled: true,
      perTxLimit: "1",
      dailyLimit: "1",
      allowedDenoms: ["uqor"],
      allowedEvmCalls: [`${CONTRACT}/0x6bc29f02`, `${CONTRACT}/0xfdccffe8`],
    });
  });
});

describe("buildLinkMsgs", () => {
  it("sets the rule, then links the hot key by address with a proof the chain accepts", () => {
    const msgs = buildLinkMsgs({
      chainId: CHAIN,
      owner: OWNER,
      hotKey: HOT_KEY,
      contract: CONTRACT,
      expiryUnix: NOW,
    });
    expect(msgs.map((m) => m.typeUrl)).toEqual([
      "/qorechain.abstractaccount.v1.MsgUpdateSpendingRules",
      "/qorechain.abstractaccount.v1.MsgRegisterAuthenticator",
    ]);
    const register = msgs[1]?.value as {
      scheme: string;
      pubkey: Uint8Array;
      possessionProof: Uint8Array;
      permissions: string[];
    };
    expect(register.scheme).toBe("secp256k1");
    expect(bytesToHex(register.pubkey)).toBe(HOT);
    expect(register.permissions).toEqual(["evm"]);
    expect(
      verifyAuthenticatorLinkProof({
        chainId: CHAIN,
        account: OWNER,
        scheme: "secp256k1",
        pubkey: register.pubkey,
        possessionProof: register.possessionProof,
      }),
    ).toBe(true);
  });

  it("revokes the same key", () => {
    const msg = buildRevokeMsg({ owner: OWNER, hotAddress: HOT as Hex });
    expect(msg.typeUrl).toBe("/qorechain.abstractaccount.v1.MsgRevokeAuthenticator");
    expect(bytesToHex((msg.value as { pubkey: Uint8Array }).pubkey)).toBe(HOT);
  });
});

describe("localProvider", () => {
  it("signs personal_sign for its own address only", async () => {
    const provider = localProvider(HOT_KEY);
    const message: Hex = `0x${"ab".repeat(32)}`;
    const signature = (await provider.request({
      method: "personal_sign",
      params: [message, HOT],
    })) as Hex;
    expect(
      (await recoverMessageAddress({ message: { raw: message }, signature })).toLowerCase(),
    ).toBe(HOT);
    await expect(
      provider.request({ method: "personal_sign", params: [message, `0x${"00".repeat(20)}`] }),
    ).rejects.toThrow(/own address/);
    await expect(
      provider.request({ method: "eth_sign", params: [HOT, message] }),
    ).rejects.toThrow();
  });
});

describe("smartAccountReady", () => {
  const ready = (chain: Chain) => smartAccountReady(smart(chain), CONTRACT, NOW);

  it("is ready when the key is linked, live, allowed evm and the rule allows both calls", async () => {
    await expect(
      ready({
        nonce: { nonce: "3", linked: true },
        authenticators: [linkedKey()],
        rules: [fullRule],
      }),
    ).resolves.toEqual({ ready: true });
  });

  it("is not ready for an unlinked, revoked, expiring or narrowed key, or an unreadable account", async () => {
    const base = {
      nonce: { nonce: "0", linked: true },
      authenticators: [linkedKey()],
      rules: [fullRule],
    };
    expect((await ready({ ...base, nonce: { nonce: "0", linked: false } })).reason).toMatch(
      /not linked/,
    );
    expect(
      (await ready({ ...base, authenticators: [linkedKey({ revoked: true })] })).reason,
    ).toMatch(/revoked/);
    expect(
      (await ready({ ...base, authenticators: [linkedKey({ expiry_unix: String(NOW + 60n) })] }))
        .reason,
    ).toMatch(/expired/);
    expect(
      (await ready({ ...base, authenticators: [linkedKey({ permissions: ["send"] })] })).reason,
    ).toMatch(/evm/);
    expect((await ready({ ...base, rules: [rule([`${CONTRACT}/0x6bc29f02`])] })).reason).toMatch(
      /rule/,
    );
    expect((await ready({ fail: true })).ready).toBe(false);
  });
});

describe("executeRecord", () => {
  const call = { to: CONTRACT, data: "0x6bc29f02aa" as Hex, gasLimit: 1_500_000n };
  const linked = { nonce: { nonce: "7", linked: true } };

  it("signs the v2 digest with the hot key at the fetched nonce and relays it", async () => {
    const r = relayer({ msgResponses: [response(true)] });
    await expect(executeRecord(smart(linked, r), call)).resolves.toBe("ABCD");
    const [sent] = r.sent;
    expect(sent?.gas).toBe(call.gasLimit + RELAY_OVERHEAD_GAS);
    const msg = sent?.messages[0];
    expect(msg?.typeUrl).toBe("/qorechain.abstractaccount.v1.MsgExecuteEVM");
    const value = msg?.value as {
      nonce: bigint;
      signature: Uint8Array;
      relayer: string;
      account: string;
    };
    expect(value.nonce).toBe(7n);
    expect(value.relayer).toBe(OWNER);
    expect(value.account).toBe(OWNER);
    const digest = evmAuthSignBytesV2({
      chainId: CHAIN,
      account: OWNER,
      pubkey: hexToBytes(HOT as Hex),
      to: CONTRACT,
      value: "0",
      data: hexToBytes(call.data),
      nonce: 7n,
      gasLimit: call.gasLimit,
    });
    const signer = await recoverMessageAddress({
      message: { raw: digest },
      signature: bytesToHex(value.signature),
    });
    expect(signer.toLowerCase()).toBe(HOT);
  });

  it("sends nothing when the key is not linked", async () => {
    const r = relayer({});
    await expect(
      executeRecord(smart({ nonce: { nonce: "0", linked: false } }, r), call),
    ).rejects.toThrow(/not linked/);
    expect(r.sent).toHaveLength(0);
  });

  it("treats a failed execution in a code-0 transaction as a failure", async () => {
    const r = relayer({ msgResponses: [response(false)] });
    await expect(executeRecord(smart(linked, r), call)).rejects.toBeInstanceOf(
      AuthenticatorExecutionError,
    );
  });

  it("refuses to count a transaction without the execution's outcome as success", async () => {
    await expect(executeRecord(smart(linked, relayer({ msgResponses: [] })), call)).rejects.toThrow(
      /could not be confirmed/,
    );
  });

  it("reports a rejected transaction", async () => {
    await expect(executeRecord(smart(linked, relayer({ code: 11 })), call)).rejects.toThrow(
      /rejected/,
    );
  });
});
