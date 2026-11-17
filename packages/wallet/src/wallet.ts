import {
  QLEDGER_MAX_POST_BYTES,
  encodeQledgerTx,
  isCanonicalQorAddress,
  qledgerWithdrawalProof,
  signQledgerTx,
} from "@qorechain/rdk";
import {
  fromHex,
  ledgerAtSequence,
  toBatchClaim,
  toHex,
  verifyBatch,
  type InboxArchive,
  type Store,
  type StoredBatch,
  type TxOutcome,
  type TxSender,
} from "@vigil/core";
import { InputError } from "./amount.js";
import type { L2Account } from "./keystore.js";

/** Smallest deposit the base chain accepts, in uqor (1 QOR). */
export const MIN_DEPOSIT_UQOR = 1_000_000n;

/** What the wallet reads about the rollup from the base chain. */
export interface WalletView {
  batches(): Promise<StoredBatch[]>;
  inbox(): Promise<{ head: number; consumed: number }>;
}

export interface WalletOptions {
  chainId: string;
  rollupId: string;
  store: Store;
  archive: InboxArchive;
  view: WalletView;
}

export interface AccountState {
  accountId: string;
  /** State after every entry in the inbox, including ones no batch has covered yet. */
  pending: { balance: bigint; nonce: bigint };
  /** State after the last entry a batch has covered. */
  batched: { balance: bigint; nonce: bigint };
  inboxHead: number;
  inboxConsumed: number;
}

/** A posted L2 transaction: the base-chain outcome plus the exact bytes that were posted. */
export type PostedTx = TxOutcome & { payload: Uint8Array };

/** A withdrawal found in a batch, with what is needed to pay it out. */
export interface Withdrawal {
  batchIndex: number;
  batchStatus: string;
  index: bigint;
  recipient: string;
  amount: bigint;
  proof: Uint8Array[];
  claimed: boolean;
}

/**
 * L2 wallet operations. Balances and nonces come from the wallet's own replay
 * of the verified inbox, never from a third party.
 */
export class Wallet {
  private readonly options: WalletOptions;

  constructor(options: WalletOptions) {
    this.options = options;
  }

  /** Balance and nonce of an L2 account. */
  async state(accountId: Uint8Array): Promise<AccountState> {
    const { archive, view } = this.options;
    const [sync, inbox] = await Promise.all([archive.sync(), view.inbox()]);
    const consumed = Math.min(inbox.consumed, sync.head);
    return {
      accountId: toHex(accountId),
      pending: ledgerAtSequence(this.options, sync.head).get(accountId),
      batched: ledgerAtSequence(this.options, consumed).get(accountId),
      inboxHead: sync.head,
      inboxConsumed: consumed,
    };
  }

  /** Moves uqor from the base chain into an L2 account. */
  async deposit(sender: TxSender, accountId: Uint8Array, amount: bigint): Promise<TxOutcome> {
    if (amount < MIN_DEPOSIT_UQOR) throw new InputError("the smallest deposit is 1 QOR");
    const { rollupId } = this.options;
    return sender.send("deposit", (tx) =>
      tx.depositToRollup({ rollupId, account: accountId, amount }),
    );
  }

  /** Sends uqor to another L2 account. */
  async transfer(
    sender: TxSender,
    account: L2Account,
    to: string,
    amount: bigint,
  ): Promise<PostedTx> {
    const recipient = parseAccountId(to);
    if (toHex(recipient) === toHex(account.accountId)) {
      throw new InputError("the recipient is the sending account");
    }
    return this.post(sender, account, amount, "transfer", { to: recipient });
  }

  /** Starts a withdrawal of uqor from the L2 account to a base-chain address. */
  async withdraw(
    sender: TxSender,
    account: L2Account,
    recipient: string,
    amount: bigint,
  ): Promise<PostedTx> {
    if (!isCanonicalQorAddress(recipient)) {
      throw new InputError("the recipient is not a valid qor1 address");
    }
    return this.post(sender, account, amount, "withdraw", { recipient });
  }

  /** Withdrawals to `recipient` in every batch judged valid, with payout proofs. */
  async withdrawals(recipient: string): Promise<Withdrawal[]> {
    const { archive, view, store, chainId, rollupId } = this.options;
    const [sync, batches] = await Promise.all([archive.sync(), view.batches()]);
    const found: Withdrawal[] = [];
    for (const batch of batches.sort((a, b) => a.batchIndex - b.batchIndex)) {
      if (batch.status === "rejected" || batch.inboxEnd > sync.head) continue;
      const verdict = verifyBatch(toBatchClaim(batch), {
        chainId,
        rollupId,
        parent: ledgerAtSequence(this.options, batch.inboxStart),
        entries: archive.range(batch.inboxStart, batch.inboxEnd),
        accFrom: archive.accAt(batch.inboxStart),
        accTo: archive.accAt(batch.inboxEnd),
      });
      if (verdict.verdict !== "valid") continue;
      verdict.withdrawals.forEach((withdrawal, position) => {
        if (withdrawal.recipient !== recipient) return;
        found.push({
          batchIndex: batch.batchIndex,
          batchStatus: batch.status,
          index: withdrawal.index,
          recipient: withdrawal.recipient,
          amount: withdrawal.amount,
          proof: qledgerWithdrawalProof(chainId, rollupId, verdict.withdrawals, position),
          claimed: store.claim(rollupId, Number(withdrawal.index)) !== undefined,
        });
      });
    }
    return found;
  }

  /** Pays out every finalized, unclaimed withdrawal addressed to the sender. */
  async claim(sender: TxSender): Promise<{ withdrawal: Withdrawal; outcome: TxOutcome }[]> {
    const { rollupId, store } = this.options;
    const paid: { withdrawal: Withdrawal; outcome: TxOutcome }[] = [];
    for (const withdrawal of await this.withdrawals(sender.address)) {
      if (withdrawal.claimed || withdrawal.batchStatus !== "finalized") continue;
      const outcome = await sender.send("claim", (tx) =>
        tx.executeWithdrawal({
          rollupId,
          batchIndex: withdrawal.batchIndex,
          withdrawalIndex: withdrawal.index,
          recipient: withdrawal.recipient,
          denom: "uqor",
          amount: withdrawal.amount,
          proof: withdrawal.proof,
        }),
      );
      store.saveClaim(rollupId, {
        withdrawalIndex: Number(withdrawal.index),
        batchIndex: withdrawal.batchIndex,
        txHash: outcome.hash,
      });
      paid.push({ withdrawal, outcome });
    }
    return paid;
  }

  private async post(
    sender: TxSender,
    account: L2Account,
    amount: bigint,
    label: string,
    target: { to: Uint8Array } | { recipient: string },
  ): Promise<PostedTx> {
    const { chainId, rollupId } = this.options;
    const state = await this.state(account.accountId);
    if (amount > state.pending.balance) {
      throw new InputError("the L2 account does not hold that much");
    }
    const signed = signQledgerTx({
      chainId,
      rollupId,
      secretKey: account.secretKey,
      publicKey: account.publicKey,
      nonce: state.pending.nonce,
      amount,
      ...target,
    });
    const data = encodeQledgerTx(signed);
    if (data.length > QLEDGER_MAX_POST_BYTES) {
      throw new InputError("the signed transaction is larger than the inbox accepts");
    }
    const outcome = await sender.send(label, (tx) => tx.postRollupData({ rollupId, data }));
    return { ...outcome, payload: data };
  }

  /** Posts an opaque payload (for example a sealed memo) to the rollup inbox. */
  async postNote(sender: TxSender, data: Uint8Array): Promise<TxOutcome> {
    if (data.length === 0 || data.length > QLEDGER_MAX_POST_BYTES) {
      throw new InputError("the payload does not fit the inbox");
    }
    const { rollupId } = this.options;
    return sender.send("note", (tx) => tx.postRollupData({ rollupId, data }));
  }
}

/** Parses a 32-byte L2 account id given as hex. */
export function parseAccountId(text: string): Uint8Array {
  const bytes = /^(0x)?[0-9a-fA-F]{64}$/.test(text.trim()) ? fromHex(text.trim()) : undefined;
  if (bytes === undefined) {
    throw new InputError("an L2 account id is 64 hex characters");
  }
  return bytes;
}
