// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @notice A QoreChain settlement anchor, as `VigilReceipts` takes it.
struct AnchorReceipt {
    string chainId;
    string layerId;
    uint64 layerHeight;
    bytes32 stateRoot;
    bytes validatorSetHash;
    uint64 txCount;
}

/// @notice The one call this contract needs from `VigilReceipts`.
interface IVigilReceipts {
    /// @notice True when `receipt`, signed with ML-DSA-87 by `signer`, was verified on chain and recorded.
    function isAnchorRecorded(address signer, AnchorReceipt calldata receipt) external view returns (bool);
}

/// @title SettlementGate
/// @notice An escrow that pays out only once a named rollup batch has settled on QoreChain: the batch's
///         settlement anchor, signed with ML-DSA-87 by the rollup's creator, has been verified by the
///         `pqcVerify` precompile and recorded in `VigilReceipts`. Until then the money stays locked, and
///         after the deadline the payer may take it back.
/// @dev The gate trusts `VigilReceipts` for the signature check and checks itself that the receipt is the
///      one the escrow names: same chain, same layer, same batch, same signer. Anyone may call `release`;
///      the money can only go to the payee.
contract SettlementGate {
    struct Escrow {
        address payer;
        address payee;
        address signer;
        uint64 layerHeight;
        uint64 refundAfter;
        bool closed;
        uint256 amount;
        bytes32 chainIdHash;
        bytes32 layerIdHash;
    }

    /// @notice The receipts registry this gate relies on.
    IVigilReceipts public immutable receipts;

    /// @notice Escrows by id, from 0.
    mapping(uint256 id => Escrow) public escrows;

    /// @notice Number of escrows opened.
    uint256 public count;

    event Opened(
        uint256 indexed id,
        address indexed payer,
        address indexed payee,
        uint256 amount,
        address signer,
        string chainId,
        string layerId,
        uint64 layerHeight,
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
    error TooEarly();
    error NotPayer();
    error TransferFailed();

    constructor(IVigilReceipts receipts_) {
        if (address(receipts_) == address(0)) revert ZeroAddress();
        receipts = receipts_;
    }

    /// @notice Locks `msg.value` for `payee` until batch `layerHeight` of `layerId` on `chainId`, signed by
    ///         `signer`, is recorded. After `refundAfter` (unix seconds) the payer may take it back.
    function open(
        address payee,
        address signer,
        string calldata chainId,
        string calldata layerId,
        uint64 layerHeight,
        uint64 refundAfter
    ) external payable returns (uint256 id) {
        if (msg.value == 0) revert ZeroAmount();
        if (payee == address(0) || signer == address(0)) revert ZeroAddress();
        id = count++;
        escrows[id] = Escrow({
            payer: msg.sender,
            payee: payee,
            signer: signer,
            layerHeight: layerHeight,
            refundAfter: refundAfter,
            closed: false,
            amount: msg.value,
            chainIdHash: keccak256(bytes(chainId)),
            layerIdHash: keccak256(bytes(layerId))
        });
        emit Opened(id, msg.sender, payee, msg.value, signer, chainId, layerId, layerHeight, refundAfter);
    }

    /// @notice Whether `receipt` is the named batch's anchor and is recorded: `release` would pay.
    function isSettled(uint256 id, AnchorReceipt calldata receipt) public view returns (bool) {
        Escrow storage e = _escrow(id);
        if (!_matches(e, receipt)) return false;
        return receipts.isAnchorRecorded(e.signer, receipt);
    }

    /// @notice Pays the payee once `receipt`, the named batch's anchor, is recorded in `VigilReceipts`.
    function release(uint256 id, AnchorReceipt calldata receipt) external {
        Escrow storage e = _escrow(id);
        if (e.closed) revert Closed();
        if (!_matches(e, receipt)) revert WrongReceipt();
        if (!receipts.isAnchorRecorded(e.signer, receipt)) revert NotSettled();
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

    function _matches(Escrow storage e, AnchorReceipt calldata receipt) private view returns (bool) {
        return receipt.layerHeight == e.layerHeight && keccak256(bytes(receipt.chainId)) == e.chainIdHash
            && keccak256(bytes(receipt.layerId)) == e.layerIdHash;
    }
}
