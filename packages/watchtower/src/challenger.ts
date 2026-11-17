import { buildQledgerFraudProof, checkQledgerFraud } from "@qorechain/rdk";
import {
  TxFailedError,
  claimId,
  ledgerAtSequence,
  type InboxArchive,
  type Logger,
  type Store,
  type StoredBatch,
  type TxSender,
} from "@vigil/core";
import type { AlertDispatcher } from "./alerts.js";
import type { ChallengeCandidate } from "./watchtower.js";

export interface ChallengerOptions {
  chainId: string;
  rollupId: string;
  store: Store;
  archive: InboxArchive;
  /** Account that pays for and submits challenges. */
  sender: TxSender;
  alerts: AlertDispatcher;
  log: Logger;
  /** When true, proofs are built and checked but nothing is sent. */
  dryRun?: boolean;
  /** Reads the batch the chain currently holds at an index, to detect a replacement. */
  current?: (batchIndex: number) => Promise<StoredBatch | undefined>;
}

export type ChallengeOutcome =
  | { batchIndex: number; action: "challenged"; hash: string }
  | { batchIndex: number; action: "dry-run" }
  | { batchIndex: number; action: "resolved"; hash: string }
  | { batchIndex: number; action: "skipped"; reason: string }
  | { batchIndex: number; action: "failed"; reason: string };

/** Result codes the chain uses when there is nothing (left) to resolve. */
const NOTHING_TO_RESOLVE = new Set([24, 25]);

/**
 * Turns a watchtower verdict into an on-chain challenge. The fraud proof is
 * the batch's own inbox entries plus Merkle witnesses of the accounts they
 * touch, so the base chain can re-execute the batch and see the wrong root for
 * itself. A proof is only sent after the same check the chain runs has
 * confirmed, locally, that it proves fraud: a failed challenge would cost fees
 * and credibility for nothing.
 */
export class Challenger {
  private readonly options: ChallengerOptions;

  constructor(options: ChallengerOptions) {
    this.options = options;
  }

  /** Challenges every candidate. One failure never stops the others. */
  async challengeAll(candidates: readonly ChallengeCandidate[]): Promise<ChallengeOutcome[]> {
    const outcomes: ChallengeOutcome[] = [];
    for (const candidate of candidates) {
      const batchIndex = candidate.batch.batchIndex;
      try {
        outcomes.push(await this.challenge(candidate));
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown error";
        this.options.log.error({ batchIndex, err: error }, "challenge failed");
        outcomes.push({ batchIndex, action: "failed", reason });
      }
    }
    return outcomes;
  }

  async challenge(candidate: ChallengeCandidate): Promise<ChallengeOutcome> {
    const { chainId, rollupId, archive, sender, alerts, log, dryRun, current } = this.options;
    const { batch } = candidate;
    const batchIndex = batch.batchIndex;

    if (batch.status !== "challenged" && candidate.secondsRemaining <= 0) {
      return { batchIndex, action: "skipped", reason: "the challenge window has closed" };
    }

    // Both challenging and resolving assert fraud, so both need the proof to hold.
    const env = { chainId, rollupId };
    const { proof } = buildQledgerFraudProof(
      env,
      ledgerAtSequence(this.options, batch.inboxStart),
      archive.accAt(batch.inboxStart),
      archive.range(batch.inboxStart, batch.inboxEnd),
    );
    let provesFraud: boolean;
    try {
      provesFraud = checkQledgerFraud(
        env,
        {
          inboxStart: batch.inboxStart,
          inboxEnd: batch.inboxEnd,
          dataHash: batch.dataHash,
          prevStateRoot: batch.prevStateRoot,
          stateRoot: batch.stateRoot,
          withdrawalsRoot: batch.withdrawalsRoot,
        },
        proof,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : "the proof could not be decided";
      log.warn({ batchIndex, reason }, "fraud proof is not decidable; not challenging");
      return { batchIndex, action: "skipped", reason };
    }
    if (!provesFraud) {
      return {
        batchIndex,
        action: "skipped",
        reason: "re-execution does not prove fraud for this batch",
      };
    }
    if (dryRun === true) {
      log.warn({ batchIndex, proofBytes: proof.length }, "dry run: fraud proof ready, not sent");
      return { batchIndex, action: "dry-run" };
    }

    // The transaction names only the index. If the batch was replaced since it was judged,
    // the proof would target a different claim.
    if (current !== undefined) {
      const live = await current(batchIndex);
      if (live === undefined || claimId(live) !== claimId(batch)) {
        return { batchIndex, action: "skipped", reason: "the batch changed since it was judged" };
      }
    }
    if (batch.status === "challenged") return this.resolve(batch);

    const outcome = await sender.send("challenge-batch", (tx) =>
      tx.challengeBatch({ rollupId, batchIndex, proof }),
    );
    alerts.raise({
      key: `challenged:${rollupId}:${String(batchIndex)}:${batch.stateRoot}:${String(batch.submittedAt)}`,
      severity: "critical",
      title: `Challenged invalid batch ${String(batchIndex)} of ${rollupId}`,
      body: `A re-execution fraud proof was submitted.\nTransaction: ${outcome.hash}`,
    });
    return { batchIndex, action: "challenged", hash: outcome.hash };
  }

  /** Asks the chain to settle an open challenge. Harmless if it is already settled. */
  private async resolve(batch: StoredBatch): Promise<ChallengeOutcome> {
    const { rollupId, sender } = this.options;
    const batchIndex = batch.batchIndex;
    try {
      const outcome = await sender.send("resolve-challenge", (tx) =>
        tx.resolveChallenge({ rollupId, batchIndex, fraudUpheld: true }),
      );
      return { batchIndex, action: "resolved", hash: outcome.hash };
    } catch (error) {
      const code = error instanceof TxFailedError ? error.details.code : undefined;
      if (typeof code === "number" && NOTHING_TO_RESOLVE.has(code)) {
        return { batchIndex, action: "skipped", reason: "the challenge is already settled" };
      }
      throw error;
    }
  }
}
