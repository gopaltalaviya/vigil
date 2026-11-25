# Command line

Every command reads its settings from the environment. From the repository root, either export
the variables or run through `pnpm exec tsx --env-file=.env <file>`. The `pnpm` scripts below
assume the environment is set.

## Wallet: `pnpm vigil`

| Command                                               | What it does                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| `vigil keygen`                                        | Creates an encrypted rollup account (ML-DSA-44) in `VIGIL_DATA_DIR/keystore.json` |
| `vigil address`                                       | Shows the rollup account id and the base-chain address                            |
| `vigil balance [account-id]`                          | Balance and nonce, from replaying the verified inbox                              |
| `vigil deposit <qor>`                                 | Base chain to rollup; at least 1 QOR                                              |
| `vigil transfer <account-id> <qor>`                   | Rollup to rollup                                                                  |
| `vigil withdraw <qor> [qor1...]`                      | Rollup to base chain; defaults to your own address                                |
| `vigil claim`                                         | Pays out every finalized, unclaimed withdrawal to you                             |
| `vigil status`                                        | Rollup, inbox and batch overview                                                  |
| `vigil memo register`                                 | Publishes your ML-KEM-1024 key on chain (once)                                    |
| `vigil memo send <qor1...> <account-id> <qor> <text>` | Transfer with a memo only the `qor1` owner can read                               |
| `vigil memo inbox`                                    | Decrypts memos addressed to you                                                   |
| `vigil login`                                         | Signs the console's Sign In With QoreChain message, read from stdin               |

Example:

```sh
pnpm vigil keygen
pnpm vigil deposit 5
pnpm vigil transfer 9621a556ab9a2b7af4e37dace1d79482171e47360ab36c1501a5ec785823b5f7 1
pnpm vigil withdraw 0.5
pnpm vigil claim
```

## Receipts: `pnpm receipts`

| Command                   | What it does                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `receipts status`         | Deployer account, its post-quantum key, EVM window and contract                       |
| `receipts setup [qor]`    | Funds the deployer (default 20 QOR), registers its ML-DSA-87 key, opens an EVM window |
| `receipts deploy`         | Deploys `VigilReceipts` (needs `forge build` output)                                  |
| `receipts check <batch>`  | Verifies a batch's anchor through the contract, read-only                             |
| `receipts record <batch>` | Verifies and records a batch's anchor                                                 |
| `receipts sync`           | Records every final batch the watchtower judged valid                                 |
| `receipts watch`          | Runs `sync` every `RECEIPTS_INTERVAL_MS` until stopped                                |

## Services

| Command                    | What it runs                                                                      |
| -------------------------- | --------------------------------------------------------------------------------- |
| `pnpm watchtower [--once]` | Re-executes every batch, raises alerts, challenges when `WATCHTOWER_CHALLENGE=on` |
| `pnpm batcher [--once]`    | Submits batches as entries arrive                                                 |
| `pnpm monitor [--once]`    | Watches QoreChain testnet and mainnet                                             |
| `pnpm api`                 | The public, read-only web app on `API_PORT`                                       |
| `pnpm console`             | The web app with wallet actions on `127.0.0.1:CONSOLE_PORT`                       |

`--once` runs a single round and exits, which is useful for checking a rollup by hand:

```sh
ROLLUP_ID=vigil-1 pnpm watchtower --once
```

## Rollup operations

| Command                           | What it does                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pnpm rollup:bootstrap`           | Dry run: simulates creating the rollup named by `ROLLUP_ID` and bonding the submitter                              |
| `pnpm rollup:bootstrap --execute` | Creates the rollup (10,000 QOR stake, 1% burned) and bonds 1,000 QOR. Skips steps already done                     |
| `pnpm fraud:drill`                | Dry run of a fraud rehearsal                                                                                       |
| `pnpm fraud:drill --execute`      | A throwaway account (`QORE_DRILL_MNEMONIC`) bonds and submits a batch with a wrong state root. Its bond is slashed |

## Checks anyone can run (no key)

| Command                                    | What it does                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `pnpm verify:proof`                        | Every Proof transaction (`qore pq status`) and every receipt (`qore read-contract`); see JUDGES  |
| `pnpm metrics [--readme]`                  | Headline numbers recomputed from the chain; `--readme` rewrites the table in README.md           |
| `pnpm redteam`                             | Ten attacks on live data, each refused by a named check with a control; see REDTEAM              |
| `pnpm cbom`                                | QoreScan inventory of the contracts, the chain and its endpoints into `docs/cbom.json`; see CBOM |
| `pnpm mcp`                                 | The MCP server over stdio; see MCP                                                               |
| `ROLLUP_ID=vigil-1 pnpm watchtower --once` | Re-executes and judges every batch                                                               |

## With the operator's keys (`.env`)

| Command                                                         | What it does                                                                                                                                    |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm redteam:full`                                             | `redteam`, plus a simulated second claim of a paid withdrawal (nothing is sent)                                                                 |
| `pnpm ibc-exit --check` / `pnpm ibc-exit <qor>`                 | Checks the IBC channel to Osmosis testnet, or sends QOR to the operator's own address there and waits for the relayer's acknowledgement         |
| `pnpm settlement-gate [v2] deploy \| open \| status \| release` | Runs the SettlementGate example (or, with `v2`, the version that also requires the watchtower's attestation) with the receipts deployer account |

## Development

| Command                                      | What it does                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| `pnpm test` / `pnpm test:coverage`           | Unit, integration and golden tests                                            |
| `pnpm lint`, `pnpm typecheck`, `pnpm format` | Code quality                                                                  |
| `pnpm golden:refresh`                        | Re-records the public rollup data the golden test replays                     |
| `pnpm live:probe [rollup-id]`                | Runs the receipt check against the chain's real precompiles without deploying |
| `pnpm gen:abi`                               | Regenerates the contract ABI for the receipts package                         |
| `pnpm video <name>`                          | Records a product video (see `scripts/video`)                                 |
| `cd contracts && forge test`                 | Contract tests                                                                |
