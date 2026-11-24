# MCP server

`vigil-mcp` lets an AI assistant read Vigil Watchtower and QoreChain through the Model Context
Protocol. It is built on QoreChain's MCP kit (`@qorechain/mcp` 0.1.1): every tool of the kit is
included, and four Vigil tools are added beside them.

Every tool only reads. The server holds no key, signs nothing and sends no transaction.

## Tools

| Tool                  | Answers                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `vigil_rollup_status` | The rollup and its watchtower: batches, verdicts, challenges, receipts, last tick, alerts  |
| `vigil_get_batch`     | One batch: roots, the watchtower's verdict, the PQ check of its transaction, its receipt   |
| `vigil_get_account`   | One L2 account by its 32-byte hex id: balance and history                                  |
| `vigil_rollup_audits` | Vigil's read-only re-execution of the other rollups on the network, and any fraud it found |

From the QoreChain kit: `get_chain_info`, `get_block`, `get_transaction`, `get_address_info`,
`get_pq_status`, `get_validators`, `get_staking_tiers`, `search`, `read_contract`, `estimate_fee`,
`simulate_tx`, `prepare_transfer`, `get_token_holders` and `request_faucet`.

`get_pq_status` with a Vigil transaction hash as `target` shows that it carries an ML-DSA-87
signature and that the signature verifies. `read_contract` can query `VigilReceipts` directly.

## Running it

The Vigil tools read from a Vigil API, by default the local one at `http://127.0.0.1:8080`. The
QoreChain tools read the public testnet endpoints.

```
pnpm install
pnpm --filter @vigil/mcp build
VIGIL_API_URL=http://127.0.0.1:8080 node packages/mcp/dist/main.js
```

The server talks over stdio. For an MCP client, add it to the client's `mcpServers` setting:

```json
{
  "mcpServers": {
    "vigil": {
      "command": "node",
      "args": ["/path/to/vigil/packages/mcp/dist/main.js"],
      "env": { "VIGIL_API_URL": "http://127.0.0.1:8080" }
    }
  }
}
```

Or, from a clone, `pnpm mcp` runs the same server from source.

## Checked against the testnet

Run over stdio against a live Vigil API on 24 Nov 2026, with a real MCP client:

- The client lists 18 tools: the kit's 14 and the 4 Vigil tools.
- `vigil_rollup_status` returns `vigil-1` with 34 batch claims and its receipts contract.
- `vigil_get_batch` with `index: 18` returns the honest batch 18, verdict `valid`, its receipt and
  a `verified` PQ check of its transaction.
- `vigil_rollup_audits` returns 12 rollups; `wicketgate-pay` is `fraud_found`, batch 12, reason
  `withdrawals_root`, proven.
- `get_pq_status` with `target` set to the forged batch 18 transaction `E6993DBC…02BDB4` returns
  tier `pqc`, one ML-DSA-87 layer, sign bytes `v2`, verified.

## Errors

A Vigil API that does not answer, answers with an error, or answers without JSON becomes a tool
error with a short message; the client sees `isError: true` and nothing is retried. Input is
checked before any request: a batch index is a non-negative integer, an account id is 64 hex
digits.

## Tests

`packages/mcp/test/server.test.ts` connects a real MCP client to the server in memory and checks
the tool list, the answers, and every error path, with the API replaced by a stub.
