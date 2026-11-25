#!/usr/bin/env node
/**
 * `vigil-receipts`: puts verified settlement receipts on chain.
 *
 *   vigil-receipts status           deployer account, its key, window and the contract
 *   vigil-receipts setup [qor]      fund the deployer (default 20 QOR), register its key, open a window
 *   vigil-receipts deploy           deploy VigilReceipts (needs `forge build` output)
 *   vigil-receipts check <batch>    verify a batch's anchor through the contract, read-only
 *   vigil-receipts record <batch>   verify and record a batch's anchor on chain
 *   vigil-receipts attest <batch>   sign and record this watchtower's attestation of a batch
 *   vigil-receipts sync             record every finalized batch the watchtower judged valid
 *   vigil-receipts recover          restore missing receipt hashes from the contract's events
 *   vigil-receipts watch            run sync every two minutes until stopped
 *   vigil-receipts smart-account link [days]   lock record calls to a hot key (default 14 days)
 *   vigil-receipts smart-account status        the smart account, its rule and the hot key
 *   vigil-receipts smart-account revoke        disable the hot key at once
 *
 * Record calls go through the smart account when its hot key is ready, and
 * through a scoped EVM window otherwise. VIGIL_RECEIPTS_MODE=smart or window
 * forces one lane.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPqKeyStatus } from "@qorechain/qoresign/network";
import { bech32ToHex, pqcKeypairFromEnv, signerFromEnv, uqorToQor } from "@qorechain/rdk";
import type { Abi, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { fetchAuthNonce, fetchAuthenticators, fetchSpendingRules } from "@qorechain/sdk";
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
  RECORD_GAS,
  deployerAccount,
  deployerRelayer,
  deployerStatus,
  fundDeployer,
  openDeployerWindow,
  openScopedWindow,
  registerDeployerKey,
} from "./deployer.js";
import {
  buildLinkMsgs,
  buildRevokeMsg,
  executeRecord,
  smartAccountReady,
  type SmartAccount,
} from "./smart-account.js";
import { attestationFor, signAttestation } from "./attest.js";
import { ReceiptsContract } from "./contract.js";
import { buildAnchorCall, verifyAnchorSignature, type AnchorCall } from "./receipts.js";
import { recoverReceiptHashes } from "./recover.js";

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
  const remember = (batchIndex: number, call: AnchorCall, txHash: string): void => {
    const store = Store.open(join(config.dataDir, "vigil.sqlite"));
    try {
      const { receipt } = call;
      store.saveReceipt(config.rollupId, {
        batchIndex,
        stateRoot: receipt.stateRoot.replace(/^0x/, "").toLowerCase(),
        contract: address(),
        txHash,
        recordedAt: Math.floor(Date.now() / 1_000),
        // Kept so that anyone can ask the contract about this exact record (web "Verify on chain").
        anchorCall: {
          signer: call.signer,
          chainId: receipt.chainId,
          layerId: receipt.layerId,
          layerHeight: receipt.layerHeight.toString(),
          stateRoot: receipt.stateRoot,
          validatorSetHash: receipt.validatorSetHash,
          txCount: receipt.txCount.toString(),
        },
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
  /** Record calls only ever need a window limited to the receipts contract. */
  const ensureScopedWindow = async (): Promise<void> => {
    const status = await deployerStatus(context);
    if (!status.window.live || status.window.remainingTxs < 1n) {
      print(`Opened a scoped EVM window: ${await openScopedWindow(context, address())}`);
    }
  };

  /** Verifies an anchor off chain once, and keeps the result: the signer's key may rotate. */
  const checkAnchorOffChain = async (index: number, call: AnchorCall): Promise<void> => {
    const stateRoot = call.receipt.stateRoot.replace(/^0x/, "").toLowerCase();
    const store = Store.open(join(config.dataDir, "vigil.sqlite"));
    try {
      const done = store
        .anchorChecks(config.rollupId)
        .some((c) => c.batchIndex === index && c.stateRoot === stateRoot);
      if (done) return;
      const rollup = await chain.rdk.rest.getRollup(config.rollupId);
      const key = await fetchPqKeyStatus({ rest: config.restUrl, address: rollup.creator });
      const publicKey = key.publicKey;
      store.saveAnchorCheck(config.rollupId, {
        batchIndex: index,
        stateRoot,
        status:
          publicKey === undefined
            ? "no_key"
            : verifyAnchorSignature(publicKey, call)
              ? "valid"
              : "invalid",
        checkedAt: Math.floor(Date.now() / 1_000),
      });
    } finally {
      store.close();
    }
  };

  /**
   * Records one anchor. Someone else may record the same receipt first (it is
   * public data); that is the outcome we wanted, so it counts as success.
   */
  const recordOne = async (index: number, call: AnchorCall): Promise<string> => {
    if (await contract.isAnchorRecorded(address(), call)) {
      remember(index, call, "");
      return `Batch ${String(index)}: already recorded.`;
    }
    if (!(await contract.checkAnchor(address(), call))) {
      return `Batch ${String(index)}: signature does not verify; nothing was sent.`;
    }
    try {
      const hash = await sendRecord(ReceiptsContract.encodeRecordAnchor(call), async () => {
        await ensureScopedWindow();
        return contract.recordAnchor(await key(), address(), call);
      });
      remember(index, call, hash);
      return `Batch ${String(index)}: recorded. Transaction ${hash}`;
    } catch (error) {
      if (await contract.isAnchorRecorded(address(), call)) {
        remember(index, call, "");
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
        await checkAnchorOffChain(index, call);
      } catch (error) {
        log.warn({ batch: index, err: error }, "could not verify the anchor off chain");
      }
      try {
        print(await recordOne(index, call));
      } catch (error) {
        log.error({ batch: index, err: error }, "could not record the receipt");
        print(`Batch ${String(index)}: failed, will retry on the next round.`);
      }
    }
  };

  /** Fills in the hash of receipts known only as "already recorded". Sends nothing. */
  const recover = async (): Promise<void> => {
    const store = Store.open(join(config.dataDir, "vigil.sqlite"));
    try {
      const report = await recoverReceiptHashes({
        store,
        rollupId: config.rollupId,
        contract: address(),
        source: contract.logSource(address()),
      });
      print(
        `Receipt hashes: ${String(report.recovered)} of ${String(report.missing)} missing restored.` +
          (report.unresolved.length > 0 ? ` Unresolved: ${report.unresolved.join(", ")}.` : ""),
      );
    } finally {
      store.close();
    }
  };

  const key = async (): Promise<Hex> => (await deployerAccount(config)).privateKey as Hex;

  /** The hot key lives in the data directory, never in `.env` or the output. */
  const hotKeyPath = join(config.dataDir, "receipts-hot.key");
  const readHotKey = (): Hex | undefined => {
    if (!existsSync(hotKeyPath)) return undefined;
    const value = readFileSync(hotKeyPath, "utf8").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
      throw new VigilError("CONFIG_INVALID", "the hot key file is malformed", { path: hotKeyPath });
    }
    return value as Hex;
  };
  const smartAccount = async (hotKey: Hex): Promise<SmartAccount> => {
    const relayer = await deployerRelayer(context);
    return {
      rest: config.restUrl,
      chainId: config.chainId,
      account: relayer.address,
      hotKey,
      relayer,
    };
  };
  const mode = (): "auto" | "smart" | "window" => {
    const value = process.env.VIGIL_RECEIPTS_MODE?.trim() ?? "";
    if (value === "") return "auto";
    if (value === "auto" || value === "smart" || value === "window") return value;
    throw new VigilError("CONFIG_INVALID", "VIGIL_RECEIPTS_MODE must be auto, smart or window");
  };

  /**
   * Sends one record call to the receipts contract: through the smart account
   * when its hot key is ready, else through the scoped window. A relayed call
   * that fails on chain is never retried through the window here, because it
   * has used up the hot key's nonce; the next round re-checks the record.
   */
  const sendRecord = async (data: Hex, viaWindow: () => Promise<string>): Promise<string> => {
    const lane = mode();
    if (lane === "window") return viaWindow();
    const hotKey = readHotKey();
    const smart = hotKey === undefined ? undefined : await smartAccount(hotKey);
    const readiness =
      smart === undefined
        ? { ready: false, reason: "no hot key" }
        : await smartAccountReady(smart, address(), BigInt(Math.floor(Date.now() / 1_000)));
    if (smart === undefined || !readiness.ready) {
      if (lane === "smart") {
        throw new VigilError(
          "CONFIG_INVALID",
          `smart account not ready: ${readiness.reason ?? ""}`,
        );
      }
      log.warn({ reason: readiness.reason }, "smart account not ready; using the scoped window");
      return viaWindow();
    }
    return executeRecord(smart, { to: address(), data, gasLimit: RECORD_GAS });
  };

  const smartAccountCommand = async (action: string | undefined): Promise<void> => {
    const relayer = await deployerRelayer(context);
    const read = { rest: config.restUrl, address: relayer.address };
    switch (action ?? "") {
      case "link": {
        const days = Number(argv[2] ?? "14");
        if (!Number.isInteger(days) || days < 1 || days > 30) {
          throw new VigilError("CONFIG_INVALID", "give the key's lifetime in days, 1 to 30");
        }
        let hotKey = readHotKey();
        if (hotKey === undefined) {
          hotKey = generatePrivateKey();
          writeFileSync(hotKeyPath, `${hotKey}\n`, { flag: "wx", mode: 0o600 });
          print(`Created a hot key in the data directory.`);
        }
        const hotAddress = privateKeyToAccount(hotKey).address;
        const expiryUnix = BigInt(Math.floor(Date.now() / 1_000) + days * 86_400);
        const result = await relayer.broadcast(
          buildLinkMsgs({
            chainId: config.chainId,
            owner: relayer.address,
            hotKey,
            contract: address(),
            expiryUnix,
          }),
          1_000_000n,
        );
        if (result.code !== 0) {
          throw new VigilError("TX_FAILED", "linking the hot key was rejected", {
            hash: result.transactionHash,
            code: result.code,
          });
        }
        print(
          `Linked hot key ${hotAddress} until ${new Date(Number(expiryUnix) * 1_000).toISOString()}.`,
        );
        print(`Transaction ${result.transactionHash}`);
        const readiness = await smartAccountReady(
          await smartAccount(hotKey),
          address(),
          BigInt(Math.floor(Date.now() / 1_000)),
        );
        print(`Ready: ${readiness.ready ? "yes" : `no (${readiness.reason ?? ""})`}`);
        break;
      }
      case "status": {
        print(`Account:    ${relayer.address}`);
        const hotKey = readHotKey();
        const hotAddress = hotKey === undefined ? undefined : privateKeyToAccount(hotKey).address;
        print(`Hot key:    ${hotAddress ?? "none in the data directory"}`);
        try {
          const rules = await fetchSpendingRules(read);
          for (const rule of rules.rules) {
            print(
              `Rule:       ${rule.id} ${rule.enabled ? "enabled" : "disabled"}, per call ${rule.perTxLimit.toString()}, daily ${rule.dailyLimit.toString()} uqor, calls ${rule.allowedEvmCalls.join(" ")}`,
            );
          }
          for (const k of await fetchAuthenticators(read)) {
            print(
              `Key:        ${k.scheme} 0x${k.pubkeyHex.replace(/^0x/i, "")} ${k.permissions.join(",")} until ${new Date(Number(k.expiryUnix) * 1_000).toISOString()}${k.revoked ? " REVOKED" : ""}`,
            );
          }
        } catch (error) {
          print(`Smart account: none or unreadable (${(error as Error).message})`);
        }
        if (hotKey !== undefined && hotAddress !== undefined) {
          const nonce = await fetchAuthNonce({ ...read, pubkey: hotAddress });
          print(`Nonce:      ${nonce.nonce.toString()}, ${nonce.linked ? "linked" : "not linked"}`);
          const readiness = await smartAccountReady(
            await smartAccount(hotKey),
            address(),
            BigInt(Math.floor(Date.now() / 1_000)),
          );
          print(`Ready:      ${readiness.ready ? "yes" : `no (${readiness.reason ?? ""})`}`);
        }
        print(`Mode:       ${mode()}`);
        break;
      }
      case "revoke": {
        const hotKey = readHotKey();
        if (hotKey === undefined) throw new VigilError("CONFIG_INVALID", "no hot key to revoke");
        const result = await relayer.broadcast(
          [
            buildRevokeMsg({
              owner: relayer.address,
              hotAddress: privateKeyToAccount(hotKey).address,
            }),
          ],
          1_000_000n,
        );
        if (result.code !== 0) {
          throw new VigilError("TX_FAILED", "revoking the hot key was rejected", {
            hash: result.transactionHash,
            code: result.code,
          });
        }
        print(`Revoked. Transaction ${result.transactionHash}`);
        break;
      }
      default:
        throw new VigilError(
          "CONFIG_INVALID",
          "usage: vigil-receipts smart-account <link|status|revoke>",
        );
    }
  };

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
    case "attest": {
      const index = batch();
      const store = Store.open(join(config.dataDir, "vigil.sqlite"));
      let attestation;
      try {
        const claim = store
          .batches(config.rollupId)
          .findLast((b) => b.batchIndex === index && b.status !== "rejected");
        if (claim === undefined) throw new VigilError("CONFIG_INVALID", "no such batch");
        attestation = attestationFor(
          config.chainId,
          config.rollupId,
          claim,
          store.verdict(config.rollupId, claimId(claim)),
        );
      } finally {
        store.close();
      }
      const env = {
        QORE_MNEMONIC: config.secrets.mnemonic,
        QORE_PQC_SEED_HEX: config.secrets.pqcSeedHex,
      };
      const nativeSigner = await signerFromEnv(env);
      const [account] = (await nativeSigner?.getAccounts()) ?? [];
      if (account === undefined) throw new VigilError("CONFIG_INVALID", "no signing account");
      const pqc = await pqcKeypairFromEnv(chain.rdk, account.address, env);
      if (pqc === undefined) throw new VigilError("CONFIG_INVALID", "no ML-DSA-87 key");
      const signer: Hex = `0x${bech32ToHex(account.address).replace(/^0x/, "")}`;
      const reader = contract.attestations(address());
      if (await reader.isAttestationRecorded(signer, attestation)) {
        print(`Batch ${String(index)}: attestation already recorded.`);
        break;
      }
      const signed = await signAttestation(reader, signer, pqc.keypair, attestation);
      const hash = await sendRecord(
        ReceiptsContract.encodeRecordAttestation(signer, signed.attestation, signed.signature),
        async () => {
          await ensureScopedWindow();
          return contract.recordAttestation(
            await key(),
            address(),
            signer,
            signed.attestation,
            signed.signature,
          );
        },
      );
      print(`Batch ${String(index)}: attestation recorded. Transaction ${hash}`);
      break;
    }
    case "sync": {
      await syncOnce();
      break;
    }
    case "recover": {
      await recover();
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
      let recovered = false;
      while (!state.stop) {
        try {
          await syncOnce();
          if (!recovered) {
            await recover();
            recovered = true;
          }
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
    case "smart-account": {
      await smartAccountCommand(argument);
      break;
    }
    default:
      throw new VigilError(
        "CONFIG_INVALID",
        "usage: vigil-receipts <status|setup|deploy|check|record|attest|sync|recover|watch|smart-account>",
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
