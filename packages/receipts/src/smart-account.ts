import type { EncodeObject } from "@cosmjs/proto-signing";
import {
  assertAuthenticatorExecutionsSucceeded,
  buildMetaMaskExecuteEvm,
  fetchAuthNonce,
  fetchAuthenticators,
  fetchSpendingRules,
  linkAuthenticatorMsgs,
  resolveEvmAuthDigestVersion,
  revokeAuthenticatorMsg,
  signAuthenticatorLinkEip191,
  type BroadcastResult,
  type Eip1193Provider,
  type SpendingRuleInput,
} from "@qorechain/sdk";
import { getAbiItem, hexToBytes, toFunctionSelector, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { IntegrityError } from "@vigil/core";
import { vigilReceiptsAbi } from "./abi.js";

/**
 * A receipts key locked down by a QoreChain smart account (`x/abstractaccount`).
 *
 * The deployer account owns the smart account. A separate hot secp256k1 key is
 * linked to it with permission `evm` and an expiry, and one spending rule pins
 * that key to two functions of one contract: `recordAnchor` and
 * `recordAttestation` on VigilReceipts, with no value. The hot key signs each
 * call; the deployer relays it as `MsgExecuteEVM` and pays the fee. A record
 * call through this lane needs no EVM window, and a leaked hot key can do
 * nothing but record receipts until it expires or is revoked.
 */

/** Selectors the hot key may call, computed from the contract's ABI. */
export const RECEIPT_SELECTORS: readonly Hex[] = [
  toFunctionSelector(getAbiItem({ abi: vigilReceiptsAbi, name: "recordAnchor" })),
  toFunctionSelector(getAbiItem({ abi: vigilReceiptsAbi, name: "recordAttestation" })),
];

/** Label the hot key is linked under. */
export const HOT_KEY_LABEL = "vigil-receipts";

/** The one spending rule of the account: zero value, two pinned functions. */
export function receiptsRule(contract: Hex): SpendingRuleInput {
  return {
    id: "receipts",
    enabled: true,
    perTxLimit: "1",
    dailyLimit: "1",
    allowedDenoms: ["uqor"],
    allowedEvmCalls: allowedCalls(contract),
  };
}

function allowedCalls(contract: Hex): string[] {
  return RECEIPT_SELECTORS.map((selector) => `${contract.toLowerCase()}/${selector}`);
}

/** The owner-signed messages that create the account, set the rule and link the hot key. */
export function buildLinkMsgs(input: {
  chainId: string;
  owner: string;
  hotKey: Hex;
  contract: Hex;
  expiryUnix: bigint;
}): EncodeObject[] {
  const proof = signAuthenticatorLinkEip191({
    chainId: input.chainId,
    account: input.owner,
    privateKey: hexToBytes(input.hotKey),
  });
  return linkAuthenticatorMsgs({
    owner: input.owner,
    chainId: input.chainId,
    scheme: proof.scheme,
    pubkey: proof.pubkey,
    possessionProof: proof.possessionProof,
    permissions: ["evm"],
    expiryUnix: input.expiryUnix,
    label: HOT_KEY_LABEL,
    spendingRule: receiptsRule(input.contract),
  });
}

/** The owner-signed message that disables the hot key at once. */
export function buildRevokeMsg(input: { owner: string; hotAddress: Hex }): EncodeObject {
  return revokeAuthenticatorMsg({
    owner: input.owner,
    scheme: "secp256k1",
    pubkey: hexToBytes(input.hotAddress),
  });
}

/**
 * An EIP-1193 provider backed by a local key, so the SDK's own MetaMask builder
 * forms the digest and the `personal_sign` call. It signs for one address only.
 */
export function localProvider(hotKey: Hex): Eip1193Provider {
  const account = privateKeyToAccount(hotKey);
  return {
    async request({ method, params }) {
      const [message, address] = params;
      if (
        method !== "personal_sign" ||
        typeof message !== "string" ||
        !/^0x[0-9a-fA-F]*$/.test(message) ||
        typeof address !== "string" ||
        address.toLowerCase() !== account.address.toLowerCase()
      ) {
        throw new IntegrityError("the local signer only signs personal_sign for its own address");
      }
      return account.signMessage({ message: { raw: message as Hex } });
    },
  };
}

type FetchLike = typeof globalThis.fetch;

/** Broadcasts owner or relayer messages and returns the delivered result. */
export interface Relayer {
  /** The `qor1…` address that signs and pays. */
  address: string;
  broadcast(messages: readonly EncodeObject[], gas: bigint): Promise<BroadcastResult>;
}

export interface SmartAccount {
  rest: string;
  chainId: string;
  /** The smart account's `qor1…` address (the deployer, which owns it). */
  account: string;
  hotKey: Hex;
  relayer: Relayer;
  fetch?: FetchLike;
}

export interface Readiness {
  ready: boolean;
  reason?: string;
}

/**
 * Whether the hot key can record receipts right now: linked, not revoked, not
 * about to expire, allowed `evm`, and the account's first enabled rule allows
 * both record functions on `contract`. Any read failure counts as not ready.
 */
export async function smartAccountReady(
  smart: SmartAccount,
  contract: Hex,
  nowUnix: bigint,
): Promise<Readiness> {
  const hot = privateKeyToAccount(smart.hotKey).address.toLowerCase();
  const read = { rest: smart.rest, address: smart.account, ...fetchOption(smart) };
  try {
    const [nonce, keys, rules] = await Promise.all([
      fetchAuthNonce({ ...read, pubkey: hot }),
      fetchAuthenticators(read),
      fetchSpendingRules(read),
    ]);
    if (!nonce.linked) return { ready: false, reason: "hot key not linked" };
    const key = keys.find(
      (k) =>
        k.scheme === "secp256k1" && `0x${k.pubkeyHex.replace(/^0x/i, "")}`.toLowerCase() === hot,
    );
    if (key === undefined) return { ready: false, reason: "hot key not linked" };
    if (key.revoked) return { ready: false, reason: "hot key revoked" };
    if (key.expiryUnix <= nowUnix + 300n) return { ready: false, reason: "hot key expired" };
    if (!key.permissions.includes("evm")) return { ready: false, reason: "hot key lacks evm" };
    const rule = rules.rules.find((r) => r.enabled);
    const calls = new Set(rule?.allowedEvmCalls.map((c) => c.toLowerCase()) ?? []);
    if (!allowedCalls(contract).every((c) => calls.has(c))) {
      return { ready: false, reason: "spending rule does not allow the record calls" };
    }
    return { ready: true };
  } catch (error) {
    return { ready: false, reason: `smart account unreadable: ${(error as Error).message}` };
  }
}

/** Gas the relayer's transaction provisions on top of the EVM call's own limit. */
export const RELAY_OVERHEAD_GAS = 600_000n;

/**
 * Has the hot key sign one call and the relayer send it as `MsgExecuteEVM`.
 * Resolves with the transaction hash. A failed execution inside a code-0
 * transaction throws `AuthenticatorExecutionError` and has used up the nonce.
 */
export async function executeRecord(
  smart: SmartAccount,
  call: { to: Hex; data: Hex; gasLimit: bigint },
): Promise<string> {
  const hot = privateKeyToAccount(smart.hotKey).address;
  const options = fetchOption(smart);
  const nonce = await fetchAuthNonce({
    rest: smart.rest,
    address: smart.account,
    pubkey: hot,
    ...options,
  });
  if (!nonce.linked) throw new IntegrityError("the hot key is not linked to the smart account");
  const message = await buildMetaMaskExecuteEvm({
    provider: localProvider(smart.hotKey),
    address: hot,
    relayer: smart.relayer.address,
    chainId: smart.chainId,
    account: smart.account,
    to: call.to,
    value: "0",
    data: hexToBytes(call.data),
    gasLimit: call.gasLimit,
    nonce: nonce.nonce,
    digestVersion: await resolveEvmAuthDigestVersion({ rest: smart.rest, ...options }),
  });
  const result = await smart.relayer.broadcast([message], call.gasLimit + RELAY_OVERHEAD_GAS);
  if (result.code !== 0) {
    throw new IntegrityError("the relayed record transaction was rejected", {
      hash: result.transactionHash,
      code: result.code,
    });
  }
  const executions = assertAuthenticatorExecutionsSucceeded(result, [message]);
  // The SDK check passes vacuously without responses: require the one success we sent.
  if (executions.length !== 1 || executions[0]?.lane !== "evm" || !executions[0].success) {
    throw new IntegrityError("the relayed record call's outcome could not be confirmed", {
      hash: result.transactionHash,
    });
  }
  return result.transactionHash;
}

function fetchOption(smart: { fetch?: FetchLike }): { fetch?: FetchLike } {
  return smart.fetch === undefined ? {} : { fetch: smart.fetch };
}
