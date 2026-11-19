// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ISystemContract } from "@reactive/src/interfaces/ISystemContract.sol";
import { IReactive } from "@reactive/src/interfaces/IReactive.sol";
import { AbstractReactive } from "@reactive/src/base/AbstractReactive.sol";
import { IGuardVault } from "./IGuardVault.sol";

/**
 * @title GuardReactive: watches GuardVaults on several chains and acts on its own.
 * @notice Phase 0 skeleton: one vault per chain, subscriptions to the vault's refusal events,
 *         and a freeze callback when the agent keeps proposing refused payments. The full rule
 *         set (bursts, incoming tokens, cross-chain quarantine, CRON) arrives in Phases 2 and 3.
 */
contract GuardReactive is AbstractReactive {
    error NotOwner();

    uint64 private constant CALLBACK_GAS_LIMIT = 300_000;
    /// @notice After this many refused proposals from the agent, the vault is frozen.
    uint256 public constant REFUSALS_BEFORE_FREEZE = 3;

    address public immutable owner;
    /// @notice chain id => the GuardVault watched on that chain.
    mapping(uint256 => address) public vaultOf;
    /// @notice chain id => refusals seen since the last freeze.
    mapping(uint256 => uint256) public refusals;

    constructor() payable {
        owner = msg.sender;
    }

    /// @notice Watch a vault (deploy this contract first, then the vault, then call this).
    function watch(uint256 chainId, address vault) external {
        if (msg.sender != owner) revert NotOwner();
        vaultOf[chainId] = vault;
        SYSTEM.subscribe(chainId, vault, uint256(IGuardVault.PaymentRefused.selector), REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
    }

    /// @inheritdoc IReactive
    function react(LogRecord memory log) external onlySystem {
        if (log.topic0 == uint256(IGuardVault.PaymentRefused.selector) && log.contractAddress == vaultOf[log.chainId]) {
            if (++refusals[log.chainId] >= REFUSALS_BEFORE_FREEZE) {
                refusals[log.chainId] = 0;
                _callback(log.chainId, abi.encodeWithSelector(IGuardVault.freeze.selector, address(0), bytes32("repeated refusals")));
            }
        }
    }

    function _callback(uint256 chainId, bytes memory payload) internal {
        SYSTEM.requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0({ chainId: chainId, recipient: vaultOf[chainId], gasLimit: CALLBACK_GAS_LIMIT, payload: payload }));
    }

    /// @notice Settle any debt with the system contract from this contract's balance.
    function coverDebt() external {
        _coverDebt();
    }
}
