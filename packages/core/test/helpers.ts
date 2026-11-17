import { readFileSync } from "node:fs";
import type { QledgerEntry } from "@qorechain/rdk";
import { fromHex, type InboxSource, type StoredBatch } from "../src/index.js";

export interface GoldenFixture {
  chainId: string;
  rollupId: string;
  head: { sequence: number; acc: string };
  batches: StoredBatch[];
  entries: { sequence: number; height: number; poster: string; payload: string }[];
}

/** Public data recorded from a live rollup: nine inbox entries and two finalized batches. */
export function loadGolden(): GoldenFixture {
  const url = new URL("./fixtures/golden-rollup.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as GoldenFixture;
}

export function toEntries(fixture: GoldenFixture): QledgerEntry[] {
  return fixture.entries.map((entry) => ({
    height: BigInt(entry.height),
    poster: entry.poster,
    payload: fromHex(entry.payload),
  }));
}

/** An inbox source that serves the fixture, optionally cut short or altered. */
export function fixtureSource(
  fixture: GoldenFixture,
  options: { headSequence?: number; headAcc?: string; mutate?: (e: QledgerEntry[]) => void } = {},
): InboxSource & { calls: [number, number][] } {
  const all = toEntries(fixture);
  options.mutate?.(all);
  const calls: [number, number][] = [];
  return {
    calls,
    head: () =>
      Promise.resolve({
        sequence: options.headSequence ?? fixture.head.sequence,
        acc: options.headAcc ?? fixture.head.acc,
      }),
    entries: (from, to) => {
      calls.push([from, to]);
      return Promise.resolve(all.slice(from, to));
    },
  };
}
