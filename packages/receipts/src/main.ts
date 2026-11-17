#!/usr/bin/env node
/**
 * `vigil-receipts`: puts verified settlement receipts on chain.
 *
 *   vigil-receipts status           deployer account, its key, window and the contract
 *   vigil-receipts setup [qor]      fund the deployer (default 20 QOR), register its key, open a window
 *   vigil-receipts deploy           deploy VigilReceipts (needs `forge build` output)
 *   vigil-receipts check <batch>    verify a batch's anchor through the contract, read-only
 *   vigil-receipts record <batch>   verify and record a batch's anchor on chain
 *   vigil-receipts sync             record every anchored batch that is not on chain yet
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { uqorToQor } from "@qorechain/rdk";
import type { Abi, Hex } from "viem";
import { Store, VigilError, createChain, createLogger, loadConfig } from "@vigil/core";
import {
  deployerAccount,
  deployerStatus,
  fundDeployer,
  openDeployerWindow,
  registerDeployerKey,
} from "./deployer.js";
import { ReceiptsContract } from "./contract.js";
import { buildAnchorCall } from "./receipts.js";

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
  const remember = (batchIndex: number, txHash: string): void => {
    const store = Store.open(join(config.dataDir, "vigil.sqlite"));
    try {
      store.saveReceipt(config.rollupId, {
        batchIndex,
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
      if (await contract.isAnchorRecorded(address(), call)) {
        remember(index, "");
        print(`Batch ${String(index)} is already recorded.`);
        break;
      }
      if (!(await contract.checkAnchor(address(), call))) {
        throw new VigilError(
          "INTEGRITY",
          "the anchor's signature does not verify; nothing was sent",
        );
      }
      await ensureWindow();
      const hash = await contract.recordAnchor(await key(), address(), call);
      remember(index, hash);
      print(`Recorded batch ${String(index)}. Transaction ${hash}`);
      break;
    }
    case "sync": {
      const batches = await chain.rdk.rest.listBatches(config.rollupId);
      for (const item of batches) {
        if (item.status === "rejected") continue;
        const index = item.batchIndex;
        let call;
        try {
          call = await buildAnchorCall(chain.rdk, config.chainId, config.rollupId, index);
        } catch (error) {
          if (error instanceof VigilError && error.code === "INTEGRITY") {
            print(`Batch ${String(index)}: no anchor, skipped.`);
            continue;
          }
          throw error;
        }
        if (await contract.isAnchorRecorded(address(), call)) {
          remember(index, "");
          print(`Batch ${String(index)}: already recorded.`);
          continue;
        }
        if (!(await contract.checkAnchor(address(), call))) {
          print(`Batch ${String(index)}: signature does not verify, skipped.`);
          continue;
        }
        await ensureWindow();
        const hash = await contract.recordAnchor(await key(), address(), call);
        remember(index, hash);
        print(`Batch ${String(index)}: recorded. Transaction ${hash}`);
      }
      break;
    }
    default:
      throw new VigilError(
        "CONFIG_INVALID",
        "usage: vigil-receipts <status|setup|deploy|check|record|sync>",
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
