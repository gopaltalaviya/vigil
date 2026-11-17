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
