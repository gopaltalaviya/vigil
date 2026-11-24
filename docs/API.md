# HTTP API

The public server (`pnpm api`) and the operator console (`pnpm console`) serve the same read-only
routes. Only the console adds the session and wallet routes. Every answer is JSON unless noted.

The read-only routes read the local database only. They need no key and make no chain request.

## Read-only routes

### `GET /api/overview`

Everything the overview, batches, base-chain and alert pages show.

```json
{
  "generatedAt": 1794905536,
  "services": [{ "service": "watchtower", "lastSeen": 1794905530, "ageSecs": 6 }],
  "rollup": {
    "id": "vigil-1",
    "challengeWindowSecs": 3600,
    "chainId": "qorechain-diana",
    "receiptsContract": "0xced683ad4319a34873e2c1aa90d18e2fcf1af1d1",
    "inboxEntriesArchived": 14,
    "summary": { "batches": 8, "valid": 8, "invalid": 0, "finalized": 3, "receiptsRecorded": 3 },
    "batches": [
      {
        "index": 7,
        "status": "submitted",
        "stateRoot": "05658cbd…",
        "entries": { "from": 14, "to": 14 },
        "submittedTime": 1794905100,
        "verdict": "valid",
        "reasons": [],
        "receipt": null
      }
    ]
  },
  "alerts": [],
  "chain": [
    {
      "network": "testnet",
      "tip": {
        "height": 10247285,
        "tipTime": 1794905530,
        "measuredBlockTimeSecs": 1.427,
        "halted": false
      },
      "tipAvailable": true,
      "checkedAt": 1794905531,
      "sources": []
    }
  ],
  "chainEvents": []
}
```

`verdict` is `valid`, `invalid`, `undecidable` or `pending`. `status` is QoreChain's: `submitted`,
`challenged`, `finalized` or `rejected`. Batches are newest first.

### `GET /api/batches/{index}`

One batch with its full claim, the re-executed roots, earlier rejected claims at the same index, and
its inbox entries decoded.

| Field            | Meaning                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `batch`          | As in the overview, plus `prevStateRoot`, `withdrawalsRoot`, `dataHash`, `submittedAtHeight`, `finalizedAtHeight`, `expectedStateRoot`, `expectedWithdrawalsRoot`, `checkedAt` |
| `rejectedClaims` | Claims at this index the chain rejected                                                                                                                                        |
| `entries`        | `{ sequence, height, poster, kind, amount, from, to, recipient, signatureValid, bytes }`                                                                                       |

`kind` is `deposit`, `transfer`, `withdrawal`, `memo` or `data`. Amounts are uqor as decimal
strings (1 QOR = 1,000,000 uqor).

### `GET /api/accounts/{account-id}`

Balance and nonce of a rollup account after every archived entry.

```json
{ "accountId": "14e8c2f8…", "balance": "4730000", "nonce": "6", "asOfEntry": 14 }
```

### `GET /api/withdrawals/{address}`

Every withdrawal request in the archived inbox that pays a base-chain address, oldest first, in the
shape of `entries` above. The address may be given as `qor1…` or `0x…`; it is checked with the
QoreChain custody kit's `validateAddress`, and `recipient` is its `qor1` form. A bad address is
refused with `400` and the kit's error code (`BAD_CHECKSUM`, `WHITESPACE`, `WRONG_PREFIX`,
`KIND_NOT_ALLOWED`, …), never guessed.

```json
{
  "recipient": "qor1…",
  "withdrawals": [
    { "sequence": 10, "kind": "withdrawal", "amount": "300000", "signatureValid": true }
  ]
}
```

A withdrawal with an invalid signature is listed but is never paid. Whether a valid one has been
paid yet is shown in the operator's wallet.

### `GET /api/entries`

The 50 most recent inbox entries, newest first, in the same shape as `entries` above.

### `GET /api/session`

`{ "console": false, "signedIn": false }` on the public server.

### `GET /healthz`, `GET /metrics`

Health check, and Prometheus metrics (`vigil_batches`, `vigil_batches_finalized`,
`vigil_receipts_recorded`, `vigil_inbox_entries_archived`, `vigil_alerts_undelivered`,
`vigil_chain_height`, `vigil_chain_halted`, `vigil_chain_block_time_seconds`). The public proxy
does not expose `/metrics`.

### `GET /docs/{NAME}.md`

These documents, as `text/markdown`.

## Console routes

Every `POST` must send `content-type: application/json` and the header `x-vigil-request: 1`, which
a cross-site page cannot add. Requests without them are refused with 403 or 415.

| Route                       | Body                                                                                                  | Answer                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `POST /api/session`         | `{ "password": "…" }`                                                                                 | Sets an HttpOnly, SameSite=Strict session cookie; 401 on a wrong password, 429 after five failures |
| `POST /api/session/logout`  | `{}`                                                                                                  | Clears the session                                                                                 |
| `GET /api/wallet`           |                                                                                                       | Balances, account, withdrawals, memos, activity                                                    |
| `POST /api/wallet/account`  | `{}`                                                                                                  | Creates the rollup account                                                                         |
| `POST /api/wallet/deposit`  | `{ "amount": "1" }`                                                                                   | `{ "hash": "…" }`                                                                                  |
| `POST /api/wallet/transfer` | `{ "to": "<account-id>", "amount": "0.5", "memo": "optional", "memoRecipient": "qor1… (with memo)" }` | `{ "hash": "…", "memoHash": "…" or null }`                                                         |
| `POST /api/wallet/withdraw` | `{ "amount": "0.3", "recipient": "optional qor1…" }`                                                  | `{ "hash": "…" }`                                                                                  |
| `POST /api/wallet/claim`    | `{}`                                                                                                  | `{ "paid": [{ "amount", "hash" }], "failed": ["reason"] }`                                         |
| `POST /api/wallet/memo-key` | `{}`                                                                                                  | `{ "hash": "…" }`                                                                                  |

Amounts are QOR as decimal strings, up to six decimal places. Errors are
`{ "error": "reason" }` with status 400 for bad input, 401 without a session and 502 when QoreChain
refused the transaction.

## Limits

Each client may make 120 requests per minute (`429` beyond). Behind a reverse proxy on the same
host, set `TRUST_PROXY=1` so the limit applies per visitor. Request bodies are limited to 16 KiB.
