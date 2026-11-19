// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { IPayable } from "@reactive/src/interfaces/IPayable.sol";
import { ISystemContract } from "@reactive/src/interfaces/ISystemContract.sol";
import { IReactive } from "@reactive/src/interfaces/IReactive.sol";
import { AbstractPayer } from "@reactive/src/base/AbstractPayer.sol";
import { AbstractCallback } from "@reactive/src/base/AbstractCallback.sol";
import { GuardVault } from "../contracts/GuardVault.sol";
import { GuardReactive } from "../contracts/GuardReactive.sol";
import { IGuardVault } from "../contracts/IGuardVault.sol";

/// @dev Stands in for Reactive's system contract: records subscriptions and callback requests.
contract MockSystem {
    struct Sub { uint256 chainId; address target; uint256 topic0; }
    Sub[] public subs;
    ISystemContract.CallbackConfiguration_V_1_0[] internal cbs;

    function subscribe(uint256 chainId, address target, uint256 topic0, uint256, uint256, uint256) external {
        subs.push(Sub(chainId, target, topic0));
    }
    function requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0 memory c) external { cbs.push(c); }
    function debt(address) external pure returns (uint256) { return 0; }
    function subCount() external view returns (uint256) { return subs.length; }
    function cbCount() external view returns (uint256) { return cbs.length; }
    function cb(uint256 i) external view returns (ISystemContract.CallbackConfiguration_V_1_0 memory) { return cbs[i]; }
    receive() external payable {}
}

contract GuardTest is Test {
    address constant SYSTEM = 0x8888888888888888888888888888888888888888;
    uint256 constant BASE_SEPOLIA = 84532;
    address constant PROXY = address(0xCA11);
    address constant AGENT = address(0xA6E7);

    MockSystem sys;
    GuardReactive rx;
    GuardVault vault;

    function setUp() public {
        vm.etch(SYSTEM, address(new MockSystem()).code);
        sys = MockSystem(payable(SYSTEM));
        rx = new GuardReactive();
        vault = new GuardVault(IPayable(payable(PROXY)), address(rx), AGENT);
        rx.watch(BASE_SEPOLIA, address(vault));
    }

    function _refusal() internal view returns (IReactive.LogRecord memory log) {
        log.chainId = BASE_SEPOLIA;
        log.contractAddress = address(vault);
        log.topic0 = uint256(IGuardVault.PaymentRefused.selector);
    }

    // ---- GuardReactive -----------------------------------------------------------

    function test_watchSubscribesToRefusals() public view {
        assertEq(sys.subCount(), 1);
        (uint256 chainId, address target, uint256 topic0) = sys.subs(0);
        assertEq(chainId, BASE_SEPOLIA);
        assertEq(target, address(vault));
        assertEq(topic0, uint256(IGuardVault.PaymentRefused.selector));
    }

    function test_onlyOwnerWatches() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(GuardReactive.NotOwner.selector);
        rx.watch(1, address(1));
    }

    function test_reactOnlyFromSystem() public {
        IReactive.LogRecord memory log = _refusal();
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, address(this), SYSTEM));
        rx.react(log);
    }

    function test_freezesAfterRepeatedRefusals() public {
        IReactive.LogRecord memory log = _refusal();
        vm.startPrank(SYSTEM);
        rx.react(log);
        rx.react(log);
        assertEq(sys.cbCount(), 0, "no callback before the threshold");
        rx.react(log);
        vm.stopPrank();

        assertEq(sys.cbCount(), 1);
        ISystemContract.CallbackConfiguration_V_1_0 memory c = sys.cb(0);
        assertEq(c.chainId, BASE_SEPOLIA);
        assertEq(c.recipient, address(vault));
        assertEq(c.payload, abi.encodeWithSelector(IGuardVault.freeze.selector, address(0), bytes32("repeated refusals")));
        assertEq(rx.refusals(BASE_SEPOLIA), 0, "counter resets after a freeze");
    }

    function test_ignoresLogsFromOtherContracts() public {
        IReactive.LogRecord memory log = _refusal();
        log.contractAddress = address(0xBEEF);
        vm.startPrank(SYSTEM);
        for (uint256 i; i < 5; ++i) rx.react(log);
        vm.stopPrank();
        assertEq(sys.cbCount(), 0);
    }

    // ---- GuardVault callbacks ------------------------------------------------------

    function test_callbackFreezesVault() public {
        vm.prank(PROXY);
        vault.freeze(address(rx), "repeated refusals");
        assertTrue(vault.frozen());
    }

    function test_callbackRejectsOtherReactiveContracts() public {
        vm.prank(PROXY);
        vm.expectRevert(abi.encodeWithSelector(AbstractCallback.CallbackNotAuthorized.selector, address(0xBAD), address(rx)));
        vault.freeze(address(0xBAD), "x");
    }

    function test_callbackRejectsCallersOtherThanProxy() public {
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, address(this), PROXY));
        vault.freeze(address(rx), "x");
    }

    function test_quarantineAndRelease() public {
        vm.prank(PROXY);
        vault.quarantineSender(address(rx), address(0xE11), "drainer");
        assertTrue(vault.quarantined(address(0xE11)));
        vault.releaseSender(address(0xE11));
        assertFalse(vault.quarantined(address(0xE11)));
    }

    function test_onlyOwnerUnfreezes() public {
        vm.prank(PROXY);
        vault.freeze(address(rx), "x");
        vm.prank(AGENT);
        vm.expectRevert(GuardVault.NotOwner.selector);
        vault.unfreeze();
        vault.unfreeze();
        assertFalse(vault.frozen());
    }
}
