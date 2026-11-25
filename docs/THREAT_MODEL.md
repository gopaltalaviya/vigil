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
- A verdict is stored per claim, identified by every committed field. A replacement batch at
  the same index is judged from scratch even if it has the same state root.
  Tests: "judges a replacement batch on its own", "does not carry an old 'invalid' verdict over".
- For an invalid batch it builds a re-execution fraud proof, confirms locally with the chain's own
  check that it proves fraud, and submits the challenge.
  Tests: `packages/watchtower/test/challenger.test.ts`.
- On the testnet the forged batch above was rejected by a fraud proof ten blocks later, the
  submitter's bond was slashed and the rollup continued from the honest batch
  (challenge `D5D739743AEBB1FCA1148D5775DD67CF39FF669D4F3AFBFE2945700CFB0ED9A4`, honest batch
  `7853216496A5E0BA69CC332165D532B4800B5734C1E391D2E21E16B5D1BF4D83`).

- In a second drill, Vigil's own watchtower judged forged batch 18 invalid 2 seconds after it was
  submitted and challenged it; the chain upheld the fraud and slashed the bond, with Vigil as the
  challenger (forged batch `E6993DBCAE77E735D138E03748A09321899525BAF24C464BEE360C2A9C02BDB4`,
  challenge `349C8DF05F888E2AEB8826101F49FD8960EB3662A47530B37C71307206822330`).

**Limits.** Fraud is only caught if at least one honest watcher is online within the challenge
window (3,600 seconds on the testnet). A mismatch in the data hash alone is detected and alerted
but cannot be proven by re-execution, so it is not challenged.

**Single host.** Vigil's challenging watchtower runs on one machine. That machine has been away:
while it slept on 18-19 November, batch 29 of `vigil-1` was forged twice and both forgeries were
rejected by other teams' bots, not by Vigil; on 24-25 November it slept for 6.5 hours (no batch
was submitted in that gap). What is in place:

- Every tick compares the time since the last heartbeat; after a gap of more than 300 seconds the
  watchtower raises "was offline" and re-reads what happened from chain events, so a missed
  forgery is reported. Live test: paused for 6 minutes, alert raised 1 second after resuming.
- A second, key-less watchtower runs on GitHub Actions every 15 minutes
  (`.github/workflows/sentinel.yml`). It re-executes and alerts, and its run fails while an
  invalid batch can still be challenged. It holds no seed phrase, so it cannot challenge; GitHub
  may delay a scheduled run, and a 15-minute cadence can see a forgery late in its one-hour
  window. It is a backstop that tells a human, not a second challenger.

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
- The chain keeps each post's accumulator value for 648,000 blocks (about 11 days on the testnet,
  `posted_data_retention_blocks`), and a checkpoint post (every 64th) only until a finalized
  batch covers it. A new archive therefore reads every entry up to the inbox head in one pass and
  checks the result against the head's accumulator, which the chain always serves. The read
  follows every page of the transaction search (the kit stops after 5,000 transactions) and
  resumes from the height of the last archived entry.
  Tests: `packages/core/test/inbox.test.ts` ("syncs from an empty store to the head in one read,
  past a pruned checkpoint", "follows every result page, where the kit alone stops after 50").
- The audit of other teams' rollups keeps the same verified archive per rollup, so each round
  reads only new posts. `sealed-scouts-1` (12,580 entries, 1,521 batches) is audited this way.

**Limit.** Entries come from the public node's transaction index. If a node pruned old
transactions before any Vigil instance archived them, they could not be recovered from it; the
testnet node still serves the transactions of `vigil-1` back to its creation. A new watchtower should be started early or
seeded from a backup.

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
- `pnpm redteam` replays ten attacks against live data, each refused by a named check with a
  passing control: [REDTEAM.md](REDTEAM.md).
- QoreScan's inventory of the contracts, the chain and its endpoints is in [CBOM.md](CBOM.md),
  with what it cannot see.

**Limits.** Hybrid signing is only as strong as the chain's enforcement of the post-quantum half.
A key's first registration is authorised classically. The EVM transaction that records a receipt
is a classical secp256k1 transaction admitted through an authorisation window; the receipt's
content is post-quantum signed, the transport is not. Hashes (SHA-256, SHAKE, Keccak) are assumed
to remain secure.

### 7. Someone reads or misuses a memo

- A memo is encrypted to the recipient's registered ML-KEM-1024 key. A different key, a changed
  ciphertext, another transfer hash, another rollup and another chain all fail to open it.
- The reader reports a memo's transfer as verified only if that entry is a correctly signed
  transfer posted by the same account as the memo, and removes control characters from the text.
  Test: "does not present a forged or borrowed transfer as a verified payment".
  Tests: `packages/memo/test/memo.test.ts`.
  Testnet: memo `1D39B55A28FDD65478B4769200156D5785449DA02B33C751D0A067E125BCA674`.

**Limits.** A memo is not proof of payment: anyone can post one that points at any entry, and a
verified link still does not show that the transfer executed. Only the text is hidden. The
poster, the time, the size and the transfer the memo points to, including its amount, are public. The sender is not authenticated by the memo itself;
the poster's base-chain address is the only indication of origin. Losing the seed phrase loses
every memo. The encryption library is version 0.1.0 and has not had an external review.

### 8. Stolen or leaked keys

- Secrets are read from the environment only and are redacted from logs. Alert destinations are
  credentials in themselves (a webhook URL, a bot token in a path), so errors from the alert
  client show the host only.
  Tests: "redacts secret fields", "never puts the bot token in an error", "shows only the host
  when the URL itself is a secret".
- L2 keys are stored encrypted (scrypt, AES-256-GCM); a wrong passphrase and a modified file are
  both refused. Tests: "keystore" in `packages/wallet/test/wallet.test.ts`.
- The public API is given no secrets at all and only reads the database. The monitor is given
  alert destinations but no seed phrase.
  Test: "never exposes secrets, keys or transaction logs".
- The operator console holds the seed phrase and can spend. It requires a password, keeps
  sessions in HttpOnly, SameSite=Strict cookies, locks out repeated failures, refuses requests a
  cross-site page could forge, and listens on the local interface by default.
  Tests: `packages/console/test/console.test.ts`.
- Vigil's containers run as a non-root user with a read-only file system and no capabilities.
  The Caddy container keeps only the capability to bind low ports.

**Limits.** The batcher, the receipts service, the console and a challenging watchtower hold the
account's seed phrase in memory. The console's password is a single shared secret with no second
factor; exposing the console to the internet is not supported. Anyone with
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

- The API is read-only, accepts GET and HEAD only, limits requests per client (per visitor behind
  a trusted proxy when `TRUST_PROXY=1`), serves files from one directory with no path traversal,
  and sets a strict content security policy.
- The page shows when each service last completed a round, and reports the watchtower as silent
  instead of claiming all is well. The page writes
  every value as text. Tests: `packages/api/test/api.test.ts`.

**Limit.** The page shows what the operator's database contains. The static mirror
(`pnpm export:site`) is a copy of that database at one moment, marked as such on every page. To
verify independently, run your own watchtower: `ROLLUP_ID=vigil-1 pnpm watchtower --once`.

## Independent review

Before release the code was reviewed by two independent reviewers who had only the source, one
for the contract and one for the services.

- **Contract.** No critical, high or medium findings. Low and informational points are
  documented for consumers in the README ("Relying on recorded receipts"): events alone do not
  identify a receipt, a record is point-in-time and never revoked, and conflicting anchors can
  both be recorded. A front-run of `recordAnchor` only makes the honest transaction revert with
  the intended state already in place; the client treats that as success.
- **Services.** One critical and one high finding, both in how verdicts were cached, are fixed
  and covered by regression tests (threat 1). The medium findings are fixed as well: a webhook
  URL could reach logs, a memo link could be mistaken for proof of payment, the API cache and
  rate limit, a status page that could look healthy with a dead watchtower, one failing challenge
  blocking the others, secrets handed to services that did not need them, receipts recorded for
  unfinalized batches, a stuck `claim`, and a start-up race on the shared database.

Also fixed afterwards: the HTTP client refuses redirects and oversized answers, and the batcher
will not build on an open batch the watchtower judged invalid.

Not changed, and stated here instead: the batcher still builds on a batch that is in its
challenge window and not yet judged; a batch that stays undecidable is only alerted on near its
deadline; the keystore passphrase sits next to the seed phrase on a server.

## Out of scope

- Bugs in the base chain, its execution model or its precompiles.
- Privacy of amounts, senders and recipients on the rollup: everything except memo text is public.
- Denial of service against the public endpoints Vigil depends on.
- Economic attacks on a rollup with a small bond relative to the value it holds.
