// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IPayable } from "@reactive/src/interfaces/IPayable.sol";
import { AbstractPayer } from "@reactive/src/base/AbstractPayer.sol";
import { IGuardVault } from "./IGuardVault.sol";

/**
 * @title GuardVault: holds an AI agent's funds and lets the agent only *propose* payments.
 * @notice Antibody's spending rules, on-chain. The agent's key can do one thing: propose a payment
 *         to a registered payee. The vault checks it against the rules and either pays or refuses,
 *         and a refusal is an event, not a revert, so GuardReactive on Reactive Network sees it.
 *
 *         - Payees are registered by label with a per-payment cap. Adding or changing one is
 *           timelocked (`payeeDelay`); removing one is immediate.
 *         - A daily limit per token (UTC days); zero means the token cannot be paid at all.
 *         - The same recipient, token and amount twice within `DUPLICATE_WINDOW` is refused.
 *         - GuardReactive (the guardian) can freeze the vault or quarantine an address through
 *           this chain's Reactive callback proxy. Only the owner can undo either.
 *
 *         The owner is the human. The owner's key is never needed for day-to-day payments.
 *         Callback fees are paid from this contract's native balance (AbstractPayer).
 */
contract GuardVault is IGuardVault, AbstractPayer {
    error NotOwner();
    error NotAgent();
    error NotGuardian(address sender, address guardian);
    error BadPayee();
    error NoPendingChange();
    error TooEarly(uint256 effectiveAt);
    error DelayCanOnlyGrow();
    error Reentrancy();
    error WithdrawFailed();

    struct Payee {
        address to;       // the active address for this label (zero when none)
        uint256 cap;      // the most one payment to this payee may be, in any token
        address pendingTo;
        uint256 pendingCap;
        uint256 effectiveAt; // when the pending change may be activated (zero when none)
    }

    uint256 public constant DUPLICATE_WINDOW = 10 minutes;
    uint256 public constant MAX_PAYEE_DELAY = 30 days;

    address public immutable owner;
    address public agent;
    /// @notice The GuardReactive contract on Reactive Network allowed to send callbacks.
    address public guardian;
    uint256 public payeeDelay;
    bool public frozen;
    uint256 public proposalCount;

    mapping(bytes32 label => Payee) public payees;
    /// @notice The label an address is currently registered under (zero when none).
    mapping(address to => bytes32) public labelOf;
    mapping(address account => bool) public quarantined;
    mapping(address token => uint256) public dailyLimit;
    mapping(address token => uint256) public spentOnDay;
    mapping(address token => uint256) public spendDay;
    /// @notice keccak(to, token, amount) => when it was last paid.
    mapping(bytes32 => uint256) public lastPaidAt;

    uint256 private _lock = 1;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @dev Callbacks come through the proxy, and the proxy writes the sending reactive contract into
    ///      the first argument, so both are checked.
    modifier onlyGuardian(address reactive) {
        _onlyServiceProvider();
        if (guardian == address(0) || reactive != guardian) revert NotGuardian(reactive, guardian);
        _;
    }

    /// @param callbackProxy_ This chain's Reactive callback proxy.
    /// @param agent_ The AI agent's address: it may propose payments, nothing else.
    /// @param payeeDelay_ How long a new or changed payee waits before it can be activated.
    constructor(IPayable callbackProxy_, address agent_, uint256 payeeDelay_) payable AbstractPayer(callbackProxy_) {
        if (payeeDelay_ > MAX_PAYEE_DELAY) revert DelayCanOnlyGrow();
        owner = msg.sender;
        agent = agent_;
        payeeDelay = payeeDelay_;
        emit AgentSet(agent_);
        emit PayeeDelaySet(payeeDelay_);
    }

    // ---- the agent --------------------------------------------------------------------

    /**
     * @notice Ask the vault to pay. Pays if every rule passes, otherwise records the refusal.
     * @return code RefusalCode.None when paid, otherwise the first rule that refused.
     */
    function proposePayment(address to, address token, uint256 amount, bytes32 label) external nonReentrant returns (RefusalCode code) {
        if (msg.sender != agent) revert NotAgent();
        uint256 id = ++proposalCount;
        emit PaymentProposed(id, to, token, amount, label);

        code = check(to, token, amount, label);
        if (code != RefusalCode.None) {
            emit PaymentRefused(id, to, uint8(code), amount);
            return code;
        }

        // effects before the transfer; undone below if the transfer fails
        uint256 today = block.timestamp / 1 days;
        if (spendDay[token] != today) {
            spendDay[token] = today;
            spentOnDay[token] = 0;
        }
        spentOnDay[token] += amount;
        bytes32 key = keccak256(abi.encode(to, token, amount));
        uint256 previous = lastPaidAt[key];
        lastPaidAt[key] = block.timestamp;

        if (!_transfer(to, token, amount)) {
            spentOnDay[token] -= amount;
            lastPaidAt[key] = previous;
            emit PaymentRefused(id, to, uint8(RefusalCode.TransferFailed), amount);
            return RefusalCode.TransferFailed;
        }
        emit PaymentExecuted(id, to, token, amount);
    }

    /// @notice What the rules would say about this payment now (no state change).
    function check(address to, address token, uint256 amount, bytes32 label) public view returns (RefusalCode) {
        if (frozen) return RefusalCode.Frozen;
        if (quarantined[to]) return RefusalCode.Quarantined;
        bytes32 registered = labelOf[to];
        if (registered == bytes32(0) || to == address(0)) return RefusalCode.UnknownPayee;
        if (label != registered) return RefusalCode.LabelMismatch;
        if (amount == 0 || amount > payees[registered].cap) return RefusalCode.OverCap;
        uint256 spent = spendDay[token] == block.timestamp / 1 days ? spentOnDay[token] : 0;
        if (amount > dailyLimit[token] - _min(spent, dailyLimit[token])) return RefusalCode.OverDailyLimit;
        uint256 last = lastPaidAt[keccak256(abi.encode(to, token, amount))];
        if (last != 0 && block.timestamp < last + DUPLICATE_WINDOW) return RefusalCode.Duplicate;
        return RefusalCode.None;
    }

    // ---- callbacks (through the proxy, from the guardian only) ------------------------

    /// @inheritdoc IGuardVault
    function freeze(address reactive, bytes32 reason) external onlyGuardian(reactive) {
        frozen = true;
        emit Frozen(reactive, reason);
    }

    /// @inheritdoc IGuardVault
    function quarantine(address reactive, address account, bytes32 reason) external onlyGuardian(reactive) {
        quarantined[account] = true;
        emit Quarantined(account, reason);
    }

    // ---- the owner: payees ------------------------------------------------------------

    /// @notice Add a payee, or change a payee's address or cap. Takes effect after `payeeDelay`.
    function requestPayee(bytes32 label, address to, uint256 cap) external onlyOwner {
        if (label == bytes32(0) || to == address(0) || to == address(this) || cap == 0) revert BadPayee();
        bytes32 existing = labelOf[to];
        if (existing != bytes32(0) && existing != label) revert BadPayee(); // one label per address
        Payee storage p = payees[label];
        p.pendingTo = to;
        p.pendingCap = cap;
        p.effectiveAt = block.timestamp + payeeDelay;
        emit PayeeChangeRequested(label, to, cap, p.effectiveAt);
    }

    /// @notice Activate a pending payee change once its delay has passed. Anyone may call this.
    function activatePayee(bytes32 label) external {
        Payee storage p = payees[label];
        if (p.effectiveAt == 0) revert NoPendingChange();
        if (block.timestamp < p.effectiveAt) revert TooEarly(p.effectiveAt);
        address to = p.pendingTo;
        bytes32 existing = labelOf[to];
        if (existing != bytes32(0) && existing != label) revert BadPayee();
        if (p.to != address(0) && p.to != to) delete labelOf[p.to];
        p.to = to;
        p.cap = p.pendingCap;
        labelOf[to] = label;
        p.pendingTo = address(0);
        p.pendingCap = 0;
        p.effectiveAt = 0;
        emit PayeeActivated(label, to, p.cap);
    }

    function cancelPayee(bytes32 label) external onlyOwner {
        Payee storage p = payees[label];
        if (p.effectiveAt == 0) revert NoPendingChange();
        emit PayeeChangeCancelled(label, p.pendingTo);
        p.pendingTo = address(0);
        p.pendingCap = 0;
        p.effectiveAt = 0;
    }

    /// @notice Remove a payee at once (removing can only make the vault safer).
    function removePayee(bytes32 label) external onlyOwner {
        Payee storage p = payees[label];
        address to = p.to;
        if (to == address(0)) revert BadPayee();
        delete labelOf[to];
        p.to = address(0);
        p.cap = 0;
        emit PayeeRemoved(label, to);
    }

    // ---- the owner: everything else ---------------------------------------------------

    function setDailyLimit(address token, uint256 limit) external onlyOwner {
        dailyLimit[token] = limit;
        emit DailyLimitSet(token, limit);
    }

    /// @notice The delay may only grow, so a stolen owner session cannot rush a payee in.
    function setPayeeDelay(uint256 delay) external onlyOwner {
        if (delay < payeeDelay || delay > MAX_PAYEE_DELAY) revert DelayCanOnlyGrow();
        payeeDelay = delay;
        emit PayeeDelaySet(delay);
    }

    function setAgent(address agent_) external onlyOwner {
        agent = agent_;
        emit AgentSet(agent_);
    }

    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    function freezeNow(bytes32 reason) external onlyOwner {
        frozen = true;
        emit Frozen(msg.sender, reason);
    }

    function unfreeze() external onlyOwner {
        frozen = false;
        emit Unfrozen(msg.sender);
    }

    function release(address account) external onlyOwner {
        quarantined[account] = false;
        emit Released(account);
    }

    /// @notice The owner can always take funds out, frozen or not.
    function withdraw(address to, address token, uint256 amount) external onlyOwner nonReentrant {
        if (!_transfer(to, token, amount)) revert WithdrawFailed();
        emit Withdrawn(to, token, amount);
    }

    /// @notice Settle any debt with the callback proxy from this contract's balance.
    function coverDebt() external {
        _coverDebt();
    }

    receive() external payable override {
        emit Deposited(msg.sender, address(0), msg.value);
    }

    // ---- internals ----------------------------------------------------------------------

    function _transfer(address to, address token, uint256 amount) internal returns (bool ok) {
        if (token == address(0)) {
            (ok,) = payable(to).call{ value: amount }("");
        } else {
            // ERC-20 transfer; accepts tokens that return nothing
            bytes memory ret;
            (ok, ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
            ok = ok && (ret.length == 0 ? token.code.length > 0 : abi.decode(ret, (bool)));
        }
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
