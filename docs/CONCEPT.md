# Concept

Vigil is a rollup on QoreChain that is safe to use because someone is always checking it, and
that checking is open to anyone.

## The problem

A rollup runs transactions off the base chain and posts only a summary, called a batch, back to
it. That keeps fees low, but the base chain does not re-run the transactions when the batch
arrives. It accepts the summary and waits: for one hour on the QoreChain testnet, anyone may prove
the batch wrong. If nobody does, the batch becomes final, including any withdrawals it pays out.

So a rollup is only as honest as the people watching it. If no one checks, a dishonest submitter
can claim balances that do not exist and withdraw them.

> On the testnet, we submitted deliberately forged batches to our own rollup. QoreChain accepted
> each one at once. The first was rejected only because another watcher happened to challenge it.
> The second was caught by Vigil's watchtower, which challenged it 5 seconds after it landed; the
> cheater lost a 1,000 QOR bond. The system works only when a watcher is online.

Two more gaps made this worse on QoreChain:

- The rollup kit has no watchtower that can judge batches of the `qledger-v1` execution model, and
  nothing challenges automatically.
- Settlement signatures exist only off chain, so no contract can rely on them.

## What Vigil does

| Part             | What it does                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rollup `vigil-1` | A based, `qledger-v1` rollup on the QoreChain testnet. Batches carry the creator's ML-DSA-87 anchor signature.                                   |
| Batcher          | A bonded submitter. It re-executes its own batch before sending it, because a wrong batch costs the whole bond.                                  |
| Watchtower       | Keeps a verified copy of the inbox, re-executes every batch, and challenges a wrong one with a fraud proof inside the window.                    |
| VigilReceipts    | A contract that checks a batch's ML-DSA-87 anchor against the signer's registered key and records it, so other contracts can rely on settlement. |
| Private memos    | Notes attached to payments, encrypted with ML-KEM-1024 to the recipient's registered key.                                                        |
| Monitor          | Watches QoreChain itself: halts, block time against the documented value, upgrades and silent setting changes.                                   |
| Web app          | Overview, wallet, batch explorer, accounts, base-chain status, alerts, and these docs.                                                           |

## How a transaction settles

1. **Sign.** A user signs a transfer or withdrawal with their rollup key (ML-DSA-44) and posts it
   to the rollup's inbox on QoreChain.
2. **Batch.** The batcher executes the new inbox entries and submits a batch: the new state root,
   the withdrawals root and a commitment to exactly which entries it covered, with an ML-DSA-87
   anchor signature.
3. **Check.** The watchtower re-executes the same entries from its own verified copy and compares
   every number. A mismatch becomes a fraud proof and a challenge.
4. **Settle.** After the challenge window the batch is final. Withdrawals in it are paid with a
   Merkle proof.
5. **Record.** The anchor is verified and recorded by `VigilReceipts`.

## Why post-quantum

Large quantum computers would break the elliptic-curve signatures most chains use. Vigil uses the
NIST standards where value is at stake:

- **ML-DSA-87** for settlement anchors and the operator's transactions.
- **ML-DSA-44** for every rollup transaction.
- **ML-KEM-1024** for private memos.

## Who it is for

- People using the rollup, who need their funds guarded.
- Rollup operators, who need a submitter, a watchtower and a status page that work together.
- Developers on QoreChain, who need to know when the chain halts or changes.

Next: [Using the web app](USER_GUIDE.md), [Architecture](ARCHITECTURE.md),
[Threat model](THREAT_MODEL.md).
