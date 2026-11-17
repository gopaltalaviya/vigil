import { buildQledgerFraudProof, checkQledgerFraud } from "@qorechain/rdk";
import {
  TxFailedError,
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
}

export type ChallengeOutcome =
  | { batchIndex: number; action: "challenged"; hash: string }
  | { batchIndex: number; action: "dry-run" }
  | { batchIndex: number; action: "resolved"; hash: string }
  | { batchIndex: number; action: "skipped"; reason: string };

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

  async challengeAll(candidates: readonly ChallengeCandidate[]): Promise<ChallengeOutcome[]> {
    const outcomes: ChallengeOutcome[] = [];
    for (const candidate of candidates) outcomes.push(await this.challenge(candidate));
    return outcomes;
  }

  async challenge(candidate: ChallengeCandidate): Promise<ChallengeOutcome> {
    const { chainId, rollupId, archive, sender, alerts, log, dryRun } = this.options;
    const { batch } = candidate;
    const batchIndex = batch.batchIndex;

    if (batch.status === "challenged") return this.resolve(batch);
    if (candidate.secondsRemaining <= 0) {
      return { batchIndex, action: "skipped", reason: "the challenge window has closed" };
    }

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

    const outcome = await sender.send("challenge-batch", (tx) =>
      tx.challengeBatch({ rollupId, batchIndex, proof }),
    );
    alerts.raise({
      key: `challenged:${rollupId}:${String(batchIndex)}:${batch.stateRoot}`,
      severity: "critical",
      title: `Challenged invalid batch ${String(batchIndex)} of ${rollupId}`,
      body: `A re-execution fraud proof was submitted.\nTransaction: ${outcome.hash}`,
    });
    return { batchIndex, action: "challenged", hash: outcome.hash };
  }

  /** Asks the chain to settle an open challenge. Harmless if it is already settled. */
  private async resolve(batch: StoredBatch): Promise<ChallengeOutcome> {
    const { rollupId, sender, dryRun } = this.options;
    const batchIndex = batch.batchIndex;
    if (dryRun === true) return { batchIndex, action: "dry-run" };
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
