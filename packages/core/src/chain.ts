import { createRdkClient, type BatchView, type QledgerEntry, type RdkClient } from "@qorechain/rdk";
import type { InboxSource } from "./archive.js";
import type { VigilConfig } from "./config.js";
import { HttpClient, type Transport } from "./http.js";
import { normalizeHex } from "./hex.js";
import { flattenMessages } from "./history.js";
import { INBOX_SEARCH_MAX_PAGES, readInboxEntries } from "./inbox.js";
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
  // The kit matches inbox posts among top-level messages only, so a post relayed through an
  // authz MsgExec would look missing. Open those up before it sees them. The kit also stops
  // after 50 pages (5,000 transactions) unless told otherwise, which a busy rollup passes.
  const searchTxs = rdk.rest.searchTxs.bind(rdk.rest);
  rdk.rest.searchTxs = async (query, options) =>
    (await searchTxs(query, { maxPages: INBOX_SEARCH_MAX_PAGES, ...options })).map(unwrapAuthz);
  return { rdk, rest, rpc: make("rpc"), evm: make("evm") };
}

/** A copy of a raw transaction with any authz `MsgExec` replaced by its inner messages. */
export function unwrapAuthz<T extends Record<string, unknown>>(record: T): T {
  const tx = record.tx as { body?: { messages?: Record<string, unknown>[] } } | undefined;
  const messages = tx?.body?.messages;
  if (tx === undefined || messages === undefined) return record;
  return { ...record, tx: { ...tx, body: { ...tx.body, messages: flattenMessages(messages) } } };
}

/**
 * Inbox reader backed by the base chain's REST API and transaction index. The archive passes
 * the height of its last entry, so a resumed read only searches blocks from there on.
 */
export function chainInboxSource(chain: Chain, chainId: string, rollupId: string): InboxSource {
  return {
    async head() {
      const inbox = await chain.rdk.rest.getInbox(rollupId);
      return { sequence: inbox.headSequence, acc: inbox.headAcc };
    },
    entries(
      from: number,
      to: number,
      accFrom: Uint8Array,
      fromHeight?: number,
    ): Promise<QledgerEntry[]> {
      return readInboxEntries(chain.rdk.rest, {
        chainId,
        rollupId,
        from,
        to,
        accFrom,
        ...(fromHeight === undefined ? {} : { fromHeight }),
      });
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
