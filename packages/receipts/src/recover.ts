import type { Store } from "@vigil/core";

/** One `AnchorRecorded` event from the receipts contract. */
export interface AnchorLog {
  txHash: string;
  blockNumber: bigint;
  layerId: string;
  layerHeight: bigint;
  /** Lower-case hex without a prefix. */
  stateRoot: string;
}

/** What recovery reads from the EVM node. */
export interface AnchorLogSource {
  latestBlock(): Promise<bigint>;
  /** Logs in the inclusive block range. */
  anchorLogs(from: bigint, to: bigint): Promise<AnchorLog[]>;
  /** Block time, Unix seconds. */
  blockTime(block: bigint): Promise<number>;
}

export interface RecoverOptions {
  store: Store;
  rollupId: string;
  contract: string;
  source: AnchorLogSource;
  /** Widest block range the node serves in one query. */
  maxSpan?: bigint;
}

export interface RecoverReport {
  /** Receipts with no transaction hash before this run. */
  missing: number;
  recovered: number;
  /** Batch indexes still without a hash. */
  unresolved: number[];
}

const DEFAULT_SPAN = 10_000n;

/**
 * Restores the transaction hash of receipts known only as "already recorded",
 * for example after the local database was lost. The hashes come from the
 * contract's own events, matched on layer, batch and state root.
 */
export async function recoverReceiptHashes(options: RecoverOptions): Promise<RecoverReport> {
  const { store, rollupId, contract, source } = options;
  const span = options.maxSpan ?? DEFAULT_SPAN;
  const missing = store
    .receipts(rollupId)
    .filter((receipt) => receipt.contract === contract && receipt.txHash === "");
  if (missing.length === 0) return { missing: 0, recovered: 0, unresolved: [] };

  // A receipt can only be recorded after its batch was submitted.
  const submitted = new Map<number, number>();
  for (const batch of store.batches(rollupId)) {
    const earliest = submitted.get(batch.batchIndex);
    if (earliest === undefined || batch.submittedAt < earliest) {
      submitted.set(batch.batchIndex, batch.submittedAt);
    }
  }
  const start = missing.reduce(
    (lowest, receipt) => {
      const height = BigInt(submitted.get(receipt.batchIndex) ?? 0);
      return height < lowest ? height : lowest;
    },
    BigInt(submitted.get(missing[0]?.batchIndex ?? 0) ?? 0),
  );

  const wanted = new Map(missing.map((r) => [`${String(r.batchIndex)}:${r.stateRoot}`, r]));
  const latest = await source.latestBlock();
  let recovered = 0;
  for (let from = start; from <= latest && wanted.size > 0; from += span) {
    const to = from + span - 1n < latest ? from + span - 1n : latest;
    for (const log of await source.anchorLogs(from, to)) {
      if (log.layerId !== rollupId) continue;
      const key = `${log.layerHeight.toString()}:${log.stateRoot}`;
      const receipt = wanted.get(key);
      if (receipt === undefined) continue;
      store.saveReceipt(rollupId, {
        ...receipt,
        txHash: log.txHash,
        recordedAt: await source.blockTime(log.blockNumber),
      });
      wanted.delete(key);
      recovered += 1;
    }
  }
  return {
    missing: missing.length,
    recovered,
    unresolved: [...wanted.values()].map((receipt) => receipt.batchIndex).sort((a, b) => a - b),
  };
}
