import { claimId, type Store, type StoredBatch } from "@vigil/core";
import { Explorer } from "./explorer.js";

export interface ApiOptions {
  store: Store;
  rollupId: string;
  chainId: string;
  /** Address of the receipts contract, if deployed. */
  receiptsContract?: string;
  networks: readonly string[];
  /** Unix seconds. */
  now?: () => number;
}

export interface ApiResponse {
  status: number;
  contentType: string;
  body: string;
}

interface BatchView {
  index: number;
  status: string;
  stateRoot: string;
  entries: { from: number; to: number };
  submittedTime: number;
  verdict: string;
  reasons: string[];
  receipt: { txHash: string; contract: string } | undefined;
}

interface TipView {
  height: number;
  tipTime: number;
  measuredBlockTimeSecs: number | null;
  halted: boolean;
}

const json = (status: number, value: unknown): ApiResponse => ({
  status,
  contentType: "application/json; charset=utf-8",
  body: JSON.stringify(value),
});

/**
 * Read-only view of what Vigil knows, served from the local database only.
 * The API never talks to the chain and never touches a key, so exposing it
 * publicly cannot move funds or leak secrets.
 */
export class Api {
  private readonly options: ApiOptions;
  private readonly now: () => number;
  private readonly explorer: Explorer;

  constructor(options: ApiOptions) {
    this.options = options;
    this.explorer = new Explorer(options);
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  }

  /** Answers a GET request for `path` (without query string). */
  handle(path: string): ApiResponse {
    switch (path) {
      case "/healthz":
        return json(200, { ok: true });
      case "/api/overview":
        return json(200, this.overview());
      case "/metrics":
        return {
          status: 200,
          contentType: "text/plain; version=0.0.4; charset=utf-8",
          body: this.metrics(),
        };
      case "/api/session":
        // The read-only server has no console. The operator console answers this itself.
        return json(200, { console: false, signedIn: false });
      case "/api/entries":
        return json(200, { entries: this.explorer.recentEntries(50) });
      default:
        return this.lookup(path);
    }
  }

  /** Routes with a parameter: one batch, one account. */
  private lookup(path: string): ApiResponse {
    const batch = /^\/api\/batches\/(\d{1,9})$/.exec(path);
    if (batch?.[1] !== undefined) {
      const detail = this.batchDetail(Number(batch[1]));
      return detail === undefined ? json(404, { error: "no such batch" }) : json(200, detail);
    }
    const account = /^\/api\/accounts\/([0-9a-fA-F]{64})$/.exec(path);
    if (account?.[1] !== undefined) {
      return json(200, this.explorer.account(account[1].toLowerCase()));
    }
    return json(404, { error: "not found" });
  }

  /** Everything known about the batches at one index, with their inbox entries decoded. */
  batchDetail(index: number) {
    const { store, rollupId } = this.options;
    const receipts = new Map(
      store.receipts(rollupId).map((r) => [`${String(r.batchIndex)}:${r.stateRoot}`, r]),
    );
    const claims = store.batches(rollupId).filter((batch) => batch.batchIndex === index);
    const current = claims.findLast((batch) => batch.status !== "rejected") ?? claims.at(-1);
    if (current === undefined) return undefined;
    const verdict = store.verdict(rollupId, claimId(current));
    return {
      batch: {
        ...this.batchView(current, receipts),
        prevStateRoot: current.prevStateRoot,
        withdrawalsRoot: current.withdrawalsRoot,
        dataHash: current.dataHash,
        submittedAtHeight: current.submittedAt,
        finalizedAtHeight: current.finalizedAt,
        expectedStateRoot: verdict?.expectedStateRoot ?? null,
        expectedWithdrawalsRoot: verdict?.expectedWithdrawalsRoot ?? null,
        checkedAt: verdict?.checkedAt ?? null,
      },
      // Earlier claims at this index that the chain rejected.
      rejectedClaims: claims
        .filter((batch) => batch !== current)
        .map((batch) => this.batchView(batch, receipts)),
      entries: this.explorer.entries(current.inboxStart, current.inboxEnd),
    };
  }

  overview() {
    const { store, rollupId, chainId, receiptsContract, networks } = this.options;
    // A receipt belongs to the state root it was recorded for, not just to an index.
    const receipts = new Map(
      store.receipts(rollupId).map((r) => [`${String(r.batchIndex)}:${r.stateRoot}`, r]),
    );
    const batches = store.batches(rollupId).map((batch) => this.batchView(batch, receipts));
    const judged = batches.filter((b) => b.verdict !== "pending");
    return {
      generatedAt: this.now(),
      // When each service last finished a round. A page that only knew the API was up could
      // say "all valid" while the watchtower was dead.
      services: store.heartbeats().map((beat) => ({
        service: beat.service,
        lastSeen: beat.at,
        ageSecs: Math.max(0, this.now() - beat.at),
      })),
      rollup: {
        id: rollupId,
        // The rollup's own window, as last read from the chain by the watchtower.
        challengeWindowSecs: this.challengeWindowSecs(),
        chainId,
        receiptsContract: receiptsContract ?? null,
        inboxEntriesArchived: store.lastInboxEntry(rollupId)?.sequence ?? 0,
        batches: batches.reverse(),
        summary: {
          batches: batches.length,
          valid: judged.filter((b) => b.verdict === "valid").length,
          invalid: judged.filter((b) => b.verdict === "invalid").length,
          finalized: batches.filter((b) => b.status === "finalized").length,
          receiptsRecorded: batches.filter((b) => b.receipt !== undefined).length,
        },
      },
      // Base-chain conditions have their own feed; this one is about the rollup.
      alerts: store
        .recentAlerts(50)
        .filter((alert) => !alert.key.startsWith("chain:"))
        .slice(0, 20)
        .map((alert) => ({
          severity: alert.severity,
          title: alert.title,
          body: alert.body,
          createdAt: alert.createdAt,
        })),
      chain: networks.map((network) => this.networkView(network)),
      chainEvents: store.recentChainEvents(30).map((event) => ({
        network: event.network,
        source: event.source,
        severity: event.severity,
        title: event.title,
        detail: event.detail,
        createdAt: event.createdAt,
      })),
    };
  }

  private batchView(
    batch: StoredBatch,
    receipts: Map<string, { txHash: string; contract: string }>,
  ): BatchView {
    const verdict = this.options.store.verdict(this.options.rollupId, claimId(batch));
    const receipt =
      batch.status === "rejected"
        ? undefined
        : receipts.get(`${String(batch.batchIndex)}:${batch.stateRoot}`);
    return {
      index: batch.batchIndex,
      status: batch.status,
      stateRoot: batch.stateRoot,
      entries: { from: batch.inboxStart + 1, to: batch.inboxEnd },
      submittedTime: batch.submittedTime,
      verdict: verdict?.verdict ?? "pending",
      reasons: verdict?.reasons ?? [],
      receipt:
        receipt === undefined ? undefined : { txHash: receipt.txHash, contract: receipt.contract },
    };
  }

  private networkView(network: string) {
    const snapshots = this.options.store.monitorSnapshots(network);
    const tipSnapshot = snapshots.find((s) => s.source === "tip");
    const tip: TipView | null =
      tipSnapshot !== undefined && tipSnapshot.body !== "null"
        ? (JSON.parse(tipSnapshot.body) as TipView)
        : null;
    return {
      network,
      tip,
      tipAvailable: tipSnapshot?.available ?? false,
      checkedAt: tipSnapshot?.fetchedAt ?? null,
      sources: snapshots
        .filter((s) => s.source !== "tip")
        .map((s) => ({
          source: s.source,
          available: s.available,
          checkedAt: s.fetchedAt,
          changedAt: s.changedAt,
        })),
    };
  }

  private challengeWindowSecs(): number {
    const beat = this.options.store.heartbeats().find((b) => b.service === "watchtower");
    try {
      const value = (JSON.parse(beat?.detail ?? "{}") as { challengeWindowSecs?: unknown })
        .challengeWindowSecs;
      return typeof value === "number" && value > 0 ? value : 3_600;
    } catch {
      return 3_600;
    }
  }

  /** Prometheus text exposition. */
  metrics(): string {
    const overview = this.overview();
    const lines: string[] = [];
    const gauge = (name: string, help: string, samples: [string, number][]): void => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
      for (const [labels, value] of samples) lines.push(`${name}${labels} ${String(value)}`);
    };
    const rollup = `rollup="${overview.rollup.id}"`;
    gauge("vigil_batches", "Batches seen on the rollup, by watchtower verdict.", [
      [`{${rollup},verdict="valid"}`, overview.rollup.summary.valid],
      [`{${rollup},verdict="invalid"}`, overview.rollup.summary.invalid],
      [
        `{${rollup},verdict="pending"}`,
        overview.rollup.summary.batches -
          overview.rollup.summary.valid -
          overview.rollup.summary.invalid,
      ],
    ]);
    gauge("vigil_batches_finalized", "Batches the base chain has finalized.", [
      [`{${rollup}}`, overview.rollup.summary.finalized],
    ]);
    gauge("vigil_receipts_recorded", "Settlement receipts recorded on chain.", [
      [`{${rollup}}`, overview.rollup.summary.receiptsRecorded],
    ]);
    gauge("vigil_inbox_entries_archived", "Inbox entries in the verified local archive.", [
      [`{${rollup}}`, overview.rollup.inboxEntriesArchived],
    ]);
    gauge("vigil_alerts_undelivered", "Alerts waiting for delivery.", [
      ["", this.options.store.undeliveredAlerts().length],
    ]);
    const withTip = overview.chain.flatMap((c) => (c.tip === null ? [] : [{ ...c, tip: c.tip }]));
    gauge(
      "vigil_chain_height",
      "Latest base-chain block height seen.",
      withTip.map((c) => [`{network="${c.network}"}`, c.tip.height]),
    );
    gauge(
      "vigil_chain_halted",
      "1 if the base chain is not producing blocks.",
      withTip.map((c) => [`{network="${c.network}"}`, c.tip.halted ? 1 : 0]),
    );
    gauge(
      "vigil_chain_block_time_seconds",
      "Average block time measured over recent blocks.",
      withTip.flatMap((c): [string, number][] =>
        c.tip.measuredBlockTimeSecs === null
          ? []
          : [[`{network="${c.network}"}`, c.tip.measuredBlockTimeSecs]],
      ),
    );
    return `${lines.join("\n")}\n`;
  }
}
