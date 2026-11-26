/**
 * A verified settlement receipt for a final batch of vigil-1, built and checked with the RDK's own
 * `buildSettlementReceipt` and `verifySettlementReceipt`. Verification is in "chain" mode: every
 * field is re-read from the testnet, so a fabricated receipt cannot pass. No key, no `.env`.
 *
 *   pnpm receipt:verify                  # the latest final batch whose anchor the chain serves
 *   pnpm receipt:verify --batch 18       # a given batch
 *   pnpm receipt:verify --save           # also write docs/receipts/<rollup>-batch-<n>.json
 *
 * Exit 0 when the receipt verifies (valid: true, all six checks), 1 otherwise.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSettlementReceipt, createRdkClient, verifySettlementReceipt } from "@qorechain/rdk";

const option = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};
const rollupId = option("rollup") ?? process.env.ROLLUP_ID ?? "vigil-1";
const save = process.argv.includes("--save");
const client = createRdkClient({ network: "testnet" });

async function pickBatch(): Promise<number> {
  const given = option("batch");
  if (given !== undefined) return Number(given);
  const batches = await client.rest.listBatches(rollupId);
  const final = batches
    .filter((b) => b.status === "finalized")
    .map((b) => b.batchIndex)
    .sort((a, b) => b - a);
  // The newest final batch whose anchor the chain still serves.
  for (const index of final) {
    try {
      await buildSettlementReceipt(client, rollupId, index);
      return index;
    } catch {
      continue;
    }
  }
  throw new Error(`no final batch of ${rollupId} has an anchor the chain serves`);
}

const batchIndex = await pickBatch();
const receipt = await buildSettlementReceipt(client, rollupId, batchIndex);
const result = await verifySettlementReceipt(receipt, { client });

console.log(
  `Settlement receipt: ${rollupId} batch ${String(batchIndex)} (layer ${receipt.layerId}, receipt v${String(receipt.version)}, ${receipt.algorithm})`,
);
console.log(`  state root      ${receipt.stateRoot}`);
console.log(
  `  anchored at     Main Chain height ${String(receipt.mainChainHeight)}, by ${receipt.creator}`,
);
console.log(`  signature       ${String(receipt.pqcSignature.length / 2)} bytes`);
console.log(`Verification (mode: ${result.mode})`);
for (const [check, ok] of Object.entries(result.checks))
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${check}`);
console.log(result.valid ? "valid: true, reproduced from live chain state" : "valid: false");

if (save) {
  const dir = fileURLToPath(new URL("../docs/receipts/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  const file = `${dir}${rollupId}-batch-${String(batchIndex)}.json`;
  writeFileSync(
    file,
    `${JSON.stringify({ receipt, verification: { ...result, checkedAt: new Date().toISOString() } }, null, 2)}\n`,
  );
  console.log(`saved docs/receipts/${rollupId}-batch-${String(batchIndex)}.json`);
}
process.exit(result.valid ? 0 : 1);
