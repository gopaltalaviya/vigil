/**
 * Exercises the receipt verification logic against the live testnet's post-quantum
 * precompiles without deploying anything: the `LiveProbe` contract's creation code is
 * simulated with `eth_call`. Also records the anchor as a fixture for the contract tests.
 * Read-only; needs no key and no funds. Run `pnpm --filter @vigil/contracts build` first.
 *
 * Usage: pnpm live:probe [rollup-id]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { anchorSignBytesForBatch, bech32ToHex } from "@qorechain/rdk";
import { decodeAbiParameters, encodeDeployData, keccak256, type Abi, type Hex } from "viem";
import { createChain, loadConfig, normalizeHex, toHex } from "@vigil/core";

const rollupId = process.argv[2] ?? "rdk-v328-e2e-mwd5v89d";
const config = loadConfig({ ROLLUP_ID: rollupId, QORE_NETWORK: "testnet" });
const chain = createChain(config);

const path = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const artifact = JSON.parse(
  readFileSync(path("../contracts/out/LiveProbe.sol/LiveProbe.json"), "utf8"),
) as { abi: Abi; bytecode: { object: Hex } };

const rollup = await chain.rdk.rest.getRollup(rollupId);
const anchors = await chain.rdk.rest.getAnchors(rollup.layerId);
const anchor = anchors[0];
if (anchor === undefined) throw new Error(`rollup ${rollupId} has no anchor to check`);
const batch = await chain.rdk.rest.getBatch(rollupId, anchor.layerHeight);

const hex = (value: string): Hex => `0x${normalizeHex(value)}`;
const signer = hex(bech32ToHex(rollup.creator));
const receipt = {
  chainId: config.chainId,
  layerId: anchor.layerId,
  layerHeight: BigInt(anchor.layerHeight),
  stateRoot: hex(anchor.stateRoot),
  validatorSetHash: hex(anchor.validatorSetHash),
  txCount: BigInt(batch.txCount),
};
const signature = hex(anchor.pqcSignature);

const expectedMessage = anchorSignBytesForBatch({
  chainId: config.chainId,
  layerId: anchor.layerId,
  batchIndex: anchor.layerHeight,
  stateRoot: anchor.stateRoot,
  txCount: batch.txCount,
  validatorSetHash: anchor.validatorSetHash,
});
const expectedMessageHash = keccak256(`0x${toHex(expectedMessage)}`);

async function probe(label: string, args: readonly unknown[]): Promise<boolean> {
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args });
  const answer = (await chain.evm.postJson(config.evmRpcUrl, {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ data }, "latest"],
  })) as { result?: Hex; error?: { message: string } };
  if (answer.result === undefined) {
    console.log(`${label}: reverted (${answer.error?.message ?? "no message"})`);
    return false;
  }
  const [valid, messageHash] = decodeAbiParameters(
    [{ type: "bool" }, { type: "bytes32" }],
    answer.result,
  );
  const layout =
    messageHash === expectedMessageHash ? "same as the kit's" : "differs from the kit's";
  console.log(`${label}: valid=${String(valid)} (signed message ${layout})`);
  return valid;
}

const genuine = await probe("genuine anchor", [signer, receipt, signature]);
const tampered = await probe("tampered tx count", [
  signer,
  { ...receipt, txCount: receipt.txCount + 1n },
  signature,
]);
await probe("unregistered signer", [
  "0x00000000000000000000000000000000000000ff",
  receipt,
  signature,
]);

const fixture = {
  rollupId,
  signer,
  receipt: {
    ...receipt,
    layerHeight: Number(receipt.layerHeight),
    txCount: Number(receipt.txCount),
  },
  signature,
  messageHash: expectedMessageHash,
};
writeFileSync(
  path("../contracts/test/fixtures/live-anchor.json"),
  `${JSON.stringify(fixture, null, 2)}\n`,
);

if (!genuine || tampered) {
  console.error("live probe FAILED");
  process.exit(1);
}
console.log("live probe passed; fixture written");
