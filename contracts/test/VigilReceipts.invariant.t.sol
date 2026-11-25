// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AnchorReceipt, BatchAttestation, ReceiptVerifier} from "../src/ReceiptVerifier.sol";
import {VigilReceipts} from "../src/VigilReceipts.sol";
import {MockKeyStatus, MockVerify} from "./VigilReceipts.t.sol";

address constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
address constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;

function filled(uint256 length, bytes1 value) pure returns (bytes memory out) {
    out = new bytes(length);
    for (uint256 i = 0; i < length; i++) {
        out[i] = value;
    }
}

/// @dev Drives VigilReceipts with honest records, forgeries, replays and unregistered signers,
///      and keeps a ghost copy of everything that should be on record.
contract ReceiptsHandler is Test {
    VigilReceipts internal immutable receipts;
    MockVerify internal immutable verify;

    address[3] internal signers = [address(0xA11CE), address(0xB0B), address(0xCA401)];
    address internal constant UNREGISTERED = address(0xBAD);
    bytes internal signature = filled(4627, 0x22);

    struct Recorded {
        bytes32 id;
        address signer;
        uint64 atBlock;
        VigilReceipts.Kind kind;
    }

    Recorded[] internal recorded;
    AnchorReceipt[] internal anchors;
    address[] internal anchorSigners;
    BatchAttestation[] internal attestations;
    address[] internal attestationSigners;

    /// @dev Number of calls the contract accepted although it must have refused them.
    uint256 public violations;
    uint256 public refusals;

    constructor(VigilReceipts receipts_, MockKeyStatus keyStatus, MockVerify verify_) {
        receipts = receipts_;
        verify = verify_;
        for (uint256 i = 0; i < signers.length; i++) {
            keyStatus.set(signers[i], true, 1, _key(i), true);
        }
    }

    function recordedCount() external view returns (uint256) {
        return recorded.length;
    }

    function recordedAt(uint256 i) external view returns (Recorded memory) {
        return recorded[i];
    }

    function anchorCount() external view returns (uint256) {
        return anchors.length;
    }

    function anchorAt(uint256 i) external view returns (address, AnchorReceipt memory) {
        return (anchorSigners[i], anchors[i]);
    }

    function attestationCount() external view returns (uint256) {
        return attestations.length;
    }

    function attestationAt(uint256 i) external view returns (address, BatchAttestation memory) {
        return (attestationSigners[i], attestations[i]);
    }

    // --- actions ---------------------------------------------------------------

    /// @dev A correctly signed anchor: recorded once, a second copy is refused.
    function recordSignedAnchor(uint256 who, uint64 height, bytes32 root, uint64 txCount, uint8 blocks) external {
        vm.roll(block.number + blocks);
        uint256 s = who % signers.length;
        AnchorReceipt memory r = _anchor(height, root, txCount);
        verify.accept(_key(s), signature, receipts.anchorMessage(r));
        bool already = receipts.isAnchorRecorded(signers[s], r);
        try receipts.recordAnchor(signers[s], r, signature) returns (bytes32 id) {
            if (already) violations++;
            recorded.push(Recorded(id, signers[s], uint64(block.number), VigilReceipts.Kind.Anchor));
            anchors.push(r);
            anchorSigners.push(signers[s]);
        } catch {
            if (!already) violations++;
            refusals++;
        }
    }

    /// @dev A correctly signed attestation.
    function recordSignedAttestation(uint256 who, uint64 batch, bytes32 root, bytes32 dataHash, bool withdrawals)
        external
    {
        uint256 s = who % signers.length;
        BatchAttestation memory a = _attestation(batch, root, dataHash, withdrawals);
        verify.accept(_key(s), signature, receipts.attestationMessage(a));
        bool already = receipts.isAttestationRecorded(signers[s], a);
        try receipts.recordAttestation(signers[s], a, signature) returns (bytes32 id) {
            if (already) violations++;
            recorded.push(Recorded(id, signers[s], uint64(block.number), VigilReceipts.Kind.Attestation));
            attestations.push(a);
            attestationSigners.push(signers[s]);
        } catch {
            if (!already) violations++;
            refusals++;
        }
    }

    /// @dev An anchor nobody signed: must always be refused.
    function recordForgedAnchor(uint256 who, uint64 height, bytes32 root, uint64 txCount) external {
        uint256 s = who % signers.length;
        AnchorReceipt memory r = _anchor(height, root, txCount);
        if (receipts.isAnchorRecorded(signers[s], r)) return;
        // The verifier only ever accepts the honest signature bytes, never these.
        try receipts.recordAnchor(signers[s], r, filled(4627, 0x33)) {
            violations++;
        } catch {
            refusals++;
        }
    }

    /// @dev Another signer's anchor presented under a signer that did not sign it.
    function recordUnderAnotherSigner(uint256 i, uint256 who) external {
        if (anchors.length == 0) return;
        i %= anchors.length;
        address other = signers[who % signers.length];
        if (other == anchorSigners[i] || receipts.isAnchorRecorded(other, anchors[i])) return;
        try receipts.recordAnchor(other, anchors[i], signature) {
            violations++;
        } catch {
            refusals++;
        }
    }

    /// @dev An anchor for an account with no registered key.
    function recordUnregistered(uint64 height, bytes32 root) external {
        try receipts.recordAnchor(UNREGISTERED, _anchor(height, root, 1), signature) {
            violations++;
        } catch {
            refusals++;
        }
    }

    /// @dev Replays an existing record: always refused.
    function replay(uint256 i) external {
        if (anchors.length == 0) return;
        i %= anchors.length;
        try receipts.recordAnchor(anchorSigners[i], anchors[i], signature) {
            violations++;
        } catch {
            refusals++;
        }
    }

    /// @dev Sends value to the contract: it has no payable entry point.
    function sendValue(uint96 amount) external {
        vm.deal(address(this), amount);
        (bool ok,) = address(receipts).call{value: amount}("");
        if (ok && amount > 0) violations++;
    }

    // --- helpers -------------------------------------------------------------

    function _key(uint256 s) internal pure returns (bytes memory) {
        return filled(2592, bytes1(uint8(0x11 + s)));
    }

    function _anchor(uint64 height, bytes32 root, uint64 txCount) internal pure returns (AnchorReceipt memory) {
        return AnchorReceipt({
            chainId: "qorechain-diana",
            layerId: "vigil-1",
            layerHeight: height,
            stateRoot: root,
            validatorSetHash: "",
            txCount: txCount
        });
    }

    function _attestation(uint64 batch, bytes32 root, bytes32 dataHash, bool withdrawals)
        internal
        pure
        returns (BatchAttestation memory)
    {
        return BatchAttestation({
            chainId: "qorechain-diana",
            rollupId: "vigil-1",
            batchIndex: batch,
            stateRoot: root,
            withdrawalsRoot: withdrawals ? abi.encodePacked(keccak256(abi.encode(root))) : bytes(""),
            dataHash: dataHash
        });
    }
}

/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 40
/// forge-config: default.invariant.fail-on-revert = true
contract VigilReceiptsInvariantTest is Test {
    VigilReceipts internal receipts;
    ReceiptsHandler internal handler;

    function setUp() public {
        receipts = new VigilReceipts();
        vm.etch(PQC_KEY_STATUS, address(new MockKeyStatus()).code);
        vm.etch(PQC_VERIFY, address(new MockVerify()).code);
        handler = new ReceiptsHandler(receipts, MockKeyStatus(PQC_KEY_STATUS), MockVerify(PQC_VERIFY));
        targetContract(address(handler));
    }

    /// Nothing that lacks a valid signature from a registered key is ever recorded, and no
    /// receipt is recorded twice.
    function invariant_onlySignedReceiptsAreRecordedAndOnlyOnce() public view {
        assertEq(handler.violations(), 0);
    }

    /// A record never changes or disappears once written.
    function invariant_recordsAreImmutable() public view {
        uint256 n = handler.recordedCount();
        for (uint256 i = 0; i < n; i++) {
            ReceiptsHandler.Recorded memory want = handler.recordedAt(i);
            (address signer, uint64 atBlock, VigilReceipts.Kind kind) = receipts.records(want.id);
            assertEq(signer, want.signer);
            assertEq(atBlock, want.atBlock);
            assertEq(uint8(kind), uint8(want.kind));
        }
    }

    /// Every recorded anchor and attestation is reported as such, and never as the other kind.
    function invariant_lookupsMatchWhatWasRecorded() public view {
        for (uint256 i = 0; i < handler.anchorCount(); i++) {
            (address signer, AnchorReceipt memory r) = handler.anchorAt(i);
            assertTrue(receipts.isAnchorRecorded(signer, r));
        }
        for (uint256 i = 0; i < handler.attestationCount(); i++) {
            (address signer, BatchAttestation memory a) = handler.attestationAt(i);
            assertTrue(receipts.isAttestationRecorded(signer, a));
        }
        uint256 n = handler.recordedCount();
        for (uint256 i = 0; i < n; i++) {
            ReceiptsHandler.Recorded memory want = handler.recordedAt(i);
            assertTrue(want.kind != VigilReceipts.Kind.None);
        }
    }

    /// Distinct records have distinct ids.
    function invariant_idsAreDistinct() public view {
        uint256 n = handler.recordedCount();
        for (uint256 i = 0; i < n; i++) {
            for (uint256 j = i + 1; j < n; j++) {
                assertTrue(handler.recordedAt(i).id != handler.recordedAt(j).id);
            }
        }
    }

    /// The contract never holds funds.
    function invariant_holdsNoFunds() public view {
        assertEq(address(receipts).balance, 0);
    }
}

/// @dev Property tests over arbitrary fields.
contract VigilReceiptsFuzzTest is Test {
    VigilReceipts internal receipts;
    MockKeyStatus internal keyStatus;
    MockVerify internal verify;
    address internal signer = address(0xA11CE);
    bytes internal publicKey = filled(2592, 0x11);
    bytes internal signature = filled(4627, 0x22);

    function setUp() public {
        receipts = new VigilReceipts();
        vm.etch(PQC_KEY_STATUS, address(new MockKeyStatus()).code);
        vm.etch(PQC_VERIFY, address(new MockVerify()).code);
        keyStatus = MockKeyStatus(PQC_KEY_STATUS);
        verify = MockVerify(PQC_VERIFY);
        keyStatus.set(signer, true, 1, publicKey, true);
    }

    function _receipt(string memory chainId, string memory layerId, uint64 h, bytes32 root, bytes memory vsh, uint64 n)
        internal
        pure
        returns (AnchorReceipt memory)
    {
        return AnchorReceipt(chainId, layerId, h, root, vsh, n);
    }

    function _bound(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        if (b.length == 0) return "x";
        if (b.length <= 128) return s;
        bytes memory out = new bytes(128);
        for (uint256 i = 0; i < 128; i++) {
            out[i] = b[i];
        }
        return string(out);
    }

    /// A recorded anchor is found again with exactly its fields; changing any one field is not.
    function testFuzz_recordedAnchor_isFoundOnlyWithItsExactFields(
        string memory chainId,
        string memory layerId,
        uint64 height,
        bytes32 root,
        uint64 txCount,
        uint8 field,
        uint256 change
    ) public {
        chainId = _bound(chainId);
        layerId = _bound(layerId);
        AnchorReceipt memory r = _receipt(chainId, layerId, height, root, "", txCount);
        verify.accept(publicKey, signature, receipts.anchorMessage(r));
        bytes32 id = receipts.recordAnchor(signer, r, signature);
        assertTrue(receipts.isAnchorRecorded(signer, r));
        (address who,, VigilReceipts.Kind kind) = receipts.records(id);
        assertEq(who, signer);
        assertEq(uint8(kind), uint8(VigilReceipts.Kind.Anchor));

        AnchorReceipt memory m = _receipt(chainId, layerId, height, root, "", txCount);
        field %= 5;
        change = bound(change, 1, type(uint64).max);
        if (field == 0) m.layerHeight = height ^ uint64(change);
        else if (field == 1) m.stateRoot = root ^ bytes32(change);
        else if (field == 2) m.txCount = txCount ^ uint64(change);
        else if (field == 3) m.layerId = string.concat(layerId, "!");
        else m.validatorSetHash = abi.encodePacked(bytes1(uint8(change)));
        if (bytes(m.layerId).length > 128) m.layerId = "y";
        if (keccak256(receipts.anchorMessage(m)) == keccak256(receipts.anchorMessage(r))) return;
        assertFalse(receipts.isAnchorRecorded(signer, m));
        assertFalse(receipts.isAnchorRecorded(address(0xB0B), r));
    }

    /// Any signature the verifier does not accept is refused and leaves nothing behind.
    function testFuzz_unacceptedSignature_isRefusedAndRecordsNothing(uint64 height, bytes32 root, bytes1 fill) public {
        AnchorReceipt memory r = _receipt("qorechain-diana", "vigil-1", height, root, "", 1);
        bytes memory forged = filled(4627, fill);
        if (keccak256(forged) == keccak256(signature)) return;
        verify.accept(publicKey, signature, receipts.anchorMessage(r));
        vm.expectRevert(VigilReceipts.InvalidSignature.selector);
        receipts.recordAnchor(signer, r, forged);
        assertFalse(receipts.isAnchorRecorded(signer, r));
    }

    /// A signature of any length other than ML-DSA-87's is refused before any lookup.
    function testFuzz_wrongSignatureLength_isRefused(uint16 length) public {
        vm.assume(length != 4627);
        AnchorReceipt memory r = _receipt("qorechain-diana", "vigil-1", 1, bytes32(uint256(1)), "", 1);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVerifier.InvalidSignatureLength.selector, uint256(length)));
        receipts.checkAnchor(signer, r, new bytes(length));
    }

    /// An attestation is bound to its deployment: the same fields give a different message
    /// for another VigilReceipts at another address.
    function testFuzz_attestationMessage_isBoundToTheDeployment(uint64 batch, bytes32 root, bytes32 dataHash) public {
        VigilReceipts other = new VigilReceipts();
        BatchAttestation memory a = BatchAttestation("qorechain-diana", "vigil-1", batch, root, "", dataHash);
        assertTrue(keccak256(receipts.attestationMessage(a)) != keccak256(other.attestationMessage(a)));
    }
}
