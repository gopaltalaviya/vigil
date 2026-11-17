import {
  EMPTY_INBOX_ACC,
  QledgerLedger,
  checkQledgerFraud,
  encodeQledgerDeposit,
  executeQledger,
  inboxRangeHash,
  qledgerAccumulate,
  type QledgerBatchPlan,
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
  /** Batch indices that were challenged, in order. */
  readonly challenges: number[] = [];
  /** `rejected` if an upheld challenge settles at once, `challenged` if it needs resolving. */
  statusAfterUpheldChallenge: "rejected" | "challenged" = "rejected";
  /** The `anchor` option of every submitted batch, in order. */
  readonly anchorModes: string[] = [];
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

  /** Records a batch exactly as claimed by a submitter, honest or not. */
  acceptBatch(input: {
    batchIndex: bigint;
    stateRoot: Uint8Array;
    inboxEnd: bigint;
    prevStateRoot?: Uint8Array;
    dataHash?: Uint8Array;
    withdrawalsRoot?: Uint8Array;
  }): StoredBatch {
    const inboxStart = this.consumed;
    this.height += 1;
    this.time += 5;
    const batch: StoredBatch = {
      batchIndex: Number(input.batchIndex),
      stateRoot: toHex(input.stateRoot),
      prevStateRoot: toHex(input.prevStateRoot ?? new Uint8Array()),
      dataHash: toHex(input.dataHash ?? new Uint8Array()),
      withdrawalsRoot: toHex(input.withdrawalsRoot ?? new Uint8Array()),
      inboxStart,
      inboxEnd: Number(input.inboxEnd),
      txCount: Number(input.inboxEnd) - inboxStart,
      status: "submitted",
      submittedAt: this.height,
      submittedTime: this.time,
      finalizedAt: 0,
    };
    this.batches.push(batch);
    return batch;
  }

  /** What an honest submitter would plan on top of `ledger` for every unbatched entry. */
  plan(ledger: QledgerLedger, inboxEnd = this.head): QledgerBatchPlan {
    const inboxStart = this.consumed;
    if (inboxEnd <= inboxStart) throw new Error("nothing to batch");
    const entries = this.entries.slice(inboxStart, inboxEnd);
    const prevStateRoot = ledger.root();
    const result = executeQledger(
      { chainId: FAKE_CHAIN_ID, rollupId: FAKE_ROLLUP_ID },
      ledger,
      entries,
    );
    return {
      input: {
        rollupId: FAKE_ROLLUP_ID,
        batchIndex: BigInt(this.batches.filter((b) => b.status !== "rejected").length),
        prevStateRoot,
        stateRoot: result.stateRoot,
        txCount: BigInt(entries.length),
        dataHash: inboxRangeHash({
          chainId: FAKE_CHAIN_ID,
          rollupId: FAKE_ROLLUP_ID,
          from: inboxStart,
          to: inboxEnd,
          accFrom: this.accs[inboxStart] ?? EMPTY_INBOX_ACC,
          accTo: this.accs[inboxEnd] ?? EMPTY_INBOX_ACC,
        }),
        withdrawalsRoot: result.withdrawalsRoot,
        inboxEnd: BigInt(inboxEnd),
      },
      entries,
      result,
      ledger,
    };
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
      simulate: () => Promise.resolve(200_000),
      challengeBatch: (input: { batchIndex: number; proof: Uint8Array }) =>
        guarded(() => {
          this.challenges.push(input.batchIndex);
          const batch = this.batches.find(
            (b) => b.batchIndex === input.batchIndex && b.status === "submitted",
          );
          if (batch === undefined) return;
          const fraud = checkQledgerFraud(
            { chainId: FAKE_CHAIN_ID, rollupId: FAKE_ROLLUP_ID },
            {
              inboxStart: batch.inboxStart,
              inboxEnd: batch.inboxEnd,
              dataHash: batch.dataHash,
              prevStateRoot: batch.prevStateRoot,
              stateRoot: batch.stateRoot,
              withdrawalsRoot: batch.withdrawalsRoot,
            },
            input.proof,
          );
          batch.status = fraud ? this.statusAfterUpheldChallenge : "submitted";
        }),
      resolveChallenge: (input: { batchIndex: number }) =>
        guarded(() => {
          const batch = this.batches.find(
            (b) => b.batchIndex === input.batchIndex && b.status === "challenged",
          );
          if (batch !== undefined) batch.status = "rejected";
        }),
      submitBatch: (
        input: { batchIndex: bigint; stateRoot: Uint8Array; inboxEnd: bigint },
        options?: { anchor?: string },
      ) =>
        guarded(() => {
          this.anchorModes.push(options?.anchor ?? "auto");
          this.acceptBatch(input);
        }),
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
