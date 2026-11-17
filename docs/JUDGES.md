# For judges

Vigil is a Protocol Builders entry. This page maps each requirement of the category to what was
built and to evidence you can check yourself on the QoreChain testnet (`qorechain-diana`).

## Where to look

| What              | Where                                                                               |
| ----------------- | ----------------------------------------------------------------------------------- |
| Rollup            | `vigil-1` (layer `vigil-1`), created at height 10,234,711                           |
| Receipts contract | `0xced683ad4319a34873e2c1aa90d18e2fcf1af1d1` on EVM chain 9800                      |
| Check it yourself | `ROLLUP_ID=vigil-1 pnpm watchtower --once` re-executes every batch from public data |

## Requirements

| Requirement                 | What Vigil does                                                                                                      | Evidence                                                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ML-DSA-signed batches       | Every batch of `vigil-1` carries the creator's ML-DSA-87 anchor signature; base-chain transactions are hybrid-signed | Batch 0: `B15BF4B9BACA1DE7ED0E290C8BD9D409AF11A8207D38FD5481066C047092E70E`; anchor on layer `vigil-1` with a 4,627-byte signature                                                           |
| Withdrawal                  | Withdrawals are paid from the deposit pool with a Merkle proof once the batch is final                               | Claim of 0.5 QOR: `511A29444A436A13956E9A40D8199B40803EE79197C102A7FD6FBF7967833BE6`                                                                                                         |
| Verified settlement receipt | `VigilReceipts` verifies the anchor with `pqcKeyStatus` and `pqcVerify` and records it                               | Batch 0 receipt: `0xa4e7838ccc9e11bb03d7650a53579aa99e34f3c7a67177b322f6dfe0cc7b1855`                                                                                                        |
| Watchtower                  | Re-executes every batch from a verified inbox copy; challenges a wrong one with a re-execution fraud proof           | The fraud drill: forged batch `E5F81D8132AF395E1EEDE9B50FC66FFD7013310EE7BAC7A0675CE3FB0DC3FEC9`, rejected by fraud proof `D5D739743AEBB1FCA1148D5775DD67CF39FF669D4F3AFBFE2945700CFB0ED9A4` |
| ML-KEM data protection      | Private memos sealed with ML-KEM-1024 to the recipient's registered key, bound to the transfer                       | Key published: `9409BE3284B456530AE1EDBA7622D04AB1D6B12A6D7C28835FE6000D36FD4CBC`; memo: `1D39B55A28FDD65478B4769200156D5785449DA02B33C751D0A067E125BCA674`                                  |
| Threat model                | Every claim tied to a test or a transaction, limits stated                                                           | [Threat model](THREAT_MODEL.md)                                                                                                                                                              |

About the fraud drill: an independent challenger on the testnet beat our watchtower to the
challenge by seconds, because ours was started after the forged batch. The chain behaved exactly as
designed; Vigil's own challenge path is covered by tests against an in-process model of the chain
that uses the chain's own execution and fraud-check code.

## What is original

The QoreChain rollup kit provides the client, the `qledger-v1` execution functions and the proof
encodings. Vigil adds:

- A watchtower for `qledger-v1` rollups, which the kit does not have, with automatic challenges.
- A verified, pruning-proof inbox archive and ledger snapshots.
- A batcher that refuses to submit a batch it would judge invalid.
- On-chain verification of settlement anchors (`VigilReceipts`), which did not exist.
- Private memos bound to transfers.
- A monitor of QoreChain itself, which found mainnet's block time at 4.78 s against a documented
  3.1 s.
- A web app and operator console.

## Quality

- 152 TypeScript tests and 19 contract tests, including a golden test that replays a live rollup's
  public data and reproduces the state roots the chain finalized.
- A 66-check browser test of the web app in light and dark themes and at phone width, including a
  real transfer.
- Two independent reviews (contract and services). Their findings are fixed or documented in the
  [threat model](THREAT_MODEL.md).

## Videos

- `media/vigil-demo.mp4`: the three-minute demo.
- `media/vigil-overview.mp4`: the concept in one minute.
- `media/vigil-security.mp4`: how a forged batch is caught.
