// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/**
 * @title The interface between a GuardVault (on each destination chain) and GuardReactive (on Reactive).
 * @notice The vault emits these events; GuardReactive subscribes to them and answers with the callbacks.
 *         Every callback's first argument is the reactive contract's address, injected by the network
 *         (pass address(0) when encoding), and the vault checks both the proxy and that address.
 */
interface IGuardVault {
    // ---- events GuardReactive subscribes to ------------------------------------------

    /// @notice The agent asked to pay. `label` is what the agent called the recipient.
    event PaymentProposed(uint256 indexed proposalId, address indexed to, address indexed token, uint256 amount, bytes32 label);
    /// @notice The rules passed and the payment went out.
    event PaymentExecuted(uint256 indexed proposalId, address indexed to, address indexed token, uint256 amount);
    /// @notice The rules refused the payment; `code` says which rule (see RefusalCode).
    event PaymentRefused(uint256 indexed proposalId, address indexed to, uint8 indexed code, uint256 amount);
    /// @notice The owner asked to add or change a payee; it takes effect at `effectiveAt`.
    event PayeeChangeRequested(bytes32 indexed payeeId, address indexed to, uint256 effectiveAt);
    event PayeeActivated(bytes32 indexed payeeId, address indexed to);
    event PayeeRemoved(bytes32 indexed payeeId);
    event Frozen(address indexed by, bytes32 reason);
    event Unfrozen(address indexed by);
    event SenderQuarantined(address indexed sender, bytes32 reason);
    event SenderReleased(address indexed sender);

    /// @notice Why a payment was refused (Antibody's rules, in order).
    enum RefusalCode {
        None,
        Frozen,          // the vault is frozen
        UnknownPayee,    // the recipient is not an active registered payee
        LabelMismatch,   // the label names a payee registered to a different address
        OverCap,         // above the payee's per-payment cap
        OverDailyLimit,  // above what is left of today's limit
        Duplicate,       // same payee, token and amount within the duplicate window
        Quarantined      // the recipient is a quarantined sender
    }

    // ---- callbacks from GuardReactive (first argument: the injected reactive contract) ----

    /// @notice Stop every payment until the owner unfreezes.
    function freeze(address reactive, bytes32 reason) external;
    /// @notice Block payments to `sender` and record it as an attacker on this chain.
    function quarantineSender(address reactive, address sender, bytes32 reason) external;
}
