# Architecture

## Overview

```
 users                                  operator
   │ vigil (wallet CLI)                    │
   │  deposit / transfer / withdraw        │
   │  sealed memo (ML-KEM-1024)            │
   ▼                                       ▼
 ┌───────────────────── QoreChain base chain ─────────────────────┐
 │  rollup module: inbox ─► batches ─► challenge ─► finality      │
 │  layer module: settlement anchors (ML-DSA-87)                  │
 │  key registries: ML-DSA-87 and ML-KEM-1024                     │
 │  EVM: VigilReceipts + pqcVerify / pqcKeyStatus precompiles     │
 └───────▲───────────────▲──────────────────▲─────────────▲──────┘
         │ submit batch  │ read, challenge  │ record      │ read
     ┌───┴────┐     ┌────┴──────┐      ┌────┴─────┐  ┌────┴────┐
     │batcher │     │watchtower │      │ receipts │  │ monitor │
     └───┬────┘     └────┬──────┘      └────┬─────┘  └────┬────┘
         └───────────────┴───── SQLite ─────┴─────────────┘
                                  │ read only
                              ┌───┴───┐
                              │  api  │──► status page, /metrics
                              └───────┘
```

Each box is one process. They share one SQLite database in write-ahead-log mode and never call
each other, so any of them can be restarted or left out.

## How a transaction settles

1. **Inbox.** A user posts a signed L2 transaction (ML-DSA-44) or makes a deposit. The base chain
   appends it to the rollup's inbox and updates a hash accumulator. The chain stores only the
   commitment; the payload lives in the transaction that posted it.
2. **Batch.** A bonded submitter picks the next range of inbox entries, executes them, and submits
   the resulting state root, withdrawals root and range commitment. The transaction is
   hybrid-signed, and on a rollup we created it also carries the creator's ML-DSA-87 signature
   over the settlement anchor.
3. **Challenge window.** For one hour (testnet) anyone may submit a fraud proof: the batch's
   entries plus Merkle witnesses of the accounts they touch. The chain re-executes the batch. If
   the claim was wrong, the batch and everything built on it are rejected and the submitter's bond
   is slashed.
4. **Finality.** After the window the batch is final and its withdrawals can be paid out with a
   Merkle proof against the withdrawals root.
5. **Receipt.** The anchor's signature is verified and recorded by `VigilReceipts`, where other
   contracts can rely on it.

## Packages

| Package      | Role                                                                                   | Holds a key             |
| ------------ | -------------------------------------------------------------------------------------- | ----------------------- |
| `core`       | Config, logging, HTTP client, storage, inbox archive, re-execution, transaction sender | No                      |
| `watchtower` | Judges batches, alerts, challenges                                                     | Only when challenging   |
| `batcher`    | Plans and submits batches                                                              | Yes                     |
| `wallet`     | `vigil` command line, encrypted L2 keystore                                            | Yes                     |
| `memo`       | Sealed memos                                                                           | Recipient's key to read |
| `receipts`   | Deploys the contract, records anchors                                                  | Yes                     |
| `monitor`    | Watches the base chain                                                                 | No                      |
| `api`        | Read-only API, metrics, static status page                                             | No                      |
| `contracts`  | `VigilReceipts`, `ReceiptVerifier`                                                     | n/a                     |

## Design decisions

**State is a function of the inbox.** The ledger after the first _n_ inbox entries is the same
however submitters group entries into batches. Every component therefore derives state by
replaying the archive (`ledgerAtSequence`), from the newest snapshot at or before the point it
needs. No component trusts a state root it did not compute.

**Verify before storing, re-execute before sending.** Inbox entries are checked against the
chain's accumulator before they enter the archive. The batcher re-executes its own plan before
submitting. The challenger runs the chain's fraud check on its own proof before sending it.

**One database, many processes.** SQLite in WAL mode with a busy timeout. Writes that two
services may attempt at once, such as archiving the same inbox entries, are idempotent. Schema
changes are append-only migrations.

**Failures are states, not crashes.** An unreachable endpoint becomes "source unavailable"; a
service loop backs off and retries; a transaction is logged as confirmed, failed or unconfirmed.
Deadlines are computed from block time reported by the chain, not from the local clock.

**No secrets where they are not needed.** Only the processes that send transactions receive the
seed phrase. The API container receives no secret at all.

**Reuse the kit for consensus-critical code.** Execution of L2 transactions, the inbox hashing
rules, fraud proof encoding and anchor sign bytes come from `@qorechain/rdk`, so Vigil computes
exactly what the chain computes. Vigil adds what the kit does not have: a verified archive,
snapshots, a watchtower for this execution model, automatic challenges, on-chain receipt
verification, memos bound to transfers, and the base-chain monitor.

## Testing strategy

- **Golden test.** Public data of a live rollup is replayed offline and must reproduce the state
  roots the chain finalized.
- **In-process chain model.** `packages/core/test/fake-rollup.ts` implements the inbox,
  accumulator, batches and challenges with the kit's own execution and fraud-check code. Wallet,
  batcher, watchtower and challenger are tested end to end against it without a network.
- **Contract tests.** Unit and fuzz tests against stand-in precompiles, plus `pnpm live:probe`,
  which runs the verification code on a live node with `eth_call` and no deployment.
- **Live runs.** Every feature was exercised on the testnet; see `docs/THREAT_MODEL.md` for
  transaction hashes.
