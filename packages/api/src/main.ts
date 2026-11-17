#!/usr/bin/env node
/**
 * Serves the read-only API, Prometheus metrics and the status page.
 * Holds no key and makes no chain requests: it only reads the local database.
 *
 * Usage: vigil-api
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, createLogger, envInt, loadConfig } from "@vigil/core";
import { Api } from "./api.js";
import { createApiServer } from "./server.js";

const config = loadConfig();
const log = createLogger({ service: "api", level: config.logLevel });
const port = envInt("API_PORT", 8080, { min: 1, max: 65_535 });
const staticDir =
  process.env.STATUS_PAGE_DIR ?? fileURLToPath(new URL("../../../apps/web", import.meta.url));
const receiptsContract = process.env.VIGIL_RECEIPTS_ADDRESS?.trim();

const store = Store.open(join(config.dataDir, "vigil.sqlite"));
const api = new Api({
  store,
  rollupId: config.rollupId,
  chainId: config.chainId,
  networks: ["testnet", "mainnet"],
  ...(receiptsContract === undefined || receiptsContract === "" ? {} : { receiptsContract }),
});
const server = createApiServer({
  api,
  staticDir,
  docsDir: process.env.DOCS_DIR ?? fileURLToPath(new URL("../../../docs", import.meta.url)),
  log,
  trustProxy: process.env.TRUST_PROXY === "1",
}).listen(port, () => {
  log.info({ port, rollup: config.rollupId }, "api listening");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info({ signal }, "shutting down");
    server.close(() => {
      store.close();
    });
  });
}
