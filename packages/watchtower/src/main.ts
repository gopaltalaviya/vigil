#!/usr/bin/env node
/**
 * Watchtower service. Reads its settings from the environment, watches one
 * rollup, and exposes `/healthz` for the container runtime.
 *
 * Usage: vigil-watchtower [--once]
 *
 * WATCHTOWER_CHALLENGE controls what happens when a batch is found invalid:
 * `off` (default) only alerts, `dry-run` also builds and checks the fraud
 * proof, `on` submits the challenge and needs the account's seed phrase.
 */
import { createServer } from "node:http";
import { inspectTransaction } from "@qorechain/qoresign/network";
import { join } from "node:path";
import {
  HttpClient,
  InboxArchive,
  Store,
  ConfigError,
  chainInboxSource,
  connectTxSender,
  createChain,
  createLogger,
  envInt,
  findSubmissionTx,
  chainHistory,
  loadConfig,
  toStoredBatch,
} from "@vigil/core";
import { AlertDispatcher, telegramSink, webhookSink, type AlertSink } from "./alerts.js";
import { RollupAuditor } from "./audit.js";
import { Challenger } from "./challenger.js";
import { runLoop } from "./loop.js";
import { PqLayerChecker } from "./pq-layer.js";
import { Watchtower, chainRollupView } from "./watchtower.js";

const config = loadConfig();
const log = createLogger({ service: "watchtower", level: config.logLevel });
const once = process.argv.includes("--once");
const intervalMs = envInt("WATCHTOWER_INTERVAL_MS", 15_000, { min: 1_000, max: 3_600_000 });
const healthPort = envInt("WATCHTOWER_HEALTH_PORT", 8081, { min: 1, max: 65_535 });

const store = Store.open(join(config.dataDir, "vigil.sqlite"));
const chain = createChain(config);

const sinks: AlertSink[] = [];
// Alert URLs carry credentials, so this client never puts a path into an error.
const alertHttp = new HttpClient({
  source: "alerts",
  maxRetries: 2,
  timeoutMs: 10_000,
  secretUrls: true,
});
if (config.alerts.telegramBotToken !== undefined && config.alerts.telegramChatId !== undefined) {
  sinks.push(telegramSink(alertHttp, config.alerts.telegramBotToken, config.alerts.telegramChatId));
}
if (config.alerts.webhookUrl !== undefined) {
  sinks.push(webhookSink(alertHttp, config.alerts.webhookUrl));
}

const archive = new InboxArchive({
  chainId: config.chainId,
  rollupId: config.rollupId,
  store,
  source: chainInboxSource(chain, config.chainId, config.rollupId),
});
const alerts = new AlertDispatcher({ store, sinks, log });
const shared = { chainId: config.chainId, rollupId: config.rollupId, store, archive, alerts, log };
const watchtower = new Watchtower({ ...shared, view: chainRollupView(chain, config.rollupId) });

const challengeMode = process.env.WATCHTOWER_CHALLENGE ?? "off";
if (!["off", "dry-run", "on"].includes(challengeMode)) {
  throw new ConfigError("WATCHTOWER_CHALLENGE must be off, dry-run or on");
}
const sender =
  challengeMode === "off" ? undefined : await connectTxSender(config, chain.rdk, { store, log });
const challenger =
  sender === undefined
    ? undefined
    : new Challenger({
        ...shared,
        sender,
        dryRun: challengeMode === "dry-run",
        current: async (batchIndex) =>
          toStoredBatch(await chain.rdk.rest.getBatch(config.rollupId, batchIndex)),
      });

const history = chainHistory(chain.rest, config.restUrl, config.rollupId);
const BACKFILL_EVERY_MS = 10 * 60_000;
// Read before the first tick overwrites it: this is how long the watchtower was away.
let previousHeartbeat = store.heartbeats().find((beat) => beat.service === "watchtower")?.at;
let nextBackfill = 0;

/** Re-reads rejected claims and payouts from the chain. A failure never stops the watch. */
const backfill = async (): Promise<void> => {
  if (Date.now() < nextBackfill) return;
  try {
    const report = await watchtower.backfill(history, {
      ...(sender === undefined ? {} : { self: sender.address }),
      ...(previousHeartbeat === undefined ? {} : { previousHeartbeat }),
    });
    previousHeartbeat = undefined;
    nextBackfill = Date.now() + BACKFILL_EVERY_MS;
    if (report.recovered > 0 || report.unmatched.length > 0)
      log.warn({ report }, "history restored");
  } catch (error) {
    nextBackfill = Date.now() + 60_000;
    log.error({ err: error }, "could not read history from the chain; will retry");
  }
};

const pqChecker = new PqLayerChecker({
  rollupId: config.rollupId,
  store,
  log,
  inspect: (txhash) =>
    inspectTransaction({
      rest: config.restUrl,
      rpc: config.rpcUrl,
      chainId: config.chainId,
      txhash,
    }),
  findSubmission: (batchIndex, height) =>
    findSubmissionTx(chain.rest, config.restUrl, config.rollupId, batchIndex, height),
});
let pqRun: Promise<void> | undefined;
/** Runs beside the watch: reading signatures must never delay a challenge. */
const checkPqLayers = (): void => {
  if (pqRun !== undefined) return;
  pqRun = pqChecker
    .checkPending()
    .then(() => undefined)
    .catch((error: unknown) => {
      log.warn({ err: error }, "PQ layer check failed; will retry");
    })
    .finally(() => {
      pqRun = undefined;
    });
};

const tick = async (): Promise<void> => {
  // Challenge first, deliver alerts second: a slow chat API must not delay a fraud proof.
  const report = await watchtower.tick({ flush: false });
  if (challenger !== undefined && report.challengeable.length > 0) {
    const outcomes = await challenger.challengeAll(report.challengeable);
    log.warn({ outcomes }, "challenge outcomes");
  }
  await alerts.flush();
  await backfill();
  checkPqLayers();
  log.info(
    {
      inboxHead: report.inboxHead,
      entriesAdded: report.entriesAdded,
      judged: report.judged.length,
      challengeable: report.challengeable.length,
      alertsRaised: report.alertsRaised,
    },
    "tick complete",
  );
};

log.info(
  {
    rollup: config.rollupId,
    network: config.network,
    sinks: sinks.map((s) => s.name),
    challenge: challengeMode,
    once,
  },
  "watchtower starting",
);

// Other teams' rollups: read-only and alert-only. It runs beside the main loop on its own
// clients, so a slow or failing foreign read can never delay a check of our own rollup.
const auditEveryMs = envInt("WATCHTOWER_AUDIT_INTERVAL_MS", 30 * 60_000, {
  min: 60_000,
  max: 86_400_000,
});
const auditor = new RollupAuditor({
  chain: createChain(config),
  chainId: config.chainId,
  ownRollupId: config.rollupId,
  store,
  alerts,
  log,
});
const auditRollups = async (): Promise<void> => {
  try {
    const audits = await auditor.runOnce();
    log.info({ rollups: audits.length }, "rollup audit complete");
  } catch (error) {
    log.warn({ err: error }, "rollup audit failed; will retry");
  }
};

if (once) {
  await tick();
  // The PQ check runs beside the tick; let it finish before the database closes.
  await pqRun;
  store.close();
} else {
  let lastSuccess = 0;
  const controller = new AbortController();
  const server = createServer((request, response) => {
    const healthy = Date.now() - lastSuccess < Math.max(4 * intervalMs, 120_000);
    const ok = request.url === "/healthz" && healthy;
    response.writeHead(ok ? 200 : request.url === "/healthz" ? 503 : 404, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ ok, lastSuccess }));
  }).listen(healthPort);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      log.info({ signal }, "shutting down");
      controller.abort();
    });
  }

  let auditing = false;
  const runAudit = (): void => {
    if (auditing) return;
    auditing = true;
    void auditRollups().finally(() => {
      auditing = false;
    });
  };
  const auditTimer = setInterval(runAudit, auditEveryMs);
  runAudit();

  await runLoop({
    tick,
    intervalMs,
    signal: controller.signal,
    log,
    onSuccess: () => {
      lastSuccess = Date.now();
    },
    // A watchtower that cannot see the chain is blind; say so instead of failing quietly.
    onFailure: (failures, error) => {
      if (failures !== 5) return;
      alerts.raise({
        key: `watchtower-blind:${config.rollupId}:${String(Math.floor(Date.now() / 3_600_000))}`,
        severity: "critical",
        title: `Watchtower for ${config.rollupId} cannot check batches`,
        body: `Five rounds in a row failed. Last error: ${error instanceof Error ? error.message : "unknown"}`,
      });
      void alerts.flush();
    },
  });
  clearInterval(auditTimer);
  server.close();
  store.close();
  log.info("watchtower stopped");
}
