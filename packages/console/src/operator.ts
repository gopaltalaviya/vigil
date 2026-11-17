import type { SealKeyPair } from "@qorechain/qoreseal";
import { VigilError, toHex, type Store, type TxSender } from "@vigil/core";
import { MAX_MEMO_BYTES, readMemos, sealMemo, transferHash } from "@vigil/memo";
import { InputError, parseQor, type L2Account, type Wallet } from "@vigil/wallet";

/** Everything the operator needs to act. Injected, so the logic is testable without a chain. */
export interface OperatorDeps {
  chainId: string;
  rollupId: string;
  store: Store;
  wallet: Wallet;
  /** The base-chain account that pays for and signs transactions. */
  sender: () => Promise<TxSender>;
  /** The L2 account from the encrypted keystore, or `undefined` if none exists yet. */
  account: () => L2Account | undefined;
  /** Creates the encrypted keystore and returns the new L2 account. */
  createAccount: () => L2Account;
  baseBalance: (address: string) => Promise<bigint>;
  /** The ML-KEM-1024 key an address published on the base chain, as hex. */
  kemKey: (address: string) => Promise<string | undefined>;
  /** The operator's own memo keys. */
  memoKeys: () => SealKeyPair;
  /** Publishes the operator's ML-KEM-1024 key. */
  publishMemoKey: (sender: TxSender, publicKey: Uint8Array) => Promise<string>;
}

const text = (value: unknown, field: string, maxLength = 200): string => {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) {
    throw new InputError(`${field} is missing or too long`);
  }
  return value.trim();
};

/**
 * The actions behind the web console: the same operations as the `vigil`
 * command line, with the same checks. Every method either completes on the
 * base chain and returns its transaction hash, or throws with the reason.
 */
export class Operator {
  private readonly deps: OperatorDeps;

  constructor(deps: OperatorDeps) {
    this.deps = deps;
  }

  /** Balances, pending withdrawals, memos and recent activity. */
  async view() {
    const { store, wallet, rollupId, chainId } = this.deps;
    const sender = await this.deps.sender();
    const account = this.deps.account();
    const [baseBalance, memoKey] = await Promise.all([
      this.deps.baseBalance(sender.address),
      this.deps.kemKey(sender.address),
    ]);
    const base = {
      baseAddress: sender.address,
      baseBalance: baseBalance.toString(),
      memoKeyPublished: memoKey !== undefined,
      activity: store.recentTxs(20).map((tx) => ({
        label: tx.label,
        status: tx.status,
        hash: tx.hash ?? null,
        error: tx.error ?? null,
        createdAt: tx.createdAt,
      })),
    };
    if (account === undefined) {
      return { ...base, account: null, withdrawals: [], memos: [] };
    }
    const state = await wallet.state(account.accountId);
    const withdrawals = await wallet.withdrawals(sender.address);
    const memos = readMemos({
      chainId,
      rollupId,
      store,
      keys: this.deps.memoKeys(),
      inboxHead: state.inboxHead,
      payee: state.accountId,
    });
    return {
      ...base,
      account: {
        accountId: state.accountId,
        balance: state.pending.balance.toString(),
        nonce: state.pending.nonce.toString(),
        batchedBalance: state.batched.balance.toString(),
        inboxHead: state.inboxHead,
        inboxConsumed: state.inboxConsumed,
      },
      withdrawals: withdrawals.map((w) => ({
        batchIndex: w.batchIndex,
        batchStatus: w.batchStatus,
        amount: w.amount.toString(),
        claimed: w.claimed,
        claimable: !w.claimed && w.batchStatus === "finalized",
      })),
      memos: memos.reverse().map((memo) => ({
        entry: memo.sequence,
        poster: memo.poster,
        text: memo.text,
        transfer:
          memo.transfer === undefined
            ? null
            : {
                amount: memo.transfer.amount.toString(),
                from: memo.transfer.from,
                verified: memo.transfer.verified,
                paysThisAccount: memo.transfer.paysPayee === true,
              },
      })),
    };
  }

  createAccount(): { accountId: string } {
    if (this.deps.account() !== undefined) throw new InputError("an L2 account already exists");
    return { accountId: toHex(this.deps.createAccount().accountId) };
  }

  async deposit(body: unknown): Promise<{ hash: string }> {
    const amount = parseQor(text(field(body, "amount"), "amount"));
    const outcome = await this.deps.wallet.deposit(
      await this.deps.sender(),
      this.requireAccount().accountId,
      amount,
    );
    return { hash: outcome.hash };
  }

  /** L2 transfer, optionally with a memo sealed to the owner of a base-chain address. */
  async transfer(body: unknown): Promise<{ hash: string; memoHash: string | null }> {
    const to = text(field(body, "to"), "recipient account");
    const amount = parseQor(text(field(body, "amount"), "amount"));
    const memoText = optional(field(body, "memo"));
    const sender = await this.deps.sender();
    const account = this.requireAccount();

    // Everything about the memo is checked before the transfer is sent, so a
    // transfer is never left without the note that was meant to go with it.
    let recipientKey: Uint8Array | undefined;
    if (memoText !== undefined) {
      if (new TextEncoder().encode(memoText).length > MAX_MEMO_BYTES) {
        throw new InputError(`the memo is longer than ${String(MAX_MEMO_BYTES)} bytes`);
      }
      const memoRecipient = text(field(body, "memoRecipient"), "memo recipient address");
      const published = await this.deps.kemKey(memoRecipient);
      if (published === undefined) {
        throw new InputError("the memo recipient has not published an encryption key");
      }
      recipientKey = Buffer.from(published, "hex");
    }

    const transfer = await this.deps.wallet.transfer(sender, account, to, amount);
    if (memoText === undefined || recipientKey === undefined) {
      return { hash: transfer.hash, memoHash: null };
    }
    const memo = sealMemo({
      chainId: this.deps.chainId,
      rollupId: this.deps.rollupId,
      recipientKey,
      boundTo: transferHash(transfer.payload),
      text: memoText,
    });
    const note = await this.deps.wallet.postNote(sender, memo);
    return { hash: transfer.hash, memoHash: note.hash };
  }

  async withdraw(body: unknown): Promise<{ hash: string }> {
    const amount = parseQor(text(field(body, "amount"), "amount"));
    const sender = await this.deps.sender();
    const recipient = optional(field(body, "recipient")) ?? sender.address;
    const outcome = await this.deps.wallet.withdraw(
      sender,
      this.requireAccount(),
      recipient,
      amount,
    );
    return { hash: outcome.hash };
  }

  async claim(): Promise<{ paid: { amount: string; hash: string }[]; failed: string[] }> {
    const result = await this.deps.wallet.claim(await this.deps.sender());
    return {
      paid: result.paid.map((p) => ({
        amount: p.withdrawal.amount.toString(),
        hash: p.outcome.hash,
      })),
      failed: result.failed.map((f) => f.reason),
    };
  }

  async publishMemoKey(): Promise<{ hash: string }> {
    const sender = await this.deps.sender();
    if ((await this.deps.kemKey(sender.address)) !== undefined) {
      throw new InputError("this account already has an encryption key on chain");
    }
    const hash = await this.deps.publishMemoKey(sender, this.deps.memoKeys().mlkemPublicKey);
    return { hash };
  }

  private requireAccount(): L2Account {
    const account = this.deps.account();
    if (account === undefined) throw new InputError("create an L2 account first");
    return account;
  }
}

function field(body: unknown, name: string): unknown {
  return body !== null && typeof body === "object"
    ? (body as Record<string, unknown>)[name]
    : undefined;
}

function optional(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 4_000) {
    throw new InputError("a text field is malformed");
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Message safe to show an operator: our own errors verbatim, anything else generic. */
export function publicMessage(error: unknown): string {
  return error instanceof VigilError ? error.message : "the request failed; see the server log";
}
