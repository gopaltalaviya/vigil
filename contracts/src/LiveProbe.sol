// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {AnchorReceipt, ReceiptVerifier} from "./ReceiptVerifier.sol";

/// @title LiveProbe
/// @notice Runs the anchor check inside a constructor and returns the result as the "deployed
///         code", so the verification logic can be exercised against a live node's precompiles
///         with a plain `eth_call` (no `to` address): nothing is deployed and no gas is spent.
/// @dev Never deployed. Local EVMs and forks do not implement QoreChain's precompiles, so this is
///      how the logic is tested against the real ones before `VigilReceipts` goes on chain.
contract LiveProbe is ReceiptVerifier {
    constructor(address signer, AnchorReceipt memory receipt, bytes memory signature) {
        bool valid = _isSignedBy(signer, anchorMessage(receipt), signature);
        bytes memory result = abi.encode(valid, keccak256(anchorMessage(receipt)));
        assembly ("memory-safe") {
            return(add(result, 32), mload(result))
        }
    }
}
