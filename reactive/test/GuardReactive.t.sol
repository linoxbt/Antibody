// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Test, Vm } from "forge-std/Test.sol";
import { IPayable } from "@reactive/src/interfaces/IPayable.sol";
import { ISystemContract } from "@reactive/src/interfaces/ISystemContract.sol";
import { IReactive } from "@reactive/src/interfaces/IReactive.sol";
import { AbstractPayer } from "@reactive/src/base/AbstractPayer.sol";
import { GuardReactive } from "../contracts/GuardReactive.sol";
import { GuardVault } from "../contracts/GuardVault.sol";
import { IGuardVault } from "../contracts/IGuardVault.sol";
import { MockSystem } from "./mocks/Mocks.sol";

/// @notice The whole system in one EVM: two real vaults ("Base Sepolia" and "Sepolia"), their events
///         fed to GuardReactive as the network would, and every callback delivered back through the
///         right chain's "proxy" with the reactive contract's address written into the first argument.
contract GuardReactiveTest is Test {
    address constant SYSTEM = 0x8888888888888888888888888888888888888888;
    address constant CRON_EMITTER = 0x0000000000000000000000000000000000fffFfF;
    uint256 constant CRON100 = 0xb49937fb8970e19fd46d48f7e3fb00d659deac0347f79cd7cb542f0fc1503c70;
    address constant PROXY_A = address(0xCA11A);
    address constant PROXY_B = address(0xCA11B);
    address constant AGENT = address(0xA6E7);
    address constant ALICE = address(0xA11CE);
    address constant ATTACKER = address(0xBADBAD);
    uint256 constant A = 84532;
    uint256 constant B = 11155111;
    uint256 constant LASNA = 5318007;

    MockSystem sys;
    GuardReactive rx;
    GuardVault va;
    GuardVault vb;
    uint256 delivered;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.chainId(LASNA);
        vm.etch(SYSTEM, address(new MockSystem()).code);
        sys = MockSystem(payable(SYSTEM));
        rx = new GuardReactive();
        va = _vault(PROXY_A);
        vb = _vault(PROXY_B);
        rx.watch(A, address(va));
        vm.recordLogs();
    }

    function _vault(address proxy) internal returns (GuardVault v) {
        v = new GuardVault(IPayable(payable(proxy)), AGENT, 0);
        v.setGuardian(address(rx));
        vm.deal(address(v), 10 ether);
        v.setDailyLimit(address(0), 100 ether);
        v.requestPayee("alice", ALICE, 1 ether);
        v.activatePayee("alice");
    }

    // ---- the network, simulated ---------------------------------------------------------

    function _chainOf(address emitter) internal view returns (uint256) {
        if (emitter == address(va)) return A;
        if (emitter == address(vb)) return B;
        return 0;
    }

    function _vaultOf(uint256 chainId) internal view returns (GuardVault) {
        return chainId == A ? va : vb;
    }

    /// Feed every vault log since the last call to GuardReactive, then deliver its callbacks; repeat
    /// until quiet (callbacks emit vault events too).
    function _relay() internal {
        for (uint256 round; round < 10; ++round) {
            Vm.Log[] memory logs = vm.getRecordedLogs();
            for (uint256 i; i < logs.length; ++i) {
                uint256 chainId = _chainOf(logs[i].emitter);
                if (chainId == 0) continue;
                IReactive.LogRecord memory r;
                r.chainId = chainId;
                r.contractAddress = logs[i].emitter;
                r.topic0 = uint256(logs[i].topics[0]);
                if (logs[i].topics.length > 1) r.topic1 = uint256(logs[i].topics[1]);
                if (logs[i].topics.length > 2) r.topic2 = uint256(logs[i].topics[2]);
                if (logs[i].topics.length > 3) r.topic3 = uint256(logs[i].topics[3]);
                r.data = logs[i].data;
                r.txHash = uint256(keccak256(abi.encode(round, i, block.timestamp)));
                vm.prank(SYSTEM);
                rx.react(r);
            }
            if (!_deliver() && logs.length == 0) return;
        }
        revert("relay did not settle");
    }

    function _deliver() internal returns (bool any) {
        for (; delivered < sys.cbCount(); ++delivered) {
            any = true;
            ISystemContract.CallbackConfiguration_V_1_0 memory c = sys.cb(delivered);
            assertGe(c.gasLimit, 100_000, "the network ignores callbacks below 100k gas");
            GuardVault v = _vaultOf(c.chainId);
            assertEq(c.recipient, address(v), "callback to the vault on its own chain");
            bytes memory p = c.payload;
            address reactive = address(rx);
            assembly { mstore(add(p, 36), reactive) } // the proxy writes the sender into the first argument
            vm.prank(c.chainId == A ? PROXY_A : PROXY_B);
            (bool ok,) = c.recipient.call{ gas: c.gasLimit }(p);
            assertTrue(ok, "callback failed at the vault");
        }
    }

    function _cronTick() internal {
        IReactive.LogRecord memory r;
        r.chainId = LASNA;
        r.contractAddress = CRON_EMITTER;
        r.topic0 = CRON100;
        r.data = abi.encode(block.number);
        vm.prank(SYSTEM);
        rx.react(r);
        _relay();
    }

    function _propose(GuardVault v, address to, uint256 amount, bytes32 label) internal returns (IGuardVault.RefusalCode c) {
        vm.prank(AGENT);
        c = v.proposePayment(to, address(0), amount, label);
    }

    // ---- subscriptions and access ---------------------------------------------------------

    function test_watchSubscribesToTenVaultEvents() public view {
        assertEq(sys.subCount(), 10);
        for (uint256 i; i < 10; ++i) {
            (uint256 chainId, address target,) = sys.subs(i);
            assertEq(chainId, A);
            assertEq(target, address(va));
        }
        (, , uint256 refused) = sys.subs(1);
        assertEq(refused, uint256(IGuardVault.PaymentRefused.selector));
    }

    function test_onlyOwnerConfigures() public {
        vm.startPrank(address(0xBAD));
        vm.expectRevert(GuardReactive.NotOwner.selector);
        rx.watch(1, address(1));
        vm.expectRevert(GuardReactive.NotOwner.selector);
        rx.setSettings(1, 1, 1, 1);
        vm.expectRevert(GuardReactive.NotOwner.selector);
        rx.unwatch(A);
        vm.expectRevert(GuardReactive.NotOwner.selector);
        rx.immunize(A, 0, 1);
        vm.expectRevert(GuardReactive.NotOwner.selector);
        rx.setCronTopic(1);
        vm.stopPrank();
    }

    function test_oneVaultPerChain() public {
        vm.expectRevert(GuardReactive.AlreadyWatched.selector);
        rx.watch(A, address(2));
    }

    function test_reactOnlyFromSystem() public {
        IReactive.LogRecord memory r;
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, address(this), SYSTEM));
        rx.react(r);
    }

    function test_ignoresLogsFromOtherContracts() public {
        IReactive.LogRecord memory r;
        r.chainId = A;
        r.contractAddress = address(0xBEEF);
        r.topic0 = uint256(IGuardVault.PaymentRefused.selector);
        vm.startPrank(SYSTEM);
        for (uint256 i; i < 5; ++i) rx.react(r);
        vm.stopPrank();
        assertEq(sys.cbCount(), 0);
    }

    function test_unwatchUnsubscribes() public {
        rx.unwatch(A);
        (address v,,,,,) = rx.watched(A);
        assertEq(v, address(0));
        assertEq(rx.chainCount(), 0);
        assertEq(sys.unsubCount(), 10);
    }

    // ---- single-chain rules -------------------------------------------------------------------

    function test_normalPaymentsDoNothing() public {
        for (uint256 i; i < 3; ++i) {
            assertEq(uint8(_propose(va, ALICE, 0.1 ether + i, "alice")), 0);
            vm.warp(block.timestamp + 60);
            _relay();
        }
        assertEq(sys.cbCount(), 0);
        assertFalse(va.frozen());
    }

    function test_unknownRecipientIsQuarantinedOnceAndLearned() public {
        _propose(va, ATTACKER, 0.1 ether, "alice");
        _relay();
        assertTrue(va.quarantined(ATTACKER));
        assertTrue(rx.quarantinedOn(A, ATTACKER));
        assertEq(rx.quarantineRequestedAt(A, ATTACKER), 0, "confirmed");
        assertTrue(rx.knownBad(ATTACKER));
        assertEq(rx.lessonCount(), 1);
        assertEq(uint8(_propose(va, ATTACKER, 0.2 ether, "alice")), uint8(IGuardVault.RefusalCode.Quarantined));
        _relay();
        assertEq(sys.cbCount(), 1, "no second quarantine request");
    }

    function test_repeatedRefusalsFreezeTheVault() public {
        _propose(va, ALICE, 5 ether, "alice"); // OverCap
        _propose(va, ALICE, 0.1 ether, "bob"); // LabelMismatch
        _relay();
        assertFalse(va.frozen());
        _propose(va, ALICE, 6 ether, "alice");
        _relay();
        assertTrue(va.frozen());
        uint256 before = sys.cbCount();
        for (uint256 i; i < 4; ++i) _propose(va, ALICE, 0.1 ether + i, "alice"); // refused as Frozen
        _relay();
        assertEq(sys.cbCount(), before, "no second freeze request");
    }

    function test_refusalsSpreadOutDoNotFreeze() public {
        for (uint256 i; i < 6; ++i) {
            _propose(va, ALICE, 5 ether + i, "alice");
            vm.warp(block.timestamp + rx.refusalWindow() / 2 + 1);
            _relay();
        }
        assertFalse(va.frozen());
    }

    function test_burstFreezesAndUnfreezeResets() public {
        for (uint256 i; i < 6; ++i) assertEq(uint8(_propose(va, ALICE, 0.01 ether + i, "alice")), 0);
        _relay();
        assertTrue(va.frozen());
        va.unfreeze();
        _relay();
        (, bool frozen, bool confirmed,,,) = rx.watched(A);
        assertFalse(frozen);
        assertFalse(confirmed);
        vm.warp(block.timestamp + 1 hours);
        for (uint256 i; i < 6; ++i) _propose(va, ALICE, 0.02 ether + i, "alice");
        _relay();
        assertTrue(va.frozen(), "frozen again on the second burst");
    }

    function test_releaseIsMirroredButTheLessonStays() public {
        _propose(va, ATTACKER, 0.1 ether, "alice");
        _relay();
        va.release(ATTACKER);
        _relay();
        assertFalse(rx.quarantinedOn(A, ATTACKER));
        assertTrue(rx.knownBad(ATTACKER));
    }

    function test_gasLimitPerChain() public {
        assertEq(rx.gasLimitFor(A), rx.DEFAULT_GAS_LIMIT());
        rx.setGasLimit(B, 500_000);
        assertEq(rx.gasLimitFor(B), 500_000);
        vm.expectRevert(GuardReactive.BadSettings.selector);
        rx.setGasLimit(B, 99_999);
        rx.watch(B, address(vb));
        _propose(va, ATTACKER, 0.1 ether, "alice");
        _relay();
        uint256 n = sys.cbCount();
        ISystemContract.CallbackConfiguration_V_1_0 memory toA = sys.cb(0);
        ISystemContract.CallbackConfiguration_V_1_0 memory toB = sys.cb(n - 1);
        assertEq(toA.chainId, A);
        assertEq(toA.gasLimit, rx.DEFAULT_GAS_LIMIT());
        assertEq(toB.chainId, B);
        assertEq(toB.gasLimit, 500_000, "the Sepolia callback uses Sepolia's limit");
    }

    function test_ownerWithdraws() public {
        vm.deal(address(rx), 1 ether);
        vm.prank(address(0xBAD));
        vm.expectRevert(GuardReactive.NotOwner.selector);
        rx.withdraw(payable(address(0xBAD)), 1);
        rx.withdraw(payable(address(0xF00D)), 0.4 ether);
        assertEq(address(0xF00D).balance, 0.4 ether);
    }

    function test_settingsValidated() public {
        vm.expectRevert(GuardReactive.BadSettings.selector);
        rx.setSettings(0, 1, 1, 1);
        rx.setSettings(2, 10, 2, 10);
        assertEq(rx.burstLimit(), 2);
    }

    // ---- across chains: learned once, blocked everywhere --------------------------------------

    function test_attackerSeenOnOneChainIsQuarantinedOnTheOther() public {
        rx.watch(B, address(vb));
        _propose(va, ATTACKER, 0.1 ether, "alice");
        _relay();
        assertTrue(va.quarantined(ATTACKER), "quarantined where it was seen");
        assertTrue(vb.quarantined(ATTACKER), "and on the other chain");
        assertTrue(rx.quarantinedOn(B, ATTACKER));
        assertEq(uint8(_propose(vb, ATTACKER, 0.1 ether, "alice")), uint8(IGuardVault.RefusalCode.Quarantined));
    }

    function test_aVaultWatchedLaterIsImmunized() public {
        _propose(va, ATTACKER, 0.1 ether, "alice");
        _relay();
        assertFalse(vb.quarantined(ATTACKER));
        rx.watch(B, address(vb)); // the new vault gets every lesson so far
        _relay();
        assertTrue(vb.quarantined(ATTACKER));
    }

    function test_payeeChangeToAKnownAttackerIsVetoed() public {
        rx.watch(B, address(vb));
        _propose(va, ATTACKER, 0.1 ether, "alice");
        _relay();
        // on the other chain, someone with the owner's session tries to point "alice" at the attacker
        vm.prank(address(this));
        vb.requestPayee("alice", ATTACKER, 1 ether);
        _relay();
        (, , address pendingTo,, uint256 effectiveAt) = vb.payees("alice");
        assertEq(pendingTo, address(0), "the change was vetoed");
        assertEq(effectiveAt, 0);
        vm.expectRevert(GuardVault.NoPendingChange.selector);
        vb.activatePayee("alice");
    }

    function test_quarantinedAddressCannotBeActivatedEvenWithoutAVeto() public {
        _propose(va, ATTACKER, 0.1 ether, "alice");
        _relay();
        va.setPayeeDelay(1 hours);
        va.requestPayee("mallory", ATTACKER, 1 ether);
        // simulate a lost veto: do not relay; the vault's own check still holds
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(GuardVault.QuarantinedPayee.selector);
        va.activatePayee("mallory");
    }

    // ---- retries -----------------------------------------------------------------------------------

    function test_lostFreezeCanBeRetriedByAnyoneAfterTheDelay() public {
        for (uint256 i; i < 6; ++i) _propose(va, ALICE, 0.01 ether + i, "alice");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        // deliver the logs to GuardReactive but "lose" the callback
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(va)) continue;
            IReactive.LogRecord memory r;
            r.chainId = A;
            r.contractAddress = address(va);
            r.topic0 = uint256(logs[i].topics[0]);
            vm.prank(SYSTEM);
            rx.react(r);
        }
        delivered = sys.cbCount(); // dropped
        assertFalse(va.frozen());
        vm.expectRevert(GuardReactive.NothingToRetry.selector);
        rx.retryFreeze(A);
        vm.warp(block.timestamp + rx.RETRY_AFTER());
        vm.prank(address(0xD00D));
        rx.retryFreeze(A);
        _relay();
        assertTrue(va.frozen());
        vm.expectRevert(GuardReactive.NothingToRetry.selector);
        rx.retryFreeze(A); // confirmed now
    }

    function test_repeatedDeliveryIsHarmless() public {
        _propose(va, ATTACKER, 0.1 ether, "alice");
        _relay();
        // the network delivers the same quarantine callback again
        ISystemContract.CallbackConfiguration_V_1_0 memory c = sys.cb(0);
        bytes memory p = c.payload;
        address reactive = address(rx);
        assembly { mstore(add(p, 36), reactive) }
        vm.prank(PROXY_A);
        (bool ok,) = address(va).call(p);
        assertTrue(ok);
        assertTrue(va.quarantined(ATTACKER));
    }

    // ---- recurring payments on CRON -------------------------------------------------------------

    function test_scheduleTurnsCronOnAndPaysWhenDue() public {
        uint256 id = va.setSchedule("alice", address(0), 0.05 ether, 15 minutes, uint64(block.timestamp));
        _relay();
        assertTrue(rx.cronOn(), "cron subscribed while a schedule is active");
        (uint256 chainId, address target, uint256 topic) = sys.subs(sys.subCount() - 1);
        assertEq(chainId, LASNA);
        assertEq(target, CRON_EMITTER);
        assertEq(topic, CRON100);

        _cronTick();
        assertEq(ALICE.balance, 0.05 ether, "paid on the first tick");
        _cronTick();
        assertEq(ALICE.balance, 0.05 ether, "not due again yet");
        vm.warp(block.timestamp + 15 minutes);
        _cronTick();
        assertEq(ALICE.balance, 0.1 ether, "paid again when due");
        (,,,, uint64 nextDue,) = va.schedules(id);
        (,,, uint64 mirrored,) = rx.schedules(0);
        assertEq(mirrored, nextDue, "next due time mirrored from the vault");
    }

    function test_cancellingTheLastScheduleTurnsCronOff() public {
        uint256 id = va.setSchedule("alice", address(0), 0.05 ether, 15 minutes, uint64(block.timestamp));
        _relay();
        uint256 unsubs = sys.unsubCount();
        va.cancelSchedule(id);
        _relay();
        assertFalse(rx.cronOn());
        assertEq(sys.unsubCount(), unsubs + 1);
        _cronTick();
        assertEq(ALICE.balance, 0);
    }

    function test_scheduledPaymentsFollowTheRulesAndStopWhileFrozen() public {
        va.setSchedule("alice", address(0), 2 ether, 15 minutes, uint64(block.timestamp)); // over alice's cap
        _relay();
        _cronTick();
        assertEq(ALICE.balance, 0, "refused under the usual rules");
        va.freezeNow("owner");
        _relay();
        uint256 before = sys.cbCount();
        vm.warp(block.timestamp + 15 minutes);
        _cronTick();
        assertEq(sys.cbCount(), before, "no payment requested while the vault is frozen");
    }

    function test_payDueIsIdempotent() public {
        uint256 id = va.setSchedule("alice", address(0), 0.05 ether, 15 minutes, uint64(block.timestamp));
        vm.startPrank(PROXY_A);
        va.payDue(address(rx), id);
        va.payDue(address(rx), id); // a repeated delivery
        vm.stopPrank();
        assertEq(ALICE.balance, 0.05 ether);
    }
}
