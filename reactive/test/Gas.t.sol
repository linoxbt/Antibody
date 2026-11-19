// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { IPayable } from "@reactive/src/interfaces/IPayable.sol";
import { GuardVault } from "../contracts/GuardVault.sol";

/// @notice Gas used by each callback entry point, to size the callback gas limit per destination chain
///         (the proxy keeps its own overhead out of the limit: 130k on Base Sepolia, 200k on Ethereum Sepolia).
contract GasTest is Test {
    address constant PROXY = address(0xCA11);
    address constant G = address(0x6A2D);
    GuardVault vault;

    function setUp() public {
        vault = new GuardVault(IPayable(payable(PROXY)), address(0xA6E7), 0);
        vault.setGuardian(G);
        vm.deal(address(vault), 1 ether);
        vault.setDailyLimit(address(0), 1 ether);
        vault.requestPayee("alice", address(0xA11CE), 1 ether);
        vault.activatePayee("alice");
        vault.setSchedule("alice", address(0), 0.01 ether, 1 hours, 0);
    }

    function test_gas_callbacks() public {
        vm.startPrank(PROXY);
        uint256 g = gasleft();
        vault.quarantine(G, address(0xBAD), "learned on another chain");
        emit log_named_uint("quarantine", g - gasleft());
        g = gasleft();
        vault.freeze(G, "burst of proposals");
        emit log_named_uint("freeze", g - gasleft());
        vm.stopPrank();
        vault.unfreeze();
        vault.requestPayee("alice", address(0xE71), 1 ether);
        vm.startPrank(PROXY);
        g = gasleft();
        vault.vetoPayee(G, "alice", address(0xE71));
        emit log_named_uint("vetoPayee", g - gasleft());
        g = gasleft();
        vault.payDue(G, 1);
        emit log_named_uint("payDue", g - gasleft());
        vm.stopPrank();
    }
}
