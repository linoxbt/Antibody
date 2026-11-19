// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IPayable } from "@reactive/src/interfaces/IPayable.sol";
import { AbstractCallback } from "@reactive/src/base/AbstractCallback.sol";
import { IGuardVault } from "./IGuardVault.sol";

/**
 * @title GuardVault: holds an AI agent's funds and lets the agent only *propose* payments.
 * @notice Phase 0 skeleton: ownership, the agent role, freeze and quarantine, and the
 *         authenticated callbacks from GuardReactive. Payee rules arrive in Phase 1.
 */
contract GuardVault is IGuardVault, AbstractCallback {
    error NotOwner();
    error NotAgent();

    address public immutable owner;
    address public agent;
    bool public frozen;
    mapping(address => bool) public quarantined;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param callbackProxy_ This chain's Reactive callback proxy.
    /// @param reactive_ The GuardReactive contract on Reactive Network allowed to send callbacks.
    /// @param agent_ The AI agent's address: it may propose payments, nothing else.
    constructor(IPayable callbackProxy_, address reactive_, address agent_) payable AbstractCallback(callbackProxy_, reactive_) {
        owner = msg.sender;
        agent = agent_;
    }

    // ---- callbacks (through the proxy, from our reactive contract only) ----------------

    /// @inheritdoc IGuardVault
    function freeze(address reactive, bytes32 reason) external onlyServiceProvider onlyCallbackSender(reactive) {
        frozen = true;
        emit Frozen(reactive, reason);
    }

    /// @inheritdoc IGuardVault
    function quarantineSender(address reactive, address sender, bytes32 reason) external onlyServiceProvider onlyCallbackSender(reactive) {
        quarantined[sender] = true;
        emit SenderQuarantined(sender, reason);
    }

    // ---- the owner ------------------------------------------------------------------

    function unfreeze() external onlyOwner {
        frozen = false;
        emit Unfrozen(msg.sender);
    }

    function releaseSender(address sender) external onlyOwner {
        quarantined[sender] = false;
        emit SenderReleased(sender);
    }

    function setAgent(address agent_) external onlyOwner {
        agent = agent_;
    }

    /// @notice Settle any debt with the callback proxy from this contract's balance.
    function coverDebt() external {
        _coverDebt();
    }
}
