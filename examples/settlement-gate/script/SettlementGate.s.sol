// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IVigilReceipts, SettlementGate} from "../src/SettlementGate.sol";

/// @notice Deploys SettlementGate against VigilReceipts. The sender needs a registered ML-DSA-87 key and a
///         live EVM authorisation window that is not limited to other contracts first (see README).
contract SettlementGateScript is Script {
    /// @dev VigilReceipts on the QoreChain testnet.
    address internal constant TESTNET_RECEIPTS = 0xCeD683ad4319a34873E2C1aa90d18e2Fcf1AF1d1;

    function run() external returns (SettlementGate gate) {
        // Forge loads .env from the project root.
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address receipts = vm.envOr("VIGIL_RECEIPTS_ADDRESS", TESTNET_RECEIPTS);
        vm.startBroadcast(deployerKey);
        gate = new SettlementGate(IVigilReceipts(receipts));
        vm.stopBroadcast();
        console.log("SettlementGate deployed at", address(gate));
    }
}
