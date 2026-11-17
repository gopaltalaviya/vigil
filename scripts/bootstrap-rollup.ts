/**
 * Creates the rollup named by ROLLUP_ID and bonds the configured account as its
 * submitter. Safe to run again: it reads the chain first and skips every step
 * that is already done.
 *
 * Without `--execute` nothing is broadcast: the script simulates each missing
 * transaction and prints what it would cost.
 *
 * Usage: pnpm rollup:bootstrap [--execute]
 */
import {
  createRollupMsg,
  estimateCreationCost,
  isRestNotFound,
  uqorToQor,
  bondRollupSubmitterMsg,
} from "@qorechain/rdk";
import { connectTxSender, createChain, createLogger, loadConfig } from "@vigil/core";

const execute = process.argv.includes("--execute");
const config = loadConfig();
const log = createLogger({ service: "bootstrap", level: "warn" });
const chain = createChain(config);
const sender = await connectTxSender(config, chain.rdk, { log });
const rest = chain.rdk.rest;
const qor = (uqor: string | bigint): string => `${uqorToQor(uqor)} QOR`;

const params = await chain.rdk.params();
const balance = BigInt(await rest.getBalance(sender.address, "uqor"));
console.log(`Account ${sender.address} holds ${qor(balance)}`);
console.log(
  `Mode: ${execute ? "EXECUTE (transactions will be sent)" : "dry run (nothing is sent)"}`,
);

// --- 1. the rollup -----------------------------------------------------------
const existing = await rest.getRollup(config.rollupId).catch((error: unknown) => {
  if (isRestNotFound(error)) return undefined;
  throw error;
});

if (existing !== undefined) {
  if (existing.creator !== sender.address) {
    throw new Error(`rollup ${config.rollupId} exists and belongs to another account`);
  }
  console.log(`Rollup ${config.rollupId} already exists (${existing.status}); skipping creation`);
} else {
  const cost = estimateCreationCost({
    stakeUqor: params.minStakeForRollup,
    burnRate: params.rollupCreationBurnRate,
  });
  console.log(
    `Creating ${config.rollupId}: stake ${qor(cost.stakeUqor)}, of which ${qor(cost.burnUqor)} is burned`,
  );
  if (balance < BigInt(cost.totalRequiredUqor))
    throw new Error("the account cannot cover the stake");

  // The settings of a `qledger-v1` rollup with based sequencing, stated explicitly.
  const input = {
    rollupId: config.rollupId,
    profile: "nft",
    vmType: "native",
    stakeAmount: params.minStakeForRollup,
    sequencing: "based",
    executionVm: "qledger-v1",
  } as const;

  if (execute) {
    const outcome = await sender.send("create-rollup", (tx) => tx.createRollup(input));
    console.log(`Created. Transaction ${outcome.hash} at height ${String(outcome.height)}`);
  } else {
    const gas = await sender.simulate([createRollupMsg({ creator: sender.address, ...input })]);
    console.log(`Simulation accepted the creation; estimated gas ${String(gas)}`);
  }
}

// --- 2. the submitter bond ---------------------------------------------------
const minBond = BigInt(params.minSubmitterBond ?? "1000000000");
const rollupNow = await rest.getRollup(config.rollupId).catch(() => undefined);
if (rollupNow === undefined) {
  console.log(`Submitter bond of ${qor(minBond)} would follow once the rollup exists`);
} else {
  console.log(
    `Rollup: ${rollupNow.status}, layer "${rollupNow.layerId}", ${rollupNow.sequencing} sequencing, ${rollupNow.executionVm}`,
  );
  const bond = await rest.getSubmitterBond(config.rollupId, sender.address);
  if (BigInt(bond.amount) >= minBond) {
    console.log(`Submitter bond already in place: ${qor(bond.amount)}`);
  } else if (execute) {
    const outcome = await sender.send("bond-submitter", (tx) =>
      tx.bondRollupSubmitter({ rollupId: config.rollupId, amount: minBond }),
    );
    console.log(`Bonded ${qor(minBond)}. Transaction ${outcome.hash}`);
  } else {
    const gas = await sender.simulate([
      bondRollupSubmitterMsg({
        submitter: sender.address,
        rollupId: config.rollupId,
        amount: minBond,
      }),
    ]);
    console.log(`Simulation accepted a bond of ${qor(minBond)}; estimated gas ${String(gas)}`);
  }
}

const after = BigInt(await rest.getBalance(sender.address, "uqor"));
console.log(`Account now holds ${qor(after)} (spent ${qor(balance - after)})`);
