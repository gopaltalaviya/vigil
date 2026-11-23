import { mldsa87 } from "@qorechain/pqc";
import { anchorSignBytesForBatch, bech32ToHex, type RdkClient } from "@qorechain/rdk";
import { keccak256, type Hex } from "viem";
import { IntegrityError, fromHex, normalizeHex, toHex } from "@vigil/core";

/** The arguments of `VigilReceipts.recordAnchor` for one settled batch. */
export interface AnchorCall {
  signer: Hex;
  receipt: {
    chainId: string;
    layerId: string;
    layerHeight: bigint;
    stateRoot: Hex;
    validatorSetHash: Hex;
    txCount: bigint;
  };
  signature: Hex;
  /** keccak256 of the bytes the creator signed, as the base chain defines them. */
  messageHash: Hex;
  /** The exact bytes the creator signed. */
  signBytes: Uint8Array;
}

const MLDSA87_PUBLIC_KEY_BYTES = 2592;
const MLDSA87_SIGNATURE_BYTES = 4627;

/**
 * Verifies a batch's ML-DSA-87 anchor signature off chain, with no gas and no
 * node involved. Anything of the wrong size is simply not valid.
 */
export function verifyAnchorSignature(publicKey: Uint8Array, call: AnchorCall): boolean {
  const signature = fromHex(call.signature);
  if (publicKey.length !== MLDSA87_PUBLIC_KEY_BYTES) return false;
  if (signature.length !== MLDSA87_SIGNATURE_BYTES) return false;
  return mldsa87.verify(publicKey, call.signBytes, signature);
}

const hex = (value: string): Hex => `0x${normalizeHex(value)}`;

/**
 * Reads a batch's settlement anchor from the base chain and shapes it for the
 * contract. The anchor must exist, belong to this batch and carry a signature.
 */
export async function buildAnchorCall(
  rdk: RdkClient,
  chainId: string,
  rollupId: string,
  batchIndex: number,
): Promise<AnchorCall> {
  const [rollup, batch] = await Promise.all([
    rdk.rest.getRollup(rollupId),
    rdk.rest.getBatch(rollupId, batchIndex),
  ]);
  const anchors = await rdk.rest.getAnchors(rollup.layerId);
  const anchor = anchors.find((candidate) => candidate.layerHeight === batchIndex);
  if (anchor === undefined) {
    throw new IntegrityError("the batch has no settlement anchor on the base chain", {
      rollupId,
      batchIndex,
    });
  }
  if (normalizeHex(anchor.stateRoot) !== normalizeHex(batch.stateRoot)) {
    throw new IntegrityError("the anchor's state root differs from the batch's", {
      rollupId,
      batchIndex,
    });
  }
  const message = anchorSignBytesForBatch({
    chainId,
    layerId: anchor.layerId,
    batchIndex,
    stateRoot: anchor.stateRoot,
    txCount: batch.txCount,
    validatorSetHash: anchor.validatorSetHash,
  });
  return {
    signer: hex(bech32ToHex(rollup.creator)),
    receipt: {
      chainId,
      layerId: anchor.layerId,
      layerHeight: BigInt(batchIndex),
      stateRoot: hex(anchor.stateRoot),
      validatorSetHash: hex(anchor.validatorSetHash),
      txCount: BigInt(batch.txCount),
    },
    signature: hex(anchor.pqcSignature),
    messageHash: keccak256(`0x${toHex(message)}`),
    signBytes: message,
  };
}
