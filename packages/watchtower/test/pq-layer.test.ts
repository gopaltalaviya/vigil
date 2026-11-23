import type { InspectedTransaction } from "@qorechain/qoresign/network";
import { describe, expect, it } from "vitest";
import { Store, claimId, createLogger, type StoredBatch } from "@vigil/core";
import { PqLayerChecker, classifyPqLayer, type InspectTx } from "../src/index.js";

const log = createLogger({ service: "test", level: "silent" });

const batch = (batchIndex: number): StoredBatch => ({
  batchIndex,
  stateRoot: "aa".repeat(32),
  prevStateRoot: "bb".repeat(32),
  dataHash: "cc".repeat(32),
  withdrawalsRoot: "dd".repeat(32),
  inboxStart: batchIndex,
  inboxEnd: batchIndex + 1,
  txCount: 1,
  status: "finalized",
  submittedAt: 100 + batchIndex,
  submittedTime: 1,
  finalizedAt: 200,
});

const inspected = (pqLayer: Partial<InspectedTransaction["pqLayer"]>) =>
  ({
    pqLayer: { present: true, count: 1, algorithmId: 1, verified: true, ...pqLayer },
    signer: { address: "qor1signer" },
  }) as InspectedTransaction;

function setup(inspect: InspectTx, count = 2, maxPerRun?: number) {
  const store = Store.open(":memory:");
  for (let i = 0; i < count; i += 1) store.upsertBatch("r1", batch(i));
  const checker = new PqLayerChecker({
    rollupId: "r1",
    store,
    inspect,
    findSubmission: (index) => Promise.resolve(`TX${String(index)}`),
    log,
    now: () => 9,
    ...(maxPerRun === undefined ? {} : { maxPerRun }),
  });
  return { store, checker };
}

describe("classifyPqLayer", () => {
  it("names each outcome", () => {
    expect(classifyPqLayer(undefined)).toBe("not_found");
    expect(classifyPqLayer(inspected({}))).toBe("verified");
    expect(classifyPqLayer(inspected({ verified: false }))).toBe("invalid");
    expect(classifyPqLayer(inspected({ present: false }))).toBe("classical");
  });

  it("does not count an undetermined signature as verified", () => {
    const unknown = inspected({});
    delete unknown.pqLayer.verified;
    expect(classifyPqLayer(unknown)).toBe("invalid");
  });
});

describe("PqLayerChecker", () => {
  it("stores the result with the transaction and signer, once", async () => {
    let calls = 0;
    const { checker, store } = setup(() => {
      calls += 1;
      return Promise.resolve(inspected({ signBytesVersion: "v2" }));
    });
    await checker.checkPending();
    await checker.checkPending();

    expect(calls).toBe(2);
    expect(store.pqChecks("r1")[0]).toMatchObject({
      claimId: claimId(batch(0)),
      txHash: "TX0",
      status: "verified",
      signBytesVersion: "v2",
      signer: "qor1signer",
      checkedAt: 9,
    });
  });

  it("records a pruned transaction as not found", async () => {
    const { checker, store } = setup(() => Promise.resolve(undefined), 1);
    await checker.checkPending();
    expect(store.pqChecks("r1")[0]?.status).toBe("not_found");
  });

  it("leaves a claim for the next run when the read fails", async () => {
    let fail = true;
    const { checker, store } = setup(() => {
      if (fail) return Promise.reject(new Error("offline"));
      return Promise.resolve(inspected({}));
    }, 1);
    await checker.checkPending();
    expect(store.pqChecks("r1")).toEqual([]);
    fail = false;
    await checker.checkPending();
    expect(store.pqChecks("r1")).toHaveLength(1);
  });

  it("works through a backlog in bounded runs", async () => {
    const { checker, store } = setup(() => Promise.resolve(inspected({})), 5, 2);
    await checker.checkPending();
    expect(store.pqChecks("r1")).toHaveLength(2);
    await checker.checkPending();
    await checker.checkPending();
    expect(store.pqChecks("r1")).toHaveLength(5);
  });
});
