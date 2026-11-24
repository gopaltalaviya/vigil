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
 * Needs QORE_MNEMONIC (the deployer is derived from it) and, after `deploy`,
 * SETTLEMENT_GATE_ADDRESS. Build the contract first: `cd examples/settlement-gate && forge build`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bech32ToHex } from "@qorechain/rdk";
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
import { createChain, createLogger, loadConfig } from "@vigil/core";
import {
  buildAnchorCall,
  deployerAccount,
  deployerStatus,
  openDeployerWindow,
} from "@vigil/receipts";

const RECEIPTS: Hex = "0xced683ad4319a34873e2c1aa90d18e2fcf1af1d1";

const artifactPath = fileURLToPath(
  new URL(
    "../examples/settlement-gate/out/SettlementGate.sol/SettlementGate.json",
    import.meta.url,
  ),
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

const gateAddress = (): Hex => {
  const value = process.env.SETTLEMENT_GATE_ADDRESS?.trim() ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("set SETTLEMENT_GATE_ADDRESS");
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

const [command, ...args] = process.argv.slice(2);
switch (command ?? "") {
  case "deploy": {
    await ensureWindow();
    const hash = await wallet.deployContract({
      abi,
      bytecode: artifact.bytecode.object,
      args: [RECEIPTS],
    });
    await mined(hash);
    const receipt = await publicClient.getTransactionReceipt({ hash });
    console.log(`SettlementGate deployed at ${String(receipt.contractAddress)}`);
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
      "usage: settlement-gate deploy | open <batch> <qor> <payee> | status <id> | release <id>",
    );
}
