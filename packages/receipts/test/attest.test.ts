import { mldsa87 } from "@qorechain/pqc";
import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { toHex, type StoredBatch, type StoredVerdict } from "@vigil/core";
import { attestationFor, signAttestation, type AttestationContract } from "../src/attest.js";

const SIGNER: Hex = `0x${"11".repeat(20)}`;
const batch: StoredBatch = {
  batchIndex: 7,
  stateRoot: "aa".repeat(32),
  prevStateRoot: "bb".repeat(32),
  dataHash: "cc".repeat(32),
  withdrawalsRoot: "dd".repeat(32),
  inboxStart: 1,
  inboxEnd: 2,
  txCount: 1,
  status: "finalized",
  submittedAt: 10,
  submittedTime: 1,
  finalizedAt: 20,
};
const verdict: StoredVerdict = {
  claimId: "c",
  batchIndex: 7,
  stateRoot: batch.stateRoot,
  verdict: "valid",
  expectedStateRoot: batch.stateRoot,
  expectedWithdrawalsRoot: batch.withdrawalsRoot,
  reasons: [],
  checkedAt: 1,
};
const keys = mldsa87.keygen(new Uint8Array(32).fill(7));
const message = new TextEncoder().encode("attestation bytes");

const contract = (accepts = true): AttestationContract => ({
  attestationMessage: () => Promise.resolve<Hex>(`0x${toHex(message)}`),
  checkAttestation: () => Promise.resolve(accepts),
  isAttestationRecorded: () => Promise.resolve(false),
});

describe("attestationFor", () => {
  it("shapes a final, valid batch for the contract", () => {
    expect(attestationFor("c1", "r1", batch, verdict)).toEqual({
      chainId: "c1",
      rollupId: "r1",
      batchIndex: 7n,
      stateRoot: `0x${batch.stateRoot}`,
      withdrawalsRoot: `0x${batch.withdrawalsRoot}`,
      dataHash: `0x${batch.dataHash}`,
    });
  });

  it("refuses a batch that is not final", () => {
    expect(() => attestationFor("c1", "r1", { ...batch, status: "submitted" }, verdict)).toThrow(
      /finalized/,
    );
  });

  it("refuses a batch without a valid verdict for this exact root", () => {
    expect(() => attestationFor("c1", "r1", batch, undefined)).toThrow(/judged valid/);
    expect(() => attestationFor("c1", "r1", batch, { ...verdict, verdict: "invalid" })).toThrow(
      /judged valid/,
    );
    expect(() =>
      attestationFor("c1", "r1", batch, { ...verdict, stateRoot: "ee".repeat(32) }),
    ).toThrow(/judged valid/);
  });
});

describe("signAttestation", () => {
  const attestation = attestationFor("c1", "r1", batch, verdict);

  it("returns a signature that verifies over the contract's message", async () => {
    const signed = await signAttestation(contract(), SIGNER, keys, attestation);
    const signature = Uint8Array.from(Buffer.from(signed.signature.slice(2), "hex"));
    expect(signature).toHaveLength(4627);
    expect(mldsa87.verify(keys.publicKey, message, signature)).toBe(true);
  });

  it("stops when the contract's read-only check refuses it", async () => {
    await expect(signAttestation(contract(false), SIGNER, keys, attestation)).rejects.toThrow(
      /does not accept/,
    );
  });

  it("stops when the key pair does not match", async () => {
    const other = mldsa87.keygen(new Uint8Array(32).fill(8));
    await expect(
      signAttestation(
        contract(),
        SIGNER,
        { publicKey: other.publicKey, secretKey: keys.secretKey },
        attestation,
      ),
    ).rejects.toThrow(/does not verify locally/);
  });
});
