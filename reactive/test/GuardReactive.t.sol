// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { ISystemContract } from "@reactive/src/interfaces/ISystemContract.sol";
import { IReactive } from "@reactive/src/interfaces/IReactive.sol";
import { AbstractPayer } from "@reactive/src/base/AbstractPayer.sol";
import { GuardReactive } from "../contracts/GuardReactive.sol";
import { IGuardVault } from "../contracts/IGuardVault.sol";
import { MockSystem } from "./mocks/Mocks.sol";

contract GuardReactiveTest is Test {
    address constant SYSTEM = 0x8888888888888888888888888888888888888888;
    uint256 constant BASE_SEPOLIA = 84532;
    address constant VAULT = address(0x7A017);

    MockSystem sys;
    GuardReactive rx;

    function setUp() public {
        vm.etch(SYSTEM, address(new MockSystem()).code);
        sys = MockSystem(payable(SYSTEM));
        rx = new GuardReactive();
        rx.watch(BASE_SEPOLIA, VAULT);
    }

    function _refusal() internal pure returns (IReactive.LogRecord memory log) {
        log.chainId = BASE_SEPOLIA;
        log.contractAddress = VAULT;
        log.topic0 = uint256(IGuardVault.PaymentRefused.selector);
    }

    function test_watchSubscribesToRefusals() public view {
        assertEq(sys.subCount(), 1);
        (uint256 chainId, address target, uint256 topic0) = sys.subs(0);
        assertEq(chainId, BASE_SEPOLIA);
        assertEq(target, VAULT);
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
        assertEq(c.recipient, VAULT);
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
}
