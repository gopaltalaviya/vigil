/**
 * Records public data of a live rollup as a test fixture: its batches and every
 * inbox entry. The golden test replays this offline and must reproduce the
 * state roots the chain accepted. Read-only; needs no key and no funds.
 *
 * Usage: pnpm golden:refresh [rollup-id]
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chainInboxSource, createChain, loadConfig, toHex, toStoredBatch } from "@vigil/core";

const rollupId = process.argv[2] ?? "rdk-v328-e2e-mwd5v89d";
const config = loadConfig({ ROLLUP_ID: rollupId, QORE_NETWORK: "testnet" });
const chain = createChain(config);
const source = chainInboxSource(chain, config.chainId, rollupId);

const head = await source.head();
const entries = await source.entries(0, head.sequence, new Uint8Array(32));
const batches = (await chain.rdk.rest.listBatches(rollupId)).map(toStoredBatch);

const fixture = {
  chainId: config.chainId,
  rollupId,
  head: { sequence: head.sequence, acc: head.acc },
  batches,
  entries: entries.map((entry, i) => ({
    sequence: i + 1,
    height: Number(entry.height),
    poster: entry.poster,
    payload: toHex(entry.payload),
  })),
};

const target = fileURLToPath(
  new URL("../packages/core/test/fixtures/golden-rollup.json", import.meta.url),
);
writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`recorded ${String(entries.length)} entries and ${String(batches.length)} batches`);
