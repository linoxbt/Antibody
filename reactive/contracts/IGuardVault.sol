// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/**
 * @title The interface between a GuardVault (on each destination chain) and GuardReactive (on Reactive).
 * @notice The vault emits these events; GuardReactive subscribes to them and answers with the callbacks.
 *         Every callback's first argument is the reactive contract's address, injected by the network
 *         (encode address(0) there), and the vault checks both the callback proxy and that address.
 *         `token` is address(0) for the chain's native coin.
 */
interface IGuardVault {
    /// @notice Why a payment was refused, in the order the rules are checked.
    enum RefusalCode {
        None,
        Frozen,          // the vault is frozen
        Quarantined,     // the recipient is a quarantined address
        UnknownPayee,    // the recipient is not an active registered payee
        LabelMismatch,   // the agent's label is not the recipient's registered label
        OverCap,         // above the payee's per-payment cap
        OverDailyLimit,  // above what is left of today's limit for this token
        Duplicate,       // same recipient, token and amount within the duplicate window
        TransferFailed   // every rule passed but the transfer itself failed
    }

    // ---- events GuardReactive subscribes to ------------------------------------------

    /// @notice The agent asked to pay. `label` is what the agent called the recipient.
    event PaymentProposed(uint256 indexed proposalId, address indexed to, address indexed token, uint256 amount, bytes32 label);
    /// @notice Every rule passed and the payment went out.
    event PaymentExecuted(uint256 indexed proposalId, address indexed to, address indexed token, uint256 amount);
    /// @notice A rule refused the payment; `code` is a RefusalCode.
    event PaymentRefused(uint256 indexed proposalId, address indexed to, uint8 indexed code, uint256 amount);
    /// @notice The owner asked to add or change a payee; it can be activated from `effectiveAt`.
    event PayeeChangeRequested(bytes32 indexed label, address indexed to, uint256 cap, uint256 effectiveAt);
    event PayeeChangeCancelled(bytes32 indexed label, address indexed to);
    event PayeeActivated(bytes32 indexed label, address indexed to, uint256 cap);
    event PayeeRemoved(bytes32 indexed label, address indexed to);
    event Frozen(address indexed by, bytes32 reason);
    event Unfrozen(address indexed by);
    event Quarantined(address indexed account, bytes32 reason);
    event Released(address indexed account);
    event Deposited(address indexed from, address indexed token, uint256 amount);
    event Withdrawn(address indexed to, address indexed token, uint256 amount);
    event DailyLimitSet(address indexed token, uint256 limit);
    event AgentSet(address indexed agent);
    event GuardianSet(address indexed guardian);
    event PayeeDelaySet(uint256 delay);
    /// @notice A pending payee change was cancelled by the guardian (the new address is a known attacker).
    event PayeeChangeVetoed(bytes32 indexed label, address indexed to);
    /// @notice A recurring payment was created or changed; it is next due at `nextDue`.
    event ScheduleSet(uint256 indexed id, bytes32 indexed label, address indexed token, uint256 amount, uint256 interval, uint256 nextDue);
    event ScheduleCancelled(uint256 indexed id);
    /// @notice A due recurring payment was attempted (paid or refused under the usual rules); next due at `nextDue`.
    event ScheduleAdvanced(uint256 indexed id, uint256 indexed proposalId, uint256 nextDue);

    // ---- callbacks from GuardReactive (first argument: the injected reactive contract) ----

    /// @notice Stop every payment until the owner unfreezes.
    function freeze(address reactive, bytes32 reason) external;
    /// @notice Refuse every payment to `account` (an attacker seen on this or another chain).
    function quarantine(address reactive, address account, bytes32 reason) external;
    /// @notice Cancel the pending change of `label` if it would point the label at `to`.
    function vetoPayee(address reactive, bytes32 label, address to) external;
    /// @notice Attempt recurring payment `id` if it is due (CRON-driven); does nothing otherwise.
    function payDue(address reactive, uint256 id) external;
}
