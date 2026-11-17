import type { RdkTxClient } from "@qorechain/rdk";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  Store,
  TxFailedError,
  TxUnconfirmedError,
  connectTxSender,
  createChain,
  createTxSender,
  loadConfig,
  type RawTxResult,
} from "../src/index.js";

const client = {} as RdkTxClient;
const ok = (hash: string): RawTxResult => ({
  code: 0,
  height: 42,
  transactionHash: hash,
  gasUsed: 123_456,
  msgResponses: [{ typeUrl: "/x.Response", value: new Uint8Array([1]) }],
});

describe("transaction sender", () => {
  it("returns the outcome of an accepted transaction and logs it", async () => {
    const store = Store.open(":memory:");
    const sender = createTxSender({ address: "qor1a", client, store, now: () => 9 });
    const outcome = await sender.send("deposit", () => Promise.resolve(ok("AA")));

    expect(outcome).toMatchObject({ hash: "AA", height: 42, gasUsed: 123_456n });
    expect(outcome.responses).toHaveLength(1);
    expect(store.recentTxs(5)).toEqual([
      {
        id: 1,
        label: "deposit",
        status: "confirmed",
        hash: "AA",
        height: 42,
        code: 0,
        error: undefined,
        createdAt: 9,
      },
    ]);
  });

  it("turns a rejected transaction into a typed error with the chain's reason", async () => {
    const store = Store.open(":memory:");
    const sender = createTxSender({ address: "qor1a", client, store });
    const error: unknown = await sender
      .send("bond", () =>
        Promise.resolve({
          code: 49,
          height: 7,
          transactionHash: "BB",
          gasUsed: 1n,
          rawLog: "failed to execute message; codespace rdk code 49",
        }),
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TxFailedError);
    expect((error as TxFailedError).details).toMatchObject({ label: "bond", hash: "BB", code: 49 });
    expect(store.recentTxs(1)[0]).toMatchObject({ status: "failed", code: 49, hash: "BB" });
  });

  it("reports a broadcast with an unknown fate as unconfirmed, not failed", async () => {
    const store = Store.open(":memory:");
    const sender = createTxSender({ address: "qor1a", client, store });
    const error: unknown = await sender
      .send("batch", () => Promise.reject(new Error("socket closed")))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TxUnconfirmedError);
    expect(store.recentTxs(1)[0]).toMatchObject({ status: "unconfirmed", error: "socket closed" });
  });

  it("never runs two transactions of one account at the same time", async () => {
    const sender = createTxSender({ address: "qor1a", client });
    const order: string[] = [];
    let running = 0;
    const slow =
      (name: string, fail = false) =>
      async (): Promise<RawTxResult> => {
        running += 1;
        expect(running).toBe(1);
        order.push(`start ${name}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`end ${name}`);
        running -= 1;
        if (fail) throw new Error("boom");
        return ok(name);
      };

    const results = await Promise.allSettled([
      sender.send("a", slow("a")),
      sender.send("b", slow("b", true)),
      sender.send("c", slow("c")),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(order).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("refuses to connect without a seed phrase, naming only the variable", async () => {
    const config = loadConfig({ ROLLUP_ID: "vigil-1" });
    const chain = createChain(config, () => Promise.reject(new Error("no network in tests")));
    const error: unknown = await connectTxSender(config, chain.rdk).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain("QORE_MNEMONIC");
  });
});
