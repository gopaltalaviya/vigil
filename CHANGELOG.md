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
- `@vigil/monitor`: base-chain monitor for testnet and mainnet with change detection.
- `@vigil/api` and the status page: read-only API, Prometheus metrics and a public dashboard.
- `vigil-receipts sync`: records every anchored batch that is not on chain yet.
- Docker image, Compose file, Caddy configuration and a backup script.
- Architecture, threat model, runbook and demo documents.

### Fixed

- Archiving the same inbox entries from two services at once no longer fails.
- Web app (`apps/web`) with a new emerald brand: overview, wallet, batch explorer with decoded
  inbox entries, account lookup, base-chain monitor and alerts.
- `@vigil/console`: password-protected operator console that performs wallet actions.
- Service heartbeats, shown in the web app.

### Fixed (independent review)

- Verdicts are keyed by the whole batch claim; a replacement batch is judged from scratch.
- Resolving a challenge now requires the same local fraud check as opening one.
- A webhook URL can no longer reach logs.
- Memo links are verified before they are shown as transfers.
- One failing challenge or claim no longer blocks the rest; challenges run before alert delivery.
- Receipts are recorded only for finalized batches the watchtower judged valid.
- The seed phrase is given only to services that send transactions.
- Opening the database from several processes at once no longer fails.
- The HTTP client refuses redirects and answers that declare more than 8 MiB.
- The batcher does not build on an open batch the watchtower judged invalid.
- Web app: WCAG AA contrast for all text, larger tap targets, loading states, correct heading
  order, focus kept at the top on first load, a shorter activity list. Verified with an automated
  browser test of every page at desktop and phone width, including a real transfer.
- Learn section in the web app: concept, animated settlement diagram, security, post-quantum,
  glossary and FAQ.
- Docs in the web app, rendered from `docs/` with a safe Markdown reader; new concept, user guide,
  command line, HTTP API, configuration, contract and judges documents.
- Video tooling under `scripts/video`: narrated overview, demo and security videos recorded from
  the live app.
- Home page that explains the product on its first screen, with a live watchtower card; the
  former overview is now the Dashboard.
- Learn page comparing nine situations without Vigil and with it.
- Proof page: every claim with the testnet transactions behind it, including a forged batch
  stopped by the watchtower 5 seconds after it was submitted.
