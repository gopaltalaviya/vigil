// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AnchorReceipt, IVigilReceipts, SettlementGate} from "../src/SettlementGate.sol";

/// @notice Runs the gate against the real VigilReceipts on a fork of the QoreChain testnet.
///         Skipped unless FORK=1:  FORK=1 forge test --match-contract Fork
contract SettlementGateForkTest is Test {
    IVigilReceipts internal constant RECEIPTS = IVigilReceipts(0xCeD683ad4319a34873E2C1aa90d18e2Fcf1AF1d1);
    /// @dev The creator of rollup vigil-1, which signs its settlement anchors.
    address internal constant CREATOR = 0x7F806B5bF878a7b89d7F7d0b4ec3a517A38d15C7;

    SettlementGate internal gate;
    address internal payee = makeAddr("payee");

    function setUp() public {
        if (!vm.envOr("FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("qorechain_testnet");
        gate = new SettlementGate(RECEIPTS);
    }

    /// @dev Batch 0 of vigil-1, as anchored on the base chain and recorded in VigilReceipts.
    function batch0() internal pure returns (AnchorReceipt memory) {
        return AnchorReceipt({
            chainId: "qorechain-diana",
            layerId: "vigil-1",
            layerHeight: 0,
            stateRoot: 0x8de3a37a763a47a2d7338865e886073b6b8e66fe60193b83842a44e9a8e8d06e,
            validatorSetHash: hex"",
            txCount: 3
        });
    }

    function test_ReleasesOnTheRecordedAnchorOfBatch0() public {
        uint256 id = gate.open{value: 1 ether}(payee, CREATOR, "qorechain-diana", "vigil-1", 0, 0);
        assertTrue(gate.isSettled(id, batch0()));
        gate.release(id, batch0());
        assertEq(payee.balance, 1 ether);
    }

    function test_RefusesAForgedStateRoot() public {
        uint256 id = gate.open{value: 1 ether}(payee, CREATOR, "qorechain-diana", "vigil-1", 0, 0);
        AnchorReceipt memory forged = batch0();
        forged.stateRoot = bytes32(uint256(forged.stateRoot) ^ 1);
        vm.expectRevert(SettlementGate.NotSettled.selector);
        gate.release(id, forged);
    }
}
