import {
  createRdkClient,
  fetchQledgerEntries,
  type BatchView,
  type QledgerEntry,
  type RdkClient,
} from "@qorechain/rdk";
import type { InboxSource } from "./archive.js";
import type { VigilConfig } from "./config.js";
import { HttpClient, type Transport } from "./http.js";
import { normalizeHex } from "./hex.js";
import type { BatchClaim } from "./replay.js";
import type { StoredBatch } from "./store.js";

/** Read access to the base chain, with every request going through `HttpClient`. */
export interface Chain {
  readonly rdk: RdkClient;
  readonly rest: HttpClient;
  readonly rpc: HttpClient;
  readonly evm: HttpClient;
}

/** Builds the chain clients for the configured network. */
export function createChain(config: VigilConfig, transport?: Transport): Chain {
  const make = (source: string): HttpClient =>
    new HttpClient({
      source: `${config.network}-${source}`,
      timeoutMs: config.http.timeoutMs,
      maxRetries: config.http.maxRetries,
      requestsPerMinute: config.http.requestsPerMinute,
      ...(transport === undefined ? {} : { transport }),
    });
  const rest = make("rest");
  const rdk = createRdkClient({
    network: config.network,
    endpoints: { rest: config.restUrl, rpc: config.rpcUrl, evmRpc: config.evmRpcUrl },
    fetch: rest.asFetch(),
  });
  return { rdk, rest, rpc: make("rpc"), evm: make("evm") };
}

/** Inbox reader backed by the base chain's REST API and transaction index. */
export function chainInboxSource(chain: Chain, chainId: string, rollupId: string): InboxSource {
  return {
    async head() {
      const inbox = await chain.rdk.rest.getInbox(rollupId);
      return { sequence: inbox.headSequence, acc: inbox.headAcc };
    },
    entries(from: number, to: number, accFrom: Uint8Array): Promise<QledgerEntry[]> {
      return fetchQledgerEntries(chain.rdk.rest, { chainId, rollupId, from, to, accFrom });
    },
  };
}

/** Converts the chain's batch view into the normalised record Vigil stores. */
export function toStoredBatch(view: BatchView): StoredBatch {
  return {
    batchIndex: view.batchIndex,
    stateRoot: normalizeHex(view.stateRoot),
    prevStateRoot: normalizeHex(view.prevStateRoot),
    dataHash: normalizeHex(view.dataHash),
    withdrawalsRoot: normalizeHex(view.withdrawalsRoot),
    inboxStart: view.inboxStart,
    inboxEnd: view.inboxEnd,
    txCount: view.txCount,
    status: view.status,
    submittedAt: view.submittedAt,
    submittedTime: view.submittedTime,
    finalizedAt: view.finalizedAt,
  };
}

/** The part of a stored batch that the watchtower judges. */
export function toBatchClaim(batch: StoredBatch): BatchClaim {
  return {
    batchIndex: batch.batchIndex,
    inboxStart: batch.inboxStart,
    inboxEnd: batch.inboxEnd,
    prevStateRoot: batch.prevStateRoot,
    stateRoot: batch.stateRoot,
    withdrawalsRoot: batch.withdrawalsRoot,
    dataHash: batch.dataHash,
  };
}
