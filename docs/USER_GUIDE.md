# Using the web app

The web app comes in two forms, built from the same pages:

| Form             | Address                 | Who it is for       | Wallet                                |
| ---------------- | ----------------------- | ------------------- | ------------------------------------- |
| Public site      | `http://<host>:8080`    | Anyone              | Read only                             |
| Operator console | `http://127.0.0.1:8090` | The rollup operator | Deposit, send, withdraw, claim, memos |

The theme button in the header switches between system, light and dark. The choice is remembered.

## Overview

The first page answers "is the rollup healthy?" at a glance.

- **The status badge** in the header reads "On duty" when the watchtower has checked the rollup in
  the last three minutes. It turns amber when the watchtower is silent and red when it has found an
  invalid batch that is still open.
- **The settlement flow** counts inbox entries, batches, re-executed batches, final batches and
  recorded receipts.
- **In the challenge window** shows every batch that can still be proven wrong, with the time left.
- **Live inbox** lists the newest transactions.
- **Services** shows when each background service last finished a round.

## Batches

Every batch, newest first, with two independent opinions side by side:

- **Watchtower verdict**: Vigil's own re-execution. Valid, Invalid, or Waiting for data.
- **Chain status**: QoreChain's view. In challenge window (with a countdown), Final, or Rejected.

Open a batch to see its settlement timeline, the roots the submitter claimed (and the re-executed
values if they differ), and every inbox entry it covers, decoded.

## Accounts

Paste a rollup account id (64 hexadecimal characters) to see its balance and how many transactions
it has sent. Balances come from replaying the verified inbox, not from anyone's word.

## Wallet (operator console)

Sign in with the console password set in `VIGIL_CONSOLE_PASSWORD`. Five failed attempts lock the
sign-in for five minutes.

1. **Create account.** The first time, create a rollup account. Its ML-DSA-44 key is stored
   encrypted on the server.
2. **Deposit.** Move QOR from the operator's base-chain account into the rollup (at least 1 QOR).
3. **Send.** Transfer to another rollup account. Optionally add a private memo: give the
   recipient's base-chain address, and the memo is encrypted to the key they published.
4. **Withdraw.** Move QOR back to a base-chain address. It can be claimed once its batch is final,
   about an hour after it is batched.
5. **Claim.** When a withdrawal shows "Ready to claim", press Claim.
6. **Encryption key.** Publish your ML-KEM-1024 key once so others can send you memos.

The balance updates as soon as a transaction is posted; "Settled in a batch" shows the part a batch
has already covered. Every base-chain transaction the console sends appears under Activity with its
hash.

A memo marked **Signed transfer** points to a correctly signed transfer from the same sender. A
memo marked **Transfer not verified** points to something else: do not treat it as payment.

## Base chain

Block production and block time on the QoreChain testnet and mainnet, measured by Vigil and
compared with the documented value. Below, every change detected in QoreChain's settings, with what
changed.

## Alerts

Everything the watchtower raised: invalid batches, closing challenge windows, a rollup that stopped
batching, and challenges it sent.

## Learn and Docs

**Learn** explains the concept with an animated diagram. **Docs** holds these pages.
