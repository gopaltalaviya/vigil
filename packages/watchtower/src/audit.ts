import {
  EMPTY_INBOX_ACC,
  QledgerLedger,
  buildQledgerFraudProof,
  checkQledgerFraud,
  qledgerAccumulate,
  type QledgerEntry,
  type RollupView as ChainRollup,
} from "@qorechain/rdk";
import {
  InboxArchive,
  chainInboxSource,
  toBatchClaim,
  toStoredBatch,
  verifyBatch,
  type Chain,
  type Logger,
  type Store,
  type StoredAuditFinding,
  type StoredBatch,
  type StoredRollupAudit,
} from "@vigil/core";
import type { AlertDispatcher } from "./alerts.js";

/** Result of replaying one rollup's batches from its genesis. */
export interface ReplayResult {
  checked: number;
  matched: number;
  findings: StoredAuditFinding[];
}

/** Why a rollup cannot be re-executed by this checker, or undefined when it can. */
export function notJudgeableReason(rollup: ChainRollup): string | undefined {
  if (rollup.executionVm !== "qledger-v1") {
    return `${rollup.settlementMode}, ${rollup.vmType} VM: not a qledger-v1 rollup`;
  }
  if (rollup.settlementMode !== "optimistic") {
    return `${rollup.settlementMode} settlement: no fraud proofs`;
  }
  return undefined;
}

/**
 * Replays every standing batch from an empty ledger and compares each claim.
 * A finding is `proven` only when the chain's own fraud check, run locally,
 * confirms it. This function reads and computes; it can send nothing.
 */
export function replayRollup(
  env: { chainId: string; rollupId: string },
  batches: readonly StoredBatch[],
  entries: readonly QledgerEntry[],
): ReplayResult {
  const standing = batches
    .filter((batch) => batch.status !== "rejected")
    .sort((a, b) => a.batchIndex - b.batchIndex);
  const accs: Uint8Array[] = [EMPTY_INBOX_ACC];
  entries.forEach((entry, position) => {
    const accFrom = accs[position] ?? EMPTY_INBOX_ACC;
    accs.push(qledgerAccumulate({ ...env, from: position, accFrom, entries: [entry] }));
  });

  let ledger = new QledgerLedger();
  let cursor = 0;
  let matched = 0;
  const findings: StoredAuditFinding[] = [];
  for (const batch of standing) {
    const accFrom = accs[batch.inboxStart];
    const accTo = accs[batch.inboxEnd];
    if (batch.inboxStart !== cursor || accFrom === undefined || accTo === undefined) {
      throw new Error(`batch ${String(batch.batchIndex)} does not continue the inbox`);
    }
    const range = entries.slice(batch.inboxStart, batch.inboxEnd);
    const verdict = verifyBatch(toBatchClaim(batch), {
      ...env,
      parent: ledger,
      entries: [...range],
      accFrom,
      accTo,
    });
    if (verdict.verdict === "valid") {
      matched += 1;
    } else {
      let proven: boolean;
      try {
        const { proof } = buildQledgerFraudProof(env, ledger, accFrom, [...range]);
        proven = checkQledgerFraud(
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
      } catch {
        proven = false;
      }
      findings.push({
        batchIndex: batch.batchIndex,
        status: batch.status,
        reasons: [...verdict.reasons],
        proven,
        claimedStateRoot: batch.stateRoot,
        expectedStateRoot: verdict.expectedStateRoot,
        claimedWithdrawalsRoot: batch.withdrawalsRoot,
        expectedWithdrawalsRoot: verdict.expectedWithdrawalsRoot,
      });
    }
    ledger = verdict.ledger;
    cursor = batch.inboxEnd;
  }
  return { checked: standing.length, matched, findings };
}

export interface RollupAuditorOptions {
  /** A chain client of its own, so foreign reads never trip the main watch's circuit breaker. */
  chain: Chain;
  chainId: string;
  /** The rollup this watchtower defends; it is watched by the main loop instead. */
  ownRollupId: string;
  store: Store;
  alerts: AlertDispatcher;
  log: Logger;
  now?: () => number;
}

/**
 * Audits other teams' rollups and raises alerts. It holds no key and no
 * transaction sender, so it has no way to challenge anything.
 */
export class RollupAuditor {
  private readonly options: RollupAuditorOptions;
  private readonly now: () => number;

  constructor(options: RollupAuditorOptions) {
    this.options = options;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  }

  /** Audits every rollup on the chain except our own. One failure never stops the rest. */
  async runOnce(): Promise<StoredRollupAudit[]> {
    const { chain, ownRollupId, store, log } = this.options;
    const results: StoredRollupAudit[] = [];
    for (const rollup of await chain.rdk.rest.listRollups()) {
      if (rollup.rollupId === ownRollupId) continue;
      let audit: StoredRollupAudit;
      try {
        audit = await this.audit(rollup);
      } catch (error) {
        log.warn({ rollup: rollup.rollupId, err: error }, "rollup audit failed");
        audit = this.record(rollup, "error", {
          reason: error instanceof Error ? error.message.slice(0, 200) : "unknown error",
        });
      }
      store.saveRollupAudit(audit);
      this.alert(audit);
      results.push(audit);
    }
    await this.options.alerts.flush();
    return results;
  }

  private async audit(rollup: ChainRollup): Promise<StoredRollupAudit> {
    const reason = notJudgeableReason(rollup);
    if (reason !== undefined) return this.record(rollup, "not_judgeable", { reason });

    const { chain, chainId, store } = this.options;
    const rollupId = rollup.rollupId;
    // Batches first: every batch they list consumes entries at or below the head synced next.
    const batches = (await chain.rdk.rest.listBatches(rollupId)).map(toStoredBatch);
    // A persisted, accumulator-checked copy of the inbox: each audit reads only the new posts,
    // and the replay keeps working after the chain prunes the posted data of old entries.
    const archive = new InboxArchive({
      chainId,
      rollupId,
      store,
      source: chainInboxSource(chain, chainId, rollupId),
    });
    const { head } = await archive.sync();
    const entries = archive.range(0, head);
    const replay = replayRollup({ chainId, rollupId }, batches, entries);
    return this.record(rollup, replay.findings.some((f) => f.proven) ? "fraud_found" : "clean", {
      batches: replay.checked,
      matched: replay.matched,
      findings: replay.findings,
    });
  }

  private record(
    rollup: ChainRollup,
    status: StoredRollupAudit["status"],
    details: Partial<Pick<StoredRollupAudit, "reason" | "batches" | "matched" | "findings">>,
  ): StoredRollupAudit {
    return {
      rollupId: rollup.rollupId,
      status,
      reason: details.reason ?? "",
      vm: rollup.executionVm === "" ? rollup.vmType : rollup.executionVm,
      settlement: rollup.settlementMode,
      chainStatus: rollup.status,
      batches: details.batches ?? 0,
      matched: details.matched ?? 0,
      findings: details.findings ?? [],
      checkedAt: this.now(),
    };
  }

  private alert(audit: StoredRollupAudit): void {
    for (const finding of audit.findings) {
      if (!finding.proven) continue;
      const open = finding.status === "submitted" || finding.status === "challenged";
      this.options.alerts.raise({
        key: `foreign-fraud:${audit.rollupId}:${String(finding.batchIndex)}:${finding.claimedStateRoot}:${finding.claimedWithdrawalsRoot}`,
        severity: open ? "critical" : "warning",
        title: `Provable fraud in batch ${String(finding.batchIndex)} of ${audit.rollupId}`,
        body:
          `Status on chain: ${finding.status}. Mismatch: ${finding.reasons.join(", ")}.\n` +
          `Alert only: this watchtower does not challenge other teams' rollups.`,
      });
    }
  }
}
