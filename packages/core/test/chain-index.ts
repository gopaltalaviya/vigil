import {
  EMPTY_INBOX_ACC,
  bytesToBase64,
  bytesToHex,
  decodeQledgerDeposit,
  postedDataHash,
  qledgerAccumulate,
} from "@qorechain/rdk";
import type { Transport } from "../src/index.js";
import { toEntries, type GoldenFixture } from "./helpers.js";

export interface ChainIndexOptions {
  /** Sequences whose posted-data record the chain has pruned. */
  pruned?: (sequence: number) => boolean;
  /** Posts of another rollup indexed before this one's, to push its posts past page 50. */
  filler?: number;
}

/**
 * A fake base-chain REST API that serves the golden inbox the way the node does: one
 * transaction per post or deposit in the transaction index, the posted-data records (some
 * possibly pruned), and the inbox head. Every URL it is asked for is recorded.
 */
export function goldenChainIndex(
  golden: GoldenFixture,
  options: ChainIndexOptions = {},
): { transport: Transport; urls: string[] } {
  const env = { chainId: golden.chainId, rollupId: golden.rollupId };
  const entries = toEntries(golden);
  const accs: string[] = [];
  let acc: Uint8Array = EMPTY_INBOX_ACC;
  entries.forEach((entry, position) => {
    acc = qledgerAccumulate({ ...env, from: position, accFrom: acc, entries: [entry] });
    accs.push(bytesToHex(acc));
  });

  const txs = entries.map((entry, position) => {
    const sequence = String(position + 1);
    const height = String(entry.height);
    const deposit = entry.poster.startsWith("deposit:")
      ? decodeQledgerDeposit(entry.payload)
      : undefined;
    if (deposit !== undefined) {
      return {
        height,
        txhash: `DEP${sequence}`,
        tx: { body: { messages: [] } },
        events: [
          {
            type: "rdk_rollup_deposit",
            attributes: [
              { key: "rollup_id", value: golden.rollupId },
              { key: "sequence", value: sequence },
              { key: "depositor", value: entry.poster.slice("deposit:".length) },
              { key: "account", value: bytesToHex(deposit.account) },
              { key: "amount", value: `${String(deposit.amount)}uqor` },
            ],
          },
        ],
      };
    }
    return {
      height,
      txhash: `POST${sequence}`,
      tx: {
        body: {
          messages: [
            {
              "@type": "/qorechain.rdk.v1.MsgPostRollupData",
              poster: entry.poster,
              data: bytesToBase64(entry.payload),
            },
          ],
        },
      },
      events: [
        {
          type: "rdk_data_posted",
          attributes: [
            { key: "rollup_id", value: golden.rollupId },
            { key: "sequence", value: sequence },
            { key: "data_hash", value: bytesToHex(postedDataHash(entry.payload)) },
            { key: "poster", value: entry.poster },
          ],
        },
      ],
    };
  });

  const filler = Array.from({ length: options.filler ?? 0 }, (_, i) => ({
    height: "1",
    txhash: `OTHER${String(i)}`,
    tx: { body: { messages: [] } },
    events: [
      {
        type: "rdk_data_posted",
        attributes: [
          { key: "rollup_id", value: "another-rollup" },
          { key: "sequence", value: String(i + 1) },
        ],
      },
    ],
  }));
  const indexed = [...filler, ...txs];

  const urls: string[] = [];
  const reply = (status: number, body: unknown) =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: "",
      json: () => Promise.resolve(body),
    });

  const transport: Transport = (url) => {
    urls.push(url);
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path.endsWith("/cosmos/tx/v1beta1/txs")) {
      const query = parsed.searchParams.get("query") ?? "";
      const page = Number(parsed.searchParams.get("page") ?? "1");
      const limit = Number(parsed.searchParams.get("limit") ?? "100");
      const event = query.split(".")[0];
      const floor = Number(/tx\.height>=(\d+)/.exec(query)?.[1] ?? "0");
      const matching = indexed.filter(
        (tx) => tx.events.some((e) => e.type === event) && Number(tx.height) >= floor,
      );
      const slice = matching.slice((page - 1) * limit, page * limit);
      return reply(200, { tx_responses: slice, total: String(matching.length) });
    }
    const posted = /\/qorechain\/rdk\/v1\/posted_data\/[^/]+\/(\d+)$/.exec(path);
    if (posted !== null) {
      const sequence = Number(posted[1]);
      const value = accs[sequence - 1];
      if (value === undefined || options.pruned?.(sequence) === true) {
        return reply(404, { code: 5, message: "not found" });
      }
      return reply(200, { posted_data: { sequence: String(sequence), inbox_acc: value } });
    }
    if (/\/qorechain\/rdk\/v1\/inbox\/[^/]+$/.test(path)) {
      return reply(200, {
        inbox: {
          rollup_id: golden.rollupId,
          head_sequence: String(golden.head.sequence),
          head_acc: golden.head.acc,
        },
      });
    }
    return reply(404, { code: 5, message: "not found" });
  };
  return { transport, urls };
}
