import { describe, expect, it } from "vitest";
import {
  HttpClient,
  Store,
  chainHistory,
  claimId,
  flattenMessages,
  parseFraud,
  parseSubmission,
  parseWithdrawals,
  type Transport,
} from "../src/index.js";

const root = (byte: number): string => Buffer.alloc(32, byte).toString("base64");
const event = (type: string, values: Record<string, string>) => ({
  type,
  attributes: Object.entries(values).map(([key, value]) => ({ key, value })),
});

const fraudTx = {
  txhash: "AA",
  height: "100",
  code: 0,
  timestamp: "2026-11-18T21:42:06Z",
  tx: { body: { messages: [] } },
  events: [
    event("rdk_fraud_upheld", {
      rollup_id: "r1",
      batch_index: "29",
      submitter: "qor1bad",
      challenger: "qor1good",
      slashed: "1000000000uqor",
      challenger_reward: "500000000uqor",
      burned: "500000000uqor",
    }),
    event("rdk_fraud_upheld", {
      rollup_id: "other",
      batch_index: "1",
      submitter: "x",
      challenger: "y",
      slashed: "1uqor",
      challenger_reward: "1uqor",
      burned: "0uqor",
    }),
  ],
};

const submitMessage = {
  "@type": "/qorechain.rdk.v1.MsgSubmitBatch",
  rollup_id: "r1",
  batch_index: "29",
  state_root: root(1),
  prev_state_root: root(2),
  data_hash: root(3),
  withdrawals_root: root(4),
  tx_count: "2",
};
const submitTx = {
  txhash: "BB",
  height: "90",
  code: 0,
  timestamp: "2026-11-18T21:41:56Z",
  tx: { body: { messages: [submitMessage] } },
  events: [
    event("rdk_inbox_consumed", {
      rollup_id: "r1",
      batch_index: "29",
      inbox_start: "41",
      inbox_end: "43",
    }),
  ],
};

describe("chain history parsing", () => {
  it("reads only this rollup's upheld fraud proofs", () => {
    expect(parseFraud(fraudTx, "r1")).toEqual([
      {
        batchIndex: 29,
        txHash: "AA",
        height: 100,
        time: Date.parse("2026-11-18T21:42:06Z") / 1_000,
        submitter: "qor1bad",
        challenger: "qor1good",
        slashedUqor: "1000000000",
        rewardUqor: "500000000",
        burnedUqor: "500000000",
      },
    ]);
  });

  it("ignores failed transactions", () => {
    expect(parseFraud({ ...fraudTx, code: 5 }, "r1")).toEqual([]);
    expect(parseSubmission({ ...submitTx, code: 5 }, "r1", 29)).toBeUndefined();
  });

  it("refuses a malformed amount instead of guessing", () => {
    const bad = {
      ...fraudTx,
      events: [
        event("rdk_fraud_upheld", {
          rollup_id: "r1",
          batch_index: "1",
          submitter: "a",
          challenger: "b",
          slashed: "12fqor",
          challenger_reward: "1uqor",
          burned: "1uqor",
        }),
      ],
    };
    expect(() => parseFraud(bad, "r1")).toThrow(/bad amount/);
  });

  it("rebuilds a claim with the hex identity the chain view uses", () => {
    const claim = parseSubmission(submitTx, "r1", 29);
    expect(claim).toMatchObject({
      stateRoot: "01".repeat(32),
      prevStateRoot: "02".repeat(32),
      dataHash: "03".repeat(32),
      withdrawalsRoot: "04".repeat(32),
      inboxStart: 41,
      inboxEnd: 43,
      txCount: 2,
      submittedAt: 90,
      status: "rejected",
    });
    expect(claim && claimId(claim)).toContain(":41:43:90");
  });

  it("finds a batch submitted through an authz MsgExec", () => {
    const wrapped = {
      ...submitTx,
      tx: {
        body: {
          messages: [{ "@type": "/cosmos.authz.v1beta1.MsgExec", msgs: [submitMessage] }],
        },
      },
    };
    expect(flattenMessages(wrapped.tx.body.messages)).toHaveLength(1);
    expect(parseSubmission(wrapped, "r1", 29)?.inboxEnd).toBe(43);
  });

  it("reads executed withdrawals", () => {
    const tx = {
      ...fraudTx,
      events: [
        event("rdk_withdrawal_executed", {
          rollup_id: "r1",
          batch_index: "28",
          withdrawal_index: "7",
          recipient: "qor1x",
          amount: "2000000uqor",
        }),
      ],
    };
    expect(parseWithdrawals(tx, "r1")).toMatchObject([
      { batchIndex: 28, withdrawalIndex: 7, recipient: "qor1x", amountUqor: "2000000" },
    ]);
  });

  it("walks every page of a search", async () => {
    const pages = [
      { tx_responses: [fraudTx], txs: [fraudTx.tx], total: "2" },
      { tx_responses: [{ ...fraudTx, txhash: "CC", height: "50" }], txs: [fraudTx.tx], total: "2" },
    ];
    const urls: string[] = [];
    const transport: Transport = (url) => {
      urls.push(url);
      const page = Number(new URL(url).searchParams.get("page"));
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "",
        json: () => Promise.resolve(pages[page - 1]),
      });
    };
    const rest = new HttpClient({ source: "test", transport });
    const found = await chainHistory(rest, "https://rest.test", "r1").fraud();
    expect(found.map((f) => f.txHash)).toEqual(["CC", "AA"]);
    expect(urls).toHaveLength(2);
  });
});

describe("fraud and claim records", () => {
  const record = {
    txHash: "AA",
    claimId: "c",
    batchIndex: 29,
    height: 100,
    time: 1,
    submitter: "a",
    challenger: "b",
    slashedUqor: "1",
    rewardUqor: "1",
    burnedUqor: "0",
    seenLive: false,
  };

  it("stores a fraud event once", () => {
    const store = Store.open(":memory:");
    expect(store.saveFraudEvent("r1", record)).toBe(true);
    expect(store.saveFraudEvent("r1", record)).toBe(false);
    expect(store.fraudEvents("r1")).toEqual([record]);
  });

  it("fills in a missing payout hash but never replaces a known one", () => {
    const store = Store.open(":memory:");
    store.saveClaim("r1", { withdrawalIndex: 1, batchIndex: 2, txHash: "" });
    store.saveClaim("r1", { withdrawalIndex: 1, batchIndex: 2, txHash: "H1" });
    store.saveClaim("r1", { withdrawalIndex: 1, batchIndex: 2, txHash: "H2" });
    expect(store.claims("r1")).toEqual([{ withdrawalIndex: 1, batchIndex: 2, txHash: "H1" }]);
  });
});
