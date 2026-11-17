// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @notice A base-chain settlement anchor for one rollup batch, as signed by the rollup creator.
/// @dev Field order and encoding follow QoreChain's `qorechain-multilayer-anchor-v2` sign bytes.
struct AnchorReceipt {
    string chainId;
    string layerId;
    uint64 layerHeight;
    bytes32 stateRoot;
    bytes validatorSetHash;
    uint64 txCount;
}

/// @notice A watchtower's statement that it re-executed a batch and found it correct.
/// @dev Used where no base-chain anchor exists for the batch. It is Vigil's own format and is
///      never presented as a base-chain anchor.
struct BatchAttestation {
    string chainId;
    string rollupId;
    uint64 batchIndex;
    bytes32 stateRoot;
    bytes withdrawalsRoot;
    bytes32 dataHash;
}

/// @title ReceiptVerifier
/// @notice Rebuilds signed messages on chain and checks their ML-DSA-87 signatures against the
///         signer's key in QoreChain's post-quantum key registry.
/// @dev The signer's public key is never taken from the caller: it is read from the
///      `pqcKeyStatus` precompile, so a receipt can only be signed by the registered key holder.
abstract contract ReceiptVerifier {
    /// @notice `pqcVerify(bytes pubkey, bytes signature, bytes message) returns (bool)`.
    address internal constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    /// @notice `pqcKeyStatus(address) returns (bool registered, uint8 algorithmId, bytes pubkey, bool possessionProven)`.
    address internal constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;

    bytes4 internal constant PQC_VERIFY_SELECTOR = 0xf52bde0a;
    bytes4 internal constant PQC_KEY_STATUS_SELECTOR = 0x850dfe51;

    /// @notice Registry identifier of ML-DSA-87.
    uint8 public constant ALGORITHM_ML_DSA_87 = 1;
    /// @notice Exact byte length of an ML-DSA-87 signature (FIPS 204).
    uint256 public constant ML_DSA_87_SIGNATURE_LENGTH = 4627;
    /// @notice Exact byte length of an ML-DSA-87 public key (FIPS 204).
    uint256 public constant ML_DSA_87_PUBLIC_KEY_LENGTH = 2592;

    uint256 internal constant MAX_ID_LENGTH = 128;
    uint256 internal constant MAX_HASH_LENGTH = 64;

    bytes internal constant ANCHOR_DOMAIN = "qorechain-multilayer-anchor-v2";
    bytes internal constant ATTESTATION_DOMAIN = "vigil-batch-attestation-v1";

    /// @notice The precompile at `precompile` is not active on this chain or returned malformed data.
    error PrecompileUnavailable(address precompile);
    /// @notice `signer` has no key in the post-quantum key registry.
    error SignerNotRegistered(address signer);
    /// @notice `signer` registered a key but never proved possession of it.
    error PossessionNotProven(address signer);
    /// @notice `signer`'s registered key is not an ML-DSA-87 key.
    error UnsupportedAlgorithm(address signer, uint8 algorithmId);
    /// @notice The signature does not have the length of an ML-DSA-87 signature.
    error InvalidSignatureLength(uint256 length);
    /// @notice A string or hash field is empty where required, or longer than allowed.
    error InvalidField();

    /// @notice The exact bytes a rollup creator signs for a settlement anchor.
    function anchorMessage(AnchorReceipt memory r) public pure returns (bytes memory) {
        uint256 chainIdLength = bytes(r.chainId).length;
        uint256 layerIdLength = bytes(r.layerId).length;
        if (
            chainIdLength == 0 || chainIdLength > MAX_ID_LENGTH || layerIdLength == 0 || layerIdLength > MAX_ID_LENGTH
                || r.validatorSetHash.length > MAX_HASH_LENGTH
        ) revert InvalidField();

        bytes memory head =
            abi.encodePacked(ANCHOR_DOMAIN, _toUint64(chainIdLength), r.chainId, _toUint64(layerIdLength), r.layerId);
        bytes memory tail = abi.encodePacked(
            r.layerHeight,
            uint64(32),
            r.stateRoot,
            _toUint64(r.validatorSetHash.length),
            r.validatorSetHash,
            r.txCount,
            uint64(0)
        );
        return bytes.concat(head, tail);
    }

    /// @notice The exact bytes a watchtower signs for a batch attestation.
    /// @dev Bound to this chain's EVM chain id and to this contract's address, so an attestation
    ///      cannot be replayed on another chain or against another deployment.
    function attestationMessage(BatchAttestation memory a) public view returns (bytes memory) {
        uint256 chainIdLength = bytes(a.chainId).length;
        uint256 rollupIdLength = bytes(a.rollupId).length;
        uint256 withdrawalsRootLength = a.withdrawalsRoot.length;
        if (
            chainIdLength == 0 || chainIdLength > MAX_ID_LENGTH || rollupIdLength == 0 || rollupIdLength > MAX_ID_LENGTH
                || (withdrawalsRootLength != 0 && withdrawalsRootLength != 32)
        ) revert InvalidField();

        bytes memory head = abi.encodePacked(
            ATTESTATION_DOMAIN,
            _toUint64(block.chainid),
            address(this),
            _toUint64(chainIdLength),
            a.chainId,
            _toUint64(rollupIdLength),
            a.rollupId
        );
        bytes memory tail = abi.encodePacked(
            a.batchIndex, a.stateRoot, _toUint64(withdrawalsRootLength), a.withdrawalsRoot, a.dataHash
        );
        return bytes.concat(head, tail);
    }

    /// @notice Reads `signer`'s ML-DSA-87 public key from the key registry.
    /// @dev Reverts unless the key is registered, is ML-DSA-87 and has a proof of possession.
    function _registeredKey(address signer) internal view returns (bytes memory publicKey) {
        (bool ok, bytes memory out) = PQC_KEY_STATUS.staticcall(abi.encodeWithSelector(PQC_KEY_STATUS_SELECTOR, signer));
        // A chain without the precompile answers a call to that address with success and no data.
        if (!ok || out.length < 160) revert PrecompileUnavailable(PQC_KEY_STATUS);

        bool registered;
        uint8 algorithmId;
        bool possessionProven;
        (registered, algorithmId, publicKey, possessionProven) = abi.decode(out, (bool, uint8, bytes, bool));

        if (!registered) revert SignerNotRegistered(signer);
        if (algorithmId != ALGORITHM_ML_DSA_87 || publicKey.length != ML_DSA_87_PUBLIC_KEY_LENGTH) {
            revert UnsupportedAlgorithm(signer, algorithmId);
        }
        if (!possessionProven) revert PossessionNotProven(signer);
    }

    /// @notice Whether `signature` is `signer`'s ML-DSA-87 signature over `message`.
    function _isSignedBy(address signer, bytes memory message, bytes memory signature) internal view returns (bool) {
        if (signature.length != ML_DSA_87_SIGNATURE_LENGTH) revert InvalidSignatureLength(signature.length);
        bytes memory publicKey = _registeredKey(signer);

        (bool ok, bytes memory out) =
            PQC_VERIFY.staticcall(abi.encodeWithSelector(PQC_VERIFY_SELECTOR, publicKey, signature, message));
        if (!ok || out.length != 32) revert PrecompileUnavailable(PQC_VERIFY);
        return abi.decode(out, (bool));
    }

    /// @dev Checked narrowing: reverts instead of truncating.
    function _toUint64(uint256 value) internal pure returns (uint64) {
        if (value > type(uint64).max) revert InvalidField();
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(value);
    }
}
