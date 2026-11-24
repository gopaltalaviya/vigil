# SettlementGate: pay only once a rollup batch has settled

An escrow on the QoreChain EVM that pays out only when a named rollup batch has settled: its
settlement anchor, signed with ML-DSA-87 by the rollup's creator, has been verified by the
`pqcVerify` precompile and recorded in [`VigilReceipts`](../../docs/CONTRACT.md). Until then the
money stays locked; after a deadline the payer may take it back.

It is an example of a contract that relies on Vigil's receipts. It asks one question,
`isAnchorRecorded(signer, receipt)`, and checks itself that the receipt is the one the escrow
names: same chain, same layer, same batch index, same signer.

| Call | What it does |
| --- | --- |
| `open(payee, signer, chainId, layerId, layerHeight, refundAfter)` | Locks `msg.value` for `payee` until that batch's anchor by `signer` is recorded |
| `isSettled(id, receipt)` | Whether `release` would pay with this receipt |
| `release(id, receipt)` | Pays the payee; anyone may call it, the money can only go to the payee |
| `refund(id)` | Returns the money to the payer after `refundAfter`, if it was never released |

Live on the testnet (24 Nov 2026): `SettlementGate` at
`0x8f05cd493adb455818ffe63e3eb09ecdd21c89af`, deployed in
`0xd1e0f1d15dd80ab5090388e76d3d67c55eee00d1f86dc34fbf16068464fb1202`. Escrow 0 locked 0.1 QOR on
batch 29 of `vigil-1` (`0xfbc44efd07656a3f52d51f7e48582306f9af804dab724a557b008fbccae2a249`);
`isSettled` was true with the batch's real anchor and false with a forged state root, and
`release` paid the payee 0.1 QOR
(`0xc80015952bc57f2d48e4cee4034ba2415485ee482d35980cae389463a2f7eb70`). From the repository root,
`pnpm settlement-gate deploy | open | status | release` runs the same steps with Vigil's deployer
account.

This folder was generated with QoreChain's scaffolder and then edited:

```sh
pnpm dlx create-qorechain-dapp@0.14.0 settlement-gate --template foundry --network testnet --yes --no-install
# the same with npm: npx create-qorechain-dapp@0.14.0 settlement-gate ...
```

| Network | EVM chain id | RPC (named in `foundry.toml`) |
| --- | --- | --- |
| Testnet (`qorechain-diana`) | 9800 | `qorechain_testnet` = `https://evm-testnet.qore.host` |
| Mainnet (`qorechain-vladi`) | 9801 | `qorechain` = `https://evm.qore.host` |

## Prerequisites

- Foundry (`forge`), installed with `foundryup`.
- Node.js 20 or later and a package manager, for the window helper.
- A funded account on the network you deploy to.

## Setup

```sh
pnpm install          # the window helper's dependencies
pnpm forge-std        # forge install foundry-rs/forge-std --no-git
cp .env.example .env  # the scaffolder already did this
```

Put the deployer's key in `.env` (`PRIVATE_KEY`). Never commit `.env`.

## Build and test

```sh
forge build
forge test
```

Tests run on Foundry's local EVM and need no network. The fork test runs the gate against the
real `VigilReceipts` and the recorded anchor of `vigil-1` batch 0, and needs the testnet RPC:

```sh
FORK=1 forge test --match-contract Fork
```

## Before you deploy: open an EVM window

QoreChain admits an EVM transaction only when the sender has:

1. a registered **ML-DSA-87** key, and
2. a live **EVM authorisation window**.

Both are set up on QoreChain's native lane with messages signed with the
post-quantum key, so the secp256k1 key in `PRIVATE_KEY` can never authorise
spending on its own. A deploy from an account without them is refused, so do
this first:

```sh
pnpm window status     # account, PQC key, window
pnpm window register   # once per account: registers its ML-DSA-87 key
pnpm window open       # opens a window: 600 blocks, 5 transactions
```

With `QORE_MNEMONIC` set, the helper derives the account and its ML-DSA-87 key
from the mnemonic. Otherwise it uses `PRIVATE_KEY` for the account and a PQC
recovery code, `QORE_PQC_RECOVERY_CODE`, for the ML-DSA-87 key; it stops with a
message if the code is missing. Create a code once and put it in `.env`:

```sh
pnpm window recovery-code   # prints a new QRC1 code (generatePqcRecoveryCode)
```

Keep a copy of the code apart from the private key and keep using the same
one: a different code gives the account a different ML-DSA-87 key. If the
account already has a key registered by another wallet, open the window from
that wallet instead. An account registered with this helper before SDK 0.13.0
has a different key registered; `pnpm window status` then shows
"registered, but NOT this key". Rotate it to the recovery-code key with
`rotatePqcKeyMsg` (MsgRotatePQCKey), loading the old key with
`unifiedAccountFromSeed(seed, { legacySeedDerivation: true })` (see the
`@qorechain/sdk` README).

What to know about the window:

- It bounds the number of blocks, the number of EVM transactions, and the total
  they may spend: value **plus** the maximum fee (gas limit x fee cap) of each
  transaction. Foundry sets the fee cap near twice the base fee (a dry run on
  the testnet priced a deploy at 200 gwei), so `pnpm window open` sizes the
  window for transactions of up to 3,000,000 gas at 250 gwei. Set
  `QORE_WINDOW_MAX_UQOR` to choose the total yourself.
- `blocks` is a block count, not a duration.
- Opening a window is a native-lane transaction, and it **advances the
  account's nonce**. Open the window first, then deploy; Foundry reads the
  nonce when it broadcasts.
- Opening replaces any earlier window.

## Deploy

```sh
pnpm window open
forge script script/SettlementGate.s.sol --rpc-url qorechain_testnet --broadcast
# or: pnpm deploy:testnet
```

The script reads `PRIVATE_KEY` and, optionally, `VIGIL_RECEIPTS_ADDRESS` from `.env`. A window
opened with `allowed_targets` (a scoped window) cannot create a contract: deploy with an
unscoped one.

Fees: on both networks today `eth_gasPrice` answers 112.5 gwei (a 100 gwei
base fee plus a 12.5 gwei priority fee). Foundry's defaults pick this up.

Contract verification: Sourcify does not list chain ids 9800 and 9801 yet.

## Project layout

```
src/SettlementGate.sol           the contract
test/SettlementGate.t.sol        Foundry tests against a stand-in VigilReceipts
test/SettlementGate.fork.t.sol   the same gate against the real VigilReceipts on a testnet fork
script/SettlementGate.s.sol      the deploy script
scripts/window.ts         the EVM window helper (pnpm window)
foundry.toml              compiler settings and the named RPC endpoints
```
