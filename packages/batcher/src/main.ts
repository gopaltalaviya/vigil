#!/usr/bin/env node
/**
 * Batcher service: a bonded submitter for one rollup. Needs the account's
 * seed phrase in the environment and a submitter bond on the rollup.
 *
 * Usage: vigil-batcher [--once]
 */
import { createServer } from "node:http";
import { join } from "node:path";
import { planQledgerBatch } from "@qorechain/rdk";
import {
  InboxArchive,
  Store,
  chainInboxSource,
  connectTxSender,
  createChain,
  createLogger,
  envInt,
  loadConfig,
  toStoredBatch,
} from "@vigil/core";
import { runLoop } from "@vigil/watchtower";
import { Batcher } from "./batcher.js";

const config = loadConfig();
const log = createLogger({ service: "batcher", level: config.logLevel });
const once = process.argv.includes("--once");
const intervalMs = envInt("BATCHER_INTERVAL_MS", 20_000, { min: 1_000, max: 3_600_000 });
const healthPort = envInt("BATCHER_HEALTH_PORT", 8082, { min: 1, max: 65_535 });

const store = Store.open(join(config.dataDir, "vigil.sqlite"));
const chain = createChain(config);
const sender = await connectTxSender(config, chain.rdk, { store, log });

const batcher = new Batcher({
  chainId: config.chainId,
  rollupId: config.rollupId,
  mode: config.mode,
  store,
  archive: new InboxArchive({
    chainId: config.chainId,
    rollupId: config.rollupId,
    store,
    source: chainInboxSource(chain, config.chainId, config.rollupId),
  }),
  view: {
    async inbox() {
      const inbox = await chain.rdk.rest.getInbox(config.rollupId);
      return { head: inbox.headSequence, consumed: inbox.consumedSequence };
    },
    async batches() {
      return (await chain.rdk.rest.listBatches(config.rollupId)).map(toStoredBatch);
    },
    plan: (ledger) =>
      planQledgerBatch(chain.rdk.rest, {
        chainId: config.chainId,
        rollupId: config.rollupId,
        submitter: sender.address,
        ledger,
      }),
  },
  sender,
  log,
});

const tick = async (): Promise<void> => {
  const report = await batcher.tick();
  store.heartbeat("batcher", Math.floor(Date.now() / 1_000), JSON.stringify(report));
  log.info(report, "tick complete");
};

log.info(
  { rollup: config.rollupId, mode: config.mode, submitter: sender.address, once },
  "batcher starting",
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
  log.info("batcher stopped");
}
