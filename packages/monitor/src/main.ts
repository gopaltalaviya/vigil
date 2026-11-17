#!/usr/bin/env node
/**
 * Base-chain monitor service: watches the QoreChain testnet and mainnet for
 * halts, block-time drift, upgrades and silent setting changes. Read-only;
 * needs no key.
 *
 * Usage: vigil-monitor [--once]
 */
import { join } from "node:path";
import { HttpClient, Store, createLogger, envInt, loadConfig } from "@vigil/core";
import {
  AlertDispatcher,
  runLoop,
  telegramSink,
  webhookSink,
  type AlertSink,
} from "@vigil/watchtower";
import { BaseChainMonitor, QORECHAIN_NETWORKS } from "./monitor.js";

const config = loadConfig();
const log = createLogger({ service: "monitor", level: config.logLevel });
const once = process.argv.includes("--once");
const intervalMs = envInt("MONITOR_INTERVAL_MS", 60_000, { min: 5_000, max: 3_600_000 });
const store = Store.open(join(config.dataDir, "vigil.sqlite"));

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
const alerts = new AlertDispatcher({ store, sinks, log });

const monitors = Object.values(QORECHAIN_NETWORKS).map(
  (network) =>
    new BaseChainMonitor({
      network,
      http: new HttpClient({
        source: `${network.name}-monitor`,
        timeoutMs: config.http.timeoutMs,
        maxRetries: 2,
        requestsPerMinute: 120,
      }),
      store,
      alerts,
      log,
    }),
);

const tick = async (): Promise<void> => {
  for (const monitor of monitors) log.info(await monitor.tick(), "network checked");
  store.heartbeat("monitor", Math.floor(Date.now() / 1_000));
};

log.info({ networks: Object.keys(QORECHAIN_NETWORKS), once }, "monitor starting");
if (once) {
  await tick();
  store.close();
} else {
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      log.info({ signal }, "shutting down");
      controller.abort();
    });
  }
  await runLoop({ tick, intervalMs, signal: controller.signal, log });
  store.close();
  log.info("monitor stopped");
}
