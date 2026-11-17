// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {AnchorReceipt, BatchAttestation, ReceiptVerifier} from "./ReceiptVerifier.sol";

/// @title VigilReceipts
/// @notice On-chain record of verified rollup settlement receipts.
/// @dev Anyone may submit a receipt. It is recorded only if its ML-DSA-87 signature verifies
///      against the key the named signer registered on QoreChain. The contract has no owner,
///      no upgrade path and holds no funds. Consumers decide which signer they trust for a
///      given rollup (for an anchor, the rollup's creator) and look the record up by id.
contract VigilReceipts is ReceiptVerifier {
    /// @notice What kind of signed statement a record holds.
    enum Kind {
        None,
        Anchor,
        Attestation
    }

    /// @notice A verified receipt.
    struct Record {
        address signer;
        uint64 recordedAtBlock;
        Kind kind;
    }

    /// @notice Verified receipts by id. See `receiptId`.
    mapping(bytes32 id => Record) public records;

    /// @notice A settlement anchor signed by `signer` was verified and recorded.
    event AnchorRecorded(
        bytes32 indexed id,
        address indexed signer,
        bytes32 indexed stateRoot,
        string layerId,
        uint64 layerHeight,
        uint64 txCount
    );

    /// @notice A watchtower attestation signed by `signer` was verified and recorded.
    event AttestationRecorded(
        bytes32 indexed id, address indexed signer, bytes32 indexed stateRoot, string rollupId, uint64 batchIndex
    );

    /// @notice The signature does not verify against the signer's registered key.
    error InvalidSignature();
    /// @notice This exact receipt from this signer is already recorded.
    error AlreadyRecorded(bytes32 id);

    /// @notice Verifies and records a settlement anchor.
    /// @param signer Account whose registered ML-DSA-87 key signed the anchor.
    /// @param receipt The anchor's fields.
    /// @param signature ML-DSA-87 signature over `anchorMessage(receipt)`.
    /// @return id Identifier under which the record is stored.
    function recordAnchor(address signer, AnchorReceipt calldata receipt, bytes calldata signature)
        external
        returns (bytes32 id)
    {
        bytes memory message = anchorMessage(receipt);
        id = _record(signer, message, signature, Kind.Anchor);
        emit AnchorRecorded(id, signer, receipt.stateRoot, receipt.layerId, receipt.layerHeight, receipt.txCount);
    }

    /// @notice Verifies and records a watchtower attestation.
    /// @param signer Account whose registered ML-DSA-87 key signed the attestation.
    /// @param attestation The attestation's fields.
    /// @param signature ML-DSA-87 signature over `attestationMessage(attestation)`.
    /// @return id Identifier under which the record is stored.
    function recordAttestation(address signer, BatchAttestation calldata attestation, bytes calldata signature)
        external
        returns (bytes32 id)
    {
        bytes memory message = attestationMessage(attestation);
        id = _record(signer, message, signature, Kind.Attestation);
        emit AttestationRecorded(id, signer, attestation.stateRoot, attestation.rollupId, attestation.batchIndex);
    }

    /// @notice Checks an anchor's signature without recording anything.
    function checkAnchor(address signer, AnchorReceipt calldata receipt, bytes calldata signature)
        external
        view
        returns (bool)
    {
        return _isSignedBy(signer, anchorMessage(receipt), signature);
    }

    /// @notice Checks an attestation's signature without recording anything.
    function checkAttestation(address signer, BatchAttestation calldata attestation, bytes calldata signature)
        external
        view
        returns (bool)
    {
        return _isSignedBy(signer, attestationMessage(attestation), signature);
    }

    /// @notice Identifier of the record for `signer` signing `message`.
    function receiptId(address signer, bytes memory message) public pure returns (bytes32) {
        return keccak256(abi.encode(signer, keccak256(message)));
    }

    /// @notice Whether `signer`'s anchor with these fields has been verified and recorded.
    function isAnchorRecorded(address signer, AnchorReceipt calldata receipt) external view returns (bool) {
        return records[receiptId(signer, anchorMessage(receipt))].kind == Kind.Anchor;
    }

    /// @notice Whether `signer`'s attestation with these fields has been verified and recorded.
    function isAttestationRecorded(address signer, BatchAttestation calldata attestation) external view returns (bool) {
        return records[receiptId(signer, attestationMessage(attestation))].kind == Kind.Attestation;
    }

    function _record(address signer, bytes memory message, bytes calldata signature, Kind kind)
        private
        returns (bytes32 id)
    {
        id = receiptId(signer, message);
        if (records[id].kind != Kind.None) revert AlreadyRecorded(id);
        if (!_isSignedBy(signer, message, signature)) revert InvalidSignature();
        records[id] = Record({signer: signer, recordedAtBlock: _toUint64(block.number), kind: kind});
    }
}
