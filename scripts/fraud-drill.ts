/**
 * Fraud drill: proves on a live network that the watchtower catches a bad batch.
 *
 * A second account (QORE_DRILL_MNEMONIC, a throwaway testnet key) bonds as a
 * submitter on the rollup and submits a batch whose state root is deliberately
 * wrong. Run the watchtower with WATCHTOWER_CHALLENGE=on afterwards: it must
 * challenge the batch, and the chain must reject it and slash the drill bond.
 *
 * Costs real testnet QOR: the drill bond is slashed (half burned, half paid to
 * the challenger). Nothing is sent without `--execute`.
 *
 * Usage: pnpm fraud:drill [--execute]
 */
import { planQledgerBatch, uqorToQor } from "@qorechain/rdk";
import {
  InboxArchive,
  Store,
  chainInboxSource,
  connectTxSender,
  createChain,
  createLogger,
  ledgerAtSequence,
  loadConfig,
  toHex,
} from "@vigil/core";
import { sendFromMainAccount } from "@vigil/receipts";
import { join } from "node:path";

const execute = process.argv.includes("--execute");
const config = loadConfig();
const drillMnemonic = process.env.QORE_DRILL_MNEMONIC?.trim();
if (drillMnemonic === undefined || drillMnemonic === "") {
  throw new Error("set QORE_DRILL_MNEMONIC to a throwaway testnet seed phrase");
}
const drillConfig = loadConfig({
  ...process.env,
  QORE_MNEMONIC: drillMnemonic,
  QORE_PQC_SEED_HEX: "",
});

const log = createLogger({ service: "fraud-drill", level: "warn" });
const chain = createChain(config);
const rest = chain.rdk.rest;
const store = Store.open(join(config.dataDir, "vigil.sqlite"));
const drill = await connectTxSender(drillConfig, chain.rdk, { log });
const qor = (uqor: string | bigint): string => `${uqorToQor(uqor)} QOR`;

// The drill account's bond is slashed on purpose. It must never be the real operator.
const main = await connectTxSender(config, chain.rdk, { log });
const rollup = await rest.getRollup(config.rollupId);
if (drill.address === main.address || drill.address === rollup.creator) {
  throw new Error("QORE_DRILL_MNEMONIC is the operator's own account; use a throwaway key");
}

const params = await chain.rdk.params();
const bondNeeded = BigInt(params.minSubmitterBond ?? "1000000000");
const reserve = 5_000_000n;
console.log(`Drill account: ${drill.address}`);
console.log(`Mode: ${execute ? "EXECUTE" : "dry run (nothing is sent)"}`);

// 1. Fund the drill account from the main account.
const balance = BigInt(await rest.getBalance(drill.address, "uqor"));
const bond = BigInt((await rest.getSubmitterBond(config.rollupId, drill.address)).amount);
const shortfall = bond >= bondNeeded ? 0n : bondNeeded + reserve - balance;
if (shortfall > 0n) {
  console.log(`Needs ${qor(shortfall)} for the bond and fees`);
  if (execute) {
    const hash = await sendFromMainAccount(
      { config, rdk: chain.rdk, log },
      drill.address,
      shortfall,
    );
    console.log(`Funded. Transaction ${hash}`);
  }
}

// 2. Bond it as a submitter.
if (bond < bondNeeded) {
  console.log(`Needs a submitter bond of ${qor(bondNeeded)}`);
  if (execute) {
    const outcome = await drill.send("drill-bond", (tx) =>
      tx.bondRollupSubmitter({ rollupId: config.rollupId, amount: bondNeeded }),
    );
    console.log(`Bonded. Transaction ${outcome.hash}`);
  }
} else {
  console.log(`Already bonded with ${qor(bond)}`);
}

// 3. Submit a batch with a wrong state root.
const archive = new InboxArchive({
  chainId: config.chainId,
  rollupId: config.rollupId,
  store,
  source: chainInboxSource(chain, config.chainId, config.rollupId),
});
await archive.sync();
const inbox = await rest.getInbox(config.rollupId);
if (inbox.headSequence <= inbox.consumedSequence) {
  console.log("The inbox has no unbatched entries: post a deposit or transfer first, then re-run.");
} else if (execute) {
  const ledger = ledgerAtSequence(
    { chainId: config.chainId, rollupId: config.rollupId, store, archive },
    inbox.consumedSequence,
  );
  const plan = await planQledgerBatch(rest, {
    chainId: config.chainId,
    rollupId: config.rollupId,
    submitter: drill.address,
    ledger,
  });
  const forged = Uint8Array.from(plan.input.stateRoot);
  forged[0] = (forged[0] ?? 0) ^ 0xff;
  console.log(`Honest state root: ${toHex(plan.input.stateRoot)}`);
  console.log(`Forged state root: ${toHex(forged)}`);
  const outcome = await drill.send("drill-bad-batch", (tx) =>
    tx.submitBatch({ ...plan.input, stateRoot: forged }, { anchor: "off" }),
  );
  console.log(
    `Submitted forged batch ${plan.input.batchIndex.toString()}. Transaction ${outcome.hash}`,
  );
  console.log("Now run the watchtower with WATCHTOWER_CHALLENGE=on.");
} else {
  console.log(
    `Would submit a forged batch for entries ${String(inbox.consumedSequence + 1)}-${String(inbox.headSequence)}`,
  );
}
store.close();
