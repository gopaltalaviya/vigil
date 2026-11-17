import { executeQledger, inboxRangeHash, QledgerLedger, type QledgerEntry } from "@qorechain/rdk";
import type { InboxArchive } from "./archive.js";
import { normalizeHex, toHex } from "./hex.js";
import { restoreLedger } from "./ledger.js";
import type { Store } from "./store.js";
import type { VerdictKind } from "./store.js";

/** What a submitter claimed for one batch, as recorded on the base chain. */
export interface BatchClaim {
  batchIndex: number;
  inboxStart: number;
  inboxEnd: number;
  prevStateRoot: string;
  stateRoot: string;
  withdrawalsRoot: string;
  dataHash: string;
}

export type MismatchReason =
  "prev_state_root" | "state_root" | "withdrawals_root" | "data_hash" | "inbox_range";

/** Result of independently re-executing a batch. */
export interface BatchVerdict {
  verdict: VerdictKind;
  reasons: MismatchReason[];
  expectedStateRoot: string;
  expectedWithdrawalsRoot: string;
  expectedDataHash: string;
  /** Ledger after honest execution; the parent for the next batch. */
  ledger: QledgerLedger;
}

export interface BatchContext {
  chainId: string;
  rollupId: string;
  /** Ledger state the batch builds on. It is not modified. */
  parent: QledgerLedger;
  /** Inbox entries with `inboxStart < sequence <= inboxEnd`. */
  entries: QledgerEntry[];
  /** Inbox accumulator before the first and after the last entry of the range. */
  accFrom: Uint8Array;
  accTo: Uint8Array;
}

/**
 * Re-executes one batch from inbox data alone and compares every commitment
 * the submitter made. The verdict never depends on anything the submitter
 * said except the claim being checked.
 */
export function verifyBatch(claim: BatchClaim, context: BatchContext): BatchVerdict {
  const reasons: MismatchReason[] = [];
  const ledger = context.parent.clone();

  if (
    claim.inboxEnd <= claim.inboxStart ||
    context.entries.length !== claim.inboxEnd - claim.inboxStart
  ) {
    reasons.push("inbox_range");
  }
  if (normalizeHex(claim.prevStateRoot) !== toHex(context.parent.root())) {
    reasons.push("prev_state_root");
  }

  const result = executeQledger(
    { chainId: context.chainId, rollupId: context.rollupId },
    ledger,
    context.entries,
  );
  const expectedStateRoot = toHex(result.stateRoot);
  const expectedWithdrawalsRoot = toHex(result.withdrawalsRoot);
  const expectedDataHash = toHex(
    inboxRangeHash({
      chainId: context.chainId,
      rollupId: context.rollupId,
      from: claim.inboxStart,
      to: claim.inboxEnd,
      accFrom: context.accFrom,
      accTo: context.accTo,
    }),
  );

  if (normalizeHex(claim.stateRoot) !== expectedStateRoot) reasons.push("state_root");
  if (normalizeHex(claim.withdrawalsRoot) !== expectedWithdrawalsRoot) {
    reasons.push("withdrawals_root");
  }
  if (normalizeHex(claim.dataHash) !== expectedDataHash) reasons.push("data_hash");

  return {
    verdict: reasons.length === 0 ? "valid" : "invalid",
    reasons,
    expectedStateRoot,
    expectedWithdrawalsRoot,
    expectedDataHash,
    ledger,
  };
}

/**
 * Ledger state after the first `sequence` inbox entries. State depends only on
 * the ordered inbox, never on how submitters grouped entries into batches, so
 * it is rebuilt from the newest snapshot at or before that point plus a replay
 * of the entries after it.
 */
export function ledgerAtSequence(
  context: { chainId: string; rollupId: string; store: Store; archive: InboxArchive },
  sequence: number,
): QledgerLedger {
  const snapshot = context.store.latestSnapshot(context.rollupId, sequence);
  const ledger = snapshot === undefined ? new QledgerLedger() : restoreLedger(snapshot);
  const from = snapshot?.inboxSequence ?? 0;
  if (from < sequence) {
    executeQledger(
      { chainId: context.chainId, rollupId: context.rollupId },
      ledger,
      context.archive.range(from, sequence),
    );
  }
  return ledger;
}
