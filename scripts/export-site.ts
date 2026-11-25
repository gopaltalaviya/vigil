/**
 * Writes a static, read-only mirror of the web app: the app's files, the docs, and every API
 * answer the pages ask for, as JSON files. Any static host can serve it, under any base path
 * (GitHub Pages serves a project at /<repository>/), because every URL in it is relative.
 *
 * The answers come from `Api.handle`, the same code the live API runs, over a Vigil database.
 * Take a consistent copy of the live one first (`deploy/backup.sh`), then:
 *
 *   pnpm export:site --db backups/vigil-<stamp>.sqlite --out out/site
 *
 * Exported: overview, rollup audits, recent entries, every batch, every rollup account and every
 * withdrawal recipient seen in the inbox. Nothing else can be looked up in the mirror, and
 * nothing can be sent: the wallet and sign-in need the operator console.
 */
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, loadConfig } from "@vigil/core";
import { Api } from "@vigil/api";

const root = fileURLToPath(new URL("..", import.meta.url));
const option = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};

const config = loadConfig();
const dbPath = option("db") ?? join(config.dataDir, "vigil.sqlite");
const out = option("out") ?? join(root, "out", "site");
const receiptsContract = process.env.VIGIL_RECEIPTS_ADDRESS?.trim();

const store = Store.open(dbPath);
const api = new Api({
  store,
  rollupId: config.rollupId,
  chainId: config.chainId,
  networks: ["testnet", "mainnet"],
  ...(receiptsContract === undefined || receiptsContract === "" ? {} : { receiptsContract }),
});

rmSync(out, { recursive: true, force: true });
const web = join(root, "apps", "web");
cpSync(web, out, { recursive: true, filter: (path) => !path.endsWith(".d.ts") });
mkdirSync(join(out, "docs"), { recursive: true });
for (const name of readdirSync(join(root, "docs"))) {
  if (/^[A-Z][A-Z_]{1,40}\.md$/.test(name))
    cpSync(join(root, "docs", name), join(out, "docs", name));
}

let written = 0;
/** Saves the API's answer for `path` as `<path>.json`, relative to the mirror's root. */
function save(path: string): void {
  const response = api.handle(path);
  if (response.status !== 200) throw new Error(`${path} answered ${String(response.status)}`);
  const file = join(out, `${path.slice(1)}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, response.body);
  written += 1;
}

const exportedAt = new Date(api.overview().generatedAt * 1_000).toISOString();
for (const path of ["/api/overview", "/api/rollups", "/api/entries"]) save(path);
writeFileSync(
  join(out, "api", "session.json"),
  JSON.stringify({ console: false, signedIn: false }),
);

const indices = new Set(store.batches(config.rollupId).map((batch) => batch.batchIndex));
for (const index of [...indices].sort((a, b) => a - b)) save(`/api/batches/${String(index)}`);

const head = store.lastInboxEntry(config.rollupId)?.sequence ?? 0;
const accounts = new Set<string>();
const recipients = new Set<string>();
for (const index of indices) {
  const detail = api.batchDetail(index);
  for (const entry of detail?.entries ?? []) {
    if (entry.from !== undefined) accounts.add(entry.from);
    if (entry.to !== undefined) accounts.add(entry.to);
    if (entry.recipient !== undefined) recipients.add(entry.recipient);
  }
}
for (const account of accounts) save(`/api/accounts/${account}`);
for (const recipient of recipients) save(`/api/withdrawals/${recipient}`);

// The page marks itself as a mirror; app.js then reads these files and shows a banner.
const index = join(out, "index.html");
const html = readFileSync(index, "utf8").replace(
  "<title>",
  `<meta name="vigil-mirror" content="${exportedAt}" />\n    <title>`,
);
writeFileSync(index, html);
writeFileSync(join(out, ".nojekyll"), "");
store.close();

process.stdout.write(
  `Mirror written to ${out}: ${String(written)} API answers (${String(indices.size)} batches, ` +
    `${String(accounts.size)} accounts, ${String(recipients.size)} withdrawal recipients, ` +
    `inbox head ${String(head)}), exported at ${exportedAt}.\n`,
);
