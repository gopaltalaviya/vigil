import type { InspectedTransaction } from "@qorechain/qoresign/network";
import {
  claimId,
  type Logger,
  type PqCheckStatus,
  type Store,
  type StoredPqCheck,
} from "@vigil/core";

/** Reads one transaction's post-quantum layer. `undefined` means the node no longer has it. */
export type InspectTx = (txHash: string) => Promise<InspectedTransaction | undefined>;

/** Finds the transaction that submitted a batch at a given height. */
export type FindSubmission = (batchIndex: number, height: number) => Promise<string | undefined>;

export interface PqLayerCheckerOptions {
  rollupId: string;
  store: Store;
  inspect: InspectTx;
  findSubmission: FindSubmission;
  log: Logger;
  /** Most claims checked per run, so a backlog never holds the network for long. */
  maxPerRun?: number;
  now?: () => number;
}

/** What a transaction's post-quantum layer says, in the terms Vigil reports. */
export function classifyPqLayer(inspected: InspectedTransaction | undefined): PqCheckStatus {
  if (inspected === undefined) return "not_found";
  if (!inspected.pqLayer.present) return "classical";
  return inspected.pqLayer.verified === true ? "verified" : "invalid";
}

/**
 * Records whether each batch transaction carried a valid ML-DSA signature. The
 * result is stored when first checked, because the signer's registered key can
 * rotate later and the node can prune the transaction.
 */
export class PqLayerChecker {
  private readonly options: PqLayerCheckerOptions;
  private readonly now: () => number;

  constructor(options: PqLayerCheckerOptions) {
    this.options = options;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  }

  /** Checks claims that have no result yet. A read failure leaves the claim for the next run. */
  async checkPending(): Promise<StoredPqCheck[]> {
    const { store, rollupId, inspect, findSubmission, log } = this.options;
    const done = new Set(store.pqChecks(rollupId).map((check) => check.claimId));
    const pending = store.batches(rollupId).filter((batch) => !done.has(claimId(batch)));
    const results: StoredPqCheck[] = [];
    for (const batch of pending.slice(0, this.options.maxPerRun ?? 10)) {
      try {
        const txHash = await findSubmission(batch.batchIndex, batch.submittedAt);
        const inspected = txHash === undefined ? undefined : await inspect(txHash);
        const check: StoredPqCheck = {
          claimId: claimId(batch),
          batchIndex: batch.batchIndex,
          txHash: txHash ?? "",
          status: classifyPqLayer(inspected),
          algorithmId: inspected?.pqLayer.algorithmId ?? 0,
          signBytesVersion: inspected?.pqLayer.signBytesVersion ?? "",
          signer: inspected?.signer?.address ?? "",
          checkedAt: this.now(),
        };
        store.savePqCheck(rollupId, check);
        results.push(check);
      } catch (error) {
        log.warn({ batch: batch.batchIndex, err: error }, "could not read the PQ layer");
      }
    }
    return results;
  }
}
