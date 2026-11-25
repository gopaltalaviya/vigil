// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {AnchorReceipt} from "./SettlementGate.sol";

/// @notice A watchtower's attestation of a batch, as `VigilReceipts` takes it.
struct BatchAttestation {
    string chainId;
    string rollupId;
    uint64 batchIndex;
    bytes32 stateRoot;
    bytes withdrawalsRoot;
    bytes32 dataHash;
}

/// @notice The two calls this contract needs from `VigilReceipts`.
interface IVigilReceiptsV2 {
    /// @notice True when `receipt`, signed with ML-DSA-87 by `signer`, was verified on chain and recorded.
    function isAnchorRecorded(address signer, AnchorReceipt calldata receipt) external view returns (bool);

    /// @notice True when `attestation`, signed with ML-DSA-87 by `signer`, was verified on chain and recorded.
    function isAttestationRecorded(address signer, BatchAttestation calldata attestation) external view returns (bool);
}

/// @title SettlementGateV2
/// @notice An escrow that pays out only once a named rollup batch has settled on QoreChain AND an
///         independent watchtower has re-executed it: the batch's settlement anchor (signed with
///         ML-DSA-87 by the rollup's creator) and the watchtower's attestation of the same batch (signed
///         with ML-DSA-87 by the watchtower's key) must both be verified and recorded in `VigilReceipts`.
///         Until then the money stays locked, and after the deadline the payer may take it back.
/// @dev Version 1 (`SettlementGate`) required the anchor alone. The gate trusts `VigilReceipts` for both
///      signature checks and checks itself that anchor and attestation name the escrow's chain, layer,
///      rollup and batch, and commit to the same state root. Anyone may call `release`; the money can only
///      go to the payee.
contract SettlementGateV2 {
    struct Escrow {
        address payer;
        address payee;
        address anchorSigner;
        address attester;
        uint64 batchIndex;
        uint64 refundAfter;
        bool closed;
        uint256 amount;
        bytes32 chainIdHash;
        bytes32 layerIdHash;
        bytes32 rollupIdHash;
    }

    /// @notice The receipts registry this gate relies on.
    IVigilReceiptsV2 public immutable receipts;

    /// @notice Escrows by id, from 0.
    mapping(uint256 id => Escrow) public escrows;

    /// @notice Number of escrows opened.
    uint256 public count;

    event Opened(
        uint256 indexed id,
        address indexed payer,
        address indexed payee,
        uint256 amount,
        address anchorSigner,
        address attester,
        string chainId,
        string layerId,
        string rollupId,
        uint64 batchIndex,
        uint64 refundAfter
    );
    event Released(uint256 indexed id, address indexed payee, uint256 amount, bytes32 stateRoot);
    event Refunded(uint256 indexed id, address indexed payer, uint256 amount);

    error ZeroAmount();
    error ZeroAddress();
    error NoSuchEscrow();
    error Closed();
    error WrongReceipt();
    error NotSettled();
    error NotAttested();
    error TooEarly();
    error NotPayer();
    error TransferFailed();

    constructor(IVigilReceiptsV2 receipts_) {
        if (address(receipts_) == address(0)) revert ZeroAddress();
        receipts = receipts_;
    }

    /// @notice Locks `msg.value` for `payee` until batch `batchIndex` is settled (anchor of `layerId` on
    ///         `chainId` by `anchorSigner`) and attested (attestation of `rollupId` by `attester`).
    ///         After `refundAfter` (unix seconds) the payer may take it back.
    function open(
        address payee,
        address anchorSigner,
        address attester,
        string calldata chainId,
        string calldata layerId,
        string calldata rollupId,
        uint64 batchIndex,
        uint64 refundAfter
    ) external payable returns (uint256 id) {
        if (msg.value == 0) revert ZeroAmount();
        if (payee == address(0) || anchorSigner == address(0) || attester == address(0)) revert ZeroAddress();
        id = count++;
        escrows[id] = Escrow({
            payer: msg.sender,
            payee: payee,
            anchorSigner: anchorSigner,
            attester: attester,
            batchIndex: batchIndex,
            refundAfter: refundAfter,
            closed: false,
            amount: msg.value,
            chainIdHash: keccak256(bytes(chainId)),
            layerIdHash: keccak256(bytes(layerId)),
            rollupIdHash: keccak256(bytes(rollupId))
        });
        emit Opened(
            id,
            msg.sender,
            payee,
            msg.value,
            anchorSigner,
            attester,
            chainId,
            layerId,
            rollupId,
            batchIndex,
            refundAfter
        );
    }

    /// @notice Whether `release` would pay with this anchor and attestation.
    function isReleasable(uint256 id, AnchorReceipt calldata receipt, BatchAttestation calldata attestation)
        external
        view
        returns (bool)
    {
        Escrow storage e = _escrow(id);
        if (e.closed || !_matches(e, receipt, attestation)) return false;
        return
            receipts.isAnchorRecorded(e.anchorSigner, receipt)
                && receipts.isAttestationRecorded(e.attester, attestation);
    }

    /// @notice Pays the payee once the named batch's anchor and the watchtower's attestation of it are both
    ///         recorded in `VigilReceipts`.
    function release(uint256 id, AnchorReceipt calldata receipt, BatchAttestation calldata attestation) external {
        Escrow storage e = _escrow(id);
        if (e.closed) revert Closed();
        if (!_matches(e, receipt, attestation)) revert WrongReceipt();
        if (!receipts.isAnchorRecorded(e.anchorSigner, receipt)) revert NotSettled();
        if (!receipts.isAttestationRecorded(e.attester, attestation)) revert NotAttested();
        e.closed = true;
        uint256 amount = e.amount;
        address payee = e.payee;
        emit Released(id, payee, amount, receipt.stateRoot);
        (bool ok,) = payee.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Returns the money to the payer after the deadline, if it was never released.
    function refund(uint256 id) external {
        Escrow storage e = _escrow(id);
        if (e.closed) revert Closed();
        if (msg.sender != e.payer) revert NotPayer();
        if (block.timestamp <= e.refundAfter) revert TooEarly();
        e.closed = true;
        uint256 amount = e.amount;
        emit Refunded(id, msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _escrow(uint256 id) private view returns (Escrow storage e) {
        if (id >= count) revert NoSuchEscrow();
        e = escrows[id];
    }

    function _matches(Escrow storage e, AnchorReceipt calldata receipt, BatchAttestation calldata attestation)
        private
        view
        returns (bool)
    {
        return receipt.layerHeight == e.batchIndex && attestation.batchIndex == e.batchIndex
            && attestation.stateRoot == receipt.stateRoot && keccak256(bytes(receipt.chainId)) == e.chainIdHash
            && keccak256(bytes(attestation.chainId)) == e.chainIdHash
            && keccak256(bytes(receipt.layerId)) == e.layerIdHash
            && keccak256(bytes(attestation.rollupId)) == e.rollupIdHash;
    }
}
