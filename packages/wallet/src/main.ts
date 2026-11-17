#!/usr/bin/env node
/**
 * `vigil`: command line for the rollup.
 *
 *   vigil keygen                      create an encrypted L2 account
 *   vigil address                     show the L2 account id and base-chain address
 *   vigil balance [account-id]        L2 balance and nonce
 *   vigil deposit <qor>               base chain -> L2 account
 *   vigil transfer <account-id> <qor> L2 -> L2
 *   vigil withdraw <qor> [qor1...]    L2 -> base chain (paid out by `claim` after finality)
 *   vigil claim                       pay out finalized withdrawals
 *   vigil status                      rollup, inbox and batch overview
 */
import { join } from "node:path";
import {
  InboxArchive,
  Store,
  VigilError,
  chainInboxSource,
  connectTxSender,
  createChain,
  createLogger,
  loadConfig,
  toStoredBatch,
  type TxSender,
  type VigilConfig,
} from "@vigil/core";
import { InputError, formatQor, parseQor } from "./amount.js";
import { createKeystore, keystoreAccountId, openKeystore, type L2Account } from "./keystore.js";
import { Wallet, parseAccountId } from "./wallet.js";

const print = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function main(argv: string[]): Promise<void> {
  const [command = "help", ...args] = argv;
  const config = loadConfig();
  const log = createLogger({ service: "vigil", level: "warn" });
  const store = Store.open(join(config.dataDir, "vigil.sqlite"));
  const chain = createChain(config);
  const keystorePath = join(config.dataDir, "keystore.json");
  const wallet = new Wallet({
    chainId: config.chainId,
    rollupId: config.rollupId,
    store,
    archive: new InboxArchive({
      chainId: config.chainId,
      rollupId: config.rollupId,
      store,
      source: chainInboxSource(chain, config.chainId, config.rollupId),
    }),
    view: {
      batches: async () => (await chain.rdk.rest.listBatches(config.rollupId)).map(toStoredBatch),
      async inbox() {
        const inbox = await chain.rdk.rest.getInbox(config.rollupId);
        return { head: inbox.headSequence, consumed: inbox.consumedSequence };
      },
    },
  });
  const sender = (): Promise<TxSender> => connectTxSender(config, chain.rdk, { store, log });
  const account = (): L2Account => openKeystore(keystorePath, passphrase(config));
  const arg = (position: number, name: string): string => {
    const value = args[position];
    if (value === undefined) throw new InputError(`missing argument: ${name}`);
    return value;
  };

  try {
    switch (command) {
      case "keygen": {
        const created = createKeystore(keystorePath, passphrase(config));
        print(`L2 account created: ${Buffer.from(created.accountId).toString("hex")}`);
        print(`Encrypted keystore: ${keystorePath}`);
        break;
      }
      case "address": {
        print(`L2 account:  ${keystoreAccountId(keystorePath)}`);
        if (config.secrets.mnemonic !== undefined)
          print(`Base chain:  ${(await sender()).address}`);
        break;
      }
      case "balance": {
        const id = parseAccountId(args[0] ?? keystoreAccountId(keystorePath));
        const state = await wallet.state(id);
        print(`Account:        ${state.accountId}`);
        print(
          `Balance:        ${formatQor(state.pending.balance)} QOR (nonce ${state.pending.nonce.toString()})`,
        );
        print(`In a batch:     ${formatQor(state.batched.balance)} QOR`);
        print(
          `Inbox:          ${String(state.inboxConsumed)} of ${String(state.inboxHead)} entries batched`,
        );
        break;
      }
      case "deposit": {
        const amount = parseQor(arg(0, "amount in QOR"));
        const id = parseAccountId(keystoreAccountId(keystorePath));
        const outcome = await wallet.deposit(await sender(), id, amount);
        print(`Deposited ${formatQor(amount)} QOR. Transaction ${outcome.hash}`);
        break;
      }
      case "transfer": {
        const to = arg(0, "recipient account id");
        const amount = parseQor(arg(1, "amount in QOR"));
        const outcome = await wallet.transfer(await sender(), account(), to, amount);
        print(`Posted a transfer of ${formatQor(amount)} QOR. Transaction ${outcome.hash}`);
        break;
      }
      case "withdraw": {
        const amount = parseQor(arg(0, "amount in QOR"));
        const from = await sender();
        const outcome = await wallet.withdraw(from, account(), args[1] ?? from.address, amount);
        print(`Posted a withdrawal of ${formatQor(amount)} QOR. Transaction ${outcome.hash}`);
        print("It can be claimed once the batch that includes it is finalized.");
        break;
      }
      case "claim": {
        const paid = await wallet.claim(await sender());
        if (paid.length === 0) print("Nothing to claim yet.");
        for (const { withdrawal, outcome } of paid) {
          print(
            `Claimed ${formatQor(withdrawal.amount)} QOR from batch ${String(withdrawal.batchIndex)}. Transaction ${outcome.hash}`,
          );
        }
        break;
      }
      case "status": {
        const rollup = await chain.rdk.rest.getRollup(config.rollupId);
        const inbox = await chain.rdk.rest.getInbox(config.rollupId);
        const batches = await chain.rdk.rest.listBatches(config.rollupId);
        print(`Rollup:   ${rollup.rollupId} (${rollup.status}, ${rollup.executionVm})`);
        print(
          `Inbox:    ${String(inbox.consumedSequence)} of ${String(inbox.headSequence)} entries batched`,
        );
        for (const batch of batches) {
          print(
            `Batch ${String(batch.batchIndex)}: ${batch.status}, entries ${String(batch.inboxStart + 1)}-${String(batch.inboxEnd)}, root ${batch.stateRoot.slice(0, 16)}...`,
          );
        }
        break;
      }
      default:
        throw new InputError(
          "usage: vigil <keygen|address|balance|deposit|transfer|withdraw|claim|status>",
        );
    }
  } finally {
    store.close();
  }
}

function passphrase(config: VigilConfig): string {
  if (config.secrets.keystorePassphrase === undefined) {
    throw new InputError("set VIGIL_KEYSTORE_PASSPHRASE to use the L2 keystore");
  }
  return config.secrets.keystorePassphrase;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof VigilError ? error.message : "unexpected error";
  process.stderr.write(`vigil: ${message}\n`);
  if (!(error instanceof VigilError)) process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
