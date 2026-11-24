/**
 * Vigil's headline numbers, recomputed from the QoreChain testnet alone: no key,
 * no `.env`, no Vigil database. Each number names where it comes from.
 *
 *   pnpm metrics             # Markdown table
 *   pnpm metrics --json      # the same as JSON
 *   pnpm metrics --readme    # also rewrite the table at the top of README.md
 *
 * Inbox entries are fetched from the chain and checked against the chain's own
 * hash accumulator before they are counted. Receipts are read from the
 * VigilReceipts contract, not from logs: calls relayed through a smart account
 * change state without a log the EVM RPC returns.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { format, resolveConfig } from "prettier";
import { fileURLToPath } from "node:url";
import { uqorToQor } from "@qorechain/rdk";
import type { Hex } from "viem";
import {
  InboxArchive,
  Store,
  chainHistory,
  chainInboxSource,
  createChain,
  loadConfig,
  type FraudRecord,
} from "@vigil/core";
import { describeEntry } from "@vigil/api";
import { ReceiptsContract, buildAnchorCall } from "@vigil/receipts";

const ROLLUP_ID = "vigil-1";
const RECEIPTS: Hex = "0xced683ad4319a34873e2c1aa90d18e2fcf1af1d1";
const README = fileURLToPath(new URL("../README.md", import.meta.url));
const START = "<!-- metrics:start -->";
const END = "<!-- metrics:end -->";

const config = loadConfig({ ROLLUP_ID, QORE_NETWORK: "testnet" });
const chain = createChain(config);
const history = chainHistory(chain.rest, config.restUrl, ROLLUP_ID);
const contract = new ReceiptsContract(config);

const qor = (uqor: bigint): string => uqorToQor(uqor);

/** Seconds from the forged submission to the upheld challenge that rejected it. */
async function timeToChallenge(fraud: FraudRecord): Promise<number | undefined> {
  const submissions = await history.submissions(fraud.batchIndex);
  const forged = submissions.filter((s) => s.submittedAt <= fraud.height).at(-1);
  return forged === undefined ? undefined : fraud.time - forged.submittedTime;
}

const [rollup, batches, fraud, withdrawals, tip] = await Promise.all([
  chain.rdk.rest.getRollup(ROLLUP_ID),
  chain.rdk.rest.listBatches(ROLLUP_ID),
  history.fraud(),
  history.withdrawals(),
  chain.rdk.rest.getInbox(ROLLUP_ID),
]);

// Inbox: fetched from the chain and verified against its accumulator in a throwaway store.
const store = Store.open(":memory:");
const archive = new InboxArchive({
  chainId: config.chainId,
  rollupId: ROLLUP_ID,
  store,
  source: chainInboxSource(chain, config.chainId, ROLLUP_ID),
});
const synced = await archive.sync();
const kinds = new Map<string, number>();
let depositedUqor = 0n;
for (const entry of store.inboxRange(ROLLUP_ID, 0, synced.head)) {
  const view = describeEntry(entry, { chainId: config.chainId, rollupId: ROLLUP_ID });
  kinds.set(view.kind, (kinds.get(view.kind) ?? 0) + 1);
  if (view.kind === "deposit" && view.amount !== undefined) depositedUqor += BigInt(view.amount);
}

const finals = batches.filter((b) => b.status === "finalized");
const anchors = await Promise.all(
  finals.map(async (batch) => {
    try {
      const call = await buildAnchorCall(chain.rdk, config.chainId, ROLLUP_ID, batch.batchIndex);
      return (await contract.isAnchorRecorded(RECEIPTS, call)) ? "recorded" : "not recorded";
    } catch {
      return "no anchor";
    }
  }),
);

const byVigil = fraud.filter((f) => f.challenger === rollup.creator);
const byOthers = fraud.filter((f) => f.challenger !== rollup.creator);
const vigilTimes = (await Promise.all(byVigil.map(timeToChallenge))).filter(
  (t): t is number => t !== undefined,
);
const otherTimes = (await Promise.all(byOthers.map(timeToChallenge))).filter(
  (t): t is number => t !== undefined,
);
const sum = (values: readonly string[]) => values.reduce((a, b) => a + BigInt(b), 0n);
const range = (times: readonly number[]) =>
  times.length === 0
    ? "none"
    : `${String(Math.min(...times))}–${String(Math.max(...times))} s`.replace(
        /^(\d+)–\1 s$/,
        "$1 s",
      );

const metrics = {
  rollupId: ROLLUP_ID,
  readAt: new Date().toISOString(),
  batches: {
    final: finals.length,
    entriesCovered: finals.reduce((n, b) => n + b.txCount, 0),
  },
  inbox: { entries: synced.head, chainHead: tip.headSequence, byKind: Object.fromEntries(kinds) },
  depositedQor: qor(depositedUqor),
  withdrawalsPaid: {
    count: withdrawals.length,
    qor: qor(sum(withdrawals.map((w) => w.amountUqor))),
  },
  receipts: {
    recorded: anchors.filter((a) => a === "recorded").length,
    finalBatches: finals.length,
    noAnchor: anchors.filter((a) => a === "no anchor").length,
  },
  forgedBatchesRejected: {
    total: fraud.length,
    byVigil: byVigil.length,
    byOthers: byOthers.length,
    bondsSlashedQor: qor(sum(fraud.map((f) => f.slashedUqor))),
    rewardToVigilQor: qor(sum(byVigil.map((f) => f.rewardUqor))),
    vigilTimeToChallenge: range(vigilTimes),
    othersTimeToChallenge: range(otherTimes),
  },
};

const day = metrics.readAt.slice(0, 10);
const PLURAL: Record<string, string> = {
  deposit: "deposits",
  transfer: "transfers",
  withdrawal: "withdrawals",
  memo: "sealed memos",
  data: "other posts",
};
const table = [
  START,
  `| Measured on the testnet (${day}, \`pnpm metrics\`) | Value |`,
  "| --- | --- |",
  `| Final batches of \`vigil-1\` | ${String(metrics.batches.final)}, covering ${String(metrics.batches.entriesCovered)} inbox entries |`,
  `| Inbox entries, checked against the chain's accumulator | ${String(metrics.inbox.entries)}: ${[...kinds].map(([k, n]) => `${String(n)} ${PLURAL[k] ?? k}`).join(", ")} |`,
  `| Deposited / withdrawals paid out | ${metrics.depositedQor} QOR / ${String(metrics.withdrawalsPaid.count)} paid, ${metrics.withdrawalsPaid.qor} QOR |`,
  `| Settlement anchors recorded in \`VigilReceipts\` | ${String(metrics.receipts.recorded)} of ${String(metrics.receipts.finalBatches)} final batches (${String(metrics.receipts.noAnchor)} without an anchor from the chain) |`,
  `| Forged batches rejected by an upheld fraud proof | ${String(fraud.length)}: ${String(byVigil.length)} by Vigil's watchtower (${metrics.forgedBatchesRejected.vigilTimeToChallenge} after submission), ${String(byOthers.length)} by other teams' bots (${metrics.forgedBatchesRejected.othersTimeToChallenge}) |`,
  `| Bonds slashed from cheaters / paid to Vigil | ${metrics.forgedBatchesRejected.bondsSlashedQor} QOR / ${metrics.forgedBatchesRejected.rewardToVigilQor} QOR |`,
  END,
].join("\n");

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(metrics, null, 2));
} else {
  console.log(table.split("\n").slice(1, -1).join("\n"));
}

if (process.argv.includes("--readme")) {
  const readme = readFileSync(README, "utf8");
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < start) throw new Error("README.md has no metrics markers");
  const next = `${readme.slice(0, start)}${table}${readme.slice(end + END.length)}`;
  const options = (await resolveConfig(README)) ?? {};
  writeFileSync(README, await format(next, { ...options, filepath: README }));
  console.log("README.md updated.");
}
store.close();
