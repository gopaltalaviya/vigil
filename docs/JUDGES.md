# For judges

Vigil Watchtower is a Protocol Builders entry. This page maps each requirement of the category to what was
built and to evidence you can check yourself on the QoreChain testnet (`qorechain-diana`).

## Where to look

| What              | Where                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------- |
| Rollup            | `vigil-1` (layer `vigil-1`), created at height 10,234,711                                |
| Receipts contract | `0xced683ad4319a34873e2c1aa90d18e2fcf1af1d1` on EVM chain 9800                           |
| Check it yourself | `ROLLUP_ID=vigil-1 pnpm watchtower --once` re-executes every batch from public data      |
| One-command check | `pnpm verify:proof`: every Proof transaction and every receipt, with QoreChain's own CLI |

## One-command check

`pnpm verify:proof` needs no key, no `.env`, no Docker and no Vigil service. It uses QoreChain's
CLI (`@qorechain/qore-cli`) against the public testnet endpoints:

- `qore pq status` on every transaction of the Proof page: each native-lane transaction must carry
  exactly one ML-DSA-87 layer that verifies. EVM-lane transactions are expected to show
  `classical` with reason `evm_lane`, because that lane has no ML-DSA-87 layer.
- `qore read-contract` with `VigilReceipts.isAnchorRecorded` for every final batch of `vigil-1`
  that has a settlement anchor, and `isAttestationRecorded` for the watchtower's attestations.

It exits non-zero on any mismatch. A transaction the node no longer keeps is reported as `pruned`.
On 25 Nov 2026 it reported 29 of 29 transactions as expected, 31 of 32 final batches with a
recorded anchor (batch 28 has no anchor served by the chain) and 2 attestations, in about 9 s.

## Requirements

| Requirement                 | What Vigil does                                                                                                      | Evidence                                                                                                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ML-DSA-signed batches       | Every batch of `vigil-1` carries the creator's ML-DSA-87 anchor signature; base-chain transactions are hybrid-signed | Batch 0: `B15BF4B9BACA1DE7ED0E290C8BD9D409AF11A8207D38FD5481066C047092E70E`; anchor on layer `vigil-1` with a 4,627-byte signature                                                                                  |
| Withdrawal                  | Withdrawals are paid from the deposit pool with a Merkle proof once the batch is final; 8 of 9 are paid              | Claim of 0.5 QOR: `511A29444A436A13956E9A40D8199B40803EE79197C102A7FD6FBF7967833BE6`; claim of 0.3 QOR: `EF08E2F0A81C1DC9A8A35770577DFFB2CAF958C3EF80EA5047177CDD5FEE8617`                                          |
| Verified settlement receipt | `VigilReceipts` verifies the anchor with `pqcKeyStatus` and `pqcVerify` and records it                               | Batch 0 receipt: `0xa4e7838ccc9e11bb03d7650a53579aa99e34f3c7a67177b322f6dfe0cc7b1855`                                                                                                                               |
| Watchtower                  | Re-executes every batch from a verified inbox copy; challenges a wrong one with a re-execution fraud proof           | Forged batch 18: `E6993DBCAE77E735D138E03748A09321899525BAF24C464BEE360C2A9C02BDB4`; Vigil's challenge 5 s later, fraud upheld and bond slashed: `349C8DF05F888E2AEB8826101F49FD8960EB3662A47530B37C71307206822330` |
| ML-KEM data protection      | Private memos sealed with ML-KEM-1024 to the recipient's registered key, bound to the transfer                       | Key published: `9409BE3284B456530AE1EDBA7622D04AB1D6B12A6D7C28835FE6000D36FD4CBC`; memo: `1D39B55A28FDD65478B4769200156D5785449DA02B33C751D0A067E125BCA674`                                                         |
| Threat model                | Every claim tied to a test or a transaction, limits stated                                                           | [Threat model](THREAT_MODEL.md)                                                                                                                                                                                     |

About the fraud drills: in the first, before Vigil's watchtower was running, forged batch 1
(`E5F81D81…`) was rejected only because an independent watcher challenged it (`D5D73974…`). In the
second, Vigil's watchtower judged forged batch 18 invalid 2 seconds after it landed and its
challenge was confirmed 3 seconds later. The chain recorded `rdk_fraud_upheld` with Vigil's
operator account as the challenger: the cheater's 1,000 QOR bond was slashed, 500 QOR burned and
500 QOR paid to Vigil. Every case, with links to the transactions, is on the app's **Proof** page.

## What we built on top of the kit

The QoreChain rollup kit provides the client, the `qledger-v1` execution functions and the proof
encodings. Vigil Watchtower adds:

- A watchtower for `qledger-v1` rollups (the kit did not include one when we started, 16 Nov
  2026), with automatic challenges.
- A verified, pruning-proof inbox archive and ledger snapshots.
- A batcher that refuses to submit a batch it would judge invalid.
- On-chain verification of settlement anchors (`VigilReceipts`).
- Private memos bound to transfers.
- A monitor of QoreChain itself, which found mainnet's block time at 4.78 s against a documented
  3.1 s.
- A web app and operator console, with Sign In With QoreChain (ML-DSA-87 checked against the
  registered key).
- A read-only audit of the other `qledger-v1` rollups on the network. It independently reproduces
  the withdrawals-root mismatch in `wicketgate-pay` batch 12 that the rollup's own team also
  reports ([their proof log](https://github.com/timix648/wicketgate/blob/main/PROOF.md)), and re-executes all 1,521 batches of `sealed-scouts-1`
  (12,580 inbox entries) from its own verified archive.
- An inbox reader that keeps working after the chain prunes posted data, and a key-less second
  watchtower on GitHub Actions that alerts while the main host is down.
- Receipt recording through a smart account whose key can call only the two record functions, with
  a scoped EVM window as the fallback.
- `SettlementGate`, an example contract that pays only after a batch has settled.
- One-command checks from a fresh clone with no key: `verify:proof`, `metrics`, `redteam`.

## Quality

- 242 TypeScript tests, 19 contract tests and 10 tests of the SettlementGate example (2 of them
  against the real `VigilReceipts` on a testnet fork), including a golden test that replays a live
  rollup's public data and reproduces the state roots the chain finalized.
- A 170-check browser test of the web app in light and dark themes and at phone width, including
  Sign In With QoreChain through the browser.
- `pnpm redteam`: ten attacks on live data, each refused by a named check with a passing control.
- No professional audit. The contract and the services each had a separate AI-assisted security
  review of the source, checked by the team; the findings are fixed or documented in the
  [threat model](THREAT_MODEL.md).

## Videos

- `media/vigil-demo.mp4`: the demo, 2 minutes 47 seconds, with a real testnet transfer, the fraud
  catch, the audit of other rollups, SettlementGate and the IBC exit.
- `media/vigil-overview.mp4`: the concept in a minute and a half.
- `media/vigil-security.mp4`: the forged batch 18 stopped by the watchtower, step by step.
