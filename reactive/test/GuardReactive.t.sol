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

/// @notice The whole loop in one EVM: a real vault emits events, they are fed to GuardReactive as the
///         network would, and every callback it requests is delivered back to the vault through the
///         "proxy" with the reactive contract's address written into the first argument.
contract GuardReactiveTest is Test {
    address constant SYSTEM = 0x8888888888888888888888888888888888888888;
    address constant PROXY = address(0xCA11);
    address constant AGENT = address(0xA6E7);
    address constant ALICE = address(0xA11CE);
    address constant ATTACKER = address(0xBADBAD);
    uint256 constant CHAIN = 84532;

    MockSystem sys;
    GuardReactive rx;
    GuardVault vault;
    uint256 delivered;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.etch(SYSTEM, address(new MockSystem()).code);
        sys = MockSystem(payable(SYSTEM));
        rx = new GuardReactive();
        vault = new GuardVault(IPayable(payable(PROXY)), AGENT, 0);
        vault.setGuardian(address(rx));
        vm.deal(address(vault), 10 ether);
        vault.setDailyLimit(address(0), 100 ether);
        vault.requestPayee("alice", ALICE, 1 ether);
        vault.activatePayee("alice");
        rx.watch(CHAIN, address(vault));
        vm.recordLogs();
    }

    // ---- the network, simulated ---------------------------------------------------------

    /// Feed every vault log emitted since the last call to GuardReactive, then deliver its callbacks.
    function _relay() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(vault)) continue;
            IReactive.LogRecord memory r;
            r.chainId = CHAIN;
            r.contractAddress = logs[i].emitter;
            r.topic0 = uint256(logs[i].topics[0]);
            if (logs[i].topics.length > 1) r.topic1 = uint256(logs[i].topics[1]);
            if (logs[i].topics.length > 2) r.topic2 = uint256(logs[i].topics[2]);
            if (logs[i].topics.length > 3) r.topic3 = uint256(logs[i].topics[3]);
            r.data = logs[i].data;
            r.txHash = uint256(keccak256(abi.encode(i, block.timestamp)));
            vm.prank(SYSTEM);
            rx.react(r);
        }
        for (; delivered < sys.cbCount(); ++delivered) {
            ISystemContract.CallbackConfiguration_V_1_0 memory c = sys.cb(delivered);
            assertEq(c.chainId, CHAIN);
            assertGe(c.gasLimit, 100_000, "the network ignores callbacks below 100k gas");
            bytes memory p = c.payload;
            address reactive = address(rx);
            assembly { mstore(add(p, 36), reactive) } // the proxy writes the sender into the first argument
            vm.prank(PROXY);
            (bool ok,) = c.recipient.call{ gas: c.gasLimit }(p);
            assertTrue(ok, "callback failed at the vault");
        }
        if (logs.length > 0) _relay(); // the callbacks emitted vault events too
    }

    function _propose(address to, uint256 amount, bytes32 label) internal returns (IGuardVault.RefusalCode c) {
        vm.prank(AGENT);
        c = vault.proposePayment(to, address(0), amount, label);
    }

    // ---- subscriptions and access ---------------------------------------------------------

    function test_watchSubscribesToSixVaultEvents() public view {
        assertEq(sys.subCount(), 6);
        for (uint256 i; i < 6; ++i) {
            (uint256 chainId, address target,) = sys.subs(i);
            assertEq(chainId, CHAIN);
            assertEq(target, address(vault));
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
        rx.unwatch(CHAIN);
        vm.stopPrank();
    }

    function test_oneVaultPerChain() public {
        vm.expectRevert(GuardReactive.AlreadyWatched.selector);
        rx.watch(CHAIN, address(2));
    }

    function test_reactOnlyFromSystem() public {
        IReactive.LogRecord memory r;
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, address(this), SYSTEM));
        rx.react(r);
    }

    function test_ignoresLogsFromOtherContracts() public {
        IReactive.LogRecord memory r;
        r.chainId = CHAIN;
        r.contractAddress = address(0xBEEF);
        r.topic0 = uint256(IGuardVault.PaymentRefused.selector);
        vm.startPrank(SYSTEM);
        for (uint256 i; i < 5; ++i) rx.react(r);
        vm.stopPrank();
        assertEq(sys.cbCount(), 0);
    }

    function test_unwatchUnsubscribes() public {
        rx.unwatch(CHAIN);
        (address v,,,) = rx.watched(CHAIN);
        assertEq(v, address(0));
        assertEq(rx.chainCount(), 0);
        assertEq(sys.unsubCount(), 6);
    }

    // ---- the rules, end to end ----------------------------------------------------------------

    function test_normalPaymentsDoNothing() public {
        for (uint256 i; i < 3; ++i) {
            assertEq(uint8(_propose(ALICE, 0.1 ether + i, "alice")), 0);
            vm.warp(block.timestamp + 60);
            _relay();
        }
        assertEq(sys.cbCount(), 0);
        assertFalse(vault.frozen());
    }

    function test_unknownRecipientIsQuarantinedOnce() public {
        _propose(ATTACKER, 0.1 ether, "alice");
        _relay();
        assertTrue(vault.quarantined(ATTACKER), "quarantined by the callback");
        assertTrue(rx.quarantinedOn(CHAIN, ATTACKER), "mirrored from the vault's event");
        assertFalse(rx.quarantinePending(CHAIN, ATTACKER));
        // the next try is refused as Quarantined, and no second callback is sent
        assertEq(uint8(_propose(ATTACKER, 0.2 ether, "alice")), uint8(IGuardVault.RefusalCode.Quarantined));
        _relay();
        assertEq(sys.cbCount(), 1);
    }

    function test_repeatedRefusalsFreezeTheVault() public {
        _propose(ALICE, 5 ether, "alice"); // OverCap
        _propose(ALICE, 0.1 ether, "bob"); // LabelMismatch
        _relay();
        assertFalse(vault.frozen());
        _propose(ALICE, 6 ether, "alice"); // third refusal inside the window
        _relay();
        assertTrue(vault.frozen());
        assertTrue(_hasDecision(GuardReactive.Rule.RepeatedRefusals));
        // while frozen, refusals (code Frozen) do not ask again
        uint256 before = sys.cbCount();
        for (uint256 i; i < 4; ++i) _propose(ALICE, 0.1 ether + i, "alice");
        _relay();
        assertEq(sys.cbCount(), before);
    }

    function test_refusalsSpreadOutDoNotFreeze() public {
        for (uint256 i; i < 6; ++i) {
            _propose(ALICE, 5 ether + i, "alice");
            vm.warp(block.timestamp + rx.refusalWindow() / 2 + 1);
            _relay();
        }
        assertFalse(vault.frozen());
    }

    function test_burstFreezesTheVault() public {
        // six different, individually valid payments within the burst window
        for (uint256 i; i < 6; ++i) assertEq(uint8(_propose(ALICE, 0.01 ether + i, "alice")), 0);
        _relay();
        assertTrue(vault.frozen());
        assertTrue(_hasDecision(GuardReactive.Rule.Burst));
    }

    function test_unfreezeResetsAndTheGuardWorksAgain() public {
        for (uint256 i; i < 6; ++i) _propose(ALICE, 0.01 ether + i, "alice");
        _relay();
        assertTrue(vault.frozen());
        vault.unfreeze();
        _relay();
        (, bool frozen,,) = rx.watched(CHAIN);
        assertFalse(frozen);
        vm.warp(block.timestamp + 1 hours);
        for (uint256 i; i < 6; ++i) _propose(ALICE, 0.02 ether + i, "alice");
        _relay();
        assertTrue(vault.frozen(), "frozen again on the second burst");
    }

    function test_releaseIsMirrored() public {
        _propose(ATTACKER, 0.1 ether, "alice");
        _relay();
        vault.release(ATTACKER);
        _relay();
        assertFalse(rx.quarantinedOn(CHAIN, ATTACKER));
    }

    function _hasDecision(GuardReactive.Rule rule) internal returns (bool) {
        // Decisions are emitted by rx; they were consumed by getRecordedLogs, so check by replaying state
        // through the callbacks the system recorded instead.
        for (uint256 i; i < sys.cbCount(); ++i) {
            bytes memory p = sys.cb(i).payload;
            bytes32 reason;
            assembly { reason := mload(add(p, 68)) }
            if (rule == GuardReactive.Rule.Burst && reason == "burst of proposals") return true;
            if (rule == GuardReactive.Rule.RepeatedRefusals && reason == "repeated refusals") return true;
        }
        return false;
    }

    function test_settingsValidated() public {
        vm.expectRevert(GuardReactive.BadSettings.selector);
        rx.setSettings(0, 1, 1, 1);
        rx.setSettings(2, 10, 2, 10);
        assertEq(rx.burstLimit(), 2);
    }
}
