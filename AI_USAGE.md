# AI usage

This file documents how Vigil Watchtower was built with AI assistance: the workflow, the generated
work and the human contribution.

## Workflow

- An AI coding assistant was used throughout the project, for planning, code, tests and
  documentation. The team set the goals and the order of work, and reviewed and approved the
  results.
- Work was split into small items. Each item had a written plan that the team agreed before it
  was built, and a log of what was done and what was found.
- Every change had to pass the same local gate before a commit: formatting, lint, type checks,
  the TypeScript tests with coverage thresholds, the contract tests, a dependency audit, and scans
  for secrets and personal data. Commits were made only after the gate passed.
- Claims about the testnet were checked against the chain itself, not taken from the assistant:
  every transaction on the Proof page is re-read by `pnpm verify:proof`, and the README numbers are
  recomputed from the chain by `pnpm metrics`.

## What was generated with AI assistance

- Most of the source code: the packages under `packages/`, the web app in `apps/web`, the
  contracts in `contracts/` and the `SettlementGate` example.
- Most of the tests: unit, fuzz and invariant tests, the golden replay test, and the red-team
  replay (`pnpm redteam`).
- The scripts for metrics, proof checks, the static mirror and the video recordings, and the
  narration texts of the videos.
- Most of the documentation, including this file.
- The security reviews of the contract and of the services were AI-assisted reviews of the source;
  the team checked each finding before it was fixed or documented (see the threat model).

## Human contribution

- **Product decisions:** what to build and for whom, the scope of each week, the name, which
  features to keep and which to drop.
- **Testnet spending:** every transaction that spends testnet QOR was approved before it was sent,
  within a budget with a stop line.
- **Fraud drills:** the decision to post forged batches to our own rollup, when to run them and
  with what bond, and the rule that the watchtower never challenges rollups run by other teams.
- **Reviews:** plans, code changes and public wording were reviewed, and corrected where they were
  wrong or claimed more than the evidence showed.
- **Accounts and keys:** the testnet accounts, keys and the running deployment are held and
  operated by the team. Keys stay in local files that are never committed.

The team owns the project and is responsible for it, including the parts written with AI
assistance.

## Limits

AI-generated code and text can be wrong. That is why every change goes through the gate and every
public claim is tied to a test or a transaction. Vigil Watchtower is testnet software and has not
had a professional audit.
