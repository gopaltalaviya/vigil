import {
  QLEDGER_KIND_TRANSFER,
  decodeQledgerDeposit,
  decodeQledgerTx,
  qledgerAccountId,
  verifyQledgerTx,
} from "@qorechain/rdk";
import {
  InboxArchive,
  ledgerAtSequence,
  toHex,
  type Store,
  type StoredInboxEntry,
} from "@vigil/core";
import { parseMemo } from "@vigil/memo";

/** One inbox entry, decoded for display. Amounts are uqor as decimal strings. */
export interface EntryView {
  sequence: number;
  height: number;
  poster: string;
  kind: "deposit" | "transfer" | "withdrawal" | "memo" | "data";
  amount: string | undefined;
  /** L2 account that signed a transfer or withdrawal. */
  from: string | undefined;
  /** L2 account credited by a deposit or transfer. */
  to: string | undefined;
  /** Base-chain address a withdrawal pays. */
  recipient: string | undefined;
  /** Whether a transfer or withdrawal carries a valid signature. */
  signatureValid: boolean | undefined;
  bytes: number;
}

const CONTROL = /\p{Cc}/gu;
const clean = (text: string): string => text.replace(CONTROL, " ");

/** Decodes an archived inbox entry. Anything unrecognised is plain data, a no-op for the ledger. */
export function describeEntry(
  entry: StoredInboxEntry,
  env: { chainId: string; rollupId: string },
): EntryView {
  const base = {
    sequence: entry.sequence,
    height: entry.height,
    poster: clean(entry.poster),
    bytes: entry.payload.length,
    amount: undefined,
    from: undefined,
    to: undefined,
    recipient: undefined,
    signatureValid: undefined,
  };
  if (entry.poster.startsWith("deposit:")) {
    const deposit = decodeQledgerDeposit(entry.payload);
    if (deposit !== undefined) {
      return {
        ...base,
        kind: "deposit",
        amount: deposit.amount.toString(),
        to: toHex(deposit.account),
      };
    }
  }
  if (parseMemo(entry.payload) !== undefined) return { ...base, kind: "memo" };
  const tx = decodeQledgerTx(entry.payload);
  if (tx !== undefined) {
    return {
      ...base,
      kind: tx.kind === QLEDGER_KIND_TRANSFER ? "transfer" : "withdrawal",
      amount: tx.amount.toString(),
      from: toHex(qledgerAccountId(tx.publicKey, tx.scheme)),
      to: tx.to === undefined ? undefined : toHex(tx.to),
      recipient: tx.recipient === undefined ? undefined : clean(tx.recipient),
      signatureValid: verifyQledgerTx(tx, env.chainId, env.rollupId),
    };
  }
  return { ...base, kind: "data" };
}

/**
 * Read-only access to ledger state, derived by replaying the archived inbox.
 * It never contacts the chain: the archive is filled by the watchtower.
 */
export class Explorer {
  private readonly context: {
    chainId: string;
    rollupId: string;
    store: Store;
    archive: InboxArchive;
  };

  constructor(options: { chainId: string; rollupId: string; store: Store }) {
    const offline = (): Promise<never> =>
      Promise.reject(new Error("the explorer reads the local archive only"));
    this.context = {
      ...options,
      archive: new InboxArchive({ ...options, source: { head: offline, entries: offline } }),
    };
  }

  /** Decoded entries with `from < sequence <= to`. */
  entries(from: number, to: number): EntryView[] {
    const { store, rollupId } = this.context;
    return store.inboxRange(rollupId, from, to).map((entry) => describeEntry(entry, this.context));
  }

  /** Every archived withdrawal request that pays `recipient` (a `qor1` address), oldest first. */
  withdrawalsTo(recipient: string): EntryView[] {
    const head = this.context.store.lastInboxEntry(this.context.rollupId)?.sequence ?? 0;
    return this.entries(0, head).filter(
      (entry) => entry.kind === "withdrawal" && entry.recipient === recipient,
    );
  }

  /** The most recent `limit` entries, newest first. */
  recentEntries(limit: number): EntryView[] {
    const head = this.context.store.lastInboxEntry(this.context.rollupId)?.sequence ?? 0;
    return this.entries(Math.max(0, head - limit), head).reverse();
  }

  /** Balance and nonce of an L2 account after every archived entry. */
  account(accountIdHex: string): {
    accountId: string;
    balance: string;
    nonce: string;
    asOfEntry: number;
  } {
    const { store, rollupId } = this.context;
    const head = store.lastInboxEntry(rollupId)?.sequence ?? 0;
    const state = ledgerAtSequence(this.context, head).get(Buffer.from(accountIdHex, "hex"));
    return {
      accountId: accountIdHex,
      balance: state.balance.toString(),
      nonce: state.nonce.toString(),
      asOfEntry: head,
    };
  }
}
