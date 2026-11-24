// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AnchorReceipt, IVigilReceipts, SettlementGate} from "../src/SettlementGate.sol";

/// @dev Stands in for VigilReceipts: an anchor counts as recorded once `record` is called for it.
contract MockReceipts is IVigilReceipts {
    mapping(bytes32 => bool) private recorded;

    function record(address signer, AnchorReceipt calldata receipt) external {
        recorded[keccak256(abi.encode(signer, receipt))] = true;
    }

    function isAnchorRecorded(address signer, AnchorReceipt calldata receipt) external view returns (bool) {
        return recorded[keccak256(abi.encode(signer, receipt))];
    }
}

contract Refuses {
    receive() external payable {
        revert("no");
    }
}

contract SettlementGateTest is Test {
    MockReceipts internal receipts;
    SettlementGate internal gate;

    address internal payer = makeAddr("payer");
    address internal payee = makeAddr("payee");
    address internal creator = makeAddr("creator");
    uint64 internal deadline;

    function setUp() public {
        receipts = new MockReceipts();
        gate = new SettlementGate(receipts);
        deadline = uint64(block.timestamp + 1 days);
        vm.deal(payer, 10 ether);
    }

    function anchor(uint64 height) internal pure returns (AnchorReceipt memory) {
        return AnchorReceipt({
            chainId: "qorechain-diana",
            layerId: "vigil-1",
            layerHeight: height,
            stateRoot: keccak256(abi.encode(height)),
            validatorSetHash: hex"01",
            txCount: 1
        });
    }

    function openFor(uint64 height, uint256 amount) internal returns (uint256 id) {
        vm.prank(payer);
        id = gate.open{value: amount}(payee, creator, "qorechain-diana", "vigil-1", height, deadline);
    }

    function test_PaysOnlyOnceTheBatchIsRecorded() public {
        uint256 id = openFor(29, 1 ether);
        AnchorReceipt memory r = anchor(29);
        assertFalse(gate.isSettled(id, r));
        vm.expectRevert(SettlementGate.NotSettled.selector);
        gate.release(id, r);

        receipts.record(creator, r);
        assertTrue(gate.isSettled(id, r));
        vm.expectEmit(true, true, false, true);
        emit SettlementGate.Released(id, payee, 1 ether, r.stateRoot);
        gate.release(id, r);
        assertEq(payee.balance, 1 ether);
        assertEq(address(gate).balance, 0);

        vm.expectRevert(SettlementGate.Closed.selector);
        gate.release(id, r);
    }

    function test_RefusesAnotherBatchChainOrLayer() public {
        uint256 id = openFor(29, 1 ether);
        AnchorReceipt memory other = anchor(28);
        receipts.record(creator, other);
        vm.expectRevert(SettlementGate.WrongReceipt.selector);
        gate.release(id, other);

        AnchorReceipt memory chain = anchor(29);
        chain.chainId = "qorechain-vladi";
        receipts.record(creator, chain);
        vm.expectRevert(SettlementGate.WrongReceipt.selector);
        gate.release(id, chain);

        AnchorReceipt memory layer = anchor(29);
        layer.layerId = "vigil-2";
        receipts.record(creator, layer);
        vm.expectRevert(SettlementGate.WrongReceipt.selector);
        gate.release(id, layer);
        assertFalse(gate.isSettled(id, layer));
    }

    function test_RefusesAnAnchorFromAnotherSigner() public {
        uint256 id = openFor(29, 1 ether);
        AnchorReceipt memory r = anchor(29);
        receipts.record(makeAddr("someone else"), r);
        vm.expectRevert(SettlementGate.NotSettled.selector);
        gate.release(id, r);
    }

    function test_RefundOnlyToThePayerAfterTheDeadline() public {
        uint256 id = openFor(29, 2 ether);
        vm.prank(payer);
        vm.expectRevert(SettlementGate.TooEarly.selector);
        gate.refund(id);

        vm.warp(deadline + 1);
        vm.prank(payee);
        vm.expectRevert(SettlementGate.NotPayer.selector);
        gate.refund(id);

        vm.prank(payer);
        gate.refund(id);
        assertEq(payer.balance, 10 ether);

        receipts.record(creator, anchor(29));
        vm.expectRevert(SettlementGate.Closed.selector);
        gate.release(id, anchor(29));
    }

    function test_NoRefundAfterRelease() public {
        uint256 id = openFor(29, 1 ether);
        receipts.record(creator, anchor(29));
        gate.release(id, anchor(29));
        vm.warp(deadline + 1);
        vm.prank(payer);
        vm.expectRevert(SettlementGate.Closed.selector);
        gate.refund(id);
    }

    function test_RejectsBadInput() public {
        vm.expectRevert(SettlementGate.ZeroAddress.selector);
        new SettlementGate(IVigilReceipts(address(0)));

        vm.prank(payer);
        vm.expectRevert(SettlementGate.ZeroAmount.selector);
        gate.open(payee, creator, "qorechain-diana", "vigil-1", 29, deadline);

        vm.prank(payer);
        vm.expectRevert(SettlementGate.ZeroAddress.selector);
        gate.open{value: 1}(address(0), creator, "qorechain-diana", "vigil-1", 29, deadline);

        vm.prank(payer);
        vm.expectRevert(SettlementGate.ZeroAddress.selector);
        gate.open{value: 1}(payee, address(0), "qorechain-diana", "vigil-1", 29, deadline);

        vm.expectRevert(SettlementGate.NoSuchEscrow.selector);
        gate.release(0, anchor(29));
        vm.expectRevert(SettlementGate.NoSuchEscrow.selector);
        gate.isSettled(0, anchor(29));
    }

    function test_AFailedTransferUndoesTheRelease() public {
        Refuses refuser = new Refuses();
        vm.prank(payer);
        uint256 id = gate.open{value: 1 ether}(address(refuser), creator, "qorechain-diana", "vigil-1", 29, deadline);
        receipts.record(creator, anchor(29));
        vm.expectRevert(SettlementGate.TransferFailed.selector);
        gate.release(id, anchor(29));
        (,,,,, bool closed,,,) = gate.escrows(id);
        assertFalse(closed);
    }

    function testFuzz_EscrowsAreIndependent(uint96 a, uint96 b) public {
        vm.assume(a > 0 && b > 0);
        vm.deal(payer, uint256(a) + uint256(b));
        uint256 first = openFor(10, a);
        uint256 second = openFor(11, b);
        receipts.record(creator, anchor(11));
        gate.release(second, anchor(11));
        assertEq(payee.balance, b);
        assertEq(address(gate).balance, a);
        vm.expectRevert(SettlementGate.NotSettled.selector);
        gate.release(first, anchor(10));
    }
}
