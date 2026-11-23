import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAbiItem,
  http,
  type Abi,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { IntegrityError, type VigilConfig } from "@vigil/core";
import { vigilReceiptsAbi } from "./abi.js";
import type { AnchorLog, AnchorLogSource } from "./recover.js";
import type { AnchorCall } from "./receipts.js";

/** Thin client for the `VigilReceipts` contract. */
export class ReceiptsContract {
  private readonly config: VigilConfig;
  private readonly chain: Chain;
  private readonly publicClient: PublicClient;

  constructor(config: VigilConfig) {
    this.config = config;
    this.chain = defineChain({
      id: config.network === "mainnet" ? 9801 : 9800,
      name: config.network === "mainnet" ? "QoreChain" : "QoreChain Testnet",
      nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
      rpcUrls: { default: { http: [config.evmRpcUrl] } },
    });
    this.publicClient = createPublicClient({
      chain: this.chain,
      transport: http(config.evmRpcUrl),
    });
  }

  private wallet(privateKey: Hex) {
    return createWalletClient({
      account: privateKeyToAccount(privateKey),
      chain: this.chain,
      transport: http(this.config.evmRpcUrl),
    });
  }

  /** Deploys the contract and returns its address once the transaction is mined. */
  async deploy(
    privateKey: Hex,
    artifact: { abi: Abi; bytecode: Hex },
  ): Promise<{ address: Hex; hash: Hex }> {
    const hash = await this.wallet(privateKey).deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success" || receipt.contractAddress == null) {
      throw new IntegrityError("the deployment transaction did not create a contract", { hash });
    }
    return { address: receipt.contractAddress, hash };
  }

  /** Whether code exists at `address` (a deployed `VigilReceipts`). */
  async hasCode(address: Hex): Promise<boolean> {
    const code = await this.publicClient.getCode({ address });
    return code !== undefined && code !== "0x";
  }

  /** Checks the anchor's signature on chain without sending a transaction. */
  async checkAnchor(address: Hex, call: AnchorCall): Promise<boolean> {
    return this.publicClient.readContract({
      address,
      abi: vigilReceiptsAbi,
      functionName: "checkAnchor",
      args: [call.signer, call.receipt, call.signature],
    });
  }

  async isAnchorRecorded(address: Hex, call: AnchorCall): Promise<boolean> {
    return this.publicClient.readContract({
      address,
      abi: vigilReceiptsAbi,
      functionName: "isAnchorRecorded",
      args: [call.signer, call.receipt],
    });
  }

  /** Reads the contract's anchor events, for restoring receipt hashes. */
  logSource(address: Hex): AnchorLogSource {
    const event = getAbiItem({ abi: vigilReceiptsAbi, name: "AnchorRecorded" });
    return {
      latestBlock: () => this.publicClient.getBlockNumber(),
      blockTime: async (blockNumber) =>
        Number((await this.publicClient.getBlock({ blockNumber })).timestamp),
      anchorLogs: async (fromBlock, toBlock) => {
        const logs = await this.publicClient.getLogs({ address, event, fromBlock, toBlock });
        return logs.flatMap((log): AnchorLog[] => {
          const { layerId, layerHeight, stateRoot } = log.args;
          if (layerId === undefined || layerHeight === undefined || stateRoot === undefined) {
            return [];
          }
          return [
            {
              txHash: log.transactionHash,
              blockNumber: log.blockNumber,
              layerId,
              layerHeight,
              stateRoot: stateRoot.replace(/^0x/, "").toLowerCase(),
            },
          ];
        });
      },
    };
  }

  /** Verifies and records the anchor on chain. Resolves with the transaction hash. */
  async recordAnchor(privateKey: Hex, address: Hex, call: AnchorCall): Promise<Hex> {
    const hash = await this.wallet(privateKey).writeContract({
      address,
      abi: vigilReceiptsAbi,
      functionName: "recordAnchor",
      args: [call.signer, call.receipt, call.signature],
      gas: 1_500_000n,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") {
      throw new IntegrityError("the contract rejected the receipt", { hash });
    }
    return hash;
  }
}
