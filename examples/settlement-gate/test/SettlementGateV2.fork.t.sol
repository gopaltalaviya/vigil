// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AnchorReceipt} from "../src/SettlementGate.sol";
import {BatchAttestation, IVigilReceiptsV2, SettlementGateV2} from "../src/SettlementGateV2.sol";

/// @notice Runs version 2 against the real VigilReceipts on a fork of the QoreChain testnet, with the
///         recorded anchor and the recorded watchtower attestation of vigil-1 batch 26.
///         Skipped unless FORK=1:  FORK=1 forge test --match-contract Fork
contract SettlementGateV2ForkTest is Test {
    IVigilReceiptsV2 internal constant RECEIPTS = IVigilReceiptsV2(0xCeD683ad4319a34873E2C1aa90d18e2Fcf1AF1d1);
    /// @dev The creator of rollup vigil-1 (signs its anchors) and the key of Vigil's watchtower (signs its
    ///      attestations) are the same operator account on the testnet.
    address internal constant CREATOR = 0x7F806B5bF878a7b89d7F7d0b4ec3a517A38d15C7;
    address internal constant WATCHTOWER = 0x7F806B5bF878a7b89d7F7d0b4ec3a517A38d15C7;

    SettlementGateV2 internal gate;
    address internal payee = makeAddr("payee");

    function setUp() public {
        if (!vm.envOr("FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("qorechain_testnet");
        gate = new SettlementGateV2(RECEIPTS);
    }

    function anchor26() internal pure returns (AnchorReceipt memory) {
        return AnchorReceipt({
            chainId: "qorechain-diana",
            layerId: "vigil-1",
            layerHeight: 26,
            stateRoot: 0x8f5049eba8492167440a4d7b4a5e8d98400d5ce99ead193766be7c52a6373ba2,
            validatorSetHash: hex"",
            txCount: 2
        });
    }

    function attestation26() internal pure returns (BatchAttestation memory) {
        return BatchAttestation({
            chainId: "qorechain-diana",
            rollupId: "vigil-1",
            batchIndex: 26,
            stateRoot: 0x8f5049eba8492167440a4d7b4a5e8d98400d5ce99ead193766be7c52a6373ba2,
            withdrawalsRoot: hex"ae4f09dfe9adef5ffd518181fed4c35e033d3e33244ffe13244bf28c3f457c8b",
            dataHash: 0xf7089fd91a849b224195d1977832ca3cd2e097a4c338ea7f2de6ea53bacdf54b
        });
    }

    function openOn26() internal returns (uint256) {
        return gate.open{value: 1 ether}(payee, CREATOR, WATCHTOWER, "qorechain-diana", "vigil-1", "vigil-1", 26, 0);
    }

    function test_ReleasesWithTheRecordedAnchorAndAttestationOfBatch26() public {
        uint256 id = openOn26();
        assertTrue(gate.isReleasable(id, anchor26(), attestation26()));
        gate.release(id, anchor26(), attestation26());
        assertEq(payee.balance, 1 ether);
    }

    function test_RefusesAnUnrecordedAttestationEvenWithTheRealAnchor() public {
        uint256 id = openOn26();
        BatchAttestation memory forged = attestation26();
        forged.dataHash = bytes32(uint256(forged.dataHash) ^ 1);
        assertTrue(RECEIPTS.isAnchorRecorded(CREATOR, anchor26()));
        vm.expectRevert(SettlementGateV2.NotAttested.selector);
        gate.release(id, anchor26(), forged);
    }

    function test_RefusesAForgedStateRoot() public {
        uint256 id = openOn26();
        AnchorReceipt memory r = anchor26();
        BatchAttestation memory a = attestation26();
        r.stateRoot = bytes32(uint256(r.stateRoot) ^ 1);
        a.stateRoot = r.stateRoot;
        vm.expectRevert(SettlementGateV2.NotSettled.selector);
        gate.release(id, r, a);
    }
}
