import { readFileSync } from "node:fs";
import { hexToBech32, type RdkClient } from "@qorechain/rdk";
import { describe, expect, it } from "vitest";
import { IntegrityError } from "@vigil/core";
import { buildAnchorCall, vigilReceiptsAbi } from "../src/index.js";

/** The anchor of a real batch, recorded from the testnet by `pnpm live:probe`. */
const live = JSON.parse(
  readFileSync(
    new URL("../../../contracts/test/fixtures/live-anchor.json", import.meta.url),
    "utf8",
  ),
) as {
  rollupId: string;
  signer: string;
  receipt: {
    chainId: string;
    layerId: string;
    layerHeight: number;
    stateRoot: string;
    validatorSetHash: string;
    txCount: number;
  };
  signature: string;
  messageHash: string;
};

const creator = hexToBech32(live.signer.slice(2), "qor");

function fakeRdk(overrides: { anchors?: unknown[]; batchRoot?: string } = {}): RdkClient {
  const anchor = {
    layerId: live.receipt.layerId,
    layerHeight: live.receipt.layerHeight,
    stateRoot: live.receipt.stateRoot.slice(2).toUpperCase(),
    validatorSetHash: live.receipt.validatorSetHash.slice(2),
    pqcSignature: live.signature.slice(2),
  };
  return {
    rest: {
      getRollup: () => Promise.resolve({ creator, layerId: live.receipt.layerId }),
      getBatch: () =>
        Promise.resolve({
          stateRoot: overrides.batchRoot ?? live.receipt.stateRoot.slice(2),
          txCount: live.receipt.txCount,
        }),
      getAnchors: () =>
        Promise.resolve(overrides.anchors ?? [{ ...anchor, layerHeight: 99 }, anchor]),
    },
  } as unknown as RdkClient;
}

describe("buildAnchorCall", () => {
  it("shapes a batch's anchor exactly as the contract and the base chain expect", async () => {
    const call = await buildAnchorCall(
      fakeRdk(),
      live.receipt.chainId,
      live.rollupId,
      live.receipt.layerHeight,
    );

    expect(call.signer).toBe(live.signer);
    expect(call.receipt).toEqual({
      chainId: live.receipt.chainId,
      layerId: live.receipt.layerId,
      layerHeight: BigInt(live.receipt.layerHeight),
      stateRoot: live.receipt.stateRoot,
      validatorSetHash: live.receipt.validatorSetHash,
      txCount: BigInt(live.receipt.txCount),
    });
    expect(call.signature).toBe(live.signature);
    expect(call.signature).toHaveLength(2 + 4627 * 2);
    expect(call.messageHash).toBe(live.messageHash);
  });

  it("refuses a batch that has no anchor", async () => {
    await expect(
      buildAnchorCall(fakeRdk({ anchors: [] }), live.receipt.chainId, live.rollupId, 0),
    ).rejects.toThrow(/no settlement anchor/);
  });

  it("refuses an anchor whose state root differs from the batch", async () => {
    const error: unknown = await buildAnchorCall(
      fakeRdk({ batchRoot: "ab".repeat(32) }),
      live.receipt.chainId,
      live.rollupId,
      live.receipt.layerHeight,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntegrityError);
  });
});

describe("generated ABI", () => {
  it("exposes the functions and events the client relies on", () => {
    const names = (vigilReceiptsAbi as readonly { name?: string; type: string }[]).map(
      (item) => item.name ?? item.type,
    );
    for (const expected of [
      "recordAnchor",
      "recordAttestation",
      "checkAnchor",
      "isAnchorRecorded",
      "AnchorRecorded",
      "InvalidSignature",
      "AlreadyRecorded",
    ]) {
      expect(names).toContain(expected);
    }
  });
});
