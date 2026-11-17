#!/usr/bin/env node
/**
 * Watchtower service. Reads its settings from the environment, watches one
 * rollup, and exposes `/healthz` for the container runtime.
 *
 * Usage: vigil-watchtower [--once]
 */
import { createServer } from "node:http";
import { join } from "node:path";
import {
  HttpClient,
  InboxArchive,
  Store,
  chainInboxSource,
  createChain,
  createLogger,
  loadConfig,
} from "@vigil/core";
import { AlertDispatcher, telegramSink, webhookSink, type AlertSink } from "./alerts.js";
import { runLoop } from "./loop.js";
import { Watchtower, chainRollupView } from "./watchtower.js";

const config = loadConfig();
const log = createLogger({ service: "watchtower", level: config.logLevel });
const once = process.argv.includes("--once");
const intervalMs = Number(process.env.WATCHTOWER_INTERVAL_MS ?? 15_000);
const healthPort = Number(process.env.WATCHTOWER_HEALTH_PORT ?? 8081);

const store = Store.open(join(config.dataDir, "vigil.sqlite"));
const chain = createChain(config);

const sinks: AlertSink[] = [];
const alertHttp = new HttpClient({ source: "alerts", maxRetries: 2, timeoutMs: 10_000 });
if (config.alerts.telegramBotToken !== undefined && config.alerts.telegramChatId !== undefined) {
  sinks.push(telegramSink(alertHttp, config.alerts.telegramBotToken, config.alerts.telegramChatId));
}
if (config.alerts.webhookUrl !== undefined) {
  sinks.push(webhookSink(alertHttp, config.alerts.webhookUrl));
}

const watchtower = new Watchtower({
  chainId: config.chainId,
  rollupId: config.rollupId,
  store,
  archive: new InboxArchive({
    chainId: config.chainId,
    rollupId: config.rollupId,
    store,
    source: chainInboxSource(chain, config.chainId, config.rollupId),
  }),
  view: chainRollupView(chain, config.rollupId),
  alerts: new AlertDispatcher({ store, sinks, log }),
  log,
});

const tick = async (): Promise<void> => {
  const report = await watchtower.tick();
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
  { rollup: config.rollupId, network: config.network, sinks: sinks.map((s) => s.name), once },
  "watchtower starting",
);

if (once) {
  await tick();
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

  await runLoop({
    tick,
    intervalMs,
    signal: controller.signal,
    log,
    onSuccess: () => {
      lastSuccess = Date.now();
    },
  });
  server.close();
  store.close();
  log.info("watchtower stopped");
}
