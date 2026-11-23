import type { QledgerBatchPlan, QledgerLedger } from "@qorechain/rdk";
import {
  IntegrityError,
  VigilError,
  claimId,
  ledgerAtSequence,
  toBatchClaim,
  toHex,
  verifyBatch,
  type InboxArchive,
  type Logger,
  type Store,
  type StoredBatch,
  type TxSender,
} from "@vigil/core";

/** What the batcher needs to read and decide; the chain adapter implements it. */
export interface BatcherView {
  inbox(): Promise<{ head: number; consumed: number }>;
  /** Every batch the chain currently lists for this rollup. */
  batches(): Promise<StoredBatch[]>;
  /**
   * Plans the next batch on top of `ledger`, the state after the last batched
   * entry. Rejects with a reason when no batch can be submitted yet, for
   * example because the newest entries are too fresh or the bond is missing.
   */
  plan(ledger: QledgerLedger): Promise<QledgerBatchPlan>;
}

export interface BatcherOptions {
  chainId: string;
  rollupId: string;
  /** `own`: we created the rollup and must sign the settlement anchor. */
  mode: "own" | "shared";
  store: Store;
  archive: InboxArchive;
  view: BatcherView;
  sender: TxSender;
  log: Logger;
}

export type BatcherReport =
  | { action: "idle" }
  | { action: "waiting"; reason: string }
  | {
      action: "submitted";
      batchIndex: number;
      stateRoot: string;
      inboxStart: number;
      inboxEnd: number;
      hash: string;
    };

/**
 * Bonded submitter. Each tick it turns the unbatched part of the inbox into
 * one batch and submits it, signed hybrid with the account's ML-DSA-87 key
 * (and, on our own rollup, with the ML-DSA-87 anchor signature).
 *
 * The plan is checked against the batcher's own verified archive before it is
 * sent: a batch this code would judge invalid is never submitted, because a
 * wrong batch costs the whole bond.
 */
export class Batcher {
  private readonly options: BatcherOptions;

  constructor(options: BatcherOptions) {
    this.options = options;
  }

  async tick(): Promise<BatcherReport> {
    const { archive, view, chainId, rollupId, sender, log, mode } = this.options;
    const [sync, inbox] = await Promise.all([archive.sync(), view.inbox()]);
    if (inbox.head <= inbox.consumed) return { action: "idle" };
    if (sync.head < inbox.consumed) {
      return { action: "waiting", reason: "the local inbox archive is still catching up" };
    }

    // A batch built on an invalid one is rejected with it, and costs our bond. The list comes
    // from the chain and each open claim is re-executed here, so this holds with no watchtower.
    const open = (await view.batches())
      .filter((batch) => batch.status === "submitted" || batch.status === "challenged")
      .sort((a, b) => a.batchIndex - b.batchIndex || a.submittedAt - b.submittedAt);
    for (const batch of open) {
      const reason = this.openBatchProblem(batch, sync.head);
      if (reason !== undefined) {
        log.warn({ batchIndex: batch.batchIndex }, reason);
        return { action: "waiting", reason };
      }
    }

    const parent = ledgerAtSequence(this.options, inbox.consumed);
    let plan: QledgerBatchPlan;
    try {
      plan = await view.plan(parent.clone());
    } catch (error) {
      // A dead endpoint is a failure to report, not a reason to wait quietly.
      if (error instanceof VigilError) throw error;
      const reason = error instanceof Error ? error.message : "the batch could not be planned";
      const bondProblem = /bond/i.test(reason);
      log[bondProblem ? "error" : "info"]({ reason }, "no batch can be submitted yet");
      return { action: "waiting", reason };
    }

    const inboxStart = inbox.consumed;
    const inboxEnd = Number(plan.input.inboxEnd);
    const batchIndex = Number(plan.input.batchIndex);
    const stateRoot = toHex(plan.input.stateRoot);
    if (inboxEnd <= inboxStart || inboxEnd > sync.head) {
      throw new IntegrityError("the planned batch covers entries this node has not verified", {
        inboxStart,
        inboxEnd,
        archiveHead: sync.head,
      });
    }

    const check = verifyBatch(
      {
        batchIndex,
        inboxStart,
        inboxEnd,
        prevStateRoot: toHex(plan.input.prevStateRoot),
        stateRoot,
        withdrawalsRoot: toHex(plan.input.withdrawalsRoot),
        dataHash: toHex(plan.input.dataHash),
      },
      {
        chainId,
        rollupId,
        parent,
        entries: archive.range(inboxStart, inboxEnd),
        accFrom: archive.accAt(inboxStart),
        accTo: archive.accAt(inboxEnd),
      },
    );
    if (check.verdict !== "valid") {
      throw new IntegrityError("refusing to submit a batch that fails re-execution", {
        batchIndex,
        reasons: check.reasons,
      });
    }

    const outcome = await sender.send("submit-batch", (tx) =>
      tx.submitBatch(plan.input, { anchor: mode === "own" ? "require" : "off" }),
    );
    log.info({ batchIndex, inboxStart, inboxEnd, hash: outcome.hash }, "batch submitted");
    return { action: "submitted", batchIndex, stateRoot, inboxStart, inboxEnd, hash: outcome.hash };
  }

  /** Why an open batch must not be built on, or undefined when it re-executes correctly. */
  private openBatchProblem(batch: StoredBatch, archiveHead: number): string | undefined {
    const { archive, chainId, rollupId, store } = this.options;
    const label = `batch ${String(batch.batchIndex)}`;
    const stored = store.verdict(rollupId, claimId(batch))?.verdict;
    if (stored === "valid") return undefined;
    if (stored === "invalid") return `${label} is invalid and still open; not building on it`;
    if (batch.inboxStart > batch.inboxEnd || batch.inboxEnd > archiveHead) {
      return `${label} is open and not in the verified archive yet; not building on it`;
    }
    const check = verifyBatch(toBatchClaim(batch), {
      chainId,
      rollupId,
      parent: ledgerAtSequence(this.options, batch.inboxStart),
      entries: archive.range(batch.inboxStart, batch.inboxEnd),
      accFrom: archive.accAt(batch.inboxStart),
      accTo: archive.accAt(batch.inboxEnd),
    });
    return check.verdict === "valid"
      ? undefined
      : `${label} is invalid and still open; not building on it`;
  }
}
