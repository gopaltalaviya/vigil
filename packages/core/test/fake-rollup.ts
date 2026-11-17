import {
  EMPTY_INBOX_ACC,
  QledgerLedger,
  encodeQledgerDeposit,
  executeQledger,
  inboxRangeHash,
  qledgerAccumulate,
  type QledgerEntry,
  type RdkTxClient,
} from "@qorechain/rdk";
import {
  createTxSender,
  toHex,
  type InboxSource,
  type RawTxResult,
  type Store,
  type StoredBatch,
  type TxSender,
} from "../src/index.js";

export const FAKE_CHAIN_ID = "qorechain-test";
export const FAKE_ROLLUP_ID = "fake-rollup";

/**
 * In-memory stand-in for a `qledger-v1` rollup on the base chain: an inbox
 * with the real hash accumulator, batches, and the transactions that change
 * them. It uses the same execution code as the chain, so wallet, batcher and
 * watchtower logic can be tested end to end without a network.
 */
export class FakeRollup {
  readonly entries: QledgerEntry[] = [];
  readonly accs: Uint8Array[] = [EMPTY_INBOX_ACC];
  readonly batches: StoredBatch[] = [];
  readonly payouts: { withdrawalIndex: bigint; recipient: string; amount: bigint }[] = [];
  height = 1_000;
  time = 1_700_000_000;
  /** Set to make the next transaction fail with this result code. */
  failNextWith: number | undefined;

  get head(): number {
    return this.entries.length;
  }

  get consumed(): number {
    return this.batches.filter((b) => b.status !== "rejected").at(-1)?.inboxEnd ?? 0;
  }

  post(poster: string, payload: Uint8Array): number {
    this.height += 1;
    const entry = { height: BigInt(this.height), poster, payload };
    const acc = qledgerAccumulate({
      chainId: FAKE_CHAIN_ID,
      rollupId: FAKE_ROLLUP_ID,
      from: this.head,
      accFrom: this.accs[this.head] ?? EMPTY_INBOX_ACC,
      entries: [entry],
    });
    this.entries.push(entry);
    this.accs.push(acc);
    return this.head;
  }

  deposit(depositor: string, account: Uint8Array, amount: bigint): number {
    return this.post(`deposit:${depositor}`, encodeQledgerDeposit(account, amount));
  }

  /** Ledger after the first `sequence` entries. */
  ledgerAt(sequence: number): QledgerLedger {
    const ledger = new QledgerLedger();
    executeQledger(
      { chainId: FAKE_CHAIN_ID, rollupId: FAKE_ROLLUP_ID },
      ledger,
      this.entries.slice(0, sequence),
    );
    return ledger;
  }

  /** Adds an honest batch covering every unconsumed entry (or up to `inboxEnd`). */
  submitHonestBatch(options: { inboxEnd?: number; status?: string } = {}): StoredBatch {
    const inboxStart = this.consumed;
    const inboxEnd = options.inboxEnd ?? this.head;
    const parent = this.ledgerAt(inboxStart);
    const prevStateRoot = toHex(parent.root());
    const result = executeQledger(
      { chainId: FAKE_CHAIN_ID, rollupId: FAKE_ROLLUP_ID },
      parent,
      this.entries.slice(inboxStart, inboxEnd),
    );
    this.height += 1;
    this.time += 5;
    const batch: StoredBatch = {
      batchIndex: this.batches.filter((b) => b.status !== "rejected").length,
      stateRoot: toHex(result.stateRoot),
      prevStateRoot,
      dataHash: toHex(
        inboxRangeHash({
          chainId: FAKE_CHAIN_ID,
          rollupId: FAKE_ROLLUP_ID,
          from: inboxStart,
          to: inboxEnd,
          accFrom: this.accs[inboxStart] ?? EMPTY_INBOX_ACC,
          accTo: this.accs[inboxEnd] ?? EMPTY_INBOX_ACC,
        }),
      ),
      withdrawalsRoot: toHex(result.withdrawalsRoot),
      inboxStart,
      inboxEnd,
      txCount: inboxEnd - inboxStart,
      status: options.status ?? "submitted",
      submittedAt: this.height,
      submittedTime: this.time,
      finalizedAt: 0,
    };
    this.batches.push(batch);
    return batch;
  }

  finalizeAll(): void {
    for (const batch of this.batches) {
      if (batch.status === "submitted") {
        batch.status = "finalized";
        batch.finalizedAt = this.height;
      }
    }
  }

  source(): InboxSource {
    return {
      head: () =>
        Promise.resolve({
          sequence: this.head,
          acc: toHex(this.accs[this.head] ?? EMPTY_INBOX_ACC),
        }),
      entries: (from, to) => Promise.resolve(this.entries.slice(from, to)),
    };
  }

  view() {
    return {
      batches: () => Promise.resolve(this.batches.map((b) => ({ ...b }))),
      inbox: () => Promise.resolve({ head: this.head, consumed: this.consumed }),
      tip: () => Promise.resolve({ height: this.height, timeSecs: this.time }),
      challengeWindowSecs: () => Promise.resolve(3_600),
    };
  }

  /** A transaction sender for `address` whose transactions act on this fake. */
  sender(address: string, store?: Store): TxSender {
    let counter = 0;
    const result = (): RawTxResult => {
      counter += 1;
      this.height += 1;
      const code = this.failNextWith ?? 0;
      this.failNextWith = undefined;
      return {
        code,
        height: this.height,
        transactionHash: `${address}-TX${String(counter)}`.toUpperCase(),
        gasUsed: 100_000n,
        ...(code === 0
          ? {}
          : { rawLog: `failed to execute message; codespace rdk code ${String(code)}` }),
      };
    };
    const guarded = (apply: () => void): Promise<RawTxResult> => {
      const outcome = result();
      if (outcome.code === 0) apply();
      return Promise.resolve(outcome);
    };
    const client = {
      address,
      depositToRollup: (input: { account: Uint8Array | string; amount: bigint }) =>
        guarded(() => this.deposit(address, input.account as Uint8Array, input.amount)),
      postRollupData: (input: { data: Uint8Array | string }) =>
        guarded(() => this.post(address, input.data as Uint8Array)),
      executeWithdrawal: (input: { withdrawalIndex: bigint; recipient: string; amount: bigint }) =>
        guarded(() =>
          this.payouts.push({
            withdrawalIndex: input.withdrawalIndex,
            recipient: input.recipient,
            amount: input.amount,
          }),
        ),
    } as unknown as RdkTxClient;
    return createTxSender({
      address,
      client,
      ...(store === undefined ? {} : { store }),
      now: () => 1,
    });
  }
}
