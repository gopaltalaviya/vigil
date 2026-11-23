import { createHash } from "node:crypto";
import {
  claimId,
  ledgerAtSequence,
  serializeLedger,
  toBatchClaim,
  toStoredBatch,
  verifyBatch,
  type Chain,
  type ChainHistory,
  type InboxArchive,
  type Logger,
  type Store,
  type StoredBatch,
  type VerdictKind,
} from "@vigil/core";
import type { AlertDispatcher } from "./alerts.js";

/** What the watchtower reads about a rollup from the base chain. */
export interface RollupView {
  batches(): Promise<StoredBatch[]>;
  inbox(): Promise<{ head: number; consumed: number }>;
  tip(): Promise<{ height: number; timeSecs: number }>;
  challengeWindowSecs(): Promise<number>;
}

/** Rollup reader backed by the base chain. */
export function chainRollupView(chain: Chain, rollupId: string): RollupView {
  return {
    async batches() {
      return (await chain.rdk.rest.listBatches(rollupId)).map(toStoredBatch);
    },
    async inbox() {
      const inbox = await chain.rdk.rest.getInbox(rollupId);
      return { head: inbox.headSequence, consumed: inbox.consumedSequence };
    },
    tip: () => chain.rdk.getChainTip(),
    async challengeWindowSecs() {
      const rollup = await chain.rdk.rest.getRollup(rollupId);
      if (rollup.challengeWindowSec !== undefined && rollup.challengeWindowSec > 0) {
        return rollup.challengeWindowSec;
      }
      return (await chain.rdk.params()).defaultChallengeWindow;
    },
  };
}

export interface WatchtowerOptions {
  chainId: string;
  rollupId: string;
  store: Store;
  archive: InboxArchive;
  view: RollupView;
  alerts: AlertDispatcher;
  log: Logger;
  /** Blocks an inbox entry may wait for a batch before the rollup counts as stalled. */
  stallBlocks?: number;
  /** Seconds before the end of a challenge window at which an open fraud case escalates. */
  deadlineWarnSecs?: number;
  /** Unix seconds. */
  now?: () => number;
}

/** One batch the watchtower judged in a tick. */
export interface JudgedBatch {
  batchIndex: number;
  stateRoot: string;
  verdict: VerdictKind;
  reasons: string[];
}

/** An invalid batch that can still be challenged. */
export interface ChallengeCandidate {
  batch: StoredBatch;
  secondsRemaining: number;
}

export interface TickReport {
  inboxHead: number;
  entriesAdded: number;
  judged: JudgedBatch[];
  challengeable: ChallengeCandidate[];
  alertsRaised: number;
}

export interface BackfillOptions {
  /** This watchtower's own address: a challenge it won is not a miss. */
  self?: string;
  /** The last heartbeat from before this process started, Unix seconds. */
  previousHeartbeat?: number;
  /** A silence longer than this counts as being offline. */
  offlineAfterSecs?: number;
}

export interface BackfillReport {
  /** Rejected claims newly restored from chain events. */
  recovered: number;
  /** Of those, how many this watchtower never saw and did not challenge. */
  missed: number;
  /** Payouts confirmed from chain events. */
  withdrawals: number;
  /** Fraud proofs whose claim could not be found; retried on the next run. */
  unmatched: string[];
}

const FINAL = new Set(["finalized", "rejected"]);

/**
 * Independent checker for one rollup. Each tick it extends its verified copy
 * of the inbox, re-executes every batch it has not judged yet, and raises an
 * alert for anything that is wrong or stuck. It never trusts a submitter's
 * numbers and never needs a key: challenging is a separate, optional step.
 */
export class Watchtower {
  private readonly options: WatchtowerOptions;
  private readonly stallBlocks: number;
  private readonly deadlineWarnSecs: number;
  private readonly now: () => number;

  constructor(options: WatchtowerOptions) {
    this.options = options;
    this.stallBlocks = options.stallBlocks ?? 600;
    this.deadlineWarnSecs = options.deadlineWarnSecs ?? 900;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  }

  /**
   * Runs one round. Pass `flush: false` to deliver alerts later, for example
   * after challenging, so a slow alert destination never delays a challenge.
   */
  async tick(options: { flush?: boolean } = {}): Promise<TickReport> {
    const { store, archive, view, rollupId, alerts } = this.options;
    const sync = await archive.sync();
    const [batches, inbox, tip, windowSecs] = await Promise.all([
      view.batches(),
      view.inbox(),
      view.tip(),
      view.challengeWindowSecs(),
    ]);
    batches.sort((a, b) => a.batchIndex - b.batchIndex || a.submittedAt - b.submittedAt);
    for (const batch of batches) store.upsertBatch(rollupId, batch);
    store.supersedeMissing(rollupId, new Set(batches.map((batch) => claimId(batch))));

    let alertsRaised = 0;
    const judged: JudgedBatch[] = [];
    const challengeable: ChallengeCandidate[] = [];

    for (const batch of batches) {
      // A verdict belongs to the whole claim: a replacement at the same index, even with the
      // same state root, is a different claim and is judged from scratch.
      const identity = shortId(claimId(batch));
      let verdict = store.verdict(rollupId, claimId(batch));
      if (verdict === undefined || verdict.verdict === "undecidable") {
        verdict = this.judge(batch, sync.head);
        store.saveVerdict(rollupId, verdict);
        judged.push({
          batchIndex: batch.batchIndex,
          stateRoot: batch.stateRoot,
          verdict: verdict.verdict,
          reasons: verdict.reasons,
        });
      }
      if (verdict.verdict !== "invalid") continue;

      const secondsRemaining = batch.submittedTime + windowSecs - tip.timeSecs;
      const label = `batch ${String(batch.batchIndex)} of ${rollupId}`;
      const facts =
        `Claimed state root: ${batch.stateRoot}\n` +
        `Re-executed state root: ${verdict.expectedStateRoot}\n` +
        `Mismatch: ${verdict.reasons.join(", ")}`;

      if (batch.status === "finalized") {
        alertsRaised += this.raise({
          key: `finalized-invalid:${rollupId}:${identity}`,
          severity: "critical",
          title: `Invalid ${label} was finalized`,
          body: `${facts}\nThe challenge window closed without a successful challenge.`,
        });
      } else if (batch.status === "rejected") {
        alertsRaised += this.raise({
          key: `rejected:${rollupId}:${identity}`,
          severity: "info",
          title: `Invalid ${label} was rejected by the chain`,
          body: facts,
        });
      } else {
        challengeable.push({ batch, secondsRemaining });
        alertsRaised += this.raise({
          key: `invalid:${rollupId}:${identity}`,
          severity: "critical",
          title: `Invalid ${label}`,
          body: `${facts}\nChallenge window closes in ${formatDuration(secondsRemaining)}.`,
        });
        if (secondsRemaining <= this.deadlineWarnSecs) {
          alertsRaised += this.raise({
            key: `deadline:${rollupId}:${identity}`,
            severity: "critical",
            title: `Challenge window for invalid ${label} is about to close`,
            body: `${facts}\nTime left: ${formatDuration(secondsRemaining)}.`,
          });
        }
      }
    }

    for (const batch of batches) {
      const verdict = store.verdict(rollupId, claimId(batch));
      const secondsRemaining = batch.submittedTime + windowSecs - tip.timeSecs;
      const open = batch.status === "submitted" || batch.status === "challenged";
      if (verdict?.verdict === "undecidable" && open && secondsRemaining <= this.deadlineWarnSecs) {
        alertsRaised += this.raise({
          key: `undecidable:${rollupId}:${shortId(claimId(batch))}`,
          severity: "critical",
          title: `Batch ${String(batch.batchIndex)} of ${rollupId} cannot be checked`,
          body:
            `Its inbox range (${String(batch.inboxStart + 1)}-${String(batch.inboxEnd)}) is not in the verified archive, ` +
            `and its challenge window closes in ${formatDuration(secondsRemaining)}.`,
        });
      }
    }

    if (inbox.head > inbox.consumed) {
      const oldest = store.inboxEntry(rollupId, inbox.consumed + 1);
      const waited = oldest === undefined ? 0 : tip.height - oldest.height;
      if (waited > this.stallBlocks) {
        alertsRaised += this.raise({
          key: `stalled:${rollupId}:${String(inbox.consumed)}:${String(oldest?.height ?? 0)}`,
          severity: "warning",
          title: `Rollup ${rollupId} is not batching its inbox`,
          body:
            `${String(inbox.head - inbox.consumed)} inbox entries are waiting. The oldest has ` +
            `waited ${String(waited)} blocks (limit ${String(this.stallBlocks)}). ` +
            `Deposits and withdrawals in those entries are stuck until a submitter posts a batch.`,
        });
      }
    }

    store.heartbeat(
      "watchtower",
      this.now(),
      JSON.stringify({
        rollupId,
        inboxHead: sync.head,
        batches: batches.length,
        challengeWindowSecs: windowSecs,
      }),
    );
    if (options.flush !== false) await alerts.flush();
    return { inboxHead: sync.head, entriesAdded: sync.added, judged, challengeable, alertsRaised };
  }

  /**
   * Recovers what happened while this watchtower was not looking: an offline
   * gap, claims the chain rejected, and withdrawals it paid. Everything comes
   * from chain events, so it is safe to repeat and works on an empty database.
   * Call it after a tick, so the ledger snapshots it replays from exist.
   */
  async backfill(history: ChainHistory, options: BackfillOptions = {}): Promise<BackfillReport> {
    const { store, archive, rollupId } = this.options;
    const offlineAfterSecs = options.offlineAfterSecs ?? 300;
    const report: BackfillReport = { recovered: 0, missed: 0, withdrawals: 0, unmatched: [] };

    const previous = options.previousHeartbeat;
    if (previous !== undefined && this.now() - previous > offlineAfterSecs) {
      this.raise({
        key: `offline:${rollupId}:${String(previous)}`,
        severity: "warning",
        title: `Watchtower for ${rollupId} was offline`,
        body:
          `No check ran for ${formatDuration(this.now() - previous)}. ` +
          `History for that period was re-read from the chain.`,
      });
    }

    const [frauds, withdrawals, sync] = await Promise.all([
      history.fraud(),
      history.withdrawals(),
      archive.sync(),
    ]);

    const known = new Set(
      store.fraudEvents(rollupId).map((e) => `${e.txHash}:${String(e.batchIndex)}`),
    );
    const stored = new Set(store.batches(rollupId).map((batch) => claimId(batch)));
    const submissions = new Map<number, StoredBatch[]>();
    for (const fraud of frauds) {
      if (known.has(`${fraud.txHash}:${String(fraud.batchIndex)}`)) continue;
      let candidates = submissions.get(fraud.batchIndex);
      if (candidates === undefined) {
        candidates = await history.submissions(fraud.batchIndex);
        submissions.set(fraud.batchIndex, candidates);
      }
      // The rejected claim is the newest submission at that index before the fraud proof.
      const claim = candidates.findLast((batch) => batch.submittedAt < fraud.height);
      if (claim === undefined) {
        report.unmatched.push(fraud.txHash);
        continue;
      }
      const id = claimId(claim);
      const seenLive = stored.has(id);
      store.upsertBatch(rollupId, { ...claim, status: "rejected" });
      stored.add(id);
      if (store.verdict(rollupId, id) === undefined) {
        store.saveVerdict(rollupId, this.judge(claim, sync.head));
      }
      store.saveFraudEvent(rollupId, { ...fraud, claimId: id, seenLive });
      report.recovered += 1;
      if (!seenLive && fraud.challenger !== options.self) {
        report.missed += 1;
        this.raise({
          key: `missed:${rollupId}:${fraud.txHash}:${String(fraud.batchIndex)}`,
          severity: "warning",
          title: `Forged batch ${String(fraud.batchIndex)} of ${rollupId} was rejected while this watchtower was not watching`,
          body:
            `Challenger: ${fraud.challenger}\nSubmitter: ${fraud.submitter}\n` +
            `Fraud proof: ${fraud.txHash} at height ${String(fraud.height)}.`,
        });
      }
    }

    for (const paid of withdrawals) {
      store.saveClaim(rollupId, {
        withdrawalIndex: paid.withdrawalIndex,
        batchIndex: paid.batchIndex,
        txHash: paid.txHash,
      });
      report.withdrawals += 1;
    }
    await this.options.alerts.flush();
    return report;
  }

  private judge(batch: StoredBatch, archiveHead: number) {
    const { chainId, rollupId, store, archive } = this.options;
    const base = {
      claimId: claimId(batch),
      batchIndex: batch.batchIndex,
      stateRoot: batch.stateRoot,
      checkedAt: this.now(),
    };
    if (batch.inboxEnd > archiveHead || batch.inboxStart > batch.inboxEnd) {
      return {
        ...base,
        verdict: "undecidable" as const,
        expectedStateRoot: "",
        expectedWithdrawalsRoot: "",
        reasons: ["inbox_not_archived"],
      };
    }
    const context = { chainId, rollupId, store, archive };
    const result = verifyBatch(toBatchClaim(batch), {
      chainId,
      rollupId,
      parent: ledgerAtSequence(context, batch.inboxStart),
      entries: archive.range(batch.inboxStart, batch.inboxEnd),
      accFrom: archive.accAt(batch.inboxStart),
      accTo: archive.accAt(batch.inboxEnd),
    });
    if (result.verdict === "valid") {
      store.saveSnapshot(rollupId, {
        inboxSequence: batch.inboxEnd,
        ...serializeLedger(result.ledger),
      });
    }
    this.options.log.info(
      { batch: batch.batchIndex, verdict: result.verdict, reasons: result.reasons },
      "batch judged",
    );
    return {
      ...base,
      verdict: result.verdict,
      expectedStateRoot: result.expectedStateRoot,
      expectedWithdrawalsRoot: result.expectedWithdrawalsRoot,
      reasons: [...result.reasons],
    };
  }

  private raise(input: Parameters<AlertDispatcher["raise"]>[0]): number {
    return this.options.alerts.raise(input) ? 1 : 0;
  }
}

/** Whether the chain will take no further action on a batch. */
export function isFinal(batch: StoredBatch): boolean {
  return FINAL.has(batch.status);
}

/** Short, stable tag for a claim, used in alert keys. */
function shortId(claim: string): string {
  return createHash("sha256").update(claim).digest("hex").slice(0, 16);
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "0 minutes (window closed)";
  const minutes = Math.floor(seconds / 60);
  return minutes >= 1 ? `${String(minutes)} minutes` : `${String(seconds)} seconds`;
}
