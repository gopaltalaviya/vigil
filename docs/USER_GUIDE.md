# Using the web app

The web app comes in two forms, built from the same pages:

| Form             | Address                 | Who it is for       | Wallet                                |
| ---------------- | ----------------------- | ------------------- | ------------------------------------- |
| Public site      | `http://<host>:8080`    | Anyone              | Read only                             |
| Operator console | `http://127.0.0.1:8090` | The rollup operator | Deposit, send, withdraw, claim, memos |

The theme button in the header switches between system, light and dark. The choice is remembered.

## Home

The front page explains Vigil Watchtower on one screen: what it is, the three things it guarantees, and a
live card from the watchtower with the latest batches and their verdicts. Further down: what
changes with Vigil, the settlement diagram, the six parts, the post-quantum algorithms, and how
to check everything yourself.

## Dashboard

The dashboard answers "is the rollup healthy?" at a glance.

- **The status badge** in the header reads "On duty" when the watchtower has checked the rollup in
  the last three minutes. It turns amber when the watchtower is silent and red when it has found an
  invalid batch that is still open.
- **The settlement flow** counts inbox entries, batches, re-executed batches, final batches and
  recorded receipts.
- **In the challenge window** shows every batch that can still be proven wrong, with the time left.
- **Live inbox** lists the newest transactions.
- **Services** shows when each background service last finished a round.

## Proof

Every claim Vigil makes, with the testnet transactions that show it happened: the forged batch
the watchtower stopped, the earlier drill, every batch re-executed, receipts on chain, a paid
withdrawal, a private memo and the chain monitor's findings. Each hash opens QoreChain's own record.

## Batches

Every batch, newest first, with two independent opinions side by side:

- **Watchtower verdict**: Vigil's own re-execution. Valid, Invalid, or Waiting for data.
- **Chain status**: QoreChain's view. In challenge window (with a countdown), Final, or Rejected.

Open a batch to see its settlement timeline, the roots the submitter claimed (and the re-executed
values if they differ), and every inbox entry it covers, decoded.

## Accounts

Paste a rollup account id (64 hexadecimal characters) to see its balance and how many transactions
it has sent. Balances come from replaying the verified inbox, not from anyone's word.

**Withdrawals to a QoreChain address** lists the rollup withdrawals that pay a `qor1…` or `0x…`
address. A mistyped address is refused with the reason (for example a bad checksum). With the QoreX
wallet installed, **Use my QoreX address** asks QoreX for your address and fills it in; nothing is
signed and nothing is sent. Without QoreX the page says so and the button is not shown.

## Wallet (operator console)

Sign in with the console password set in `VIGIL_CONSOLE_PASSWORD`, or with QoreChain:

1. Under **Or sign in with QoreChain**, enter the operator's `qor1` address and choose **Get the
   message**. The console shows a one-time Sign In With QoreChain message, valid for five minutes.
2. Sign it. On the server, run `pnpm -s vigil login`, paste the message, end the input (Ctrl+D, or
   Ctrl+Z then Enter on Windows) and paste the line it prints. With a QoreX version that can sign
   messages, choose **Sign with QoreX** instead.
3. The console checks the secp256k1 signature and the ML-DSA-87 signature against the key the
   account registered on chain with a proof of possession. A classical-only signature is refused.

Only the operator's own account, and any listed in `CONSOLE_SIWQ_ADDRESSES`, may sign in. The
`vigil login` route uses the same seed phrase the console holds, so it replaces the shared password
with a post-quantum signature rather than adding a second person. Five failed attempts, of either
kind, lock the sign-in for five minutes.

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

**Learn** explains the concept with an animated diagram, and compares the same situations without
Vigil and with it under **Before and after**. **Docs** holds these pages.
