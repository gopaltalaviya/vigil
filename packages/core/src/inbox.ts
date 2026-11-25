import {
  QLEDGER_DEPOSIT_POSTER_PREFIX,
  base64ToBytes,
  bytesToHex,
  encodeQledgerDeposit,
  hexToBytes,
  isRestNotFound,
  postedDataHash,
  qledgerAccumulate,
  type QledgerEntry,
  type RawRecord,
  type RestClient,
} from "@qorechain/rdk";
import { IntegrityError } from "./errors.js";

/** What one inbox read needs: the range `from < sequence <= to` and where to start looking. */
export interface InboxReadInput {
  chainId: string;
  rollupId: string;
  from: number;
  to: number;
  accFrom: Uint8Array;
  /** Lowest block height that can hold an entry of this range; 0 searches from genesis. */
  fromHeight?: number;
}

/** Search pages allowed per query: 10,000 pages of 100 transactions. */
export const INBOX_SEARCH_MAX_PAGES = 10_000;

type Attributes = Record<string, string>;

/** A string field of a raw REST record; numbers count, anything else is empty. */
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return value.toString();
  return "";
}

function attributes(event: RawRecord): Attributes {
  const out: Attributes = {};
  const list = Array.isArray(event.attributes) ? (event.attributes as RawRecord[]) : [];
  for (const item of list) out[text(item.key)] = text(item.value);
  return out;
}

function events(tx: RawRecord): RawRecord[] {
  return Array.isArray(tx.events) ? (tx.events as RawRecord[]) : [];
}

function messages(tx: RawRecord): RawRecord[] {
  const body = (tx.tx as { body?: { messages?: RawRecord[] } } | undefined)?.body;
  return body?.messages ?? [];
}

/**
 * Reads inbox entries `from < sequence <= to` from the base chain's transaction index.
 *
 * It does the same work as the RDK's `fetchQledgerEntries`, with two differences: the search
 * starts at `fromHeight`, so a resumed read does not page through a rollup's whole history, and
 * it follows every result page, where the kit stops after 5,000 transactions. The result is
 * still checked against the chain's accumulator at `to`, which the chain keeps for recent posts,
 * for retained checkpoints, and always for the inbox head.
 */
export async function readInboxEntries(
  rest: RestClient,
  input: InboxReadInput,
): Promise<QledgerEntry[]> {
  const { rollupId, from, to } = input;
  const floor = input.fromHeight !== undefined && input.fromHeight > 0 ? input.fromHeight : 0;
  const query = (event: string): string =>
    `${event}.rollup_id='${rollupId}'` + (floor > 0 ? ` AND tx.height>=${String(floor)}` : "");
  const search = (event: string): Promise<RawRecord[]> =>
    rest.searchTxs(query(event), { maxPages: INBOX_SEARCH_MAX_PAGES });
  const inRange = (sequence: number): boolean => sequence > from && sequence <= to;

  const bySequence = new Map<number, QledgerEntry>();
  for (const tx of await search("rdk_data_posted")) {
    const height = BigInt(text(tx.height) || "0");
    const posts = messages(tx).filter((m) => m["@type"] === "/qorechain.rdk.v1.MsgPostRollupData");
    for (const event of events(tx)) {
      if (event.type !== "rdk_data_posted") continue;
      const a = attributes(event);
      const sequence = Number(a.sequence ?? "0");
      if (a.rollup_id !== rollupId || !inRange(sequence)) continue;
      const post = posts.find((m) => {
        const data = base64ToBytes(text(m.data));
        return bytesToHex(postedDataHash(data)) === a.data_hash && text(m.poster) === a.poster;
      });
      if (post === undefined) {
        throw new IntegrityError("an inbox post's payload is missing from its transaction", {
          rollupId,
          sequence,
          txhash: text(tx.txhash),
        });
      }
      bySequence.set(sequence, {
        height,
        poster: a.poster ?? "",
        payload: base64ToBytes(text(post.data)),
      });
    }
  }
  for (const tx of await search("rdk_rollup_deposit")) {
    const height = BigInt(text(tx.height) || "0");
    for (const event of events(tx)) {
      if (event.type !== "rdk_rollup_deposit") continue;
      const a = attributes(event);
      const sequence = Number(a.sequence ?? "0");
      if (a.rollup_id !== rollupId || !inRange(sequence)) continue;
      const amount = BigInt((a.amount ?? "0").replace(/uqor$/, ""));
      bySequence.set(sequence, {
        height,
        poster: QLEDGER_DEPOSIT_POSTER_PREFIX + (a.depositor ?? ""),
        payload: encodeQledgerDeposit(hexToBytes(a.account ?? ""), amount),
      });
    }
  }

  const entries: QledgerEntry[] = [];
  for (let sequence = from + 1; sequence <= to; sequence += 1) {
    const entry = bySequence.get(sequence);
    if (entry === undefined) {
      throw new IntegrityError("an inbox entry is not in the node's transaction index", {
        rollupId,
        sequence,
      });
    }
    entries.push(entry);
  }

  const accTo = bytesToHex(qledgerAccumulate({ ...input, entries }));
  if (accTo !== normalise(await chainAccAt(rest, rollupId, to))) {
    throw new IntegrityError("the inbox entries read back do not match the chain's accumulator", {
      rollupId,
      to,
    });
  }
  return entries;
}

/** The chain's accumulator after `sequence`, from the posted-data record or the inbox head. */
async function chainAccAt(rest: RestClient, rollupId: string, sequence: number): Promise<string> {
  try {
    return (await rest.getPostedData(rollupId, sequence)).inboxAcc;
  } catch (error) {
    if (!isRestNotFound(error)) throw error;
  }
  const inbox = await rest.getInbox(rollupId);
  if (inbox.headSequence === sequence) return inbox.headAcc;
  throw new IntegrityError(
    "the chain no longer holds the accumulator at the end of this range; read up to the head",
    { rollupId, sequence },
  );
}

function normalise(hex: string): string {
  return hex.replace(/^0x/, "").toLowerCase();
}
