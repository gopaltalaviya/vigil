# Threat model

This document says what Vigil protects, against whom, and where it stops. Every claim points to
a test in this repository or to a transaction on the QoreChain testnet (`qorechain-diana`).
Vigil is testnet software and has not been audited.

## What is being protected

| Asset                                                             | Where it lives                                           |
| ----------------------------------------------------------------- | -------------------------------------------------------- |
| Funds deposited into the rollup                                   | The rollup's deposit pool on the base chain              |
| The submitter's bond (1,000 QOR)                                  | The base chain's rollup module                           |
| Correctness of the rollup's state                                 | The state root in each batch                             |
| Keys: account seed phrase, ML-DSA-87, ML-DSA-44 (L2), ML-KEM-1024 | The operator's environment and the encrypted L2 keystore |
| Memo text                                                         | Encrypted payloads in the rollup inbox                   |
| Truthfulness of the status page                                   | The operator's database                                  |

## Who is trusted for what

- **The base chain** is trusted to order transactions, keep the inbox accumulator, re-execute a
  challenged batch correctly and pay withdrawals. Vigil cannot protect against a faulty or
  malicious base chain. The testnet is a permissioned network with a small validator set.
- **The submitter** is not trusted. Any bonded account may submit a batch for a based rollup.
- **The watchtower operator** is trusted only by people who choose to rely on that watchtower.
  Anyone can run their own from this repository; it needs no key.
- **The rollup's creator** is trusted to keep its ML-DSA-87 key, which signs settlement anchors.

## Threats and what Vigil does about them

### 1. A submitter posts a wrong state root or withdrawals root

The base chain accepts the batch at submission; it checks nothing about execution until someone
challenges. This was observed on the testnet: a batch with a flipped state root was accepted
(transaction `E5F81D8132AF395E1EEDE9B50FC66FFD7013310EE7BAC7A0675CE3FB0DC3FEC9`).

- The watchtower re-executes every batch from its own verified copy of the inbox and compares the
  state root, withdrawals root, data hash, previous state root and inbox range.
  Tests: `packages/core/test/golden.test.ts`, `packages/watchtower/test/watchtower.test.ts`.
- For an invalid batch it builds a re-execution fraud proof, confirms locally with the chain's own
  check that it proves fraud, and submits the challenge.
  Tests: `packages/watchtower/test/challenger.test.ts`.
- On the testnet the forged batch above was rejected by a fraud proof ten blocks later, the
  submitter's bond was slashed and the rollup continued from the honest batch
  (challenge `D5D739743AEBB1FCA1148D5775DD67CF39FF669D4F3AFBFE2945700CFB0ED9A4`, honest batch
  `7853216496A5E0BA69CC332165D532B4800B5734C1E391D2E21E16B5D1BF4D83`).

**Limits.** That challenge was sent by an independent third party that reacted before Vigil's
watchtower was started; Vigil's own challenge path is verified against an in-process model of the
chain that uses the chain's execution and fraud-check code, not yet by a challenge of its own on
the testnet. Fraud is only caught if at least one honest watcher is online within the challenge
window (3,600 seconds on the testnet). A mismatch in the data hash alone is detected and alerted
but cannot be proven by re-execution, so it is not challenged.

### 2. The submitter stops, censors, or batches slowly

Deposits and withdrawals sit in the inbox until some submitter batches them.

- The watchtower raises a warning when inbox entries wait longer than a set number of blocks.
  Test: "warns when inbox entries wait too long for a batch".
- On a based rollup any bonded account can submit, so an operator can run the batcher from this
  repository to restore liveness. A competing submitter is handled by re-planning from the chain's
  latest state. Test: "re-plans after another submitter batches the same entries first".

**Limit.** Nothing forces anyone to batch. Liveness depends on at least one willing, bonded
submitter.

### 3. Our own batcher produces a wrong batch

A wrong batch would cost the whole bond.

- The batcher re-executes its plan against its own verified archive and refuses to submit anything
  it would judge invalid, or that covers entries it has not verified.
  Tests: "never submits a plan that fails its own re-execution", "refuses a plan that reaches past
  the entries it has verified".

### 4. Inbox data is withheld, altered or pruned

Batches commit to inbox entries by hash; the entries themselves live in base-chain transactions.

- Every entry is checked against the chain's hash accumulator before it is archived, and a chain
  whose inbox is shorter than, or different from, the archive is refused.
  Tests: "inbox archive integrity" in `packages/core/test/golden.test.ts`.
- The archive is kept locally, so re-execution keeps working after the public node prunes old
  blocks.

**Limit.** An entry that was pruned before any Vigil instance archived it cannot be recovered
from the public node. A new watchtower should be started early or seeded from a backup.

### 5. A forged or replayed settlement receipt

- `VigilReceipts` never takes a public key from the caller. It reads the signer's ML-DSA-87 key
  from the chain's key registry, requires a proof of possession, rebuilds the signed bytes on
  chain and verifies the signature with the chain's precompile.
- A receipt is recorded once; an anchor signature cannot be used as an attestation; attestations
  are bound to the EVM chain id and the contract address; field boundaries cannot be shifted.
- A chain without the precompiles is detected and refused, never treated as "valid".
  Tests: `contracts/test/VigilReceipts.t.sol` (19 tests, including fuzz tests).
- On the testnet the contract at `0xced683ad4319a34873e2c1aa90d18e2fcf1af1d1` recorded the
  receipts of batches 0, 1 and 2 of `vigil-1`
  (for example `0xa4e7838ccc9e11bb03d7650a53579aa99e34f3c7a67177b322f6dfe0cc7b1855`).

**Limits.** The contract records that a registered key signed an anchor. Whether that signer is
the right authority for a rollup is the consumer's decision: compare the recorded signer with the
rollup's creator. Anyone may submit a valid receipt; that is intended.

### 6. A quantum-capable adversary

- Base-chain transactions are hybrid-signed (secp256k1 and ML-DSA-87). Settlement anchors are
  signed with ML-DSA-87. L2 transactions are signed with ML-DSA-44. Memos use ML-KEM-1024.

**Limits.** Hybrid signing is only as strong as the chain's enforcement of the post-quantum half.
A key's first registration is authorised classically. The EVM transaction that records a receipt
is a classical secp256k1 transaction admitted through an authorisation window; the receipt's
content is post-quantum signed, the transport is not. Hashes (SHA-256, SHAKE, Keccak) are assumed
to remain secure.

### 7. Someone reads or misuses a memo

- A memo is encrypted to the recipient's registered ML-KEM-1024 key. A different key, a changed
  ciphertext, another transfer, another rollup and another chain all fail to open it.
  Tests: `packages/memo/test/memo.test.ts`.
  Testnet: memo `1D39B55A28FDD65478B4769200156D5785449DA02B33C751D0A067E125BCA674`.

**Limits.** Only the text is hidden. The poster, the time, the size and the transfer the memo
points to, including its amount, are public. The sender is not authenticated by the memo itself;
the poster's base-chain address is the only indication of origin. Losing the seed phrase loses
every memo. The encryption library is version 0.1.0 and has not had an external review.

### 8. Stolen or leaked keys

- Secrets are read from the environment only, are redacted from logs and never appear in error
  messages, including a bot token inside a URL.
  Tests: "redacts secret fields", "never puts the bot token in an error".
- L2 keys are stored encrypted (scrypt, AES-256-GCM); a wrong passphrase and a modified file are
  both refused. Tests: "keystore" in `packages/wallet/test/wallet.test.ts`.
- The public API is given no secrets at all and only reads the database.
  Test: "never exposes secrets, keys or transaction logs".
- Containers run as a non-root user with a read-only file system and no capabilities.

**Limits.** The batcher and watchtower hold the account's seed phrase in memory. Anyone with
access to the host or its `.env` file controls the account, the bond and the rollup's anchors.
There is no hardware key support and no key rotation procedure yet.

### 9. The base chain halts, changes its rules, or is reset

- The monitor detects a halt, measures block time against the documented value and records any
  change to upgrade plans, proposals, disabled message types, precompiles and module parameters.
  Tests: `packages/monitor/test/monitor.test.ts`. First live finding: mainnet block time of
  4.78 s against a documented 3.1 s.
- Services back off and resume by themselves after a halt or an unreachable endpoint.
  Tests: "service loop", "HttpClient".

**Limits.** Detection only. A based rollup can be paused or stopped by governance, parameters can
be changed, and a testnet reset erases the rollup; Vigil can report these, not prevent them. The
challenge window is assumed to be measured in block time, so that a halt extends it; this has not
been observed during a real halt.

### 10. The status page lies or is attacked

- The API is read-only, accepts GET and HEAD only, limits requests per client, serves files from
  one directory with no path traversal, and sets a strict content security policy. The page writes
  every value as text. Tests: `packages/api/test/api.test.ts`.

**Limit.** The page shows what the operator's database contains. To verify independently, run
your own watchtower: `ROLLUP_ID=vigil-1 pnpm watchtower --once`.

## Out of scope

- Bugs in the base chain, its execution model or its precompiles.
- Privacy of amounts, senders and recipients on the rollup: everything except memo text is public.
- Denial of service against the public endpoints Vigil depends on.
- Economic attacks on a rollup with a small bond relative to the value it holds.
