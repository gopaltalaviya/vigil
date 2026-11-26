# Crypto inventory

[`docs/cbom.json`](cbom.json) is a cryptographic bill of materials (CycloneDX 1.6) of Vigil Watchtower
Watchtower, made with QoreChain's scanner, QoreScan (`@qorechain/qorescan` 0.1.0). It lists every
algorithm QoreScan finds in four places: the Solidity contracts, the testnet chain itself, the
receipts deployer account, and the TLS endpoints Vigil talks to.

```
pnpm cbom    # rescan and check; writes docs/cbom.json
```

QoreScan is an inventory aid, not a certification or an audit.

## What it found (24 Nov 2026, height 10,665,951)

24 components. By classification:

| Classification     | Algorithms                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| Post-quantum       | ML-DSA-87 (NIST category 5, FIPS 204)                                                           |
| Hybrid             | X25519MLKEM768 (TLS 1.3 key exchange on both endpoints)                                         |
| Quantum-vulnerable | ECDSA P-256, P-384, secp256k1, ECDSA with SHA-256 and SHA-384, Ed25519, RSA PKCS#1 v1.5 SHA-256 |
| Symmetric or hash  | AES-128-GCM, HKDF-SHA256, SHA-256, Keccak-256                                                   |

Where they come from:

- **Contracts.** ML-DSA-87 at the two precompile calls of `contracts/src/ReceiptVerifier.sol`:
  `pqcVerify` (`0x0A01`, line 34) and `pqcKeyStatus` (`0x0A02`, line 36). Keccak-256 for receipt
  ids. No quantum-vulnerable algorithm in the contracts' own sources.
- **Chain.** `qorechain-diana` with `hybrid-signature-mode = required`, `pqc-primary = true`,
  `allow-classical-fallback = false` and `min-security-level = 5`; the `pqcVerify` and
  `pqcKeyStatus` precompiles are active. 353 protocol features enabled, 33 of them PQC-related.
- **Account.** The receipts deployer `qor1x2jpzzxspw9yl59uwgxyjtxnx8clehnwt2yt0c` holds a hybrid
  key: secp256k1 plus ML-DSA-87 (`dilithium5`).
- **Endpoints.** `api-testnet.qore.host` and `evm-testnet.qore.host` negotiate TLS 1.3 with
  X25519MLKEM768. Their certificates are still ECDSA and RSA, and validators sign consensus votes
  with Ed25519: these are the chain's and the host's, not Vigil's, and are listed so the
  remaining classical parts are visible.

## What it cannot see

QoreScan reads Solidity, chain state and TLS, not TypeScript. Vigil's off-chain cryptography is
therefore not in the file:

- ML-DSA-87 signatures of settlement anchors and watchtower attestations, and their off-chain
  verification (`@qorechain/pqc`).
- The hybrid ML-DSA-87 layer on every native transaction Vigil sends (`@qorechain/rdk`, SDK), and
  its inspection with QoreSign.
- ML-DSA-44 signatures on L2 transactions.
- ML-KEM-1024 with X25519 for private memos (`@qorechain/qoreseal`).
- The secp256k1 hot key of the receipts smart account.

These are covered by the [threat model](THREAT_MODEL.md) and the unit tests.

## Checks

`scripts/check-cbom.mjs` fails when ML-DSA-87 is no longer found at both precompile calls in
`ReceiptVerifier.sol`, or when a quantum-vulnerable algorithm appears in `contracts/src`. CI runs
it on a fresh Solidity scan and on the committed `docs/cbom.json`. A rescan changes only the
timestamp, the serial number and the chain's live values, so the file is refreshed with
`pnpm cbom`, not compared byte for byte.
