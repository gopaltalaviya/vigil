# Receipts contract

`VigilReceipts` turns a batch's ML-DSA-87 settlement signature into a fact other contracts can rely
on. It is deployed on the QoreChain testnet's EVM (chain id 9800) at
`0xced683ad4319a34873e2c1aa90d18e2fcf1af1d1`.

Source: `contracts/src/VigilReceipts.sol` and `contracts/src/ReceiptVerifier.sol` (Solidity 0.8.28,
EVM version `paris`). No owner, no upgrade path, no funds held.

## How it verifies

1. It rebuilds the exact bytes QoreChain defines for a settlement anchor:
   `"qorechain-multilayer-anchor-v2"` followed by the length-prefixed chain id, layer id, layer
   height, state root, validator-set hash, transaction count and a final zero.
2. It reads the signer's public key from QoreChain's key registry with the `pqcKeyStatus`
   precompile (`0x…0a02`). The key must be registered, be ML-DSA-87, and have a proof of
   possession. **The caller never supplies a public key.**
3. It checks the signature with the `pqcVerify` precompile (`0x…0a01`).
4. It records the receipt once and emits an event.

On a chain where the precompiles are not active, a call to them returns nothing; the contract
detects that and reverts, rather than treating it as valid.

## Functions

| Function                                                                                                | Kind  | Purpose                                                                                           |
| ------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------- |
| `recordAnchor(address signer, AnchorReceipt receipt, bytes signature) returns (bytes32 id)`             | write | Verify and record a settlement anchor                                                             |
| `recordAttestation(address signer, BatchAttestation attestation, bytes signature) returns (bytes32 id)` | write | Verify and record a watchtower attestation (Vigil's own format, bound to this contract and chain) |
| `checkAnchor(address signer, AnchorReceipt receipt, bytes signature) returns (bool)`                    | view  | Verify without recording                                                                          |
| `checkAttestation(…) returns (bool)`                                                                    | view  | Verify without recording                                                                          |
| `isAnchorRecorded(address signer, AnchorReceipt receipt) returns (bool)`                                | view  | Whether this signer's anchor is recorded                                                          |
| `isAttestationRecorded(…) returns (bool)`                                                               | view  | Same for attestations                                                                             |
| `anchorMessage(AnchorReceipt) returns (bytes)`                                                          | view  | The exact bytes that are signed                                                                   |
| `receiptId(address signer, bytes message) returns (bytes32)`                                            | view  | Record identifier                                                                                 |
| `records(bytes32 id) returns (address signer, uint64 recordedAtBlock, Kind kind)`                       | view  | Stored record                                                                                     |

`AnchorReceipt` is `(string chainId, string layerId, uint64 layerHeight, bytes32 stateRoot,
bytes validatorSetHash, uint64 txCount)`.

## Errors

| Error                                  | Meaning                                                           |
| -------------------------------------- | ----------------------------------------------------------------- |
| `InvalidSignature()`                   | The signature does not verify against the signer's registered key |
| `AlreadyRecorded(bytes32 id)`          | This exact receipt from this signer is already recorded           |
| `SignerNotRegistered(address)`         | The signer has no key in the registry                             |
| `PossessionNotProven(address)`         | The signer never proved possession of its key                     |
| `UnsupportedAlgorithm(address, uint8)` | The key is not ML-DSA-87                                          |
| `InvalidSignatureLength(uint256)`      | Not a 4,627-byte ML-DSA-87 signature                              |
| `InvalidField()`                       | An id is empty or too long, or a hash has the wrong length        |
| `PrecompileUnavailable(address)`       | The precompile is not active or answered something malformed      |

## Relying on a receipt

- **Always check the signer.** Anyone with a registered key can record an anchor they signed
  themselves. Only the rollup creator's signature means settlement: call
  `isAnchorRecorded(creator, receipt)` with the creator you trust. Do not rely on events alone.
- **A record is a point-in-time fact.** It shows that the key registered for the signer at
  recording time signed the anchor. Records are never revoked, including after a key rotation.
- **Conflicting anchors can both be recorded.** Query with the full receipt, not just the height.
- **Front-running is harmless.** Someone who records your receipt first makes your transaction
  revert with `AlreadyRecorded`; the state is what you wanted. The Vigil client treats that as
  success.

## Tests

`contracts/test/VigilReceipts.t.sol`: 19 tests, including fuzz tests, against stand-in precompiles.
`pnpm live:probe` runs the same verification code against the testnet's real precompiles without
deploying.
