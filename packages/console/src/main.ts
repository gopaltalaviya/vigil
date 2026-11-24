#!/usr/bin/env node
/**
 * Operator console: the web app with wallet actions. It serves the same pages
 * as the public API, plus password-protected routes that deposit, transfer,
 * withdraw, claim and send memos with the account configured in the
 * environment.
 *
 * It holds the seed phrase. It listens on 127.0.0.1 unless CONSOLE_HOST says
 * otherwise; reach it over SSH or a VPN rather than exposing it.
 *
 * Usage: vigil-console
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Api, createApiServer } from "@vigil/api";
import {
  ConfigError,
  InboxArchive,
  Store,
  chainHistory,
  chainInboxSource,
  connectTxSender,
  createChain,
  createLogger,
  envInt,
  loadConfig,
  toStoredBatch,
  validateAddress,
  type TxSender,
} from "@vigil/core";
import { memoKeys } from "@vigil/memo";
import { Wallet, createKeystore, openKeystore } from "@vigil/wallet";
import { Operator } from "./operator.js";
import { createConsoleRoutes } from "./routes.js";
import { Sessions } from "./session.js";
import { SiwqSignIn } from "./siwq.js";

const config = loadConfig();
const log = createLogger({ service: "console", level: config.logLevel });
const port = envInt("CONSOLE_PORT", 8090, { min: 1, max: 65_535 });
const host = process.env.CONSOLE_HOST?.trim() ?? "127.0.0.1";
const password = process.env.VIGIL_CONSOLE_PASSWORD?.trim() ?? "";
if (password.length < 12) {
  throw new ConfigError("VIGIL_CONSOLE_PASSWORD must be set to at least 12 characters", {
    problems: [{ variable: "VIGIL_CONSOLE_PASSWORD", problem: "missing or too short" }],
  });
}
const { mnemonic, keystorePassphrase } = config.secrets;
if (mnemonic === undefined || keystorePassphrase === undefined) {
  throw new ConfigError("the console needs QORE_MNEMONIC and VIGIL_KEYSTORE_PASSPHRASE");
}

const staticDir =
  process.env.WEB_APP_DIR ?? fileURLToPath(new URL("../../../apps/web", import.meta.url));
const receiptsContract = process.env.VIGIL_RECEIPTS_ADDRESS?.trim();
const store = Store.open(join(config.dataDir, "vigil.sqlite"));
const chain = createChain(config);
const keystorePath = join(config.dataDir, "keystore.json");

let connected: Promise<TxSender> | undefined;
const sender = (): Promise<TxSender> => {
  connected ??= connectTxSender(config, chain.rdk, { store, log }).catch((error: unknown) => {
    connected = undefined;
    throw error;
  });
  return connected;
};

const wallet = new Wallet({
  chainId: config.chainId,
  rollupId: config.rollupId,
  store,
  archive: new InboxArchive({
    chainId: config.chainId,
    rollupId: config.rollupId,
    store,
    source: chainInboxSource(chain, config.chainId, config.rollupId),
  }),
  paidOut: () => chainHistory(chain.rest, config.restUrl, config.rollupId).withdrawals(),
  view: {
    batches: async () => (await chain.rdk.rest.listBatches(config.rollupId)).map(toStoredBatch),
    async inbox() {
      const inbox = await chain.rdk.rest.getInbox(config.rollupId);
      return { head: inbox.headSequence, consumed: inbox.consumedSequence };
    },
  },
});

const operator = new Operator({
  chainId: config.chainId,
  rollupId: config.rollupId,
  store,
  wallet,
  sender,
  account: () =>
    existsSync(keystorePath) ? openKeystore(keystorePath, keystorePassphrase) : undefined,
  createAccount: () => createKeystore(keystorePath, keystorePassphrase),
  baseBalance: async (address) => BigInt(await chain.rdk.rest.getBalance(address, "uqor")),
  kemKey: async (address) => (await chain.rdk.rest.getKemKey(address))?.publicKey,
  memoKeys: () => memoKeys(mnemonic),
  publishMemoKey: async (from, publicKey) =>
    (await from.send("register-kem-key", (tx) => tx.registerKemKey({ publicKey }))).hash,
});

const api = new Api({
  store,
  rollupId: config.rollupId,
  chainId: config.chainId,
  networks: ["testnet", "mainnet"],
  ...(receiptsContract === undefined || receiptsContract === "" ? {} : { receiptsContract }),
});
const sessions = new Sessions({
  password,
  secureCookie: process.env.CONSOLE_SECURE_COOKIE === "1",
});
// Sign In With QoreChain: the operator's own account, plus any listed in CONSOLE_SIWQ_ADDRESSES.
const extraSignIn = (process.env.CONSOLE_SIWQ_ADDRESSES ?? "")
  .split(",")
  .map((a) => a.trim())
  .filter((a) => a !== "")
  .map((a) => {
    const check = validateAddress(a);
    if (!check.valid) {
      throw new ConfigError("CONSOLE_SIWQ_ADDRESSES holds an invalid address", {
        problems: [{ variable: "CONSOLE_SIWQ_ADDRESSES", problem: check.error }],
      });
    }
    return check.bech32;
  });
const domain = process.env.CONSOLE_DOMAIN?.trim() ?? `127.0.0.1:${String(port)}`;
const siwq = new SiwqSignIn({
  domain,
  uri: `${process.env.CONSOLE_SECURE_COOKIE === "1" ? "https" : "http"}://${domain}/`,
  chainId: config.chainId,
  rest: config.restUrl,
  allowed: async () => [(await sender()).address, ...extraSignIn],
});

const server = createApiServer({
  api,
  staticDir,
  docsDir: process.env.DOCS_DIR ?? fileURLToPath(new URL("../../../docs", import.meta.url)),
  log,
  routes: createConsoleRoutes({ operator, sessions, siwq, log }),
  trustProxy: process.env.TRUST_PROXY === "1",
  cacheSecs: 2,
}).listen(port, host, () => {
  log.info({ host, port, rollup: config.rollupId }, "console listening");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info({ signal }, "shutting down");
    server.close(() => {
      store.close();
    });
  });
}
