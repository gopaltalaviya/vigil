// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AnchorReceipt} from "../src/SettlementGate.sol";
import {BatchAttestation, IVigilReceiptsV2, SettlementGateV2} from "../src/SettlementGateV2.sol";
import {Refuses} from "./SettlementGate.t.sol";

/// @dev Stands in for VigilReceipts: a receipt counts as recorded once it is recorded here.
contract MockReceiptsV2 is IVigilReceiptsV2 {
    mapping(bytes32 => bool) private anchors;
    mapping(bytes32 => bool) private attestations;

    function recordAnchor(address signer, AnchorReceipt calldata receipt) external {
        anchors[keccak256(abi.encode(signer, receipt))] = true;
    }

    function recordAttestation(address signer, BatchAttestation calldata attestation) external {
        attestations[keccak256(abi.encode(signer, attestation))] = true;
    }

    function isAnchorRecorded(address signer, AnchorReceipt calldata receipt) external view returns (bool) {
        return anchors[keccak256(abi.encode(signer, receipt))];
    }

    function isAttestationRecorded(address signer, BatchAttestation calldata attestation) external view returns (bool) {
        return attestations[keccak256(abi.encode(signer, attestation))];
    }
}

contract SettlementGateV2Test is Test {
    MockReceiptsV2 internal receipts;
    SettlementGateV2 internal gate;

    address internal payer = makeAddr("payer");
    address internal payee = makeAddr("payee");
    address internal creator = makeAddr("creator");
    address internal watchtower = makeAddr("watchtower");
    uint64 internal deadline;

    function setUp() public {
        receipts = new MockReceiptsV2();
        gate = new SettlementGateV2(receipts);
        deadline = uint64(block.timestamp + 1 days);
        vm.deal(payer, 10 ether);
    }

    function anchor(uint64 batch) internal pure returns (AnchorReceipt memory) {
        return AnchorReceipt({
            chainId: "qorechain-diana",
            layerId: "vigil-1",
            layerHeight: batch,
            stateRoot: keccak256(abi.encode(batch)),
            validatorSetHash: "",
            txCount: 1
        });
    }

    function attestation(uint64 batch) internal pure returns (BatchAttestation memory) {
        return BatchAttestation({
            chainId: "qorechain-diana",
            rollupId: "vigil-1",
            batchIndex: batch,
            stateRoot: keccak256(abi.encode(batch)),
            withdrawalsRoot: "",
            dataHash: keccak256(abi.encode("data", batch))
        });
    }

    function openFor(uint64 batch, uint256 amount) internal returns (uint256 id) {
        vm.prank(payer);
        id = gate.open{value: amount}(
            payee, creator, watchtower, "qorechain-diana", "vigil-1", "vigil-1", batch, deadline
        );
    }

    function test_PaysOnlyWithBothTheAnchorAndTheAttestation() public {
        uint256 id = openFor(26, 1 ether);
        AnchorReceipt memory r = anchor(26);
        BatchAttestation memory a = attestation(26);

        vm.expectRevert(SettlementGateV2.NotSettled.selector);
        gate.release(id, r, a);

        receipts.recordAttestation(watchtower, a);
        vm.expectRevert(SettlementGateV2.NotSettled.selector);
        gate.release(id, r, a);

        // Anchor without attestation is what version 1 accepted; version 2 does not.
        MockReceiptsV2 anchorOnly = new MockReceiptsV2();
        SettlementGateV2 strict = new SettlementGateV2(anchorOnly);
        vm.prank(payer);
        uint256 sid = strict.open{value: 1 ether}(
            payee, creator, watchtower, "qorechain-diana", "vigil-1", "vigil-1", 26, deadline
        );
        anchorOnly.recordAnchor(creator, r);
        assertFalse(strict.isReleasable(sid, r, a));
        vm.expectRevert(SettlementGateV2.NotAttested.selector);
        strict.release(sid, r, a);

        receipts.recordAnchor(creator, r);
        assertTrue(gate.isReleasable(id, r, a));
        gate.release(id, r, a);
        assertEq(payee.balance, 1 ether);
        assertFalse(gate.isReleasable(id, r, a));
        vm.expectRevert(SettlementGateV2.Closed.selector);
        gate.release(id, r, a);
    }

    function test_RefusesAnAttestationOfAnotherStateBatchOrRollup() public {
        uint256 id = openFor(26, 1 ether);
        AnchorReceipt memory r = anchor(26);
        receipts.recordAnchor(creator, r);

        BatchAttestation memory otherRoot = attestation(26);
        otherRoot.stateRoot = bytes32(uint256(otherRoot.stateRoot) ^ 1);
        receipts.recordAttestation(watchtower, otherRoot);
        vm.expectRevert(SettlementGateV2.WrongReceipt.selector);
        gate.release(id, r, otherRoot);

        BatchAttestation memory otherBatch = attestation(27);
        receipts.recordAttestation(watchtower, otherBatch);
        vm.expectRevert(SettlementGateV2.WrongReceipt.selector);
        gate.release(id, r, otherBatch);

        BatchAttestation memory otherRollup = attestation(26);
        otherRollup.rollupId = "other-1";
        receipts.recordAttestation(watchtower, otherRollup);
        vm.expectRevert(SettlementGateV2.WrongReceipt.selector);
        gate.release(id, r, otherRollup);

        BatchAttestation memory otherChain = attestation(26);
        otherChain.chainId = "qorechain-vladi";
        receipts.recordAttestation(watchtower, otherChain);
        vm.expectRevert(SettlementGateV2.WrongReceipt.selector);
        gate.release(id, r, otherChain);
    }

    function test_RefusesAnAttestationByAnotherWatchtower() public {
        uint256 id = openFor(26, 1 ether);
        receipts.recordAnchor(creator, anchor(26));
        receipts.recordAttestation(makeAddr("someone else"), attestation(26));
        vm.expectRevert(SettlementGateV2.NotAttested.selector);
        gate.release(id, anchor(26), attestation(26));
        // And the watchtower's attestation does not stand in for the creator's anchor.
        uint256 id2 = openFor(27, 1 ether);
        receipts.recordAnchor(watchtower, anchor(27));
        receipts.recordAttestation(watchtower, attestation(27));
        vm.expectRevert(SettlementGateV2.NotSettled.selector);
        gate.release(id2, anchor(27), attestation(27));
    }

    function test_RefundOnlyToThePayerAfterTheDeadline() public {
        uint256 id = openFor(26, 1 ether);
        vm.prank(payer);
        vm.expectRevert(SettlementGateV2.TooEarly.selector);
        gate.refund(id);
        vm.warp(deadline + 1);
        vm.expectRevert(SettlementGateV2.NotPayer.selector);
        gate.refund(id);
        vm.prank(payer);
        gate.refund(id);
        assertEq(payer.balance, 10 ether);
        receipts.recordAnchor(creator, anchor(26));
        receipts.recordAttestation(watchtower, attestation(26));
        vm.expectRevert(SettlementGateV2.Closed.selector);
        gate.release(id, anchor(26), attestation(26));
    }

    function test_RejectsBadInput() public {
        vm.expectRevert(SettlementGateV2.ZeroAddress.selector);
        new SettlementGateV2(IVigilReceiptsV2(address(0)));
        vm.startPrank(payer);
        vm.expectRevert(SettlementGateV2.ZeroAmount.selector);
        gate.open(payee, creator, watchtower, "c", "l", "r", 1, deadline);
        vm.expectRevert(SettlementGateV2.ZeroAddress.selector);
        gate.open{value: 1}(address(0), creator, watchtower, "c", "l", "r", 1, deadline);
        vm.expectRevert(SettlementGateV2.ZeroAddress.selector);
        gate.open{value: 1}(payee, address(0), watchtower, "c", "l", "r", 1, deadline);
        vm.expectRevert(SettlementGateV2.ZeroAddress.selector);
        gate.open{value: 1}(payee, creator, address(0), "c", "l", "r", 1, deadline);
        vm.stopPrank();
        vm.expectRevert(SettlementGateV2.NoSuchEscrow.selector);
        gate.refund(0);
        vm.expectRevert(SettlementGateV2.NoSuchEscrow.selector);
        gate.isReleasable(0, anchor(1), attestation(1));
    }

    function test_AFailedTransferUndoesTheRelease() public {
        address refuses = address(new Refuses());
        vm.prank(payer);
        uint256 id = gate.open{value: 1 ether}(
            refuses, creator, watchtower, "qorechain-diana", "vigil-1", "vigil-1", 26, deadline
        );
        receipts.recordAnchor(creator, anchor(26));
        receipts.recordAttestation(watchtower, attestation(26));
        vm.expectRevert(SettlementGateV2.TransferFailed.selector);
        gate.release(id, anchor(26), attestation(26));
        (,,,,,, bool closed, uint256 amount,,,) = gate.escrows(id);
        assertFalse(closed);
        assertEq(amount, 1 ether);
    }

    /// Changing any one field of a recorded anchor or attestation stops the payout.
    function testFuzz_AnyChangedFieldIsRefused(uint8 field, uint256 change) public {
        uint256 id = openFor(26, 1 ether);
        AnchorReceipt memory r = anchor(26);
        BatchAttestation memory a = attestation(26);
        receipts.recordAnchor(creator, r);
        receipts.recordAttestation(watchtower, a);
        change = bound(change, 1, type(uint64).max);
        field %= 8;
        if (field == 0) r.stateRoot = bytes32(uint256(r.stateRoot) ^ change);
        else if (field == 1) a.stateRoot = bytes32(uint256(a.stateRoot) ^ change);
        else if (field == 2) a.dataHash = bytes32(uint256(a.dataHash) ^ change);
        else if (field == 3) a.withdrawalsRoot = abi.encodePacked(bytes32(change));
        else if (field == 4) r.txCount ^= uint64(change);
        else if (field == 5) r.validatorSetHash = abi.encodePacked(uint8(change));
        else if (field == 6) a.batchIndex ^= uint64(change);
        else r.layerHeight ^= uint64(change);
        assertFalse(gate.isReleasable(id, r, a));
        vm.expectRevert();
        gate.release(id, r, a);
        assertEq(address(gate).balance, 1 ether);
    }
}
