import { EMPTY_INBOX_ACC, qledgerAccumulate, type QledgerEntry } from "@qorechain/rdk";
import { IntegrityError } from "./errors.js";
import { fromHex, normalizeHex, toHex } from "./hex.js";
import type { Store, StoredInboxEntry } from "./store.js";

/** Where inbox data comes from. The chain adapter implements this; tests fake it. */
export interface InboxSource {
  /** Current head of the rollup's inbox and the accumulator value at that head. */
  head(): Promise<{ sequence: number; acc: string }>;
  /**
   * Entries with `from < sequence <= to`, in order, as posted on the base chain. `fromHeight`
   * is the height of entry `from` when known: no later entry can sit in an earlier block.
   */
  entries(
    from: number,
    to: number,
    accFrom: Uint8Array,
    fromHeight?: number,
  ): Promise<QledgerEntry[]>;
}

export interface InboxArchiveOptions {
  chainId: string;
  rollupId: string;
  store: Store;
  source: InboxSource;
  /**
   * Entries fetched per round trip. By default a sync reads up to the head in one call: the
   * chain prunes the accumulator of older posts (about 11 days on testnet, and checkpoints once
   * a finalized batch covers them), so a range that ends below the head may not be checkable.
   */
  chunkSize?: number;
}

export interface SyncResult {
  /** Sequence of the last archived entry after the sync. */
  head: number;
  /** Number of entries added by this sync. */
  added: number;
}

/**
 * Durable local copy of a rollup's inbox. Every entry is checked against the
 * chain's hash accumulator before it is stored, so the archive can be trusted
 * for re-execution even after the public node has pruned the original blocks.
 */
export class InboxArchive {
  private readonly chainId: string;
  private readonly rollupId: string;
  private readonly store: Store;
  private readonly source: InboxSource;
  private readonly chunkSize: number;

  constructor(options: InboxArchiveOptions) {
    this.chainId = options.chainId;
    this.rollupId = options.rollupId;
    this.store = options.store;
    this.source = options.source;
    this.chunkSize = options.chunkSize ?? Number.POSITIVE_INFINITY;
  }

  /** Pulls any entries posted since the last sync and verifies them. */
  async sync(): Promise<SyncResult> {
    const head = await this.source.head();
    const headAcc = normalizeHex(head.acc);
    const last = this.store.lastInboxEntry(this.rollupId);
    let sequence = last?.sequence ?? 0;
    let acc = last === undefined ? EMPTY_INBOX_ACC : fromHex(last.acc);
    let height = last?.height ?? 0;

    if (head.sequence < sequence) {
      throw new IntegrityError("the chain's inbox is shorter than the local archive", {
        chainHead: head.sequence,
        archiveHead: sequence,
      });
    }
    if (head.sequence === sequence) {
      this.assertHead(acc, headAcc, sequence);
      return { head: sequence, added: 0 };
    }

    let added = 0;
    while (sequence < head.sequence) {
      const to = Math.min(head.sequence, sequence + this.chunkSize);
      const fetched = await this.source.entries(sequence, to, acc, height);
      if (fetched.length !== to - sequence) {
        throw new IntegrityError("the inbox source returned the wrong number of entries", {
          expected: to - sequence,
          got: fetched.length,
        });
      }
      const rows: StoredInboxEntry[] = [];
      for (const entry of fetched) {
        acc = qledgerAccumulate({
          chainId: this.chainId,
          rollupId: this.rollupId,
          from: sequence,
          accFrom: acc,
          entries: [entry],
        });
        sequence += 1;
        height = Number(entry.height);
        rows.push({
          sequence,
          height,
          poster: entry.poster,
          payload: entry.payload,
          acc: toHex(acc),
        });
      }
      if (to === head.sequence) this.assertHead(acc, headAcc, to);
      this.store.appendInboxEntries(this.rollupId, rows);
      added += rows.length;
    }
    return { head: sequence, added };
  }

  /** Accumulator value after `sequence`; sequence 0 is the empty inbox. */
  accAt(sequence: number): Uint8Array {
    if (sequence === 0) return EMPTY_INBOX_ACC;
    const entry = this.store.inboxEntry(this.rollupId, sequence);
    if (entry === undefined) {
      throw new IntegrityError("inbox entry is not in the archive", { sequence });
    }
    return fromHex(entry.acc);
  }

  /** Archived entries with `from < sequence <= to`, in the shape the ledger executes. */
  range(from: number, to: number): QledgerEntry[] {
    const rows = this.store.inboxRange(this.rollupId, from, to);
    if (rows.length !== to - from) {
      throw new IntegrityError("inbox range is not fully archived", {
        from,
        to,
        available: rows.length,
      });
    }
    return rows.map((row) => ({
      height: BigInt(row.height),
      poster: row.poster,
      payload: row.payload,
    }));
  }

  private assertHead(acc: Uint8Array, headAcc: string, sequence: number): void {
    if (toHex(acc) !== headAcc) {
      throw new IntegrityError("archived inbox does not match the chain's accumulator", {
        sequence,
      });
    }
  }
}
