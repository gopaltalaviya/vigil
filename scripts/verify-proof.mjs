#!/usr/bin/env node
/**
 * Checks Vigil's public claims against the QoreChain testnet with QoreChain's own
 * CLI (`@qorechain/qore-cli`). It needs no key, no `.env`, no Docker and no Vigil
 * service: every answer comes from the chain's public endpoints.
 *
 *   pnpm verify:proof            # table, exit 1 on any mismatch
 *   pnpm verify:proof --json     # one JSON object
 *
 * 1. Every transaction on the Proof page (`apps/web/proof.js`): `qore pq status`.
 *    A native-lane transaction must carry one ML-DSA-87 layer that verifies. An
 *    EVM-lane transaction is expected to be `classical` (reason `evm_lane`): that
 *    lane has no ML-DSA-87 layer, and the account guards it from the native lane.
 * 2. Every final batch of `vigil-1` with a settlement anchor: `qore read-contract`
 *    calls `VigilReceipts.isAnchorRecorded`, which must be true.
 * 3. The same batches: `isAttestationRecorded` for the creator's watchtower
 *    attestation. Not every batch is attested, so this part only counts.
 *
 * A transaction the node no longer keeps is reported as `pruned`, not as a failure.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { bech32ToHex, createRdkClient } from "@qorechain/rdk";
import { encodeFunctionData } from "viem";

const ROLLUP_ID = "vigil-1";
const CHAIN_ID = "qorechain-diana";
const RECEIPTS = "0xced683ad4319a34873e2c1aa90d18e2fcf1af1d1";
const PARALLEL = 4;

const run = promisify(execFile);
const qoreBin = createRequire(import.meta.url).resolve("@qorechain/qore-cli/dist/bin.js");
const asJson = process.argv.includes("--json");

/** Runs `qore <args> --json` and returns its JSON, error answers included. */
async function qore(args) {
  try {
    const { stdout } = await run(
      process.execPath,
      [qoreBin, ...args, "--json", "--timeout", "20000"],
      {
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return JSON.parse(stdout);
  } catch (error) {
    const stdout = /** @type {{ stdout?: string }} */ (error).stdout ?? "";
    try {
      return JSON.parse(stdout);
    } catch {
      return {
        error: { code: "CLI_FAILED", message: String(error.message ?? error).slice(0, 200) },
      };
    }
  }
}

/** Maps `items` through `fn`, at most `limit` at a time, keeping the order. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The labelled transactions of the Proof page, read from its source. */
function proofTransactions(source) {
  const found = [];
  const re = /tx\(\s*"([^"]+)",\s*"((?:0x)?[0-9A-Fa-f]{64})"\s*(,\s*true)?\s*,?\s*\)/g;
  for (const m of source.matchAll(re))
    found.push({ label: m[1], hash: m[2], evm: m[3] !== undefined });
  return found;
}

async function checkTransaction({ label, hash, evm }) {
  const answer = await qore(["pq", "status", hash]);
  if (answer.error?.code === "NOT_FOUND") return { label, hash, result: "pruned", ok: true };
  const t = answer.transaction_status;
  if (t === undefined || t === null) {
    return { label, hash, result: `error ${answer.error?.code ?? "no answer"}`, ok: false };
  }
  if (evm || hash.startsWith("0x")) {
    const ok = t.tier === "classical" && t.verification?.reason === "evm_lane";
    return {
      label,
      hash,
      result: ok ? "EVM lane (expected)" : `unexpected ${t.tier}`,
      ok,
      height: t.height,
    };
  }
  const ok = t.tier === "pqc" && t.has_exactly_one_pqc_layer && t.verification?.verified === true;
  return {
    label,
    hash,
    result: ok
      ? `ML-DSA-87 verified (${t.verification.sign_bytes_version})`
      : `NOT verified: ${t.verification?.reason ?? t.tier}`,
    ok,
    height: t.height,
    signer: t.signer,
  };
}

const RECEIPT = {
  type: "tuple",
  components: [
    { name: "chainId", type: "string" },
    { name: "layerId", type: "string" },
    { name: "layerHeight", type: "uint64" },
    { name: "stateRoot", type: "bytes32" },
    { name: "validatorSetHash", type: "bytes" },
    { name: "txCount", type: "uint64" },
  ],
};
const ATTESTATION = {
  type: "tuple",
  components: [
    { name: "chainId", type: "string" },
    { name: "rollupId", type: "string" },
    { name: "batchIndex", type: "uint64" },
    { name: "stateRoot", type: "bytes32" },
    { name: "withdrawalsRoot", type: "bytes" },
    { name: "dataHash", type: "bytes32" },
  ],
};
const ABI = [
  {
    type: "function",
    name: "isAnchorRecorded",
    stateMutability: "view",
    inputs: [
      { name: "signer", type: "address" },
      { name: "receipt", ...RECEIPT },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "isAttestationRecorded",
    stateMutability: "view",
    inputs: [
      { name: "signer", type: "address" },
      { name: "attestation", ...ATTESTATION },
    ],
    outputs: [{ type: "bool" }],
  },
];

const hex = (value) => `0x${value.replace(/^0x/i, "").toLowerCase()}`;

async function readBool(data) {
  const answer = await qore([
    "read-contract",
    "--to",
    RECEIPTS,
    "--data",
    data,
    "--returns",
    "bool",
  ]);
  if (answer.reverted === false && Array.isArray(answer.decoded)) return answer.decoded[0] === true;
  return undefined;
}

async function checkReceipts() {
  const rdk = createRdkClient({ network: "testnet" });
  const rollup = await rdk.rest.getRollup(ROLLUP_ID);
  const [batches, anchors] = await Promise.all([
    rdk.rest.listBatches(ROLLUP_ID),
    rdk.rest.getAnchors(rollup.layerId),
  ]);
  const signer = hex(bech32ToHex(rollup.creator));
  const finals = batches.filter((b) => b.status === "finalized");
  const rows = await pool(finals, PARALLEL, async (batch) => {
    const anchor = anchors.find(
      (a) => a.layerHeight === batch.batchIndex && hex(a.stateRoot) === hex(batch.stateRoot),
    );
    const attested = await readBool(
      encodeFunctionData({
        abi: ABI,
        functionName: "isAttestationRecorded",
        args: [
          signer,
          {
            chainId: CHAIN_ID,
            rollupId: ROLLUP_ID,
            batchIndex: BigInt(batch.batchIndex),
            stateRoot: hex(batch.stateRoot),
            withdrawalsRoot: batch.withdrawalsRoot === "" ? "0x" : hex(batch.withdrawalsRoot),
            dataHash: hex(batch.dataHash),
          },
        ],
      }),
    );
    if (anchor === undefined)
      return { batch: batch.batchIndex, anchor: "none served", ok: true, attested };
    const recorded = await readBool(
      encodeFunctionData({
        abi: ABI,
        functionName: "isAnchorRecorded",
        args: [
          signer,
          {
            chainId: CHAIN_ID,
            layerId: anchor.layerId,
            layerHeight: BigInt(batch.batchIndex),
            stateRoot: hex(anchor.stateRoot),
            validatorSetHash: hex(anchor.validatorSetHash),
            txCount: BigInt(batch.txCount),
          },
        ],
      }),
    );
    return {
      batch: batch.batchIndex,
      anchor: recorded === true ? "recorded" : recorded === false ? "NOT recorded" : "read failed",
      ok: recorded === true,
      attested,
    };
  });
  return { creator: rollup.creator, layerId: rollup.layerId, batches: batches.length, rows };
}

const started = Date.now();
const source = readFileSync(new URL("../apps/web/proof.js", import.meta.url), "utf8");
const txs = proofTransactions(source);
const [txRows, receipts] = await Promise.all([
  pool(txs, PARALLEL, checkTransaction),
  checkReceipts(),
]);
const failures = [...txRows, ...receipts.rows].filter((r) => !r.ok).length;
const summary = {
  rollupId: ROLLUP_ID,
  receiptsContract: RECEIPTS,
  rollupCreator: receipts.creator,
  transactions: {
    checked: txRows.length,
    pruned: txRows.filter((r) => r.result === "pruned").length,
  },
  anchors: {
    recorded: receipts.rows.filter((r) => r.anchor === "recorded").length,
    finalBatches: receipts.rows.length,
    noneServed: receipts.rows.filter((r) => r.anchor === "none served").length,
  },
  attestationsRecorded: receipts.rows.filter((r) => r.attested === true).length,
  failures,
  // A run where every transaction was pruned, or no anchor could be read, proves nothing: say so and fail.
  nothingVerified:
    txRows.every((r) => r.result === "pruned") ||
    receipts.rows.every((r) => r.anchor !== "recorded"),
  seconds: Math.round((Date.now() - started) / 100) / 10,
};

if (asJson) {
  console.log(JSON.stringify({ summary, transactions: txRows, receipts: receipts.rows }, null, 2));
} else {
  console.log(`Proof page transactions (qore pq status), ${String(txRows.length)}:`);
  for (const r of txRows) {
    console.log(
      `  ${r.ok ? "ok  " : "FAIL"}  ${r.label.padEnd(34)} ${r.hash.slice(0, 12)}…  ${r.result}`,
    );
  }
  console.log(
    `\n${ROLLUP_ID} receipts on ${RECEIPTS} (qore read-contract), creator ${receipts.creator}:`,
  );
  for (const r of receipts.rows) {
    const att = r.attested === true ? ", attested" : "";
    console.log(
      `  ${r.ok ? "ok  " : "FAIL"}  batch ${String(r.batch).padStart(3)}  anchor ${r.anchor}${att}`,
    );
  }
  console.log(
    `\n${String(txRows.length)} transactions (${String(summary.transactions.pruned)} pruned), ` +
      `${String(summary.anchors.recorded)} of ${String(summary.anchors.finalBatches)} final batches with a recorded anchor ` +
      `(${String(summary.anchors.noneServed)} without a served anchor), ` +
      `${String(summary.attestationsRecorded)} attestations, ${String(failures)} failures, ${String(summary.seconds)} s.`,
  );
}
if (summary.nothingVerified && !asJson) {
  console.log(
    "Nothing could be verified: every transaction was pruned, or no anchor was recorded.",
  );
}
process.exit(failures === 0 && !summary.nothingVerified ? 0 : 1);
