import { randomBytes } from "node:crypto";
import {
  createSiwqMessage,
  isQoreSignError,
  parseSiwqMessage,
  verifyMessage,
  verifySiwq,
  type SiwqSignature,
} from "@qorechain/qoresign";
import { fetchPqKeyStatus } from "@qorechain/qoresign/network";
import { validateAddress } from "@vigil/core";

/** An account's ML-DSA-87 key as registered on QoreChain. */
export interface RegisteredKey {
  publicKey?: Uint8Array;
  possessionProven?: boolean;
}

export interface SiwqOptions {
  /** The host the browser sees, for example `127.0.0.1:8090`. Part of every message. */
  domain: string;
  /** Page the operator signs in to. */
  uri: string;
  chainId: string;
  /** REST endpoint used to read registered keys. */
  rest: string;
  /** `qor1` accounts allowed to sign in. */
  allowed: () => Promise<readonly string[]>;
  /** Seconds a challenge stays valid. */
  ttlSecs?: number;
  /** Reads an account's registered key; defaults to the chain's PQC registry. */
  registeredKey?: (address: string) => Promise<RegisteredKey>;
  /** Unix seconds. */
  now?: () => number;
}

export type SiwqResult =
  { ok: true; address: string; format: "siwq" | "message-v1" } | { ok: false; reason: string };

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const MAX_OPEN = 100;

/**
 * Sign In With QoreChain for the operator console. The server issues a
 * single-use challenge; the operator signs it with the account's keys, from the
 * `vigil login` command or from the QoreX wallet, and the server checks both
 * halves: the secp256k1 signature, and the ML-DSA-87 signature against the key
 * the account registered on chain with a proof of possession. A classical-only
 * signature is refused.
 *
 * Two signed forms are accepted, because QoreX signs arbitrary data with
 * QoreSign message signing v1 rather than the SIWQ domain: the fields, nonce,
 * domain, times and classical part are checked as SIWQ either way.
 */
export class SiwqSignIn {
  private readonly options: SiwqOptions;
  private readonly now: () => number;
  private readonly ttlSecs: number;
  private readonly open = new Map<string, { address: string; expiresAt: number }>();

  constructor(options: SiwqOptions) {
    this.options = options;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000));
    this.ttlSecs = options.ttlSecs ?? 300;
  }

  /** A sign-in message for `address` to sign, with a fresh single-use nonce. */
  async challenge(input: unknown): Promise<{ message: string; expiresAt: number }> {
    const address = await this.allowedAddress(input);
    this.prune();
    if (this.open.size >= MAX_OPEN) throw new SiwqError("too many open sign-ins; try again later");
    const bytes = randomBytes(24);
    const nonce = Array.from(bytes, (b) => ALPHANUMERIC[b % ALPHANUMERIC.length]).join("");
    const issuedAt = this.now();
    const expiresAt = issuedAt + this.ttlSecs;
    this.open.set(nonce, { address, expiresAt });
    const message = createSiwqMessage({
      domain: this.options.domain,
      address,
      statement: "Sign in to the Vigil Watchtower operator console.",
      uri: this.options.uri,
      version: "1",
      chainId: this.options.chainId,
      nonce,
      issuedAt: new Date(issuedAt * 1_000).toISOString(),
      expirationTime: new Date(expiresAt * 1_000).toISOString(),
    });
    return { message, expiresAt };
  }

  /** Checks a signed challenge. The nonce is used up whatever the outcome. */
  async verify(body: unknown): Promise<SiwqResult> {
    const { message, signature } = (body ?? {}) as { message?: unknown; signature?: unknown };
    if (typeof message !== "string" || message.length > 4_000 || !isSignature(signature)) {
      return { ok: false, reason: "send the signed message and its signature" };
    }
    let fields;
    try {
      fields = parseSiwqMessage(message);
    } catch {
      return { ok: false, reason: "not a sign-in message" };
    }
    const issued = this.open.get(fields.nonce);
    this.open.delete(fields.nonce);
    if (issued === undefined || issued.expiresAt <= this.now()) {
      return { ok: false, reason: "unknown or expired sign-in; start again" };
    }
    if (fields.address !== issued.address) {
      return { ok: false, reason: "the message is for another account" };
    }
    if (signature.signatureType !== "ml-dsa-87-hybrid" || signature.pq === undefined) {
      return { ok: false, reason: "an ML-DSA-87 signature is required" };
    }

    const key = await (this.options.registeredKey ?? this.chainKey)(fields.address);
    if (key.publicKey === undefined) {
      return { ok: false, reason: "the account has no registered ML-DSA-87 key" };
    }
    if (key.possessionProven !== true) {
      return {
        ok: false,
        reason: "the account's key was registered without a proof of possession",
      };
    }
    const common = {
      message,
      domain: this.options.domain,
      nonce: fields.nonce,
      chainId: this.options.chainId,
      now: new Date(this.now() * 1_000),
    };
    try {
      verifySiwq({ ...common, signature, pqPublicKey: key.publicKey, requirePq: true });
      return { ok: true, address: fields.address, format: "siwq" };
    } catch (error) {
      if (!isQoreSignError(error) || error.code !== "PQ_SIGNATURE_INVALID") {
        return { ok: false, reason: describe(error) };
      }
    }
    // QoreX: message signing v1 over the same text. Fields and the classical part as SIWQ,
    // then the ML-DSA-87 part in the message-signing domain, against the same registered key.
    try {
      verifySiwq({
        ...common,
        signature: { signatureType: "secp256k1", classical: signature.classical },
        requirePq: false,
      });
      verifyMessage({
        chainId: this.options.chainId,
        signer: fields.address,
        data: message,
        signature,
        pqPublicKey: key.publicKey,
        requirePq: true,
      });
      return { ok: true, address: fields.address, format: "message-v1" };
    } catch (error) {
      return { ok: false, reason: describe(error) };
    }
  }

  private readonly chainKey = async (address: string): Promise<RegisteredKey> => {
    const status = await fetchPqKeyStatus({ rest: this.options.rest, address });
    return {
      ...(status.publicKey === undefined ? {} : { publicKey: status.publicKey }),
      ...(status.possessionProven === undefined
        ? {}
        : { possessionProven: status.possessionProven }),
    };
  };

  private async allowedAddress(input: unknown): Promise<string> {
    const check = validateAddress(typeof input === "string" ? input : "");
    if (!check.valid) throw new SiwqError(`not a valid address (${check.error})`);
    if (!(await this.options.allowed()).includes(check.bech32)) {
      throw new SiwqError("this account may not sign in to this console");
    }
    return check.bech32;
  }

  private prune(): void {
    const now = this.now();
    for (const [nonce, entry] of this.open) if (entry.expiresAt <= now) this.open.delete(nonce);
  }
}

/** A sign-in refused for a reason the operator should see. */
export class SiwqError extends Error {}

function isSignature(value: unknown): value is SiwqSignature {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<SiwqSignature>;
  return (
    typeof v.signatureType === "string" &&
    typeof v.classical === "object" &&
    typeof v.classical.publicKey === "string" &&
    typeof v.classical.signature === "string" &&
    (v.pq === undefined || (typeof v.pq === "object" && typeof v.pq.signature === "string"))
  );
}

function describe(error: unknown): string {
  if (isQoreSignError(error)) return `signature refused (${error.code})`;
  return "signature refused";
}
