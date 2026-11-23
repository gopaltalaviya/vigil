import { mldsa87 } from "@qorechain/pqc";
import type { Hex } from "viem";
import { IntegrityError, fromHex, toHex, type StoredBatch, type StoredVerdict } from "@vigil/core";

/** The arguments of `VigilReceipts.recordAttestation`, without the signer. */
export interface BatchAttestation {
  chainId: string;
  rollupId: string;
  batchIndex: bigint;
  stateRoot: Hex;
  withdrawalsRoot: Hex;
  dataHash: Hex;
}

/** The contract calls an attestation needs. */
export interface AttestationContract {
  attestationMessage(attestation: BatchAttestation): Promise<Hex>;
  checkAttestation(signer: Hex, attestation: BatchAttestation, signature: Hex): Promise<boolean>;
  isAttestationRecorded(signer: Hex, attestation: BatchAttestation): Promise<boolean>;
}

export interface SignedAttestation {
  attestation: BatchAttestation;
  signature: Hex;
}

/**
 * Builds the attestation for a batch this watchtower re-executed. It refuses
 * anything but a final batch judged valid: an attestation is a public promise.
 */
export function attestationFor(
  chainId: string,
  rollupId: string,
  batch: StoredBatch,
  verdict: StoredVerdict | undefined,
): BatchAttestation {
  if (batch.status !== "finalized") {
    throw new IntegrityError("only a finalized batch can be attested", {
      batchIndex: batch.batchIndex,
      status: batch.status,
    });
  }
  if (verdict?.verdict !== "valid" || verdict.stateRoot !== batch.stateRoot) {
    throw new IntegrityError("only a batch this watchtower judged valid can be attested", {
      batchIndex: batch.batchIndex,
    });
  }
  return {
    chainId,
    rollupId,
    batchIndex: BigInt(batch.batchIndex),
    stateRoot: `0x${batch.stateRoot}`,
    withdrawalsRoot: `0x${batch.withdrawalsRoot}`,
    dataHash: `0x${batch.dataHash}`,
  };
}

/**
 * Signs an attestation with ML-DSA-87 and proves it before any transaction:
 * first locally, then with the contract's own read-only check.
 */
export async function signAttestation(
  contract: AttestationContract,
  signer: Hex,
  keys: { publicKey: Uint8Array; secretKey: Uint8Array },
  attestation: BatchAttestation,
): Promise<SignedAttestation> {
  const message = fromHex(await contract.attestationMessage(attestation));
  const signatureBytes = mldsa87.sign(keys.secretKey, message);
  if (!mldsa87.verify(keys.publicKey, message, signatureBytes)) {
    throw new IntegrityError("the attestation signature does not verify locally");
  }
  const signature: Hex = `0x${toHex(signatureBytes)}`;
  if (!(await contract.checkAttestation(signer, attestation, signature))) {
    throw new IntegrityError("the contract does not accept this attestation's signature");
  }
  return { attestation, signature };
}
