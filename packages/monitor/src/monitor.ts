import { createHash } from "node:crypto";
import type { AlertSeverity, HttpClient, Logger, Store } from "@vigil/core";
import type { AlertDispatcher } from "@vigil/watchtower";

/** One base-chain network to watch. */
export interface NetworkTarget {
  name: string;
  rpcUrl: string;
  restUrl: string;
  /** Download manifest published for node operators. */
  manifestUrl: string;
  /** Block time the documentation states, in seconds. */
  documentedBlockTimeSecs: number;
}

/** The public QoreChain networks and their documented block times. */
export const QORECHAIN_NETWORKS: Readonly<Record<"testnet" | "mainnet", NetworkTarget>> = {
  testnet: {
    name: "testnet",
    rpcUrl: "https://rpc-testnet.qore.host",
    restUrl: "https://api-testnet.qore.host",
    manifestUrl: "https://download.qore.host/testnet/latest.json",
    documentedBlockTimeSecs: 1.3,
  },
  mainnet: {
    name: "mainnet",
    rpcUrl: "https://rpc.qore.host",
    restUrl: "https://api.qore.host",
    manifestUrl: "https://download.qore.host/mainnet/latest.json",
    documentedBlockTimeSecs: 3.1,
  },
};

/** Settings whose silent change matters to anyone building on the chain. */
const WATCHED_SOURCES: readonly { source: string; path: string; label: string }[] = [
  {
    source: "upgrade-plan",
    path: "/cosmos/upgrade/v1beta1/current_plan",
    label: "Scheduled upgrade",
  },
  {
    source: "voting-proposals",
    path: "/cosmos/gov/v1/proposals?proposal_status=PROPOSAL_STATUS_VOTING_PERIOD",
    label: "Proposals in voting",
  },
  {
    source: "circuit-breaker",
    path: "/cosmos/circuit/v1/disable_list",
    label: "Disabled message types",
  },
  {
    source: "evm-params",
    path: "/cosmos/evm/vm/v1/params",
    label: "EVM parameters and precompiles",
  },
  { source: "rdk-params", path: "/qorechain/rdk/v1/params", label: "Rollup module parameters" },
  {
    source: "multilayer-params",
    path: "/qorechain/multilayer/v1/params",
    label: "Layer module parameters",
  },
  {
    source: "pqc-params",
    path: "/qorechain/pqc/v1/params",
    label: "Post-quantum module parameters",
  },
  { source: "staking-params", path: "/cosmos/staking/v1beta1/params", label: "Staking parameters" },
];

export interface MonitorOptions {
  network: NetworkTarget;
  http: HttpClient;
  store: Store;
  alerts: AlertDispatcher;
  log: Logger;
  /** Blocks used to measure the average block time. */
  blockTimeWindow?: number;
  /** A tip older than this many documented block times counts as a halt. */
  haltAfterBlockTimes?: number;
  /** Relative drift from the documented block time that raises a warning (0.5 = 50%). */
  driftTolerance?: number;
  /** Unix seconds. */
  now?: () => number;
}

export interface MonitorReport {
  network: string;
  height: number | undefined;
  tipAgeSecs: number | undefined;
  halted: boolean;
  measuredBlockTimeSecs: number | undefined;
  /** Sources whose content changed in this tick. */
  changed: string[];
  /** Sources that could not be read in this tick. */
  unavailable: string[];
}

/** Stable text form of a JSON value: object keys sorted, so equal content hashes equal. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value);
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const field = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>(
    (current, key) =>
      current !== null && typeof current === "object"
        ? (current as Record<string, unknown>)[key]
        : undefined,
    value,
  );

/**
 * Watches one base-chain network. Every tick it reads the tip, measures the
 * block time, and fetches a fixed set of settings. Each answer is stored in
 * canonical form; a change of content becomes a recorded event and an alert.
 * A source that cannot be read is marked unavailable, never treated as changed.
 */
export class BaseChainMonitor {
  private readonly options: MonitorOptions;
  private readonly now: () => number;

  constructor(options: MonitorOptions) {
    this.options = options;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  }

  async tick(): Promise<MonitorReport> {
    const { network, http } = this.options;
    const report: MonitorReport = {
      network: network.name,
      height: undefined,
      tipAgeSecs: undefined,
      halted: false,
      measuredBlockTimeSecs: undefined,
      changed: [],
      unavailable: [],
    };

    await this.checkTip(report);

    const targets = [
      ...WATCHED_SOURCES.map((s) => ({ ...s, url: `${network.restUrl}${s.path}` })),
      { source: "node-manifest", url: network.manifestUrl, label: "Published node release" },
    ];
    for (const target of targets) {
      try {
        const body = canonicalJson(stable(target.source, await http.getJson(target.url)));
        if (this.record(target.source, body, target.label)) report.changed.push(target.source);
      } catch (error) {
        report.unavailable.push(target.source);
        this.markUnavailable(target.source);
        this.options.log.warn({ source: target.source, err: error }, "source unavailable");
      }
    }
    await this.options.alerts.flush();
    return report;
  }

  private async checkTip(report: MonitorReport): Promise<void> {
    const { network, http, store } = this.options;
    const window = this.options.blockTimeWindow ?? 1_000;
    try {
      const status = await http.getJson(`${network.rpcUrl}/status`);
      const height = Number(field(status, "result", "sync_info", "latest_block_height"));
      const tipTime = Date.parse(String(field(status, "result", "sync_info", "latest_block_time")));
      if (!Number.isInteger(height) || Number.isNaN(tipTime)) throw new Error("malformed status");
      const tipSecs = Math.floor(tipTime / 1_000);
      report.height = height;
      report.tipAgeSecs = Math.max(0, this.now() - tipSecs);

      const haltAfter = (this.options.haltAfterBlockTimes ?? 60) * network.documentedBlockTimeSecs;
      report.halted = report.tipAgeSecs > haltAfter;
      if (report.halted) {
        this.raise(
          "tip",
          "critical",
          `halt:${String(height)}`,
          `${label(network.name)} is not producing blocks`,
          [
            `Last block ${String(height)} is ${String(report.tipAgeSecs)} s old.`,
            `Expected a block about every ${String(network.documentedBlockTimeSecs)} s.`,
          ],
        );
      }

      if (height > window) {
        const earlier = await http.getJson(
          `${network.rpcUrl}/header?height=${String(height - window)}`,
        );
        const earlierTime = Date.parse(String(field(earlier, "result", "header", "time")));
        if (!Number.isNaN(earlierTime)) {
          const measured = (tipTime - earlierTime) / 1_000 / window;
          report.measuredBlockTimeSecs = Math.round(measured * 1_000) / 1_000;
          const drift = measured / network.documentedBlockTimeSecs - 1;
          const tolerance = this.options.driftTolerance ?? 0.5;
          if (Math.abs(drift) > tolerance) {
            // One alert per direction, not one per tick.
            this.raise(
              "block-time",
              "warning",
              `drift:${drift > 0 ? "slow" : "fast"}`,
              `${label(network.name)} block time differs from the documented value`,
              [
                `Measured ${String(report.measuredBlockTimeSecs)} s over the last ${String(window)} blocks.`,
                `Documented ${String(network.documentedBlockTimeSecs)} s (${drift > 0 ? "+" : ""}${String(Math.round(drift * 100))}%).`,
                `Anything timed in blocks, such as upgrade heights, arrives ${drift > 0 ? "later" : "earlier"} than the documentation implies.`,
              ],
            );
          }
        }
      }
      const body = canonicalJson({
        height,
        tipTime: tipSecs,
        measuredBlockTimeSecs: report.measuredBlockTimeSecs ?? null,
        halted: report.halted,
      });
      const previous = store.monitorSnapshot(network.name, "tip");
      store.saveMonitorSnapshot({
        network: network.name,
        source: "tip",
        hash: sha256(body),
        body,
        fetchedAt: this.now(),
        changedAt: previous?.changedAt ?? this.now(),
        available: true,
      });
    } catch (error) {
      report.unavailable.push("tip");
      this.markUnavailable("tip");
      this.options.log.warn({ source: "tip", err: error }, "source unavailable");
    }
  }

  /** Stores a source's content. Returns true when it differs from what was stored before. */
  private record(source: string, body: string, label: string): boolean {
    const { network, store } = this.options;
    const hash = sha256(body);
    const previous = store.monitorSnapshot(network.name, source);
    const changed = previous !== undefined && previous.hash !== hash && previous.hash !== "";
    store.saveMonitorSnapshot({
      network: network.name,
      source,
      hash,
      body,
      fetchedAt: this.now(),
      changedAt: previous === undefined || changed ? this.now() : previous.changedAt,
      available: true,
    });
    if (changed) {
      this.raise(source, "warning", `change:${hash}`, `${label} changed on ${network.name}`, [
        describeChange(previous.body, body),
      ]);
    }
    return changed;
  }

  private markUnavailable(source: string): void {
    const { network, store } = this.options;
    const previous = store.monitorSnapshot(network.name, source);
    store.saveMonitorSnapshot({
      network: network.name,
      source,
      hash: previous?.hash ?? "",
      body: previous?.body ?? "null",
      fetchedAt: this.now(),
      changedAt: previous?.changedAt ?? this.now(),
      available: false,
    });
  }

  private raise(
    source: string,
    severity: AlertSeverity,
    key: string,
    title: string,
    lines: string[],
  ): void {
    const { network, store, alerts } = this.options;
    const detail = lines.join("\n");
    const isNew = alerts.raise({
      key: `chain:${network.name}:${source}:${key}`,
      severity,
      title,
      body: detail,
    });
    if (isNew) {
      store.addChainEvent({
        network: network.name,
        source,
        severity,
        title,
        detail,
        createdAt: this.now(),
      });
    }
  }
}

/**
 * Removes parts of an answer that change constantly without meaning anything
 * to a builder. The node manifest republishes its state-sync checkpoint many
 * times a day; only the release itself (version, binary, notes) is tracked.
 */
function stable(source: string, value: unknown): unknown {
  if (source !== "node-manifest" || value === null || typeof value !== "object") return value;
  const release = { ...(value as Record<string, unknown>) };
  delete release.stateSync;
  delete release.releasedAt;
  return release;
}

/** A short, readable account of which top-level parts of a JSON document changed. */
export function describeChange(before: string, after: string): string {
  let a: unknown;
  let b: unknown;
  try {
    a = JSON.parse(before);
    b = JSON.parse(after);
  } catch {
    return "The content changed.";
  }
  const lines: string[] = [];
  const walk = (left: unknown, right: unknown, path: string): void => {
    if (lines.length >= 8) return;
    const bothObjects =
      left !== null &&
      right !== null &&
      typeof left === "object" &&
      typeof right === "object" &&
      !Array.isArray(left) &&
      !Array.isArray(right);
    if (bothObjects) {
      const l = left as Record<string, unknown>;
      const r = right as Record<string, unknown>;
      for (const key of [...new Set([...Object.keys(l), ...Object.keys(r)])].sort()) {
        walk(l[key], r[key], path === "" ? key : `${path}.${key}`);
      }
      return;
    }
    const was = canonicalJson(left ?? null);
    const is = canonicalJson(right ?? null);
    if (was !== is) lines.push(`${path === "" ? "value" : path}: ${clip(was)} -> ${clip(is)}`);
  };
  walk(a, b, "");
  return lines.length === 0 ? "The content changed." : lines.join("\n");
}

const label = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);
const clip = (text: string): string => (text.length > 120 ? `${text.slice(0, 117)}...` : text);
