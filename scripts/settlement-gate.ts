/**
 * Runs the SettlementGate example (`examples/settlement-gate`) on the QoreChain
 * testnet with the receipts deployer account: an escrow that pays out only once
 * a named batch of `vigil-1` has a settlement anchor recorded in VigilReceipts.
 *
 *   pnpm settlement-gate deploy                         # deploy the gate (opens an EVM window)
 *   pnpm settlement-gate open <batch> <qor> <payee 0x>  # lock QOR until <batch> has settled
 *   pnpm settlement-gate status <id>                    # escrow, and whether release would pay
 *   pnpm settlement-gate release <id>                   # pay the payee with the batch's real anchor
 *
 * Version 2 (`SettlementGateV2`) also requires the watchtower's ML-DSA-87 attestation of the
 * batch to be recorded. The same commands after `v2`, with SETTLEMENT_GATE_V2_ADDRESS:
 *
 *   pnpm settlement-gate v2 deploy | open <batch> <qor> <payee 0x> | status <id> | release <id>
 *
 * Needs QORE_MNEMONIC (the deployer is derived from it) and, after `deploy`,
 * SETTLEMENT_GATE_ADDRESS. Build the contract first: `cd examples/settlement-gate && forge build`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bech32ToHex, signerFromEnv } from "@qorechain/rdk";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  http,
  parseEther,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createChain, createLogger, loadConfig, toStoredBatch } from "@vigil/core";
import {
  buildAnchorCall,
  deployerAccount,
  deployerStatus,
  openDeployerWindow,
} from "@vigil/receipts";

const RECEIPTS: Hex = "0xced683ad4319a34873e2c1aa90d18e2fcf1af1d1";

const argv = process.argv.slice(2);
const v2 = argv[0] === "v2";
const name = v2 ? "SettlementGateV2" : "SettlementGate";
const artifactPath = fileURLToPath(
  new URL(`../examples/settlement-gate/out/${name}.sol/${name}.json`, import.meta.url),
);
const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
  abi: Abi;
  bytecode: { object: Hex };
};
const abi = artifact.abi;

const config = loadConfig();
const chain = createChain(config);
const context = { config, rdk: chain.rdk, log: createLogger({ service: "gate", level: "warn" }) };
const evm = defineChain({
  id: 9800,
  name: "QoreChain Testnet",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [config.evmRpcUrl] } },
});
const publicClient = createPublicClient({ chain: evm, transport: http(config.evmRpcUrl) });
const deployer = await deployerAccount(config);
const wallet = createWalletClient({
  account: privateKeyToAccount(deployer.privateKey as Hex),
  chain: evm,
  transport: http(config.evmRpcUrl),
});

const addressVariable = v2 ? "SETTLEMENT_GATE_V2_ADDRESS" : "SETTLEMENT_GATE_ADDRESS";
const gateAddress = (): Hex => {
  const value = process.env[addressVariable]?.trim() ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`set ${addressVariable}`);
  return value as Hex;
};

/** EVM transactions need a live window; a deploy needs one that is not scoped to a contract. */
const ensureWindow = async (): Promise<void> => {
  const status = await deployerStatus(context);
  if (!status.window.live || status.window.remainingTxs < 1n) {
    console.log(`Opened an EVM window: ${await openDeployerWindow(context, { maxTxs: 4n })}`);
  }
};

const mined = async (hash: Hex): Promise<void> => {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  const fee = receipt.gasUsed * receipt.effectiveGasPrice;
  console.log(
    `Transaction ${hash}: ${receipt.status}, block ${String(receipt.blockNumber)}, gas ${String(receipt.gasUsed)}, fee ${formatEther(fee)} QOR`,
  );
  if (receipt.status !== "success") throw new Error("the transaction reverted");
};

/** The named batch's real anchor, as VigilReceipts takes it. */
const anchorFor = async (batchIndex: number) =>
  (await buildAnchorCall(chain.rdk, config.chainId, config.rollupId, batchIndex)).receipt;

/** The batch as the chain lists it, shaped as the watchtower's attestation of it. */
const attestationFor = async (batchIndex: number) => {
  const batch = toStoredBatch(await chain.rdk.rest.getBatch(config.rollupId, batchIndex));
  return {
    chainId: config.chainId,
    rollupId: config.rollupId,
    batchIndex: BigInt(batchIndex),
    stateRoot: `0x${batch.stateRoot}`,
    withdrawalsRoot: `0x${batch.withdrawalsRoot}`,
    dataHash: `0x${batch.dataHash}`,
  };
};

/** The account whose ML-DSA-87 key signs this watchtower's attestations (the main account). */
const watchtowerSigner = async (): Promise<Hex> => {
  const signer = await signerFromEnv({
    QORE_MNEMONIC: config.secrets.mnemonic,
    QORE_PQC_SEED_HEX: config.secrets.pqcSeedHex,
  });
  const [account] = (await signer?.getAccounts()) ?? [];
  if (account === undefined) throw new Error("no signing account in QORE_MNEMONIC");
  return `0x${bech32ToHex(account.address).replace(/^0x/, "")}`;
};

const escrowV2 = async (id: bigint) => {
  const [payer, payee, anchorSigner, attester, batchIndex, refundAfter, closed, amount] =
    (await publicClient.readContract({
      address: gateAddress(),
      abi,
      functionName: "escrows",
      args: [id],
    })) as [Hex, Hex, Hex, Hex, bigint, bigint, boolean, bigint, Hex, Hex, Hex];
  return { payer, payee, anchorSigner, attester, batchIndex, refundAfter, closed, amount };
};

const isReleasable = async (id: bigint, receipt: unknown, attestation: unknown) =>
  (await publicClient.readContract({
    address: gateAddress(),
    abi,
    functionName: "isReleasable",
    args: [id, receipt, attestation],
  })) as boolean;

const escrow = async (id: bigint) => {
  const [payer, payee, signer, layerHeight, refundAfter, closed, amount] =
    (await publicClient.readContract({
      address: gateAddress(),
      abi,
      functionName: "escrows",
      args: [id],
    })) as [Hex, Hex, Hex, bigint, bigint, boolean, bigint, Hex, Hex];
  return { payer, payee, signer, layerHeight, refundAfter, closed, amount };
};

const isSettled = async (id: bigint, receipt: unknown): Promise<boolean> =>
  (await publicClient.readContract({
    address: gateAddress(),
    abi,
    functionName: "isSettled",
    args: [id, receipt],
  })) as boolean;

const [command, ...args] = v2 ? argv.slice(1) : argv;
switch (`${v2 ? "v2 " : ""}${command ?? ""}`) {
  case "deploy": {
    await ensureWindow();
    const hash = await wallet.deployContract({
      abi,
      bytecode: artifact.bytecode.object,
      args: [RECEIPTS],
    });
    await mined(hash);
    const receipt = await publicClient.getTransactionReceipt({ hash });
    console.log(`${name} deployed at ${String(receipt.contractAddress)}`);
    break;
  }
  case "v2 deploy": {
    await ensureWindow();
    const hash = await wallet.deployContract({
      abi,
      bytecode: artifact.bytecode.object,
      args: [RECEIPTS],
    });
    await mined(hash);
    const receipt = await publicClient.getTransactionReceipt({ hash });
    console.log(`${name} deployed at ${String(receipt.contractAddress)}`);
    break;
  }
  case "v2 open": {
    const [batch, qor, payee] = args;
    if (batch === undefined || qor === undefined || payee === undefined) {
      throw new Error("usage: v2 open <batch> <qor> <payee 0x>");
    }
    const rollup = await chain.rdk.rest.getRollup(config.rollupId);
    const anchorSigner = `0x${bech32ToHex(rollup.creator).replace(/^0x/, "")}`;
    const attester = await watchtowerSigner();
    await ensureWindow();
    const refundAfter = BigInt(Math.floor(Date.now() / 1_000) + 86_400);
    const hash = await wallet.writeContract({
      address: gateAddress(),
      abi,
      functionName: "open",
      args: [
        payee,
        anchorSigner,
        attester,
        config.chainId,
        rollup.layerId,
        config.rollupId,
        BigInt(batch),
        refundAfter,
      ],
      value: parseEther(qor),
    });
    await mined(hash);
    break;
  }
  case "v2 status": {
    const id = BigInt(args[0] ?? "0");
    const e = await escrowV2(id);
    const receipt = await anchorFor(Number(e.batchIndex));
    const attestation = await attestationFor(Number(e.batchIndex));
    const unrecorded = { ...attestation, dataHash: `0x${"00".repeat(32)}` };
    console.log(
      `Escrow ${String(id)}: ${formatEther(e.amount)} QOR for ${e.payee}, batch ${String(e.batchIndex)}, ${e.closed ? "closed" : "open"}`,
    );
    console.log(
      `  real anchor + recorded attestation would pay:   ${String(await isReleasable(id, receipt, attestation))}`,
    );
    console.log(
      `  real anchor + unrecorded attestation would pay: ${String(await isReleasable(id, receipt, unrecorded))}`,
    );
    break;
  }
  case "v2 release": {
    const id = BigInt(args[0] ?? "0");
    const e = await escrowV2(id);
    const receipt = await anchorFor(Number(e.batchIndex));
    const attestation = await attestationFor(Number(e.batchIndex));
    if (!(await isReleasable(id, receipt, attestation))) {
      throw new Error("the batch is not both settled and attested; nothing sent");
    }
    await ensureWindow();
    const before = await publicClient.getBalance({ address: e.payee });
    const hash = await wallet.writeContract({
      address: gateAddress(),
      abi,
      functionName: "release",
      args: [id, receipt, attestation],
    });
    await mined(hash);
    const after = await publicClient.getBalance({ address: e.payee });
    console.log(`Payee received ${formatEther(after - before)} QOR`);
    break;
  }
  case "open": {
    const [batch, qor, payee] = args;
    if (batch === undefined || qor === undefined || payee === undefined) {
      throw new Error("usage: open <batch> <qor> <payee 0x>");
    }
    const rollup = await chain.rdk.rest.getRollup(config.rollupId);
    const signer = `0x${bech32ToHex(rollup.creator).replace(/^0x/, "")}`;
    await ensureWindow();
    const refundAfter = BigInt(Math.floor(Date.now() / 1_000) + 86_400);
    const hash = await wallet.writeContract({
      address: gateAddress(),
      abi,
      functionName: "open",
      args: [payee, signer, config.chainId, rollup.layerId, BigInt(batch), refundAfter],
      value: parseEther(qor),
    });
    await mined(hash);
    break;
  }
  case "status": {
    const id = BigInt(args[0] ?? "0");
    const e = await escrow(id);
    const receipt = await anchorFor(Number(e.layerHeight));
    const forged = { ...receipt, stateRoot: `0x${"00".repeat(32)}` };
    console.log(
      `Escrow ${String(id)}: ${formatEther(e.amount)} QOR for ${e.payee}, batch ${String(e.layerHeight)}, ${e.closed ? "closed" : "open"}`,
    );
    console.log(
      `  release with the batch's real anchor would pay: ${String(await isSettled(id, receipt))}`,
    );
    console.log(
      `  release with a forged state root would pay:     ${String(await isSettled(id, forged))}`,
    );
    break;
  }
  case "release": {
    const id = BigInt(args[0] ?? "0");
    const e = await escrow(id);
    const receipt = await anchorFor(Number(e.layerHeight));
    if (!(await isSettled(id, receipt))) throw new Error("the batch has not settled; nothing sent");
    await ensureWindow();
    const before = await publicClient.getBalance({ address: e.payee });
    const hash = await wallet.writeContract({
      address: gateAddress(),
      abi,
      functionName: "release",
      args: [id, receipt],
    });
    await mined(hash);
    const after = await publicClient.getBalance({ address: e.payee });
    console.log(`Payee received ${formatEther(after - before)} QOR`);
    break;
  }
  default:
    throw new Error(
      "usage: settlement-gate [v2] deploy | open <batch> <qor> <payee> | status <id> | release <id>",
    );
}
