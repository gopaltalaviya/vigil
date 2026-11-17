#!/usr/bin/env node
/**
 * `vigil-receipts`: puts verified settlement receipts on chain.
 *
 *   vigil-receipts status           deployer account, its key, window and the contract
 *   vigil-receipts setup [qor]      fund the deployer (default 20 QOR), register its key, open a window
 *   vigil-receipts deploy           deploy VigilReceipts (needs `forge build` output)
 *   vigil-receipts check <batch>    verify a batch's anchor through the contract, read-only
 *   vigil-receipts record <batch>   verify and record a batch's anchor on chain
 *   vigil-receipts sync             record every finalized batch the watchtower judged valid
 *   vigil-receipts watch            run sync every two minutes until stopped
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { uqorToQor } from "@qorechain/rdk";
import type { Abi, Hex } from "viem";
import {
  Store,
  VigilError,
  claimId,
  createChain,
  createLogger,
  envInt,
  loadConfig,
} from "@vigil/core";
import {
  deployerAccount,
  deployerStatus,
  fundDeployer,
  openDeployerWindow,
  registerDeployerKey,
} from "./deployer.js";
import { ReceiptsContract } from "./contract.js";
import { buildAnchorCall, type AnchorCall } from "./receipts.js";

const print = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function main(argv: string[]): Promise<void> {
  const [command = "status", argument] = argv;
  const config = loadConfig();
  const log = createLogger({ service: "receipts", level: "warn" });
  const chain = createChain(config);
  const context = { config, rdk: chain.rdk, log };
  const contract = new ReceiptsContract(config);
  const remember = (batchIndex: number, stateRoot: string, txHash: string): void => {
    const store = Store.open(join(config.dataDir, "vigil.sqlite"));
    try {
      store.saveReceipt(config.rollupId, {
        batchIndex,
        stateRoot: stateRoot.replace(/^0x/, "").toLowerCase(),
        contract: address(),
        txHash,
        recordedAt: Math.floor(Date.now() / 1_000),
      });
    } finally {
      store.close();
    }
  };

  const address = (): Hex => {
    const value = process.env.VIGIL_RECEIPTS_ADDRESS?.trim();
    if (value === undefined || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
      throw new VigilError("CONFIG_INVALID", "set VIGIL_RECEIPTS_ADDRESS to the deployed contract");
    }
    return value as Hex;
  };
  const batch = (): number => {
    const index = Number(argument);
    if (!Number.isInteger(index) || index < 0) {
      throw new VigilError("CONFIG_INVALID", "give a batch index, for example: record 0");
    }
    return index;
  };
  const ensureWindow = async (): Promise<void> => {
    const status = await deployerStatus(context);
    if (!status.window.live || status.window.remainingTxs < 1n) {
      print(`Opened an EVM window: ${await openDeployerWindow(context)}`);
    }
  };
  /**
   * Records one anchor. Someone else may record the same receipt first (it is
   * public data); that is the outcome we wanted, so it counts as success.
   */
  const recordOne = async (index: number, call: AnchorCall): Promise<string> => {
    if (await contract.isAnchorRecorded(address(), call)) {
      remember(index, call.receipt.stateRoot, "");
      return `Batch ${String(index)}: already recorded.`;
    }
    if (!(await contract.checkAnchor(address(), call))) {
      return `Batch ${String(index)}: signature does not verify; nothing was sent.`;
    }
    await ensureWindow();
    try {
      const hash = await contract.recordAnchor(await key(), address(), call);
      remember(index, call.receipt.stateRoot, hash);
      return `Batch ${String(index)}: recorded. Transaction ${hash}`;
    } catch (error) {
      if (await contract.isAnchorRecorded(address(), call)) {
        remember(index, call.receipt.stateRoot, "");
        return `Batch ${String(index)}: recorded by another sender first.`;
      }
      throw error;
    }
  };

  /**
   * Records the receipt of every batch that is final on the base chain and that
   * our own watchtower judged valid. A batch still in its challenge window, or
   * one nobody has re-executed, gets no receipt.
   */
  const syncOnce = async (): Promise<void> => {
    const store = Store.open(join(config.dataDir, "vigil.sqlite"));
    let judgedValid: Set<string>;
    try {
      judgedValid = new Set(
        store
          .batches(config.rollupId)
          .filter((b) => store.verdict(config.rollupId, claimId(b))?.verdict === "valid")
          .map((b) => `${String(b.batchIndex)}:${b.stateRoot}`),
      );
    } finally {
      store.close();
    }
    for (const item of await chain.rdk.rest.listBatches(config.rollupId)) {
      const index = item.batchIndex;
      if (item.status !== "finalized") continue;
      if (!judgedValid.has(`${String(index)}:${item.stateRoot.replace(/^0x/, "").toLowerCase()}`)) {
        print(`Batch ${String(index)}: not judged valid by the watchtower yet, skipped.`);
        continue;
      }
      let call: AnchorCall;
      try {
        call = await buildAnchorCall(chain.rdk, config.chainId, config.rollupId, index);
      } catch (error) {
        if (error instanceof VigilError && error.code === "INTEGRITY") {
          print(`Batch ${String(index)}: no anchor, skipped.`);
          continue;
        }
        throw error;
      }
      try {
        print(await recordOne(index, call));
      } catch (error) {
        log.error({ batch: index, err: error }, "could not record the receipt");
        print(`Batch ${String(index)}: failed, will retry on the next round.`);
      }
    }
  };

  const key = async (): Promise<Hex> => (await deployerAccount(config)).privateKey as Hex;

  switch (command) {
    case "status": {
      const status = await deployerStatus(context);
      print(`Deployer:   ${status.evmAddress} (${status.cosmosAddress})`);
      print(`Balance:    ${uqorToQor(status.balanceUqor)} QOR`);
      print(`PQC key:    ${status.pqcKeyRegistered ? "registered" : "not registered"}`);
      print(
        `EVM window: ${status.window.live ? `live, ${status.window.remainingTxs.toString()} transactions left` : "none"}`,
      );
      const deployed = process.env.VIGIL_RECEIPTS_ADDRESS?.trim();
      print(`Contract:   ${deployed === undefined || deployed === "" ? "not deployed" : deployed}`);
      break;
    }
    case "setup": {
      let status = await deployerStatus(context);
      const target = BigInt(Math.round(Number(argument ?? "20") * 1_000_000));
      if (status.balanceUqor < target / 2n) {
        print(`Funded the deployer: ${await fundDeployer(context, target - status.balanceUqor)}`);
      }
      if (!status.pqcKeyRegistered) {
        print(`Registered its ML-DSA-87 key: ${await registerDeployerKey(context)}`);
      }
      status = await deployerStatus(context);
      if (!status.window.live) print(`Opened an EVM window: ${await openDeployerWindow(context)}`);
      print("Deployer is ready.");
      break;
    }
    case "deploy": {
      const artifactPath = fileURLToPath(
        new URL("../../../contracts/out/VigilReceipts.sol/VigilReceipts.json", import.meta.url),
      );
      const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
        abi: Abi;
        bytecode: { object: Hex };
      };
      await ensureWindow();
      const deployed = await contract.deploy(await key(), {
        abi: artifact.abi,
        bytecode: artifact.bytecode.object,
      });
      print(`VigilReceipts deployed at ${deployed.address}`);
      print(`Transaction ${deployed.hash}`);
      print("Set VIGIL_RECEIPTS_ADDRESS to this address.");
      break;
    }
    case "check": {
      const call = await buildAnchorCall(chain.rdk, config.chainId, config.rollupId, batch());
      const valid = await contract.checkAnchor(address(), call);
      const recorded = await contract.isAnchorRecorded(address(), call);
      print(
        `Batch ${String(batch())}: signature ${valid ? "valid" : "INVALID"}, ${recorded ? "recorded on chain" : "not recorded yet"}`,
      );
      break;
    }
    case "record": {
      const index = batch();
      const call = await buildAnchorCall(chain.rdk, config.chainId, config.rollupId, index);
      print(await recordOne(index, call));
      break;
    }
    case "sync": {
      await syncOnce();
      break;
    }
    case "watch": {
      // Long-running form of `sync`, for a container: no shell loop, clean shutdown.
      const intervalMs = envInt("RECEIPTS_INTERVAL_MS", 120_000, { min: 10_000, max: 86_400_000 });
      const state = { stop: false, wake: undefined as (() => void) | undefined };
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.once(signal, () => {
          state.stop = true;
          state.wake?.();
        });
      }
      while (!state.stop) {
        try {
          await syncOnce();
        } catch (error) {
          log.error({ err: error }, "receipt sync failed; will retry");
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, intervalMs);
          state.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      break;
    }
    default:
      throw new VigilError(
        "CONFIG_INVALID",
        "usage: vigil-receipts <status|setup|deploy|check|record|sync|watch>",
      );
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const known = error instanceof VigilError;
  process.stderr.write(`vigil-receipts: ${known ? error.message : "unexpected error"}\n`);
  if (known && Object.keys(error.details).length > 0) {
    process.stderr.write(`${JSON.stringify(error.details)}\n`);
  }
  if (!known) process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
