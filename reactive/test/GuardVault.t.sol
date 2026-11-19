// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { IPayable } from "@reactive/src/interfaces/IPayable.sol";
import { AbstractPayer } from "@reactive/src/base/AbstractPayer.sol";
import { GuardVault } from "../contracts/GuardVault.sol";
import { IGuardVault } from "../contracts/IGuardVault.sol";
import { MockToken, RefusingPayee } from "./mocks/Mocks.sol";

contract GuardVaultTest is Test {
    address constant PROXY = address(0xCA11);
    address constant GUARDIAN = address(0x6A2D);
    address constant AGENT = address(0xA6E7);
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);
    address constant ETH = address(0);
    bytes32 constant L_ALICE = "alice";
    bytes32 constant L_BOB = "bob";
    uint256 constant DELAY = 1 hours;

    GuardVault vault;

    function setUp() public {
        vm.warp(1_800_000_000);
        vault = new GuardVault(IPayable(payable(PROXY)), AGENT, DELAY);
        vault.setGuardian(GUARDIAN);
        vm.deal(address(vault), 100 ether);
        vault.setDailyLimit(ETH, 5 ether);
        _addPayee(L_ALICE, ALICE, 1 ether);
        _addPayee(L_BOB, BOB, 2 ether);
    }

    function _addPayee(bytes32 label, address to, uint256 cap) internal {
        vault.requestPayee(label, to, cap);
        vm.warp(block.timestamp + DELAY);
        vault.activatePayee(label);
    }

    function _pay(address to, uint256 amount, bytes32 label) internal returns (IGuardVault.RefusalCode) {
        vm.prank(AGENT);
        return vault.proposePayment(to, ETH, amount, label);
    }

    function _code(IGuardVault.RefusalCode c) internal pure returns (uint8) { return uint8(c); }

    // ---- the happy path ----------------------------------------------------------------

    function test_paysARegisteredPayee() public {
        vm.expectEmit(address(vault));
        emit IGuardVault.PaymentProposed(1, ALICE, ETH, 0.5 ether, L_ALICE);
        vm.expectEmit(address(vault));
        emit IGuardVault.PaymentExecuted(1, ALICE, ETH, 0.5 ether);
        assertEq(_code(_pay(ALICE, 0.5 ether, L_ALICE)), 0);
        assertEq(ALICE.balance, 0.5 ether);
        assertEq(vault.spentOnDay(ETH), 0.5 ether);
    }

    function test_onlyTheAgentProposes() public {
        vm.expectRevert(GuardVault.NotAgent.selector);
        vault.proposePayment(ALICE, ETH, 1, L_ALICE);
    }

    // ---- each rule refuses, as an event (never a revert) ---------------------------------

    function _expectRefusal(address to, uint256 amount, bytes32 label, IGuardVault.RefusalCode want) internal {
        uint256 id = vault.proposalCount() + 1;
        vm.expectEmit(address(vault));
        emit IGuardVault.PaymentRefused(id, to, uint8(want), amount);
        uint256 before = to.balance;
        assertEq(_code(_pay(to, amount, label)), _code(want));
        assertEq(to.balance, before, "nothing paid");
    }

    function test_refusesWhenFrozen() public {
        vault.freezeNow("test");
        _expectRefusal(ALICE, 0.1 ether, L_ALICE, IGuardVault.RefusalCode.Frozen);
    }

    function test_refusesQuarantined() public {
        vm.prank(PROXY);
        vault.quarantine(GUARDIAN, ALICE, "drainer");
        _expectRefusal(ALICE, 0.1 ether, L_ALICE, IGuardVault.RefusalCode.Quarantined);
    }

    function test_refusesUnknownPayee() public {
        _expectRefusal(address(0xE11), 0.1 ether, L_ALICE, IGuardVault.RefusalCode.UnknownPayee);
    }

    function test_refusesLabelMismatch() public {
        // the agent was told "pay alice" but the address it was given is bob's
        _expectRefusal(BOB, 0.1 ether, L_ALICE, IGuardVault.RefusalCode.LabelMismatch);
    }

    function test_refusesOverCap() public {
        _expectRefusal(ALICE, 1 ether + 1, L_ALICE, IGuardVault.RefusalCode.OverCap);
        _expectRefusal(ALICE, 0, L_ALICE, IGuardVault.RefusalCode.OverCap);
    }

    function test_refusesOverDailyLimit_andResetsNextDay() public {
        assertEq(_code(_pay(BOB, 2 ether, L_BOB)), 0);
        assertEq(_code(_pay(BOB, 1.9 ether, L_BOB)), 0);
        assertEq(_code(_pay(ALICE, 1 ether, L_ALICE)), 0); // 4.9 spent
        _expectRefusal(ALICE, 0.2 ether, L_ALICE, IGuardVault.RefusalCode.OverDailyLimit);
        vm.warp(block.timestamp + 1 days);
        assertEq(_code(_pay(ALICE, 0.2 ether, L_ALICE)), 0);
        assertEq(vault.spentOnDay(ETH), 0.2 ether);
    }

    function test_tokenWithoutLimitCannotBePaid() public {
        MockToken t = new MockToken();
        t.mint(address(vault), 100);
        vm.prank(AGENT);
        assertEq(_code(vault.proposePayment(ALICE, address(t), 10, L_ALICE)), _code(IGuardVault.RefusalCode.OverDailyLimit));
    }

    function test_refusesDuplicateWithinWindow() public {
        assertEq(_code(_pay(ALICE, 0.3 ether, L_ALICE)), 0);
        _expectRefusal(ALICE, 0.3 ether, L_ALICE, IGuardVault.RefusalCode.Duplicate);
        assertEq(_code(_pay(ALICE, 0.31 ether, L_ALICE)), 0, "a different amount is not a duplicate");
        vm.warp(block.timestamp + vault.DUPLICATE_WINDOW());
        assertEq(_code(_pay(ALICE, 0.3 ether, L_ALICE)), 0);
    }

    function test_failedTransferIsRefusedAndRolledBack() public {
        RefusingPayee r = new RefusingPayee();
        _addPayee("refuser", address(r), 1 ether);
        _expectRefusal(address(r), 0.5 ether, "refuser", IGuardVault.RefusalCode.TransferFailed);
        assertEq(vault.spentOnDay(ETH), 0);
        assertEq(vault.lastPaidAt(keccak256(abi.encode(address(r), ETH, uint256(0.5 ether)))), 0);
    }

    // ---- ERC-20 -----------------------------------------------------------------------

    function test_paysErc20_includingTokensThatReturnNothing() public {
        MockToken t = new MockToken();
        t.mint(address(vault), 1000);
        vault.setDailyLimit(address(t), 500);
        vm.startPrank(AGENT);
        assertEq(_code(vault.proposePayment(ALICE, address(t), 100, L_ALICE)), 0);
        t.setQuiet(true);
        assertEq(_code(vault.proposePayment(ALICE, address(t), 101, L_ALICE)), 0);
        t.setBroken(true);
        assertEq(_code(vault.proposePayment(ALICE, address(t), 102, L_ALICE)), _code(IGuardVault.RefusalCode.TransferFailed));
        vm.stopPrank();
        assertEq(t.balanceOf(ALICE), 201);
        assertEq(vault.spentOnDay(address(t)), 201);
    }

    // ---- payee timelock ---------------------------------------------------------------

    function test_newPayeeWaitsForTheDelay() public {
        address carol = address(0xCA01);
        vault.requestPayee("carol", carol, 1 ether);
        _expectRefusal(carol, 0.1 ether, "carol", IGuardVault.RefusalCode.UnknownPayee);
        vm.expectRevert(abi.encodeWithSelector(GuardVault.TooEarly.selector, block.timestamp + DELAY));
        vault.activatePayee("carol");
        vm.warp(block.timestamp + DELAY);
        vm.prank(address(0xD00D)); // anyone may activate once the delay has passed
        vault.activatePayee("carol");
        assertEq(_code(_pay(carol, 0.1 ether, "carol")), 0);
    }

    function test_changingAPayeeAddressIsTimelockedAndMovesTheLabel() public {
        address evil = address(0xE71);
        vault.requestPayee(L_ALICE, evil, 1 ether);
        // until activation, alice is still alice and evil is unknown
        _expectRefusal(evil, 0.1 ether, L_ALICE, IGuardVault.RefusalCode.UnknownPayee);
        assertEq(_code(_pay(ALICE, 0.1 ether, L_ALICE)), 0);
        vault.cancelPayee(L_ALICE);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(GuardVault.NoPendingChange.selector);
        vault.activatePayee(L_ALICE);

        vault.requestPayee(L_ALICE, evil, 1 ether);
        vm.warp(block.timestamp + DELAY);
        vault.activatePayee(L_ALICE);
        assertEq(vault.labelOf(ALICE), bytes32(0), "old address loses the label");
        assertEq(vault.labelOf(evil), L_ALICE);
    }

    function test_oneLabelPerAddress() public {
        vm.expectRevert(GuardVault.BadPayee.selector);
        vault.requestPayee("alias", ALICE, 1 ether);
    }

    function test_removeIsImmediate() public {
        vault.removePayee(L_ALICE);
        _expectRefusal(ALICE, 0.1 ether, L_ALICE, IGuardVault.RefusalCode.UnknownPayee);
    }

    function test_delayCanOnlyGrow() public {
        vm.expectRevert(GuardVault.DelayCanOnlyGrow.selector);
        vault.setPayeeDelay(DELAY - 1);
        vault.setPayeeDelay(DELAY * 2);
        assertEq(vault.payeeDelay(), DELAY * 2);
    }

    // ---- callbacks ----------------------------------------------------------------------

    function test_guardianFreezesThroughTheProxy() public {
        vm.prank(PROXY);
        vault.freeze(GUARDIAN, "burst");
        assertTrue(vault.frozen());
    }

    function test_callbackFromAnotherReactiveContractIsRejected() public {
        vm.prank(PROXY);
        vm.expectRevert(abi.encodeWithSelector(GuardVault.NotGuardian.selector, address(0xBAD), GUARDIAN));
        vault.freeze(address(0xBAD), "x");
    }

    function test_callbackNotFromTheProxyIsRejected() public {
        vm.prank(GUARDIAN); // the right address, but not through the proxy
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, GUARDIAN, PROXY));
        vault.freeze(GUARDIAN, "x");
    }

    function test_noGuardianMeansNoCallbacks() public {
        vault.setGuardian(address(0));
        vm.prank(PROXY);
        vm.expectRevert(abi.encodeWithSelector(GuardVault.NotGuardian.selector, address(0), address(0)));
        vault.freeze(address(0), "x");
    }

    // ---- the owner ------------------------------------------------------------------------

    function test_ownerOnly() public {
        vm.startPrank(AGENT);
        vm.expectRevert(GuardVault.NotOwner.selector);
        vault.unfreeze();
        vm.expectRevert(GuardVault.NotOwner.selector);
        vault.release(ALICE);
        vm.expectRevert(GuardVault.NotOwner.selector);
        vault.requestPayee("x", address(1), 1);
        vm.expectRevert(GuardVault.NotOwner.selector);
        vault.withdraw(AGENT, ETH, 1);
        vm.expectRevert(GuardVault.NotOwner.selector);
        vault.setDailyLimit(ETH, type(uint256).max);
        vm.expectRevert(GuardVault.NotOwner.selector);
        vault.setGuardian(AGENT);
        vm.stopPrank();
    }

    function test_ownerWithdrawsEvenWhenFrozen() public {
        vault.freezeNow("x");
        vault.withdraw(address(0xF00D), ETH, 3 ether);
        assertEq(address(0xF00D).balance, 3 ether);
    }

    function test_depositsAreRecorded() public {
        vm.deal(address(this), 1 ether);
        vm.expectEmit(address(vault));
        emit IGuardVault.Deposited(address(this), ETH, 1 ether);
        (bool ok,) = address(vault).call{ value: 1 ether }("");
        assertTrue(ok);
    }

    // ---- veto and recurring payments ---------------------------------------------------------

    function test_vetoCancelsOnlyTheMatchingChange() public {
        address evil = address(0xE71);
        vault.requestPayee(L_ALICE, evil, 1 ether);
        vm.startPrank(PROXY);
        vault.vetoPayee(GUARDIAN, L_ALICE, address(0x1234)); // a different address: no effect
        (, , address pendingTo,,) = vault.payees(L_ALICE);
        assertEq(pendingTo, evil);
        vm.expectEmit(address(vault));
        emit IGuardVault.PayeeChangeVetoed(L_ALICE, evil);
        vault.vetoPayee(GUARDIAN, L_ALICE, evil);
        vault.vetoPayee(GUARDIAN, L_ALICE, evil); // repeated delivery: harmless
        vm.stopPrank();
        (, , pendingTo,,) = vault.payees(L_ALICE);
        assertEq(pendingTo, address(0));
    }

    function test_newCallbacksNeedTheGuardianThroughTheProxy() public {
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, address(this), PROXY));
        vault.vetoPayee(GUARDIAN, L_ALICE, ALICE);
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, address(this), PROXY));
        vault.payDue(GUARDIAN, 1);
        vm.startPrank(PROXY);
        vm.expectRevert(abi.encodeWithSelector(GuardVault.NotGuardian.selector, address(0xBAD), GUARDIAN));
        vault.payDue(address(0xBAD), 1);
        vm.stopPrank();
    }

    function test_scheduleRules() public {
        uint64 tooShort = uint64(vault.DUPLICATE_WINDOW() - 1); // shorter than the duplicate window
        vm.expectRevert(GuardVault.BadSchedule.selector);
        vault.setSchedule(L_ALICE, ETH, 1, tooShort, 0);
        vm.expectRevert(GuardVault.BadSchedule.selector);
        vault.setSchedule(L_ALICE, ETH, 0, 1 hours, 0);
        vm.prank(AGENT);
        vm.expectRevert(GuardVault.NotOwner.selector);
        vault.setSchedule(L_ALICE, ETH, 1, 1 hours, 0);
        uint256 id = vault.setSchedule(L_ALICE, ETH, 0.1 ether, 1 hours, 0);
        (,,,, uint64 nextDue, bool active) = vault.schedules(id);
        assertEq(nextDue, block.timestamp, "a past first-due time starts now");
        assertTrue(active);
        vault.cancelSchedule(id);
        vm.expectRevert(GuardVault.BadSchedule.selector);
        vault.cancelSchedule(id);
    }

    function test_payDueAdvancesWithoutCatchUpBursts() public {
        uint256 id = vault.setSchedule(L_ALICE, ETH, 0.1 ether, 1 hours, 0);
        vm.warp(block.timestamp + 5 hours); // missed several intervals
        vm.prank(PROXY);
        vault.payDue(GUARDIAN, id);
        assertEq(ALICE.balance, 0.1 ether);
        (,,,, uint64 nextDue,) = vault.schedules(id);
        assertEq(nextDue, block.timestamp + 1 hours, "one payment, then the next interval");
        vm.prank(PROXY);
        vault.payDue(GUARDIAN, id);
        assertEq(ALICE.balance, 0.1 ether, "not due");
    }

    function test_payDuePaysTheCurrentAddressOfTheLabel() public {
        uint256 id = vault.setSchedule(L_ALICE, ETH, 0.1 ether, 1 hours, 0);
        vault.removePayee(L_ALICE);
        vm.prank(PROXY);
        vault.payDue(GUARDIAN, id); // the label has no address now: refused, nothing sent
        assertEq(ALICE.balance, 0);
    }

    // ---- invariants by fuzzing ------------------------------------------------------------

    /// Whatever the agent proposes, it never moves more than today's limit, never pays an
    /// unregistered address, and never pays above a payee's cap.
    function testFuzz_agentCannotExceedTheRules(uint256 seed, address stranger, bytes32 anyLabel, uint8 n) public {
        vm.assume(stranger.code.length == 0 && uint160(stranger) > 0x100);
        n = uint8(bound(n, 1, 30));
        uint256 before = address(vault).balance;
        address[3] memory tos = [ALICE, BOB, stranger];
        bytes32[3] memory labels = [L_ALICE, L_BOB, anyLabel];
        for (uint256 i; i < n; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            address to = tos[r % 3];
            bytes32 label = labels[(r >> 8) % 3];
            uint256 a = bound(r >> 16, 0, 3 ether);
            if (r % 7 == 0) vm.warp(block.timestamp + 1 hours); // some days roll over
            bool registered = vault.labelOf(to) != bytes32(0);
            uint256 toBefore = to.balance;
            IGuardVault.RefusalCode c = _pay(to, a, label);
            if (c == IGuardVault.RefusalCode.None) {
                assertTrue(registered);
                assertEq(label, vault.labelOf(to));
                (, uint256 cap,,,) = vault.payees(label);
                assertLe(a, cap);
                assertEq(to.balance, toBefore + a);
            }
        }
        // the agent may spend at most one daily limit per UTC day the run touched
        uint256 daysTouched = (block.timestamp / 1 days) - (1_800_000_000 + 2 * DELAY) / 1 days + 1;
        assertLe(before - address(vault).balance, vault.dailyLimit(ETH) * daysTouched);
    }
}
