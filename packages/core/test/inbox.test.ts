import {
  EMPTY_INBOX_ACC,
  QLEDGER_CHECKPOINT_INTERVAL,
  RestClient,
  fetchQledgerEntries,
} from "@qorechain/rdk";
import { describe, expect, it } from "vitest";
import {
  INBOX_SEARCH_MAX_PAGES,
  InboxArchive,
  IntegrityError,
  Store,
  chainInboxSource,
  createChain,
  loadConfig,
  readInboxEntries,
  toHex,
} from "../src/index.js";
import { goldenChainIndex } from "./chain-index.js";
import { loadGolden, toEntries } from "./helpers.js";

const golden = loadGolden();
const env = { chainId: golden.chainId, rollupId: golden.rollupId };
const config = loadConfig({ ROLLUP_ID: golden.rollupId, HTTP_MAX_RETRIES: "0" });
const everythingPruned = () => true;

function chainWith(options: Parameters<typeof goldenChainIndex>[1] = {}) {
  const index = goldenChainIndex(golden, options);
  return { chain: createChain(config, index.transport), urls: index.urls };
}

const searches = (urls: string[]) =>
  urls
    .filter((url) => url.includes("/cosmos/tx/v1beta1/txs"))
    .map((url) => new URL(url).searchParams);

describe("own inbox reader", () => {
  it("reads every entry up to the head after the chain pruned all posted data", async () => {
    const { chain } = chainWith({ pruned: everythingPruned });
    const read = await readInboxEntries(chain.rdk.rest, {
      ...env,
      from: 0,
      to: golden.head.sequence,
      accFrom: EMPTY_INBOX_ACC,
    });
    expect(read.map((e) => [String(e.height), e.poster, toHex(e.payload)])).toEqual(
      toEntries(golden).map((e) => [String(e.height), e.poster, toHex(e.payload)]),
    );
  });

  it("refuses a range ending below the head when that accumulator is pruned", async () => {
    const { chain } = chainWith({ pruned: everythingPruned });
    const read = readInboxEntries(chain.rdk.rest, {
      ...env,
      from: 0,
      to: 4,
      accFrom: EMPTY_INBOX_ACC,
    });
    await expect(read).rejects.toThrow(/no longer holds the accumulator/);
  });

  it("checks a range below the head against a retained posted-data record", async () => {
    const { chain } = chainWith({ pruned: (sequence) => sequence !== 4 });
    const read = await readInboxEntries(chain.rdk.rest, {
      ...env,
      from: 0,
      to: 4,
      accFrom: EMPTY_INBOX_ACC,
    });
    expect(read).toHaveLength(4);
  });

  it("follows every result page, where the kit alone stops after 50", async () => {
    // 5,050 posts of another rollup come first, so this rollup's posts start on page 51.
    const index = goldenChainIndex(golden, { filler: 5_050 });
    const fast = loadConfig({
      ROLLUP_ID: golden.rollupId,
      HTTP_MAX_RETRIES: "0",
      HTTP_REQUESTS_PER_MINUTE: "1000",
    });
    const chain = createChain(fast, index.transport);
    const read = await readInboxEntries(chain.rdk.rest, {
      ...env,
      from: 0,
      to: golden.head.sequence,
      accFrom: EMPTY_INBOX_ACC,
    });
    expect(read).toHaveLength(golden.head.sequence);
    expect(INBOX_SEARCH_MAX_PAGES).toBeGreaterThan(50);

    const plain = new RestClient(config.restUrl, { fetch: index.transport });
    const kit = fetchQledgerEntries(plain, {
      ...env,
      from: 0,
      to: golden.head.sequence,
      accFrom: EMPTY_INBOX_ACC,
    });
    await expect(kit).rejects.toThrow(/not found in the node's transaction index/);
  });

  it("starts the search at the height floor it is given", async () => {
    const { chain, urls } = chainWith();
    const archive = new InboxArchive({
      ...env,
      store: Store.open(":memory:"),
      source: chainInboxSource(chain, env.chainId, env.rollupId),
      chunkSize: 5,
    });
    await archive.sync();
    const queries = searches(urls).map((p) => p.get("query") ?? "");
    expect(queries.slice(0, 2).every((q) => !q.includes("tx.height"))).toBe(true);
    const fifth = golden.entries[4];
    expect(queries.slice(2).every((q) => q.endsWith(`tx.height>=${String(fifth?.height)}`))).toBe(
      true,
    );
  });

  it("refuses an entry whose payload was changed", async () => {
    const tampered = structuredClone(golden);
    const third = tampered.entries[2];
    if (third === undefined) throw new Error("fixture needs three entries");
    third.payload = "00" + third.payload.slice(2);
    const index = goldenChainIndex(tampered, { pruned: everythingPruned });
    const chain = createChain(config, index.transport);
    const read = readInboxEntries(chain.rdk.rest, {
      ...env,
      from: 0,
      to: golden.head.sequence,
      accFrom: EMPTY_INBOX_ACC,
    });
    await expect(read).rejects.toBeInstanceOf(IntegrityError);
  });
});

describe("inbox archive over a pruned chain", () => {
  it("syncs from an empty store to the head in one read, past a pruned checkpoint", async () => {
    // Checkpoints keep their record only until a finalized batch covers them; here none is left.
    expect(QLEDGER_CHECKPOINT_INTERVAL).toBe(64);
    const { chain, urls } = chainWith({ pruned: everythingPruned });
    const store = Store.open(":memory:");
    const archive = new InboxArchive({
      ...env,
      store,
      source: chainInboxSource(chain, env.chainId, env.rollupId),
    });
    expect(await archive.sync()).toEqual({ head: golden.head.sequence, added: 9 });
    expect(toHex(archive.accAt(golden.head.sequence))).toBe(golden.head.acc);
    // One search per event type: posts and deposits.
    expect(searches(urls)).toHaveLength(2);
  });

  it("a chunked sync over the same chain fails, which is why the default reads to the head", async () => {
    const { chain } = chainWith({ pruned: everythingPruned });
    const archive = new InboxArchive({
      ...env,
      store: Store.open(":memory:"),
      source: chainInboxSource(chain, env.chainId, env.rollupId),
      chunkSize: 4,
    });
    await expect(archive.sync()).rejects.toThrow(/no longer holds the accumulator/);
  });
});
