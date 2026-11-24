# Red-team replay

`pnpm redteam` runs ten attacks against Vigil with live testnet data. Each attack must be refused
by a named check, and each has a control: the same check, given the honest input, must accept
it. Nothing is broadcast. EVM attacks are `eth_call`s against the deployed `VigilReceipts`; the
double withdrawal is a node simulation.

```
pnpm redteam          # no key needed; the double withdrawal is skipped
pnpm redteam:full     # with .env: also simulates the double withdrawal
pnpm redteam --json
```

The script exits 1 if an attack is accepted or a control is refused. The rollup is first rebuilt
from the chain: every inbox entry is fetched and checked against the chain's hash accumulator.

## Results (24 Nov 2026, `pnpm redteam:full`)

| Attack                                                   | Refused by                                                    | Attack result                 | Control                      |
| -------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------- | ---------------------------- |
| Forged state root (batch 29, one bit changed)            | Watchtower re-execution, `verifyBatch`                        | invalid: `state_root`         | valid                        |
| Forged withdrawals root only (batch 0)                   | Watchtower re-execution, `verifyBatch`                        | invalid: `withdrawals_root`   | valid                        |
| L2 transaction with a changed ML-DSA-44 signature byte   | `verifyQledgerTx`; the ledger skips the entry                 | signature invalid             | signature valid              |
| Replay batch 0's recorded receipt (`recordAnchor` again) | `VigilReceipts`: one record per signer and message            | `AlreadyRecorded`             | `checkAnchor` valid          |
| Batch 0's anchor claimed for another registered signer   | `VigilReceipts`: `pqcVerify` against that signer's key        | signature invalid             | valid for the rollup creator |
| Anchor for a signer with no registered ML-DSA-87 key     | `VigilReceipts`: `pqcKeyStatus`                               | `SignerNotRegistered`         | registered and valid         |
| Batch 0's submission with one body byte changed          | QoreSign: ML-DSA-87 layer against the registered key          | `PQ_SIGNATURE_INVALID`        | valid (sign bytes `v2`)      |
| Sealed memo with one ciphertext byte changed             | QoreSeal: ML-KEM-1024 envelope, authenticated decryption      | refused                       | opened                       |
| Sealed memo moved to another transfer                    | QoreSeal: the transfer hash is the envelope's associated data | refused                       | opened on its own transfer   |
| Claim batch 0 withdrawal #0 again (paid in `511A2944…`)  | QoreChain RDK: each withdrawal index pays once                | `withdrawal already executed` | proof rebuilt from the batch |

The forged withdrawals root is the class of fraud that paid out 13 QOR on another team's rollup
(`wicketgate-pay` batch 12) with nobody challenging it; Vigil's audit of other rollups reports
that batch as proven fraud.

## Limits

- The memo attacks use a throwaway recipient (BIP-39's public test mnemonic), because opening a
  real memo needs the real recipient's key.
- The forged batches are judged by Vigil's own checker, not submitted: the chain accepts every
  optimistic batch, and what stops one is a challenge. The live counterpart is the fraud drill on
  the Proof page, where Vigil's watchtower challenged forged batch 18 five seconds after it landed.
- The double withdrawal is a simulation signed by Vigil's account; any account gets the same
  answer, but the node only simulates a signed transaction.
