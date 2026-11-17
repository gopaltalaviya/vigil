import {
  decodeRdkTxError,
  pqcKeypairFromEnv,
  signerFromEnv,
  type RdkClient,
  type RdkTxClient,
} from "@qorechain/rdk";
import type { VigilConfig } from "./config.js";
import { ConfigError, TxFailedError, TxUnconfirmedError } from "./errors.js";
import type { Logger } from "./log.js";
import type { Store } from "./store.js";

/** The part of a broadcast result Vigil relies on. */
export interface RawTxResult {
  code: number;
  height: number;
  transactionHash: string;
  gasUsed: bigint | number;
  rawLog?: string;
  msgResponses?: readonly { typeUrl: string; value: Uint8Array }[];
}

/** A transaction the chain included and accepted. */
export interface TxOutcome {
  hash: string;
  height: number;
  gasUsed: bigint;
  responses: readonly { typeUrl: string; value: Uint8Array }[];
}

/** Sends base-chain transactions for one account, one at a time. */
export interface TxSender {
  readonly address: string;
  /**
   * Runs one transaction. Resolves only if the chain accepted it; a rejection
   * becomes `TxFailedError`, and a broadcast whose fate is unknown becomes
   * `TxUnconfirmedError`. Every attempt is written to the transaction log.
   */
  send(label: string, run: (tx: RdkTxClient) => Promise<RawTxResult>): Promise<TxOutcome>;
}

export interface TxSenderOptions {
  address: string;
  client: RdkTxClient;
  store?: Store;
  log?: Logger;
  /** Unix seconds. */
  now?: () => number;
}

/** Wraps a connected kit client with serial execution, result checking and logging. */
export function createTxSender(options: TxSenderOptions): TxSender {
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  let queue: Promise<unknown> = Promise.resolve();

  const execute = async (
    label: string,
    run: (tx: RdkTxClient) => Promise<RawTxResult>,
  ): Promise<TxOutcome> => {
    let result: RawTxResult;
    try {
      result = await run(options.client);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      options.store?.logTx({ label, status: "unconfirmed", error: reason, createdAt: now() });
      options.log?.error({ label, err: error }, "transaction not confirmed");
      throw new TxUnconfirmedError(`${label}: ${reason}`, { label }, { cause: error });
    }

    const base = { label, hash: result.transactionHash, height: result.height, createdAt: now() };
    if (result.code !== 0) {
      const codespace = /codespace (\w+)/.exec(result.rawLog ?? "")?.[1];
      const decoded = decodeRdkTxError({
        code: result.code,
        ...(codespace === undefined ? {} : { codespace }),
        ...(result.rawLog === undefined ? {} : { rawLog: result.rawLog }),
      });
      options.store?.logTx({
        ...base,
        status: "failed",
        code: result.code,
        error: decoded.message,
      });
      options.log?.error(
        { label, hash: result.transactionHash, code: result.code },
        decoded.message,
      );
      throw new TxFailedError(`${label}: ${decoded.message}`, {
        label,
        hash: result.transactionHash,
        code: result.code,
        kind: decoded.kind,
        ...(decoded.hint === undefined ? {} : { hint: decoded.hint }),
      });
    }

    options.store?.logTx({ ...base, status: "confirmed", code: 0 });
    options.log?.info(
      { label, hash: result.transactionHash, height: result.height },
      "transaction confirmed",
    );
    return {
      hash: result.transactionHash,
      height: result.height,
      gasUsed: BigInt(result.gasUsed),
      responses: result.msgResponses ?? [],
    };
  };

  return {
    address: options.address,
    send(label, run) {
      // Chain transactions from one account must not overlap: each needs the next sequence number.
      const next = queue.then(
        () => execute(label, run),
        () => execute(label, run),
      );
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

/**
 * Connects the account configured in the environment. Transactions are signed
 * hybrid: secp256k1 plus the account's ML-DSA-87 key.
 */
export async function connectTxSender(
  config: VigilConfig,
  rdk: RdkClient,
  extras: { store?: Store; log?: Logger } = {},
): Promise<TxSender> {
  if (config.secrets.mnemonic === undefined) {
    throw new ConfigError("QORE_MNEMONIC is required to send transactions", {
      problems: [{ variable: "QORE_MNEMONIC", problem: "missing" }],
    });
  }
  const env = {
    QORE_MNEMONIC: config.secrets.mnemonic,
    ...(config.secrets.pqcSeedHex === undefined
      ? {}
      : { QORE_PQC_SEED_HEX: config.secrets.pqcSeedHex }),
  };
  const signer = await signerFromEnv(env);
  if (signer === undefined) throw new ConfigError("could not derive a signer from QORE_MNEMONIC");
  const [account] = await signer.getAccounts();
  if (account === undefined) throw new ConfigError("the signer holds no account");

  const pqc = await pqcKeypairFromEnv(rdk, account.address, env);
  if (pqc === undefined) throw new ConfigError("could not derive the ML-DSA-87 key");

  const client = await rdk.connectTx(signer, {
    gasPrice: config.gasPrice,
    pqcKeypair: pqc.keypair,
    includePqcPublicKey: pqc.includePqcPublicKey,
  });
  return createTxSender({ address: account.address, client, ...extras });
}
