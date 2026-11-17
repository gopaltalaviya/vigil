# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `@vigil/core`: validated configuration, structured logging with secret redaction, an HTTP
  client with retries, rate limiting and a circuit breaker, a SQLite store with migrations, a
  verified inbox archive, batch re-execution and ledger snapshots.
- Golden test that replays public testnet data and reproduces the finalized state roots.
- `VigilReceipts` contract: verifies ML-DSA-87 settlement anchors and watchtower attestations
  on chain through the `pqcKeyStatus` and `pqcVerify` precompiles; unit and fuzz tests, plus a
  no-deploy check against a live node.
- `@vigil/watchtower`: judges every batch by re-execution, raises de-duplicated alerts to
  Telegram or a webhook, detects a stalled inbox, and runs as a service with a health check.
- `@vigil/wallet`: the `vigil` command line with an encrypted L2 keystore.
- `@vigil/batcher`: bonded submitter that never sends a batch failing its own re-execution.
- `scripts/bootstrap-rollup.ts`: idempotent rollup creation and bonding, dry run by default.
- Rollup `vigil-1` created on the QoreChain testnet; first anchored batch submitted.
- `@vigil/receipts`: deploys `VigilReceipts` and records settlement anchors through it; the
  contract is live on the testnet and holds the receipt of the first batch.
- Watchtower: automatic challenge of invalid batches with a locally checked re-execution fraud
  proof (`WATCHTOWER_CHALLENGE`), and a fraud drill script for live networks.
- `@vigil/memo` and `vigil memo`: confidential memos sealed with ML-KEM-1024, bound to an L2
  transfer and carried through the rollup inbox.
