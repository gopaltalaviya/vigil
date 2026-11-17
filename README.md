<p align="center"><img src="brand/logo.svg" width="320" alt="Vigil"></p>

<p align="center"><strong>The rollup that never looks away.</strong></p>

Vigil is a post-quantum rollup stack for [QoreChain](https://qorechain.io): batches signed with
ML-DSA-87, verified settlement receipts, withdrawals, ML-KEM-protected memos, and a watchtower
that independently re-executes every batch and monitors the base chain underneath.

Built for _Build Before Q-Day: The QoreChain Developer Fest_, Protocol Builders category.

> **Status: in active development.** The table below is kept honest: a component is marked
> "working" only when it has tests in this repository.

## Why

A rollup is only as trustworthy as the people checking it. On QoreChain an optimistic rollup
gives anyone one hour (on testnet) to prove a bad batch wrong, but the rollup kit ships no
watchtower that can judge a `qledger-v1` batch, and nothing challenges automatically. Vigil
fills that gap, and adds the pieces an operator needs around it.

## Components

| Component                 | What it does                                                                                                     | Status  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------- |
| `packages/core`           | Resilient chain access, verified inbox archive, ledger replay and snapshots, storage                             | Working |
| `packages/watchtower`     | Re-executes each batch, compares every commitment, raises alerts, and challenges fraud with a re-execution proof | Working |
| `packages/batcher`        | Bonded submitter: plans a batch, re-checks it against its own archive, signs and submits it                      | Working |
| `packages/wallet`         | `vigil` command line: encrypted L2 keys, deposit, transfer, withdraw, claim                                      | Working |
| `contracts/VigilReceipts` | Verifies a settlement receipt's ML-DSA-87 signature on chain through the `pqcVerify` precompile                  | Working |
| `packages/receipts`       | Reads a batch's settlement anchor from the base chain and records it through the contract                        | Working |
| `packages/memo`           | Confidential memos sealed with ML-KEM-1024 to the recipient's registered key and bound to an L2 transfer         | Working |
| `packages/monitor`        | Base-chain monitor: halts, block-time drift, upgrades, parameter and feature-flag changes                        | Planned |
| `apps/status`             | Public status page                                                                                               | Planned |

## How the watchtower decides

1. **Archive.** Every inbox entry (deposit or posted transaction) is fetched from the base chain
   and checked against the chain's hash accumulator before it is stored. The archive survives
   node pruning.
2. **Re-execute.** For each batch, the entries in its inbox range are executed on the parent
   ledger state. Nothing the submitter says is trusted except the claim being checked.
3. **Compare.** The state root, withdrawals root, data hash, previous state root and inbox range
   must all match. Any difference is recorded with its exact reason.
4. **Act.** A mismatch produces a re-execution fraud proof and a challenge transaction while the
   challenge window is open.

The replay is tested against public data of a live testnet rollup: it reproduces the state roots
of the batches the chain finalized (`packages/core/test/golden.test.ts`).

## Getting started

Requirements: Node.js 22.13 or newer (24 recommended) and pnpm 10.

```sh
pnpm install
pnpm test          # unit and golden tests, offline
pnpm lint
pnpm typecheck

cd contracts && forge test   # contract tests (needs Foundry)
```

Configuration is read from the environment. Copy `.env.example` to `.env` and fill it in; the
file is ignored by git. Use a testnet-only wallet.

Two read-only checks run against the live testnet and need no key:

```sh
pnpm golden:refresh   # re-record the rollup data the golden test replays
pnpm live:probe       # run the receipt check against the chain's real precompiles, without deploying
```

## Live on testnet

Vigil runs its own rollup, `vigil-1`, on the QoreChain testnet (`qorechain-diana`): based
sequencing, `qledger-v1` execution, one-hour challenge window. Its batches are submitted by the
batcher in this repository and carry the creator's ML-DSA-87 anchor signature.

| What                   | Where                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| Rollup                 | `vigil-1` (layer `vigil-1`) on `qorechain-diana`                                          |
| Receipts contract      | `0xced683ad4319a34873e2c1aa90d18e2fcf1af1d1` on EVM chain 9800                            |
| First recorded receipt | batch 0, transaction `0xa4e7838ccc9e11bb03d7650a53579aa99e34f3c7a67177b322f6dfe0cc7b1855` |

```sh
ROLLUP_ID=vigil-1 pnpm watchtower --once   # re-execute and judge every batch yourself
pnpm live:probe vigil-1                    # check an anchor signature with the chain's precompiles
```

## Using the rollup

Set `QORE_MNEMONIC` (a funded testnet account) and `VIGIL_KEYSTORE_PASSPHRASE` in `.env`, then:

```sh
pnpm vigil keygen                      # create an encrypted L2 account (ML-DSA-44)
pnpm vigil deposit 5                   # base chain -> L2
pnpm vigil transfer <account-id> 1     # L2 -> L2
pnpm vigil withdraw 0.5                # L2 -> base chain
pnpm vigil balance
pnpm vigil claim                       # pay out withdrawals once their batch is final
```

The commands read the environment only (for example `pnpm exec tsx --env-file=.env ...`).
To operate a rollup of your own:

```sh
pnpm rollup:bootstrap            # dry run: simulates creation and the bond, sends nothing
pnpm rollup:bootstrap --execute  # creates the rollup named by ROLLUP_ID and bonds the submitter
pnpm batcher                     # submit batches as entries arrive
```

## Confidential memos

A transfer can carry a note that only its recipient can read.

```sh
pnpm vigil memo register                                  # publish your ML-KEM-1024 key (once)
pnpm vigil memo send <qor1...> <account-id> 0.25 "text"   # transfer plus a sealed memo
pnpm vigil memo inbox                                     # decrypt memos addressed to you
```

The memo is encrypted with ML-KEM-1024 to the key the recipient registered on the base chain,
posted through the rollup inbox, and bound to the hash of its transfer, so it cannot be attached
to another payment or replayed on another rollup. The ledger ignores memo payloads.

What stays public: who posted the memo, when, its size, and the transfer it points to, including
the amount. Only the text is hidden.

## Recording receipts on chain

```sh
pnpm receipts status      # deployer account, its key, EVM window, contract
pnpm receipts setup       # fund the deployer, register its ML-DSA-87 key, open a window
pnpm receipts deploy      # deploy VigilReceipts
pnpm receipts check 0     # verify batch 0's anchor through the contract, read-only
pnpm receipts record 0    # verify and record it
```

QoreChain's EVM side only accepts transactions from an account with a registered post-quantum
key and an open authorisation window, so `setup` does both. The deployer only pays gas; receipts
are signed by the rollup's creator and checked against the creator's registered key.

## Running the watchtower

The watchtower needs no key and no funds: it only reads the chain.

```sh
ROLLUP_ID=<rollup-id> pnpm watchtower --once   # judge everything once and exit
ROLLUP_ID=<rollup-id> pnpm watchtower          # keep watching; health check on :8081/healthz
```

State is kept in `VIGIL_DATA_DIR` (default `./data`), so a restart resumes where it stopped.
Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, or `ALERT_WEBHOOK_URL`, to receive alerts.

| Alert                                   | Severity | Raised when                                                           |
| --------------------------------------- | -------- | --------------------------------------------------------------------- |
| Invalid batch                           | Critical | Re-execution disagrees with a batch that can still be challenged      |
| Challenge window about to close         | Critical | An invalid batch is still unchallenged 15 minutes before its deadline |
| Invalid batch was finalized             | Critical | The window closed without a successful challenge                      |
| Rollup is not batching its inbox        | Warning  | Inbox entries have waited more than 600 blocks for a batch            |
| Invalid batch was rejected by the chain | Info     | A challenge succeeded                                                 |

Each condition is reported once, stored before delivery, and retried until delivered.

### Challenging fraud

`WATCHTOWER_CHALLENGE` decides what the watchtower does about an invalid batch: `off` (default)
only alerts, `dry-run` also builds the fraud proof and checks it locally, `on` submits the
challenge with the configured account. A proof is sent only after the same check the chain runs
has confirmed it locally.

`pnpm fraud:drill` rehearses this on a live network: a throwaway account bonds and submits a batch
with a wrong state root. It is a dry run unless `--execute` is given, because the drill bond is
slashed. Start the watchtower first: on the public testnet other challengers react within seconds.

## Verified settlement receipts

`VigilReceipts` turns a signed settlement anchor into a fact other contracts can rely on. It
rebuilds the signed bytes on chain, reads the signer's ML-DSA-87 key from QoreChain's key registry
(`pqcKeyStatus`), checks the signature with `pqcVerify`, and records the result. The caller never
supplies the public key, so only the registered key holder can produce a valid receipt.

Local EVMs do not implement QoreChain's precompiles, so the contract is tested two ways: unit and
fuzz tests against stand-in precompiles, and `pnpm live:probe`, which simulates the same
verification code on a live node with `eth_call`.

## Security

- Secrets are read from the environment only and are redacted from logs.
- Keys used with this project should be testnet-only.
- See [SECURITY.md](SECURITY.md) to report a problem.

## Credits

Vigil builds on open-source work, used under their licences:

- [`@qorechain/qoreseal`](https://github.com/qorechain/qoreseal): ML-KEM-1024 envelopes for memos.
- [`@qorechain/sdk`](https://github.com/qorechain/qorechain-sdk) and `@qorechain/evm`: EVM account,
  key registration and authorisation windows.
- [`@qorechain/rdk`](https://github.com/qorechain/qorechain-rdk) (Apache-2.0): chain client,
  `qledger-v1` execution, inbox hashing, receipt and envelope helpers.
- [forge-std](https://github.com/foundry-rs/forge-std) and [viem](https://github.com/wevm/viem).
- [pino](https://github.com/pinojs/pino), [zod](https://github.com/colinhacks/zod),
  [vitest](https://github.com/vitest-dev/vitest), [fast-check](https://github.com/dubzzz/fast-check),
  [TypeScript](https://www.typescriptlang.org/), [ESLint](https://eslint.org/) and
  [Prettier](https://prettier.io/).

Test fixtures under `packages/core/test/fixtures` are public data recorded from the QoreChain
testnet.

## Licence

[Apache-2.0](LICENSE)
