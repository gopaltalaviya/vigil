# Runbook

How to run Vigil on a server and what to do when something goes wrong.

## First deployment

Requirements: a Linux host with Docker and the Compose plugin, and a funded testnet account.

1. Copy the repository to the host and create `.env` from `.env.example`. Set at least
   `QORE_MNEMONIC`, `ROLLUP_ID`, `VIGIL_MODE` and, if deployed, `VIGIL_RECEIPTS_ADDRESS`.
   Protect the file: `chmod 600 .env`.
2. Start the services:
   ```sh
   docker compose -f deploy/compose.yaml up -d --build
   docker compose -f deploy/compose.yaml ps
   ```
   `api`, `batcher` and `watchtower` should report `healthy` within a minute.
3. To publish the status page with TLS, point a DNS name at the host, set `VIGIL_DOMAIN` in the
   shell or in `deploy/.env`, and add the public profile:
   ```sh
   VIGIL_DOMAIN=status.example.org docker compose -f deploy/compose.yaml --profile public up -d
   ```
   Without the profile the API listens on `127.0.0.1:8080` only.

## Services

| Service      | Needs the seed phrase               | Health check        | What it does when the chain is unreachable |
| ------------ | ----------------------------------- | ------------------- | ------------------------------------------ |
| `watchtower` | Only with `WATCHTOWER_CHALLENGE=on` | `:8081/healthz`     | Backs off, resumes                         |
| `batcher`    | Yes                                 | `:8082/healthz`     | Backs off, resumes                         |
| `receipts`   | Yes                                 | none (periodic job) | Skips the round                            |
| `monitor`    | No                                  | none                | Marks sources unavailable                  |
| `api`        | No                                  | `:8080/healthz`     | Keeps serving the last known state         |

## Routine operations

- **Logs:** `docker compose -f deploy/compose.yaml logs -f watchtower`. Logs are JSON, one event
  per line; secrets are redacted.
- **Metrics:** `curl http://127.0.0.1:8080/metrics` (Prometheus format). The public proxy does
  not expose this path.
- **Backup:** `deploy/backup.sh /path/to/backups` takes a consistent copy of the database while
  services run. Back up `.env` separately and securely.
- **Upgrade:** `git pull`, then `docker compose -f deploy/compose.yaml up -d --build`. Database
  migrations run automatically and only move forward.
- **Wallet commands on the host:** run them in a one-off container so they use the same data:
  ```sh
  docker compose -f deploy/compose.yaml run --rm watchtower packages/wallet/dist/main.js status
  ```

## Alerts and what to do

| Alert                                        | Meaning                                                       | Action                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invalid batch                                | Re-execution disagrees with a submitted batch                 | With `WATCHTOWER_CHALLENGE=on` the challenge is automatic; check the logs for `challenge outcomes`. Otherwise run the watchtower once with it on. |
| Challenge window about to close              | An invalid batch is still open 15 minutes before its deadline | Challenge now. Check the account has gas and the node is reachable.                                                                               |
| Invalid batch was finalized                  | Nobody challenged in time                                     | The state on chain is wrong. Stop using the rollup and escalate to the base-chain operators.                                                      |
| Rollup is not batching its inbox             | Entries have waited too long                                  | Check the batcher's health and bond (`vigil status`); restart it.                                                                                 |
| Chain is not producing blocks                | Base-chain halt                                               | Nothing to do; services resume by themselves. Challenge windows are measured in block time.                                                       |
| Block time differs from the documented value | Drift                                                         | Recompute any deadline expressed in blocks.                                                                                                       |
| A setting changed                            | Parameters, precompiles or disabled messages changed          | Read the diff in the alert and check whether the rollup is affected.                                                                              |

## Incidents

**The batcher's bond is too low or locked.** The batcher logs `waiting` with the chain's reason.
Top up with `pnpm rollup:bootstrap --execute`, which skips steps already done.

**A service restarts in a loop.** Read its log. A configuration error names the variable (never
its value). A database error after a downgrade means the database was written by a newer version:
restore the newer image.

**The database is lost.** Restore the latest backup, or start empty: the inbox archive, batches
and verdicts are rebuilt from the chain as long as the public node still serves the old blocks.
Alerts, the transaction log and receipt transaction hashes are not recoverable from the chain.

**The seed phrase may have leaked.** Treat the account as lost. Unbond, move remaining funds to a
new account, and create a new rollup: the creator of an existing rollup cannot be changed.

**The testnet was reset.** The rollup no longer exists. Archive the old database, set a new
`ROLLUP_ID` if needed, run `pnpm rollup:bootstrap --execute`, redeploy the contract with
`pnpm receipts deploy`, and update `VIGIL_RECEIPTS_ADDRESS`.

**The base chain is upgrading.** Expect a halt at the upgrade height. Services pause and resume.
Afterwards check the monitor's events for changed parameters or precompiles.
