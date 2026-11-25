# Demo walkthrough

A script for showing Vigil Watchtower end to end on the QoreChain testnet in about three minutes. Run the
commands from the repository root with a funded account in `.env`. Replace `pnpm vigil` with
`pnpm exec tsx --env-file=.env packages/wallet/src/main.ts` if your shell does not load `.env`.

## Before you start

```sh
docker compose --env-file .env -f deploy/compose.yaml --profile console up -d
open http://127.0.0.1:8090    # the web app with the wallet (sign in with the console password)
open http://127.0.0.1:8080    # the public, read-only site
```

Every step below can be done in the web app's Wallet page or on the command line.

## 1. Use the rollup (about 40 seconds)

```sh
pnpm vigil status
pnpm vigil deposit 2
pnpm vigil transfer <account-id> 0.5
pnpm vigil withdraw 0.25
pnpm vigil balance
```

Point out: L2 transactions are signed with ML-DSA-44; the base-chain transactions that carry them
are hybrid-signed with ML-DSA-87.

## 2. A signed batch and its verdict (about 40 seconds)

Within a few seconds the batcher submits a batch. On the status page a new row appears:
"Valid" from the watchtower, "In challenge window" from the chain.

```sh
ROLLUP_ID=vigil-1 pnpm watchtower --once   # anyone can re-check it, without a key
```

## 3. The receipt on chain (about 30 seconds)

```sh
pnpm receipts check <batch>     # the contract verifies the ML-DSA-87 anchor signature
pnpm receipts record <batch>    # and records it
```

The status page shows "Recorded" for the batch.

## 4. A sealed memo (about 30 seconds)

```sh
pnpm vigil memo send <qor1...> <account-id> 0.1 "Invoice 42, thank you"
pnpm vigil memo inbox           # run by the recipient
```

Point out what is hidden (the text) and what is not (who, when, how much).

## 5. Catching fraud (about 40 seconds)

```sh
pnpm fraud:drill                # dry run: shows what would be sent
pnpm fraud:drill --execute      # a throwaway account submits a batch with a wrong state root
```

The watchtower marks the batch invalid, sends an alert and submits a fraud proof; the chain
rejects the batch and the batcher replaces it with the honest one. The drill bond is slashed, so
run it sparingly.

## 6. The withdrawal (after the one-hour challenge window)

```sh
pnpm vigil claim
```

For a recording, show a claim of a withdrawal made earlier.
