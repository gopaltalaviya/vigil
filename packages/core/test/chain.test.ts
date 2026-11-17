import { isRestNotFound, type BatchView } from "@qorechain/rdk";
import { describe, expect, it } from "vitest";
import {
  chainInboxSource,
  createChain,
  loadConfig,
  toBatchClaim,
  toStoredBatch,
  type Transport,
} from "../src/index.js";

const config = loadConfig({ ROLLUP_ID: "vigil-1", HTTP_MAX_RETRIES: "0" });

function transportReturning(
  status: number,
  body: unknown,
): { transport: Transport; urls: string[] } {
  const urls: string[] = [];
  const transport: Transport = (url) => {
    urls.push(url);
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: "",
      json: () => Promise.resolve(body),
    });
  };
  return { transport, urls };
}

describe("chain access", () => {
  it("labels each endpoint and routes the kit's reads through the resilient client", async () => {
    const { transport, urls } = transportReturning(404, { code: 5, message: "not found" });
    const chain = createChain(config, transport);

    expect([chain.rest.source, chain.rpc.source, chain.evm.source]).toEqual([
      "testnet-rest",
      "testnet-rpc",
      "testnet-evm",
    ]);
    const error: unknown = await chain.rdk.rest.getRollup("vigil-1").catch((e: unknown) => e);
    expect(isRestNotFound(error)).toBe(true);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^https:\/\/api-testnet\.qore\.host\/qorechain\/rdk\/v1\//);
  });

  it("reads the inbox head and surfaces a missing payload as an error", async () => {
    const inbox = {
      rollup_id: "vigil-1",
      sequencing: "based",
      head_sequence: "3",
      head_acc: "AB".repeat(32),
      consumed_sequence: "0",
      consumed_acc: "",
    };
    const { transport } = transportReturning(200, { ...inbox, inbox, txs: [], tx_responses: [] });
    const source = chainInboxSource(createChain(config, transport), config.chainId, "vigil-1");

    const head = await source.head();
    expect(head.sequence).toBe(3);
    await expect(source.entries(0, 3, new Uint8Array(32))).rejects.toThrow();
  });

  it("normalises a batch view into a stored batch and a claim", () => {
    const view: BatchView = {
      rollupId: "vigil-1",
      batchIndex: 7,
      stateRoot: "0xAA" + "bb".repeat(31),
      prevStateRoot: "CC".repeat(32),
      txCount: 3,
      dataHash: "dd".repeat(32),
      proofType: "fraud",
      status: "submitted",
      submittedAt: 100,
      finalizedAt: 0,
      withdrawalsRoot: "",
      submittedTime: 1,
      inboxStart: 10,
      inboxEnd: 13,
      withdrawalsRootReduced: false,
    };
    const stored = toStoredBatch(view);
    expect(stored.stateRoot).toBe("aa" + "bb".repeat(31));
    expect(stored.prevStateRoot).toBe("cc".repeat(32));
    expect(stored.submittedTime).toBe(1);
    expect(toBatchClaim(stored)).toEqual({
      batchIndex: 7,
      inboxStart: 10,
      inboxEnd: 13,
      prevStateRoot: "cc".repeat(32),
      stateRoot: "aa" + "bb".repeat(31),
      withdrawalsRoot: "",
      dataHash: "dd".repeat(32),
    });
  });
});
