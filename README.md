<p align="center"><img src="brand/logo.svg" width="520" alt="Vigil Watchtower"></p>

<p align="center"><strong>The rollup that never looks away.</strong></p>

Vigil Watchtower (Vigil for short) is a post-quantum rollup stack for [QoreChain](https://qorechain.io): batches signed with
ML-DSA-87, verified settlement receipts, withdrawals, ML-KEM-protected memos, and a watchtower
that independently re-executes every batch and monitors the base chain underneath.

Built for _Build Before Q-Day: The QoreChain Developer Fest_, Protocol Builders category. Not to
be confused with the fest's `/p/vigil` page, which is a different team's project.

<!-- metrics:start -->

| Measured on the testnet (2026-11-25, `pnpm metrics`)   | Value                                                                               |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Final batches of `vigil-1`                             | 32, covering 47 inbox entries                                                       |
| Inbox entries, checked against the chain's accumulator | 47: 5 deposits, 29 transfers, 9 withdrawals, 2 sealed memos, 2 other posts          |
| Deposited / withdrawals paid out                       | 12 QOR / 8 paid, 2.85 QOR                                                           |
| Settlement anchors recorded in `VigilReceipts`         | 31 of 32 final batches (1 without an anchor from the chain)                         |
| Forged batches rejected by an upheld fraud proof       | 4: 1 by Vigil's watchtower (5 s after submission), 3 by other teams' bots (10–14 s) |
| Bonds slashed from cheaters / paid to Vigil            | 4000 QOR / 500 QOR                                                                  |

<!-- metrics:end -->

Every number above is recomputed from the testnet alone by `pnpm metrics` (no key, no `.env`, no
Vigil database). Watchtower uptime is not on chain, so it is not in the table; the Dashboard shows
the age of each service's last tick.

## What to check, and where

| Requirement                 | What Vigil does                                                                                                      | Evidence on the testnet                                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ML-DSA-signed batches       | Every batch of `vigil-1` carries the creator's ML-DSA-87 anchor signature; base-chain transactions are hybrid-signed | Batch 0: `B15BF4B9BACA1DE7ED0E290C8BD9D409AF11A8207D38FD5481066C047092E70E`                                                                                                                 |
| Withdrawal                  | Withdrawals are paid from the deposit pool with a Merkle proof once the batch is final                               | Claim of 0.5 QOR: `511A29444A436A13956E9A40D8199B40803EE79197C102A7FD6FBF7967833BE6`                                                                                                        |
| Verified settlement receipt | `VigilReceipts` verifies the anchor with `pqcKeyStatus` and `pqcVerify` and records it                               | Batch 0 receipt: `0xa4e7838ccc9e11bb03d7650a53579aa99e34f3c7a67177b322f6dfe0cc7b1855`                                                                                                       |
| Watchtower                  | Re-executes every batch from a verified inbox copy; challenges a wrong one with a re-execution fraud proof           | Forged batch 18: `E6993DBCAE77E735D138E03748A09321899525BAF24C464BEE360C2A9C02BDB4`; Vigil's upheld challenge 5 s later: `349C8DF05F888E2AEB8826101F49FD8960EB3662A47530B37C71307206822330` |
| ML-KEM data protection      | Private memos sealed with ML-KEM-1024 to the recipient's registered key, bound to the transfer                       | Memo: `1D39B55A28FDD65478B4769200156D5785449DA02B33C751D0A067E125BCA674`                                                                                                                    |
| Threat model                | Every claim tied to a test or a transaction, limits stated                                                           | [Threat model](docs/THREAT_MODEL.md)                                                                                                                                                        |

Every case, with its transactions, is on the web app's **Proof** page and in
[For judges](docs/JUDGES.md); `pnpm verify:proof` re-checks them all from a fresh clone.

> **Status:** every component below runs on the QoreChain testnet and has tests in this
> repository. Vigil is testnet software and has not been audited.

## Try it in 60 seconds, no key

On a fresh clone, with Node.js 22.13+ and pnpm 10, and no `.env`, Docker or account:

```sh
pnpm install --frozen-lockfile
pnpm verify:proof                          # every Proof transaction and receipt, with QoreChain's CLI (~10 s)
pnpm metrics                               # the numbers above, recomputed from the chain (~20 s)
ROLLUP_ID=vigil-1 pnpm watchtower --once   # re-execute and judge every batch of vigil-1 yourself (~20 s)
```

`verify:proof` runs `qore pq status` on each transaction of the app's Proof page (one ML-DSA-87
layer that verifies, or `classical` for the two EVM-lane ones) and `qore read-contract` on
`VigilReceipts` for every final batch. It exits non-zero on any mismatch. The watchtower run
fetches every inbox entry, checks it against the chain's hash accumulator, replays the ledger
and reports the four forged batches the chain rejected (state is written to `./data`).

## Start here

| If you want to                   | Read                                                                       |
| -------------------------------- | -------------------------------------------------------------------------- |
| Understand the idea              | [Concept](docs/CONCEPT.md)                                                 |
| Judge the entry                  | [For judges](docs/JUDGES.md)                                               |
| Use the web app and wallet       | [Using the web app](docs/USER_GUIDE.md)                                    |
| Use the command line             | [Command line](docs/CLI.md)                                                |
| Build on the API or the contract | [HTTP API](docs/API.md), [Receipts contract](docs/CONTRACT.md)             |
| Run it                           | [Configuration](docs/CONFIGURATION.md), [Runbook](docs/RUNBOOK.md)         |
| Know the limits                  | [Threat model](docs/THREAT_MODEL.md), [Architecture](docs/ARCHITECTURE.md) |

The same documents are built into the web app under **Docs**, and the **Learn** tab explains the
concept with an animated diagram.

## Videos

Three narrated videos are recorded from the live app with `scripts/video` (re-recorded 25 Nov
2026): the full demo with a real testnet transfer (2:47), an overview of the concept (1:28), and
how a forged batch is caught (1:05). The video files are not stored in the repository.

## Why

A rollup is only as trustworthy as the people checking it. On QoreChain an optimistic rollup
gives anyone one hour (on testnet) to prove a bad batch wrong, but the rollup kit ships no
watchtower that can judge a `qledger-v1` batch (as of 16 Nov 2026, when we started). Vigil
Watchtower fills that gap, and adds the pieces an operator needs around it.

## Components

| Component                 | What it does                                                                                                                  | Status  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------- |
| `packages/core`           | Resilient chain access, verified inbox archive, ledger replay and snapshots, storage                                          | Working |
| `packages/watchtower`     | Re-executes each batch, compares every commitment, raises alerts, and challenges fraud with a re-execution proof              | Working |
| `packages/batcher`        | Bonded submitter: plans a batch, re-checks it against its own archive, signs and submits it                                   | Working |
| `packages/wallet`         | `vigil` command line: encrypted L2 keys, deposit, transfer, withdraw, claim                                                   | Working |
| `contracts/VigilReceipts` | Verifies a settlement receipt's ML-DSA-87 signature on chain through the `pqcVerify` precompile                               | Working |
| `packages/receipts`       | Reads a batch's settlement anchor from the base chain and records it through the contract                                     | Working |
| `packages/memo`           | Confidential memos sealed with ML-KEM-1024 to the recipient's registered key and bound to an L2 transfer                      | Working |
| `packages/monitor`        | Base-chain monitor for testnet and mainnet: halts, block-time drift, upgrades, proposals, setting and feature-flag changes    | Working |
| `packages/api`            | Read-only JSON API and Prometheus metrics over the local database                                                             | Working |
| `packages/console`        | Operator console: the web app's wallet actions behind a password                                                              | Working |
| `packages/mcp`            | MCP server (`pnpm mcp`): QoreChain's 14 read-only tools plus four Vigil tools for rollup status, batches, accounts and audits | Working |
| `apps/web`                | Web app: overview, wallet, batch explorer, account lookup, base-chain monitor, alerts                                         | Working |

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

| What                    | Where                                                                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rollup                  | `vigil-1` (layer `vigil-1`) on `qorechain-diana`                                                                                                                                                           |
| Receipts contract       | `0xced683ad4319a34873e2c1aa90d18e2fcf1af1d1` on EVM chain 9800                                                                                                                                             |
| First recorded receipt  | batch 0, transaction `0xa4e7838ccc9e11bb03d7650a53579aa99e34f3c7a67177b322f6dfe0cc7b1855`                                                                                                                  |
| SettlementGate examples | v1 `0x8f05cd493adb455818ffe63e3eb09ecdd21c89af` (anchor only); v2 `0xcc03488ffa85db2b664a95a173f694616caf9ff3` (anchor and watchtower attestation), see [the example](examples/settlement-gate/README.md)  |
| Receipts deployer       | `qor1x2jpzzxspw9yl59uwgxyjtxnx8clehnwt2yt0c`: deploys and relays record calls; also the smart account                                                                                                      |
| Fraud-drill account     | `qor1hnfd8kf8kjegp8eyjm3shklydy443z7yw6fmuk`: bonded and posted the forged batches 1 and 18                                                                                                                |
| Operator                | `qor107qxkklc0znm38tl0595asa9z73c69w85tsztr`: creator of `vigil-1`; submits batches with the ML-DSA-87 anchor, sends challenges, claims withdrawals, posts memos; also signs the watchtower's attestations |

```sh
ROLLUP_ID=vigil-1 pnpm watchtower --once   # re-execute and judge every batch yourself
pnpm live:probe vigil-1                    # check an anchor signature with the chain's precompiles
```

Money that leaves the rollup can leave QoreChain too: `pnpm ibc-exit 0.5` sent 0.5 QOR withdrawn
from `vigil-1` over IBC (`channel-1`, ICS-20) to the operator's own address on Osmosis testnet, and
the relayer's acknowledgement came back 21 seconds later
(`471BDAC775B1A4A2766BCFF8CDC6B1970CF7D4C67865ED6B5471439871BC6CD5`). Another team's protocol,
Wicketgate, already uses `vigil-1`: it paid an instant exit against batch 28. Both are on the Proof
page, with the other cases in Learn, **Use cases**.

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

## The web app

```sh
pnpm api       # public, read-only site on port 8080
pnpm console   # the same site plus wallet actions, on 127.0.0.1:8090
```

| Page       | What it shows                                                                           | Needs sign-in      |
| ---------- | --------------------------------------------------------------------------------------- | ------------------ |
| Home       | What Vigil is, live headline numbers                                                    | No                 |
| Dashboard  | Verdict counts, latest batches, service health                                          | No                 |
| Proof      | Every testnet case with its transactions, each linked to the chain                      | No                 |
| Wallet     | Balance, send, deposit, withdraw, claim, private memos, activity                        | Yes (console only) |
| Batches    | Every batch with the watchtower's verdict; each batch's roots and decoded inbox entries | No                 |
| Accounts   | Balance and nonce of any rollup account, withdrawals by base-chain address              | No                 |
| Base chain | Block production and block time on testnet and mainnet, detected changes                | No                 |
| Rollups    | The read-only audit of every other `qledger-v1` rollup on the network                   | No                 |
| Alerts     | Everything the watchtower raised                                                        | No                 |
| Learn      | The concept with an animated diagram, before and after, use cases                       | No                 |
| Docs       | The documents of this repository                                                        | No                 |

The public API reads only the local database: it holds no key and makes no chain requests. It
accepts GET and HEAD only, limits requests per client and sets a strict content security policy.
The one outside address pages may reach is QoreChain's public EVM endpoint: **Verify on chain**
(on a batch and on Proof) has the browser itself ask `VigilReceipts` whether a receipt is recorded,
and **Change one digit** shows the contract refusing the same call with one digit of the state root
changed. It works in the static mirror too.

The console adds the wallet. It signs with the account in `.env`, so it is protected by
`VIGIL_CONSOLE_PASSWORD` (session cookie: HttpOnly, SameSite=Strict; failed sign-ins are locked
out). Requests that change anything must be JSON and carry a header a cross-site page cannot
send. It listens on `127.0.0.1` by default: reach it through SSH or a VPN, not the open internet.

## Base-chain monitor

```sh
pnpm monitor --once   # check both networks once (read-only, no key)
pnpm monitor          # keep checking every minute
```

The monitor reads the tip of each network, measures the average block time over the last 1,000
blocks, and fetches a fixed set of settings: the upgrade plan, proposals in voting, the circuit
breaker list, EVM settings and active precompiles, rollup, layer, post-quantum and staking
parameters, and the published node release. Each answer is stored in canonical form. When the
content changes, the monitor records what changed and raises an alert; a source that cannot be
read is shown as unavailable, never as changed.

## Confidential memos

A transfer can carry a note that only its recipient can read.

```sh
pnpm vigil memo register                                  # publish your ML-KEM-1024 key (once)
pnpm vigil memo send <qor1...> <account-id> 0.25 "text"   # transfer plus a sealed memo
pnpm vigil memo inbox                                     # decrypt memos addressed to you
```

The memo is encrypted with ML-KEM-1024 to the key the recipient registered on the base chain and
posted through the rollup inbox. It carries the hash of its transfer, authenticated with the
ciphertext, so it cannot be re-pointed at another payment or replayed on another rollup. The
ledger ignores memo payloads.

A memo is not proof of payment. Anyone can post a memo that points at any inbox entry. The
reader therefore marks the link as verified only when the entry is a correctly signed transfer
posted by the same account as the memo, and even then the transfer may not have executed: check
the balance.

What stays public: who posted the memo, when, its size, and the transfer it points to, including
the amount. Only the text is hidden.

## Recording receipts on chain

```sh
pnpm receipts status      # deployer account, its key, EVM window, contract
pnpm receipts setup       # fund the deployer, register its ML-DSA-87 key, open a window
pnpm receipts deploy      # deploy VigilReceipts
pnpm receipts check 0     # verify batch 0's anchor through the contract, read-only
pnpm receipts record 0    # verify and record it
pnpm receipts attest 0    # sign and record this watchtower's ML-DSA-87 attestation of batch 0
pnpm receipts smart-account link 14   # lock record calls to a hot key for 14 days
```

QoreChain's EVM side only accepts transactions from an account with a registered post-quantum
key and an open authorisation window, so `setup` does both. The deployer only pays gas; receipts
are signed by the rollup's creator and checked against the creator's registered key.

Record calls then go through a QoreChain smart account: a hot key that may call only
`recordAnchor` and `recordAttestation` on `VigilReceipts`, with no value, until it expires. When
that key is not ready, the service falls back to an EVM window that can reach only this contract.
See [docs/CONTRACT.md](docs/CONTRACT.md#how-vigil-sends-record-calls).

## Running the watchtower

The watchtower needs no key and no funds: it only reads the chain.

```sh
ROLLUP_ID=<rollup-id> pnpm watchtower --once   # judge everything once and exit
ROLLUP_ID=<rollup-id> pnpm watchtower          # keep watching; health check on :8081/healthz
```

State is kept in `VIGIL_DATA_DIR` (default `./data`), so a restart resumes where it stopped.
Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, or `ALERT_WEBHOOK_URL`, to receive alerts.
`--once` exits 3 while an invalid batch can still be challenged, so a scheduler sees it fail. A
key-less second watchtower runs this way every 15 minutes on GitHub Actions
(`.github/workflows/sentinel.yml`, see the [runbook](docs/RUNBOOK.md#sentinel-a-second-watchtower-on-github-actions)).

| Alert                                   | Severity | Raised when                                                           |
| --------------------------------------- | -------- | --------------------------------------------------------------------- |
| Invalid batch                           | Critical | Re-execution disagrees with a batch that can still be challenged      |
| Challenge window about to close         | Critical | An invalid batch is still unchallenged 15 minutes before its deadline |
| Invalid batch was finalized             | Critical | The window closed without a successful challenge                      |
| Rollup is not batching its inbox        | Warning  | Inbox entries have waited more than 600 blocks for a batch            |
| Invalid batch was rejected by the chain | Info     | A challenge succeeded                                                 |

Each condition is stored once, before delivery, and delivery is retried until every configured
destination accepts it (so a destination may see an alert twice after a partial failure). With
no destination configured, alerts are only stored and shown in the web app.

### Challenging fraud

`WATCHTOWER_CHALLENGE` decides what the watchtower does about an invalid batch: `off` (default)
only alerts, `dry-run` also builds the fraud proof and checks it locally, `on` submits the
challenge with the configured account. A proof is sent only after the same check the chain runs
has confirmed it locally.

A verdict belongs to a whole claim (index, both state roots, withdrawals root, data hash, inbox
range and submission height), so a replacement batch is always judged from scratch.

`pnpm fraud:drill` rehearses this on a live network: a throwaway account bonds and submits a batch
with a wrong state root. It is a dry run unless `--execute` is given, because the drill bond is
slashed. Start the watchtower first: on the public testnet other challengers react within seconds.

## Verified settlement receipts

`VigilReceipts` turns a signed settlement anchor into a fact other contracts can rely on. It
rebuilds the signed bytes on chain, reads the signer's ML-DSA-87 key from QoreChain's key registry
(`pqcKeyStatus`), checks the signature with `pqcVerify`, and records the result. The caller never
supplies the public key, so only the registered key holder can produce a valid receipt.

Local EVMs do not implement QoreChain's precompiles, so the contract is tested two ways: unit,
fuzz and invariant tests against stand-in precompiles, and `pnpm live:probe`, which simulates the
same verification code on a live node with `eth_call`.

The invariant tests drive the contract with random sequences of honest records, forgeries,
replays, other signers' receipts, unregistered signers and plain value transfers, and check after
every step that only correctly signed receipts are recorded, each once, that records never change,
that lookups agree with what was recorded, and that the contract holds no funds. The
`SettlementGate` example has the same kind of tests: money is conserved, the balance is the sum of
open escrows, nothing pays before its batch is recorded, and no escrow pays twice.

| `forge coverage` (25 Nov 2026)      | Lines         | Statements    | Branches      | Functions    |
| ----------------------------------- | ------------- | ------------- | ------------- | ------------ |
| `VigilReceipts` + `ReceiptVerifier` | 100% (63/63)  | 98.9% (92/93) | 90.9% (10/11) | 100% (13/13) |
| `SettlementGate` (example)          | 100% (40/40)  | 98.3% (57/58) | 92.3% (12/13) | 100% (7/7)   |
| `SettlementGateV2` (example)        | 97.8% (45/46) | 97.3% (73/75) | 85.7% (12/14) | 100% (7/7)   |

`LiveProbe.sol` is not in the first row: it is a diagnostic contract that `pnpm live:probe`
simulates against the live node, with no unit tests of its own.

## Deployment

```sh
docker compose --env-file .env -f deploy/compose.yaml up -d --build
```

One image, one process per container: watchtower, batcher, receipts, monitor and the API. They
run as a non-root user with a read-only file system and share a SQLite database on a volume. Only
the services that send transactions receive the seed phrase. Add `--profile console` for the
operator console, and `--profile public` with `VIGIL_DOMAIN` to put the public site behind Caddy
with automatic TLS.
See [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md): components, how a transaction settles, design decisions.
- [Threat model](docs/THREAT_MODEL.md): what is protected, against whom, and the limits, with a
  test or a testnet transaction for every claim.
- [Runbook](docs/RUNBOOK.md): deployment, alerts and incidents.
- [Receipts contract](docs/CONTRACT.md): what it verifies and how Vigil sends record calls.
- [MCP server](docs/MCP.md): read Vigil and QoreChain from an AI assistant.
- [Red-team replay](docs/REDTEAM.md): ten attacks on live data, each refused by a named check.
- [Crypto inventory](docs/CBOM.md): every algorithm in the contracts, the chain and its endpoints.
- [Demo walkthrough](docs/DEMO.md).
- [AI usage](AI_USAGE.md): how the project was built with an AI coding assistant, and what the
  team decided, approved and checked.

## Relying on recorded receipts

`VigilReceipts` records that the key registered for a given signer signed a given anchor at the
time of recording. If you consume it:

- Always check the signer. Anyone with a registered key can record an anchor they signed
  themselves; only the rollup creator's signature means settlement. Use
  `isAnchorRecorded(signer, receipt)` with the signer you trust, not the events alone.
- A record does not say which key signed, and it is never revoked: after a key rotation, older
  records still read as recorded.
- A signer can sign two different roots for the same height; both can be recorded. Query with the
  full receipt.

[`examples/settlement-gate`](examples/settlement-gate) is a contract that does exactly this: an
escrow that pays out only once a named batch's anchor by the rollup's creator is recorded. It was
scaffolded with `create-qorechain-dapp@0.14.0` (foundry template), is tested against a stand-in and
against the real `VigilReceipts` on a testnet fork, and is live at
`0x8f05cd493adb455818ffe63e3eb09ecdd21c89af`, where it released 0.1 QOR on batch 29.

## Security

- Secrets are read from the environment only and are redacted from logs.
- Keys used with this project should be testnet-only.
- See [SECURITY.md](SECURITY.md) to report a problem.

## Credits

Vigil builds on open-source work, used under their licences:

- [`@qorechain/qoreseal`](https://github.com/qorechain/qoreseal): ML-KEM-1024 envelopes for memos.
- [`@qorechain/sdk`](https://github.com/qorechain/qorechain-sdk) and `@qorechain/evm`: EVM account,
  key registration, authorisation windows and the smart-account (`x/abstractaccount`) messages.
- `@qorechain/qoresign`: inspection of each batch transaction's ML-DSA-87 layer, key lookups, and
  Sign In With QoreChain for the operator console.
- `@qorechain/pqc`: ML-DSA-87 verification of settlement anchors off chain, and attestation
  signing.
- `@qorechain/qore-cli`: `pnpm verify:proof` checks every public claim with QoreChain's own CLI.
- `create-qorechain-dapp` 0.14.0: the scaffold of `examples/settlement-gate` (foundry template).
- [QoreChain custody kit](https://github.com/qorechain/qorechain-custody-kit) v0.1.1 (Apache-2.0): `validateAddress`, vendored unmodified in `packages/core/src/vendor/custody-kit`, checks every base-chain address the API and the console accept.
- `@qorechain/qorescan`: the cryptographic bill of materials in `docs/cbom.json`, checked in CI.
- [`@qorechain/mcp`](https://github.com/qorechain/qorechain-mcp) and the
  [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk): the MCP server.
- [`@qorechain/rdk`](https://github.com/qorechain/qorechain-rdk) (Apache-2.0): chain client,
  `qledger-v1` execution, inbox hashing, receipt and envelope helpers.
- [forge-std](https://github.com/foundry-rs/forge-std) and [viem](https://github.com/wevm/viem).
- [CosmJS](https://github.com/cosmos/cosmjs) (`@cosmjs/stargate`, `@cosmjs/proto-signing`):
  the message registry and the chain connection the base-chain transactions of `packages/receipts`
  and the SettlementGate example go through.
- [pino](https://github.com/pinojs/pino), [zod](https://github.com/colinhacks/zod),
  [vitest](https://github.com/vitest-dev/vitest) with
  [`@vitest/coverage-v8`](https://github.com/vitest-dev/vitest/tree/main/packages/coverage-v8),
  [fast-check](https://github.com/dubzzz/fast-check), [tsx](https://github.com/privatenumber/tsx),
  [TypeScript](https://www.typescriptlang.org/), [ESLint](https://eslint.org/) with
  [typescript-eslint](https://typescript-eslint.io/), and [Prettier](https://prettier.io/).

Test fixtures under `packages/core/test/fixtures` are public data recorded from the QoreChain
testnet.

## Licence

[Apache-2.0](LICENSE)
