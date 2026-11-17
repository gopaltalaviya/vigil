import { Registry } from "@cosmjs/proto-signing";
import { StargateClient, defaultRegistryTypes } from "@cosmjs/stargate";
import { evmWindowCost, evmWindowStatus } from "@qorechain/evm";
import { pqcKeypairFromEnv, signerFromEnv, type RdkClient } from "@qorechain/rdk";
import {
  EthNativeSigner,
  buildRegisterPqcKeyMsg,
  deriveUnifiedAccount,
  fetchPqcStatus,
  openEvmWindowMsg,
  signAndBroadcastHybrid,
  signProofOfPossession,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { ConfigError, TxFailedError, type Logger, type VigilConfig } from "@vigil/core";

/** Fee for one native-lane transaction; hybrid transactions are large, so gas is generous. */
const NATIVE_FEE = { amount: [{ denom: "uqor", amount: "150000" }], gas: "1000000" };

export interface DeployerContext {
  config: VigilConfig;
  rdk: RdkClient;
  log: Logger;
}

export interface DeployerStatus {
  evmAddress: string;
  cosmosAddress: string;
  balanceUqor: bigint;
  pqcKeyRegistered: boolean;
  window: { live: boolean; remainingTxs: bigint; remainingBlocks: bigint };
}

/**
 * The account that deploys and calls contracts. QoreChain's EVM lane needs an
 * account whose address comes from an Ethereum-style key, so this is derived
 * from the same seed phrase on the Ethereum path. It only pays gas: it is not
 * the rollup's creator and signs no settlement data.
 */
export async function deployerAccount(config: VigilConfig): Promise<UnifiedAccount> {
  if (config.secrets.mnemonic === undefined) {
    throw new ConfigError("QORE_MNEMONIC is required for EVM transactions", {
      problems: [{ variable: "QORE_MNEMONIC", problem: "missing" }],
    });
  }
  return deriveUnifiedAccount(config.secrets.mnemonic, 0);
}

export async function deployerStatus(context: DeployerContext): Promise<DeployerStatus> {
  const { config, rdk } = context;
  const account = await deployerAccount(config);
  const [balance, pqc, window] = await Promise.all([
    rdk.rest.getBalance(account.cosmos, "uqor"),
    fetchPqcStatus({ rest: config.restUrl, address: account.cosmos }),
    evmWindowStatus({ rest: config.restUrl, address: account.cosmos }),
  ]);
  return {
    evmAddress: account.evm,
    cosmosAddress: account.cosmos,
    balanceUqor: BigInt(balance),
    pqcKeyRegistered: pqc.registered,
    window: {
      live: window.found && window.live,
      remainingTxs: window.found ? window.remainingTxs : 0n,
      remainingBlocks: window.found ? window.remainingBlocks : 0n,
    },
  };
}

/** Sends uqor from the main (native) account to the deployer account, signed hybrid. */
export async function fundDeployer(context: DeployerContext, amountUqor: bigint): Promise<string> {
  const deployer = await deployerAccount(context.config);
  return sendFromMainAccount(context, deployer.cosmos, amountUqor);
}

/** Sends uqor from the main (native) account to any `qor1` address, signed hybrid. */
export async function sendFromMainAccount(
  context: DeployerContext,
  toAddress: string,
  amountUqor: bigint,
): Promise<string> {
  const { config, rdk, log } = context;
  const env = {
    QORE_MNEMONIC: config.secrets.mnemonic,
    QORE_PQC_SEED_HEX: config.secrets.pqcSeedHex,
  };
  const signer = await signerFromEnv(env);
  if (signer === undefined || !("signDirect" in signer)) {
    throw new ConfigError("could not derive a direct signer from QORE_MNEMONIC");
  }
  const [from] = await signer.getAccounts();
  if (from === undefined) throw new ConfigError("the signer holds no account");
  const pqc = await pqcKeypairFromEnv(rdk, from.address, env);
  if (pqc === undefined) throw new ConfigError("could not derive the ML-DSA-87 key");

  const transport = await StargateClient.connect(config.rpcUrl);
  try {
    const { accountNumber, sequence } = await transport.getSequence(from.address);
    const result = await signAndBroadcastHybrid({
      registry: new Registry(defaultRegistryTypes),
      signer,
      pqcKeypair: pqc.keypair,
      includePqcPublicKey: pqc.includePqcPublicKey,
      chainId: config.chainId,
      accountNumber,
      sequence,
      fee: NATIVE_FEE,
      rest: config.restUrl,
      transport,
      messages: [
        {
          typeUrl: "/cosmos.bank.v1beta1.MsgSend",
          value: {
            fromAddress: from.address,
            toAddress,
            amount: [{ denom: "uqor", amount: amountUqor.toString() }],
          },
        },
      ],
    });
    assertAccepted("send", result);
    log.info({ hash: result.transactionHash, to: toAddress }, "transfer confirmed");
    return result.transactionHash;
  } finally {
    transport.disconnect();
  }
}

/** Registers the deployer's ML-DSA-87 key with a proof of possession (needed once). */
export async function registerDeployerKey(context: DeployerContext): Promise<string> {
  const { config } = context;
  const account = await deployerAccount(config);
  const proofOfPossession = signProofOfPossession({
    chainId: config.chainId,
    account: account.cosmos,
    keypair: account.pqc,
  });
  const message = buildRegisterPqcKeyMsg(account.cosmos, {
    pqcKeypair: account.pqc,
    proofOfPossession,
  });
  // Registration is the one message the chain accepts with a classical signature only.
  return broadcastFromDeployer(context, account, "classical", "register-deployer-key", message);
}

/**
 * Opens an EVM authorisation window sized for `maxTxs` transactions of up to
 * `gasPerTx` gas. Without a live window the chain refuses every EVM transaction.
 */
export async function openDeployerWindow(
  context: DeployerContext,
  options: { blocks?: bigint; maxTxs?: bigint; gasPerTx?: bigint } = {},
): Promise<string> {
  const account = await deployerAccount(context.config);
  const maxTxs = options.maxTxs ?? 5n;
  const perTx = evmWindowCost({
    gas: options.gasPerTx ?? 3_000_000n,
    maxFeePerGas: 250_000_000_000n,
  });
  const message = openEvmWindowMsg({
    sender: account.cosmos,
    blocks: options.blocks ?? 600n,
    maxTxs,
    maxValue: perTx * maxTxs,
  });
  return broadcastFromDeployer(context, account, "hybrid", "open-evm-window", message);
}

async function broadcastFromDeployer(
  context: DeployerContext,
  account: UnifiedAccount,
  mode: "hybrid" | "classical",
  label: string,
  message: Parameters<EthNativeSigner["sign"]>[0]["messages"][number],
): Promise<string> {
  const { config, log } = context;
  const transport = await StargateClient.connect(config.rpcUrl);
  try {
    const { accountNumber, sequence } = await transport.getSequence(account.cosmos);
    const signer = new EthNativeSigner(account, { signMode: mode, rest: config.restUrl });
    const result = await signer.signAndBroadcast(transport, {
      chainId: config.chainId,
      accountNumber: accountNumber,
      sequence: BigInt(sequence),
      fee: NATIVE_FEE,
      messages: [message],
    });
    assertAccepted(label, result);
    log.info({ label, hash: result.transactionHash }, "transaction confirmed");
    return result.transactionHash;
  } finally {
    transport.disconnect();
  }
}

function assertAccepted(
  label: string,
  result: { code: number; transactionHash: string; rawLog?: string },
): void {
  if (result.code !== 0) {
    throw new TxFailedError(`${label}: rejected with code ${String(result.code)}`, {
      label,
      hash: result.transactionHash,
      code: result.code,
      log: (result.rawLog ?? "").slice(0, 300),
    });
  }
}
