import { createHash } from "node:crypto";
import { QLEDGER_MAX_POST_BYTES, decodeQledgerTx } from "@qorechain/rdk";
import {
  ML_KEM_1024_PUBLIC_KEY_LENGTH,
  deriveSealKeys,
  isQoreSealError,
  open,
  seal,
  type SealKeyPair,
} from "@qorechain/qoreseal";
import { VigilError, bytesEqual, toHex, type Store } from "@vigil/core";

/** Marks an inbox payload as a Vigil memo. The ledger treats such a payload as a no-op. */
const MAGIC = new TextEncoder().encode("VGLM");
const VERSION = 1;
const HEADER_LENGTH = MAGIC.length + 1 + 32;
/** Longest memo text, in UTF-8 bytes. Keeps the payload well inside the inbox limit. */
export const MAX_MEMO_BYTES = 2_000;

/** A memo cannot be built, for example because the text is too long or a key is malformed. */
export class MemoError extends VigilError {
  constructor(message: string) {
    super("CONFIG_INVALID", message);
  }
}

/** The recipient's ML-KEM-1024 key pair, derived from their seed phrase. */
export function memoKeys(mnemonic: string): SealKeyPair {
  return deriveSealKeys({ mnemonic });
}

/** SHA-256 of an encoded L2 transaction: what a memo is bound to. */
export function transferHash(encodedTransaction: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(encodedTransaction).digest());
}

const purpose = (rollupId: string): string => `vigil-memo/${rollupId}`;

export interface SealMemoInput {
  chainId: string;
  rollupId: string;
  /** The recipient's ML-KEM-1024 encapsulation key, as registered on the base chain. */
  recipientKey: Uint8Array;
  /** Hash of the L2 transfer this memo belongs to; see `transferHash`. */
  boundTo: Uint8Array;
  text: string;
}

/**
 * Encrypts a memo to one recipient with ML-KEM-1024 and returns the bytes to
 * post to the rollup inbox. The transfer hash is authenticated with the
 * ciphertext, so a memo cannot be re-attached to a different transfer, and
 * the chain id and rollup id are part of the key derivation, so it cannot be
 * replayed on another network or rollup.
 *
 * Only the text is hidden. Who posted the memo, when, its length and the
 * transfer it points to are public.
 */
export function sealMemo(input: SealMemoInput): Uint8Array {
  const plaintext = new TextEncoder().encode(input.text);
  if (plaintext.length === 0) throw new MemoError("the memo is empty");
  if (plaintext.length > MAX_MEMO_BYTES) {
    throw new MemoError(`the memo is longer than ${String(MAX_MEMO_BYTES)} bytes`);
  }
  if (input.recipientKey.length !== ML_KEM_1024_PUBLIC_KEY_LENGTH) {
    throw new MemoError("the recipient's key is not an ML-KEM-1024 key");
  }
  if (input.boundTo.length !== 32) throw new MemoError("a memo binds to a 32-byte transfer hash");

  const envelope = seal({
    chainId: input.chainId,
    purpose: purpose(input.rollupId),
    recipients: [{ mlkemPublicKey: input.recipientKey }],
    plaintext,
    aad: input.boundTo,
    mode: "mlkem",
  });
  const payload = new Uint8Array(HEADER_LENGTH + envelope.length);
  payload.set(MAGIC, 0);
  payload[MAGIC.length] = VERSION;
  payload.set(input.boundTo, MAGIC.length + 1);
  payload.set(envelope, HEADER_LENGTH);
  if (payload.length > QLEDGER_MAX_POST_BYTES) {
    throw new MemoError("the sealed memo is larger than the inbox accepts");
  }
  return payload;
}

/** Splits a memo payload into its parts, or returns `undefined` if it is not a memo. */
export function parseMemo(
  payload: Uint8Array,
): { boundTo: Uint8Array; envelope: Uint8Array } | undefined {
  if (payload.length <= HEADER_LENGTH) return undefined;
  if (!bytesEqual(payload.subarray(0, MAGIC.length), MAGIC)) return undefined;
  if (payload[MAGIC.length] !== VERSION) return undefined;
  return {
    boundTo: payload.slice(MAGIC.length + 1, HEADER_LENGTH),
    envelope: payload.slice(HEADER_LENGTH),
  };
}

/**
 * Decrypts a memo with the recipient's keys. Returns `undefined` when the
 * payload is not a memo or was sealed for someone else; a wrong key and a
 * tampered memo look the same and are both refused.
 */
export function openMemo(input: {
  chainId: string;
  rollupId: string;
  keys: SealKeyPair;
  payload: Uint8Array;
}): { boundTo: Uint8Array; text: string } | undefined {
  const memo = parseMemo(input.payload);
  if (memo === undefined) return undefined;
  try {
    const plaintext = open({
      chainId: input.chainId,
      purpose: purpose(input.rollupId),
      envelope: memo.envelope,
      keys: input.keys,
      aad: memo.boundTo,
    });
    return {
      boundTo: memo.boundTo,
      text: new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
    };
  } catch (error) {
    if (isQoreSealError(error) || error instanceof TypeError) return undefined;
    throw error;
  }
}

/** A memo the recipient could read, with the transfer it belongs to. */
export interface ReceivedMemo {
  sequence: number;
  height: number;
  poster: string;
  text: string;
  /** The L2 transfer the memo is bound to, if it is in the inbox. */
  transfer: { sequence: number; amount: bigint; to: string | undefined } | undefined;
}

/**
 * Reads every memo addressed to `keys` from the local, verified inbox archive.
 * A memo whose transfer cannot be found is still returned, marked as unbound,
 * so a recipient is never misled about which payment a note refers to.
 */
export function readMemos(input: {
  chainId: string;
  rollupId: string;
  store: Store;
  keys: SealKeyPair;
  inboxHead: number;
}): ReceivedMemo[] {
  const entries = input.store.inboxRange(input.rollupId, 0, input.inboxHead);
  const byHash = new Map<string, { sequence: number; payload: Uint8Array }>();
  for (const entry of entries) {
    if (parseMemo(entry.payload) === undefined) {
      byHash.set(toHex(transferHash(entry.payload)), entry);
    }
  }

  const memos: ReceivedMemo[] = [];
  for (const entry of entries) {
    const opened = openMemo({ ...input, payload: entry.payload });
    if (opened === undefined) continue;
    const bound = byHash.get(toHex(opened.boundTo));
    const decoded = bound === undefined ? undefined : decodeQledgerTx(bound.payload);
    memos.push({
      sequence: entry.sequence,
      height: entry.height,
      poster: entry.poster,
      text: opened.text,
      transfer:
        bound === undefined || decoded === undefined
          ? undefined
          : {
              sequence: bound.sequence,
              amount: decoded.amount,
              to: decoded.to === undefined ? undefined : toHex(decoded.to),
            },
    });
  }
  return memos;
}
