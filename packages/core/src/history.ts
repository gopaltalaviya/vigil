import { IntegrityError } from "./errors.js";
import type { HttpClient } from "./http.js";
import { toHex } from "./hex.js";
import type { StoredBatch } from "./store.js";

/** A fraud proof the base chain upheld against a batch. */
export interface FraudRecord {
  batchIndex: number;
  txHash: string;
  height: number;
  /** Block time, Unix seconds. */
  time: number;
  submitter: string;
  challenger: string;
  slashedUqor: string;
  rewardUqor: string;
  burnedUqor: string;
}

/** A withdrawal the base chain has paid out. */
export interface ExecutedWithdrawal {
  batchIndex: number;
  withdrawalIndex: number;
  recipient: string;
  amountUqor: string;
  txHash: string;
  height: number;
}

/** What the base chain's transaction index can tell about a rollup's past. */
export interface ChainHistory {
  fraud(): Promise<FraudRecord[]>;
  /** Every submission at one batch index, oldest first, whatever became of it. */
  submissions(batchIndex: number): Promise<StoredBatch[]>;
  withdrawals(): Promise<ExecutedWithdrawal[]>;
}

interface TxEvent {
  type: string;
  attributes: { key: string; value: string }[];
}

interface TxResponse {
  txhash: string;
  height: string;
  code: number;
  timestamp: string;
  events: TxEvent[];
  tx: { body: { messages: Record<string, unknown>[] } };
}

const PAGE_SIZE = 50;
const SUBMIT_BATCH = "/qorechain.rdk.v1.MsgSubmitBatch";
const AUTHZ_EXEC = "/cosmos.authz.v1beta1.MsgExec";

const attributes = (event: TxEvent): Map<string, string> =>
  new Map(event.attributes.map((a) => [a.key, a.value]));

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined) throw new IntegrityError("chain event is missing a field", { key });
  return value;
}

function integer(value: string, field: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new IntegrityError("chain event has a bad integer", { field });
  }
  return parsed;
}

/** `1000000uqor` to `1000000`. */
function uqor(value: string, field: string): string {
  const match = /^(\d+)uqor$/.exec(value);
  if (match?.[1] === undefined) throw new IntegrityError("chain event has a bad amount", { field });
  return match[1];
}

function unixSeconds(timestamp: string): number {
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) throw new IntegrityError("transaction has a bad timestamp");
  return Math.floor(ms / 1_000);
}

const base64Hex = (value: unknown): string =>
  typeof value === "string" ? toHex(new Uint8Array(Buffer.from(value, "base64"))) : "";

/** A transaction's messages, with any authz `MsgExec` opened up. */
export function flattenMessages(messages: readonly Record<string, unknown>[]) {
  const flat: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message["@type"] === AUTHZ_EXEC && Array.isArray(message.msgs)) {
      flat.push(...flattenMessages(message.msgs as Record<string, unknown>[]));
    } else {
      flat.push(message);
    }
  }
  return flat;
}

/** Reads the upheld fraud proofs of one rollup out of a transaction. */
export function parseFraud(tx: TxResponse, rollupId: string): FraudRecord[] {
  if (tx.code !== 0) return [];
  return tx.events
    .filter((event) => event.type === "rdk_fraud_upheld")
    .map(attributes)
    .filter((values) => values.get("rollup_id") === rollupId)
    .map((values) => ({
      batchIndex: integer(required(values, "batch_index"), "batch_index"),
      txHash: tx.txhash,
      height: integer(tx.height, "height"),
      time: unixSeconds(tx.timestamp),
      submitter: required(values, "submitter"),
      challenger: required(values, "challenger"),
      slashedUqor: uqor(required(values, "slashed"), "slashed"),
      rewardUqor: uqor(required(values, "challenger_reward"), "challenger_reward"),
      burnedUqor: uqor(required(values, "burned"), "burned"),
    }));
}

/** Reads the executed withdrawals of one rollup out of a transaction. */
export function parseWithdrawals(tx: TxResponse, rollupId: string): ExecutedWithdrawal[] {
  if (tx.code !== 0) return [];
  return tx.events
    .filter((event) => event.type === "rdk_withdrawal_executed")
    .map(attributes)
    .filter((values) => values.get("rollup_id") === rollupId)
    .map((values) => ({
      batchIndex: integer(required(values, "batch_index"), "batch_index"),
      withdrawalIndex: integer(required(values, "withdrawal_index"), "withdrawal_index"),
      recipient: required(values, "recipient"),
      amountUqor: uqor(required(values, "amount"), "amount"),
      txHash: tx.txhash,
      height: integer(tx.height, "height"),
    }));
}

/**
 * Rebuilds the claim a `MsgSubmitBatch` made, in the same form as a batch read
 * from the chain, so its identity matches. The status is left to the caller.
 */
export function parseSubmission(
  tx: TxResponse,
  rollupId: string,
  batchIndex: number,
): StoredBatch | undefined {
  if (tx.code !== 0) return undefined;
  const message = flattenMessages(tx.tx.body.messages).find(
    (m) =>
      m["@type"] === SUBMIT_BATCH &&
      m.rollup_id === rollupId &&
      Number(m.batch_index) === batchIndex,
  );
  if (message === undefined) return undefined;
  const consumed = tx.events
    .filter((event) => event.type === "rdk_inbox_consumed")
    .map(attributes)
    .find(
      (values) =>
        values.get("rollup_id") === rollupId && values.get("batch_index") === String(batchIndex),
    );
  if (consumed === undefined) return undefined;
  return {
    batchIndex,
    stateRoot: base64Hex(message.state_root),
    prevStateRoot: base64Hex(message.prev_state_root),
    dataHash: base64Hex(message.data_hash),
    withdrawalsRoot: base64Hex(message.withdrawals_root),
    inboxStart: integer(required(consumed, "inbox_start"), "inbox_start"),
    inboxEnd: integer(required(consumed, "inbox_end"), "inbox_end"),
    txCount: integer(String(message.tx_count), "tx_count"),
    status: "rejected",
    submittedAt: integer(tx.height, "height"),
    submittedTime: unixSeconds(tx.timestamp),
    finalizedAt: 0,
  };
}

/** The hash of the transaction that submitted a batch at a given height. */
export async function findSubmissionTx(
  rest: HttpClient,
  restUrl: string,
  rollupId: string,
  batchIndex: number,
  height: number,
): Promise<string | undefined> {
  const txs = await searchTxs(
    rest,
    restUrl,
    `batch_submitted.rollup_id='${rollupId}' AND batch_submitted.batch_index='${String(batchIndex)}'`,
  );
  return txs.find((tx) => tx.code === 0 && Number(tx.height) === height)?.txhash;
}

/** Every transaction matching an event query, oldest first. */
async function searchTxs(rest: HttpClient, restUrl: string, query: string): Promise<TxResponse[]> {
  const found: TxResponse[] = [];
  for (let page = 1; ; page += 1) {
    const params = new URLSearchParams({ query, page: String(page), limit: String(PAGE_SIZE) });
    const body = (await rest.getJson(`${restUrl}/cosmos/tx/v1beta1/txs?${params.toString()}`)) as {
      txs?: TxResponse["tx"][];
      tx_responses?: Omit<TxResponse, "tx">[];
      total?: string;
      pagination?: { total?: string };
    };
    const responses = body.tx_responses ?? [];
    responses.forEach((response, i) => {
      const tx = body.txs?.[i];
      if (tx !== undefined) found.push({ ...response, tx });
    });
    const total = Number(body.total ?? body.pagination?.total ?? 0);
    if (responses.length === 0 || found.length >= total) break;
  }
  return found.sort((a, b) => Number(a.height) - Number(b.height));
}

/** History reader backed by the base chain's REST transaction search. */
export function chainHistory(rest: HttpClient, restUrl: string, rollupId: string): ChainHistory {
  const search = (query: string) => searchTxs(rest, restUrl, query);

  return {
    async fraud() {
      const txs = await search(`rdk_fraud_upheld.rollup_id='${rollupId}'`);
      return txs.flatMap((tx) => parseFraud(tx, rollupId));
    },
    async submissions(batchIndex) {
      const txs = await search(
        `batch_submitted.rollup_id='${rollupId}' AND batch_submitted.batch_index='${String(batchIndex)}'`,
      );
      return txs.flatMap((tx) => parseSubmission(tx, rollupId, batchIndex) ?? []);
    },
    async withdrawals() {
      const txs = await search(`rdk_withdrawal_executed.rollup_id='${rollupId}'`);
      return txs.flatMap((tx) => parseWithdrawals(tx, rollupId));
    },
  };
}
