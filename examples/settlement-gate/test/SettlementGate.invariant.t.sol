// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AnchorReceipt, SettlementGate} from "../src/SettlementGate.sol";
import {MockReceipts} from "./SettlementGate.t.sol";

/// @dev Opens, records, releases and refunds escrows in any order, and keeps a ghost ledger.
contract GateHandler is Test {
    SettlementGate internal immutable gate;
    MockReceipts internal immutable receipts;

    address[3] internal payers = [address(0x1001), address(0x1002), address(0x1003)];
    address[3] internal payees = [address(0x2001), address(0x2002), address(0x2003)];
    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant STRANGER = address(0xBAD);

    uint256 public deposited;
    uint256 public paidOut;
    /// @dev Calls that succeeded although they must have failed, or failed although they must have succeeded.
    uint256 public violations;
    uint256 public releases;
    uint256 public refunds;

    mapping(uint256 id => uint256) public closings;

    constructor(SettlementGate gate_, MockReceipts receipts_) {
        gate = gate_;
        receipts = receipts_;
    }

    function anchor(uint64 height) public pure returns (AnchorReceipt memory) {
        return AnchorReceipt({
            chainId: "qorechain-diana",
            layerId: "vigil-1",
            layerHeight: height,
            stateRoot: keccak256(abi.encode("root", height)),
            validatorSetHash: "",
            txCount: 1
        });
    }

    function open(uint256 who, uint96 amount, uint8 height, uint32 lifetime) external {
        amount = uint96(bound(amount, 1, 100 ether));
        address payer = payers[who % payers.length];
        vm.deal(payer, amount);
        vm.prank(payer);
        gate.open{value: amount}(
            payees[who % payees.length],
            CREATOR,
            "qorechain-diana",
            "vigil-1",
            height,
            uint64(block.timestamp) + lifetime
        );
        deposited += amount;
    }

    function recordAnchor(uint256 id) public {
        uint256 count = gate.count();
        if (count == 0) return;
        id %= count;
        (,,, uint64 height,,,,,) = gate.escrows(id);
        receipts.record(CREATOR, anchor(height));
    }

    /// @dev Records an escrow's batch and releases it at once, so sequences often reach a payout.
    function recordThenRelease(uint256 id) external {
        uint256 count = gate.count();
        if (count == 0) return;
        id %= count;
        this.recordAnchor(id);
        this.release(id, false);
    }

    function release(uint256 id, bool forged) public {
        uint256 count = gate.count();
        if (count == 0) return;
        id %= count;
        (, address payee,, uint64 height,, bool closed, uint256 amount,,) = gate.escrows(id);
        AnchorReceipt memory r = anchor(height);
        if (forged) r.stateRoot = ~r.stateRoot;
        bool shouldPay = !closed && !forged && receipts.isAnchorRecorded(CREATOR, r);
        uint256 before = payee.balance;
        vm.prank(STRANGER);
        try gate.release(id, r) {
            if (!shouldPay || payee.balance != before + amount) violations++;
            paidOut += amount;
            closings[id]++;
            releases++;
        } catch {
            if (shouldPay) violations++;
        }
    }

    function refund(uint256 id, bool asPayer, uint32 wait) external {
        uint256 count = gate.count();
        if (count == 0) return;
        id %= count;
        vm.warp(block.timestamp + wait);
        (address payer,,,, uint64 refundAfter, bool closed, uint256 amount,,) = gate.escrows(id);
        address caller = asPayer ? payer : STRANGER;
        bool shouldPay = !closed && asPayer && block.timestamp > refundAfter;
        uint256 before = payer.balance;
        vm.prank(caller);
        try gate.refund(id) {
            if (!shouldPay || payer.balance != before + amount) violations++;
            paidOut += amount;
            closings[id]++;
            refunds++;
        } catch {
            if (shouldPay) violations++;
        }
    }
}

/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 50
/// forge-config: default.invariant.fail-on-revert = true
contract SettlementGateInvariantTest is Test {
    SettlementGate internal gate;
    MockReceipts internal receipts;
    GateHandler internal handler;

    function setUp() public {
        receipts = new MockReceipts();
        gate = new SettlementGate(receipts);
        handler = new GateHandler(gate, receipts);
        targetContract(address(handler));
    }

    uint256 internal runsWithRelease;
    uint256 internal runsWithRefund;

    /// The sequences really reach the paying paths (shown with -vv).
    function afterInvariant() public {
        if (handler.releases() > 0) runsWithRelease++;
        if (handler.refunds() > 0) runsWithRefund++;
        emit log_named_uint("releases in this run", handler.releases());
        emit log_named_uint("refunds in this run", handler.refunds());
    }

    /// Money is never created or lost: what is held plus what was paid out is what was deposited.
    function invariant_moneyIsConserved() public view {
        assertEq(address(gate).balance + handler.paidOut(), handler.deposited());
    }

    /// The gate holds exactly the sum of the escrows still open.
    function invariant_balanceIsTheSumOfOpenEscrows() public view {
        uint256 open;
        for (uint256 i = 0; i < gate.count(); i++) {
            (,,,,, bool closed, uint256 amount,,) = gate.escrows(i);
            if (!closed) open += amount;
        }
        assertEq(address(gate).balance, open);
    }

    /// Nothing is paid before its batch is recorded, to anyone but the payee or (after the
    /// deadline) the payer, and no escrow pays twice.
    function invariant_paysOnlyWhenAllowedAndOnlyOnce() public view {
        assertEq(handler.violations(), 0);
        for (uint256 i = 0; i < gate.count(); i++) {
            assertLe(handler.closings(i), 1);
        }
    }
}

contract GateHandlerSmokeTest is Test {
    function test_handlerCanRelease() public {
        MockReceipts receipts = new MockReceipts();
        SettlementGate gate = new SettlementGate(receipts);
        GateHandler handler = new GateHandler(gate, receipts);
        handler.open(0, 1 ether, 7, 100);
        handler.recordAnchor(0);
        handler.release(0, false);
        assertEq(handler.releases(), 1);
        assertEq(handler.violations(), 0);
    }
}
