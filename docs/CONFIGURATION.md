# Configuration

Every setting is an environment variable. Copy `.env.example` to `.env` and fill it in; the file is
ignored by git. A missing or malformed value stops the service at start-up with the variable's name,
never its value.

## Secrets

| Variable                                 | Read by                                                        | Meaning                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `QORE_MNEMONIC`                          | batcher, receipts, console, challenging watchtower, wallet CLI | Seed phrase of the operator's testnet account                                              |
| `QORE_PQC_SEED_HEX`                      | same                                                           | Optional 32-byte hex seed for the ML-DSA-87 key, if it is not derived from the seed phrase |
| `VIGIL_KEYSTORE_PASSPHRASE`              | console, wallet CLI                                            | Encrypts the rollup account keystore                                                       |
| `VIGIL_CONSOLE_PASSWORD`                 | console                                                        | Sign-in password, at least 12 characters                                                   |
| `QORE_DRILL_MNEMONIC`                    | fraud drill                                                    | A throwaway account whose bond is slashed on purpose; refused if it is the operator's own  |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | watchtower, monitor                                            | Alert delivery to Telegram                                                                 |
| `ALERT_WEBHOOK_URL`                      | watchtower, monitor                                            | Alert delivery as JSON to a webhook                                                        |

## Network

| Variable           | Default                         | Meaning                               |
| ------------------ | ------------------------------- | ------------------------------------- |
| `QORE_NETWORK`     | `testnet`                       | `testnet` or `mainnet`                |
| `QORE_CHAIN_ID`    | `qorechain-diana`               | Cosmos chain id                       |
| `QORE_RPC_URL`     | `https://rpc-testnet.qore.host` | Consensus RPC                         |
| `QORE_REST_URL`    | `https://api-testnet.qore.host` | REST API                              |
| `QORE_EVM_RPC_URL` | `https://evm-testnet.qore.host` | EVM JSON-RPC                          |
| `QORE_GAS_PRICE`   | `0.15uqor`                      | Gas price for base-chain transactions |

## Rollup

| Variable                 | Default  | Meaning                                                                        |
| ------------------------ | -------- | ------------------------------------------------------------------------------ |
| `ROLLUP_ID`              | required | The rollup to operate on, for example `vigil-1`                                |
| `VIGIL_MODE`             | `shared` | `own`: we created the rollup and sign anchors. `shared`: someone else's rollup |
| `VIGIL_RECEIPTS_ADDRESS` | empty    | Address of the deployed `VigilReceipts`                                        |
| `VIGIL_DATA_DIR`         | `./data` | Where the database and keystore live                                           |

## Services

| Variable                   | Default                                | Meaning                                                                                       |
| -------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `WATCHTOWER_INTERVAL_MS`   | `15000`                                | Time between watchtower rounds                                                                |
| `WATCHTOWER_HEALTH_PORT`   | `8081`                                 | Watchtower health check                                                                       |
| `WATCHTOWER_CHALLENGE`     | `off`                                  | `off` alerts only; `dry-run` also builds and checks the fraud proof; `on` sends the challenge |
| `BATCHER_INTERVAL_MS`      | `20000`                                | Time between batcher rounds                                                                   |
| `BATCHER_HEALTH_PORT`      | `8082`                                 | Batcher health check                                                                          |
| `MONITOR_INTERVAL_MS`      | `60000`                                | Time between base-chain checks                                                                |
| `RECEIPTS_INTERVAL_MS`     | `120000`                               | Time between receipt syncs                                                                    |
| `API_PORT`                 | `8080`                                 | Public server port                                                                            |
| `CONSOLE_PORT`             | `8090`                                 | Console port                                                                                  |
| `CONSOLE_HOST`             | `127.0.0.1`                            | Console listen address                                                                        |
| `CONSOLE_SECURE_COOKIE`    | unset                                  | `1` to mark the session cookie Secure (when served over HTTPS)                                |
| `TRUST_PROXY`              | `0`                                    | `1` when a reverse proxy on the same host fronts the server                                   |
| `LOG_LEVEL`                | `info`                                 | `fatal`, `error`, `warn`, `info`, `debug` or `trace`                                          |
| `HTTP_TIMEOUT_MS`          | `15000`                                | Timeout of each request to QoreChain                                                          |
| `HTTP_MAX_RETRIES`         | `4`                                    | Retries of a failed request                                                                   |
| `HTTP_REQUESTS_PER_MINUTE` | `300`                                  | Rate limit towards QoreChain endpoints                                                        |
| `WEB_APP_DIR`, `DOCS_DIR`  | the repository's `apps/web` and `docs` | Where the server finds the web app and these docs                                             |

## Docker

`deploy/compose.yaml` passes `.env` only to the services that sign: watchtower, batcher, receipts
and console. The monitor receives the network settings and alert destinations; the public API
receives no secret at all. Run from the repository root:

```sh
docker compose --env-file .env -f deploy/compose.yaml up -d --build
docker compose --env-file .env -f deploy/compose.yaml --profile console up -d
```
