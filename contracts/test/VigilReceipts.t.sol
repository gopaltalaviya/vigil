// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AnchorReceipt, BatchAttestation, ReceiptVerifier} from "../src/ReceiptVerifier.sol";
import {VigilReceipts} from "../src/VigilReceipts.sol";

/// @dev Stand-in for the `pqcKeyStatus` precompile.
contract MockKeyStatus {
    struct Status {
        bool registered;
        uint8 algorithmId;
        bytes publicKey;
        bool possessionProven;
    }

    mapping(address => Status) internal statuses;

    function set(address account, bool registered, uint8 algorithmId, bytes calldata publicKey, bool possessionProven)
        external
    {
        statuses[account] = Status(registered, algorithmId, publicKey, possessionProven);
    }

    function pqcKeyStatus(address account) external view returns (bool, uint8, bytes memory, bool) {
        Status storage s = statuses[account];
        return (s.registered, s.algorithmId, s.publicKey, s.possessionProven);
    }
}

/// @dev Stand-in for the `pqcVerify` precompile: accepts exactly the triples it was told about.
contract MockVerify {
    mapping(bytes32 => bool) internal accepted;

    function accept(bytes calldata publicKey, bytes calldata signature, bytes calldata message) external {
        accepted[keccak256(abi.encode(publicKey, signature, message))] = true;
    }

    function pqcVerify(bytes calldata publicKey, bytes calldata signature, bytes calldata message)
        external
        view
        returns (bool)
    {
        return accepted[keccak256(abi.encode(publicKey, signature, message))];
    }
}

contract VigilReceiptsTest is Test {
    address internal constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address internal constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;

    VigilReceipts internal receipts;
    MockKeyStatus internal keyStatus;
    MockVerify internal verify;

    address internal signer = address(0xA11CE);
    bytes internal publicKey;
    bytes internal signature;

    event AnchorRecorded(
        bytes32 indexed id,
        address indexed signer,
        bytes32 indexed stateRoot,
        string layerId,
        uint64 layerHeight,
        uint64 txCount
    );
    event AttestationRecorded(
        bytes32 indexed id, address indexed signer, bytes32 indexed stateRoot, string rollupId, uint64 batchIndex
    );

    function setUp() public {
        receipts = new VigilReceipts();
        vm.etch(PQC_KEY_STATUS, address(new MockKeyStatus()).code);
        vm.etch(PQC_VERIFY, address(new MockVerify()).code);
        keyStatus = MockKeyStatus(PQC_KEY_STATUS);
        verify = MockVerify(PQC_VERIFY);

        publicKey = _bytes(2592, 0x11);
        signature = _bytes(4627, 0x22);
        keyStatus.set(signer, true, 1, publicKey, true);
    }

    // --- message layout ---------------------------------------------------

    function test_anchorMessage_matchesTheBaseChainLayoutForALiveAnchor() public view {
        string memory json = vm.readFile("test/fixtures/live-anchor.json");
        AnchorReceipt memory r = AnchorReceipt({
            chainId: vm.parseJsonString(json, ".receipt.chainId"),
            layerId: vm.parseJsonString(json, ".receipt.layerId"),
            layerHeight: uint64(vm.parseJsonUint(json, ".receipt.layerHeight")),
            stateRoot: vm.parseJsonBytes32(json, ".receipt.stateRoot"),
            validatorSetHash: vm.parseJsonBytes(json, ".receipt.validatorSetHash"),
            txCount: uint64(vm.parseJsonUint(json, ".receipt.txCount"))
        });
        assertEq(keccak256(receipts.anchorMessage(r)), vm.parseJsonBytes32(json, ".messageHash"));
    }

    function test_anchorMessage_encodesEveryFieldInOrder() public view {
        AnchorReceipt memory r = _anchor();
        bytes memory expected = abi.encodePacked(
            "qorechain-multilayer-anchor-v2",
            uint64(15),
            "qorechain-diana",
            uint64(7),
            "layer-1",
            uint64(3),
            uint64(32),
            r.stateRoot,
            uint64(2),
            hex"beef",
            uint64(9),
            uint64(0)
        );
        assertEq(receipts.anchorMessage(r), expected);
    }

    function test_attestationMessage_isBoundToChainAndContract() public {
        BatchAttestation memory a = _attestation();
        bytes memory here = receipts.attestationMessage(a);

        VigilReceipts other = new VigilReceipts();
        assertNotEq(keccak256(other.attestationMessage(a)), keccak256(here));

        vm.chainId(block.chainid + 1);
        assertNotEq(keccak256(receipts.attestationMessage(a)), keccak256(here));
    }

    function test_messages_rejectMalformedFields() public {
        AnchorReceipt memory r = _anchor();
        r.chainId = "";
        vm.expectRevert(ReceiptVerifier.InvalidField.selector);
        receipts.anchorMessage(r);

        r = _anchor();
        r.layerId = string(_bytes(129, 0x61));
        vm.expectRevert(ReceiptVerifier.InvalidField.selector);
        receipts.anchorMessage(r);

        r = _anchor();
        r.validatorSetHash = _bytes(65, 0x01);
        vm.expectRevert(ReceiptVerifier.InvalidField.selector);
        receipts.anchorMessage(r);

        BatchAttestation memory a = _attestation();
        a.withdrawalsRoot = _bytes(31, 0x01);
        vm.expectRevert(ReceiptVerifier.InvalidField.selector);
        receipts.attestationMessage(a);

        a = _attestation();
        a.rollupId = "";
        vm.expectRevert(ReceiptVerifier.InvalidField.selector);
        receipts.attestationMessage(a);
    }

    function testFuzz_anchorMessage_distinctReceiptsGiveDistinctMessages(
        uint64 heightA,
        uint64 heightB,
        uint64 txA,
        uint64 txB,
        bytes32 rootA,
        bytes32 rootB
    ) public view {
        AnchorReceipt memory a = _anchor();
        AnchorReceipt memory b = _anchor();
        (a.layerHeight, a.txCount, a.stateRoot) = (heightA, txA, rootA);
        (b.layerHeight, b.txCount, b.stateRoot) = (heightB, txB, rootB);
        bool same = heightA == heightB && txA == txB && rootA == rootB;
        assertEq(keccak256(receipts.anchorMessage(a)) == keccak256(receipts.anchorMessage(b)), same);
    }

    function testFuzz_anchorMessage_fieldBoundariesCannotBeShifted(string calldata chainId, string calldata layerId)
        public
        view
    {
        uint256 c = bytes(chainId).length;
        uint256 l = bytes(layerId).length;
        vm.assume(c > 1 && c <= 128 && l > 0 && l < 128);

        AnchorReceipt memory a = _anchor();
        (a.chainId, a.layerId) = (chainId, layerId);
        // Move the last byte of the chain id to the front of the layer id: same concatenation.
        AnchorReceipt memory b = _anchor();
        b.chainId = string(bytes(chainId)[:c - 1]);
        b.layerId = string(abi.encodePacked(bytes(chainId)[c - 1:], layerId));

        assertNotEq(keccak256(receipts.anchorMessage(a)), keccak256(receipts.anchorMessage(b)));
    }

    // --- recording --------------------------------------------------------

    function test_recordAnchor_storesAndEmits() public {
        AnchorReceipt memory r = _anchor();
        bytes memory message = receipts.anchorMessage(r);
        verify.accept(publicKey, signature, message);
        bytes32 id = receipts.receiptId(signer, message);

        assertFalse(receipts.isAnchorRecorded(signer, r));
        assertTrue(receipts.checkAnchor(signer, r, signature));

        vm.roll(1234);
        vm.expectEmit(true, true, true, true, address(receipts));
        emit AnchorRecorded(id, signer, r.stateRoot, r.layerId, r.layerHeight, r.txCount);
        vm.prank(address(0xBEEF));
        assertEq(receipts.recordAnchor(signer, r, signature), id);

        (address recordedSigner, uint64 atBlock, VigilReceipts.Kind kind) = receipts.records(id);
        assertEq(recordedSigner, signer);
        assertEq(atBlock, 1234);
        assertEq(uint8(kind), uint8(VigilReceipts.Kind.Anchor));
        assertTrue(receipts.isAnchorRecorded(signer, r));
    }

    function test_recordAttestation_storesAndEmits() public {
        BatchAttestation memory a = _attestation();
        bytes memory message = receipts.attestationMessage(a);
        verify.accept(publicKey, signature, message);
        bytes32 id = receipts.receiptId(signer, message);

        assertTrue(receipts.checkAttestation(signer, a, signature));
        vm.expectEmit(true, true, true, true, address(receipts));
        emit AttestationRecorded(id, signer, a.stateRoot, a.rollupId, a.batchIndex);
        receipts.recordAttestation(signer, a, signature);

        assertTrue(receipts.isAttestationRecorded(signer, a));
        assertFalse(receipts.isAttestationRecorded(address(0xB0B), a));
    }

    function test_record_rejectsAReplay() public {
        AnchorReceipt memory r = _anchor();
        bytes memory message = receipts.anchorMessage(r);
        verify.accept(publicKey, signature, message);
        receipts.recordAnchor(signer, r, signature);

        vm.expectRevert(
            abi.encodeWithSelector(VigilReceipts.AlreadyRecorded.selector, receipts.receiptId(signer, message))
        );
        receipts.recordAnchor(signer, r, signature);
    }

    function test_record_rejectsASignatureOverDifferentFields() public {
        AnchorReceipt memory r = _anchor();
        verify.accept(publicKey, signature, receipts.anchorMessage(r));

        r.txCount += 1;
        assertFalse(receipts.checkAnchor(signer, r, signature));
        vm.expectRevert(VigilReceipts.InvalidSignature.selector);
        receipts.recordAnchor(signer, r, signature);
        assertFalse(receipts.isAnchorRecorded(signer, r));
    }

    function test_record_anAnchorSignatureIsNotAnAttestation() public {
        AnchorReceipt memory r = _anchor();
        verify.accept(publicKey, signature, receipts.anchorMessage(r));

        vm.expectRevert(VigilReceipts.InvalidSignature.selector);
        receipts.recordAttestation(signer, _attestation(), signature);
    }

    function test_record_rejectsAnotherAccountsSignature() public {
        AnchorReceipt memory r = _anchor();
        verify.accept(publicKey, signature, receipts.anchorMessage(r));

        address impostor = address(0xBAD);
        keyStatus.set(impostor, true, 1, _bytes(2592, 0x33), true);
        vm.expectRevert(VigilReceipts.InvalidSignature.selector);
        receipts.recordAnchor(impostor, r, signature);
    }

    // --- signer key checks ------------------------------------------------

    function test_signer_mustBeRegistered() public {
        address unknown = address(0xDEAD);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVerifier.SignerNotRegistered.selector, unknown));
        receipts.recordAnchor(unknown, _anchor(), signature);
    }

    function test_signer_mustHaveProvenPossession() public {
        keyStatus.set(signer, true, 1, publicKey, false);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVerifier.PossessionNotProven.selector, signer));
        receipts.recordAnchor(signer, _anchor(), signature);
    }

    function test_signer_mustUseMlDsa87() public {
        keyStatus.set(signer, true, 2, publicKey, true);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVerifier.UnsupportedAlgorithm.selector, signer, uint8(2)));
        receipts.recordAnchor(signer, _anchor(), signature);

        keyStatus.set(signer, true, 1, _bytes(1952, 0x11), true);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVerifier.UnsupportedAlgorithm.selector, signer, uint8(1)));
        receipts.recordAnchor(signer, _anchor(), signature);
    }

    function test_signature_mustHaveTheExactLength() public {
        vm.expectRevert(abi.encodeWithSelector(ReceiptVerifier.InvalidSignatureLength.selector, uint256(4626)));
        receipts.recordAnchor(signer, _anchor(), _bytes(4626, 0x22));
    }

    // --- chains without the precompiles -----------------------------------

    function test_inactiveKeyStatusPrecompile_isReportedNotTrusted() public {
        vm.etch(PQC_KEY_STATUS, "");
        vm.expectRevert(abi.encodeWithSelector(ReceiptVerifier.PrecompileUnavailable.selector, PQC_KEY_STATUS));
        receipts.recordAnchor(signer, _anchor(), signature);
    }

    function test_inactiveVerifyPrecompile_isReportedNotTrusted() public {
        vm.etch(PQC_VERIFY, "");
        vm.expectRevert(abi.encodeWithSelector(ReceiptVerifier.PrecompileUnavailable.selector, PQC_VERIFY));
        receipts.recordAnchor(signer, _anchor(), signature);
    }

    function test_precompileReturningMalformedData_isRejected() public {
        vm.mockCall(PQC_VERIFY, bytes(""), abi.encode(true, true));
        vm.expectRevert(abi.encodeWithSelector(ReceiptVerifier.PrecompileUnavailable.selector, PQC_VERIFY));
        receipts.recordAnchor(signer, _anchor(), signature);
    }

    // --- helpers ----------------------------------------------------------

    function _anchor() internal pure returns (AnchorReceipt memory) {
        return AnchorReceipt({
            chainId: "qorechain-diana",
            layerId: "layer-1",
            layerHeight: 3,
            stateRoot: keccak256("state"),
            validatorSetHash: hex"beef",
            txCount: 9
        });
    }

    function _attestation() internal pure returns (BatchAttestation memory) {
        return BatchAttestation({
            chainId: "qorechain-diana",
            rollupId: "vigil-1",
            batchIndex: 5,
            stateRoot: keccak256("state"),
            withdrawalsRoot: abi.encodePacked(keccak256("withdrawals")),
            dataHash: keccak256("data")
        });
    }

    function _bytes(uint256 length, uint8 fill) internal pure returns (bytes memory out) {
        out = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            out[i] = bytes1(fill);
        }
    }
}
