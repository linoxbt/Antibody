// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ISystemContract } from "@reactive/src/interfaces/ISystemContract.sol";
import { IReactive } from "@reactive/src/interfaces/IReactive.sol";
import { AbstractReactive } from "@reactive/src/base/AbstractReactive.sol";
import { IGuardVault } from "./IGuardVault.sol";

/**
 * @title GuardReactive: one immune system for an AI agent's vaults on several chains.
 * @notice Runs on Reactive Network. For each watched GuardVault it subscribes to the vault's events and:
 *
 *         - Burst: more than `burstLimit` payment proposals within `burstWindow` → freeze that vault.
 *         - Repeated refusals: `refusalLimit` refusals within `refusalWindow` → freeze that vault.
 *         - Unknown recipient: the agent tried to pay an address that is not a payee → quarantine it.
 *         - Lessons: an address quarantined on any watched vault becomes a known attacker, and is
 *           quarantined on every other watched vault ("learned once, blocked everywhere"). A vault
 *           watched later is given the lessons already learned.
 *         - Veto: a payee change towards a known attacker is cancelled before its timelock ends.
 *         - Recurring payments: vault schedules are mirrored, and a CRON subscription (held only
 *           while some schedule is active, since every tick is billed) triggers each due payment.
 *
 *         It mirrors each vault's frozen flag, quarantines and schedules from the vault's own events,
 *         so it never asks twice for the same action, and every callback is idempotent on the vault
 *         side (the network may deliver a log twice). Callbacks are not retried by the network, so a
 *         freeze or quarantine that was not confirmed within `RETRY_AFTER` can be re-requested by anyone.
 *
 *         The callback gas limit is set per destination chain: it is the whole destination transaction's
 *         gas, and each chain's callback proxy keeps its own overhead out of it (about 130k on Base
 *         Sepolia, 200k on Ethereum Sepolia), so one limit does not fit every chain.
 */
contract GuardReactive is AbstractReactive {
    error NotOwner();
    error AlreadyWatched();
    error NotWatched();
    error BadSettings();
    error NothingToRetry();
    error WithdrawFailed();

    enum Rule { None, Burst, RepeatedRefusals, UnknownRecipient, CrossChainQuarantine, PayeeVeto, ScheduledPayment, Retry }

    struct Window {
        uint64 start;
        uint64 count;
    }

    struct Watched {
        address vault;
        bool frozen;            // frozen, or a freeze has been requested
        bool frozenConfirmed;   // the vault's Frozen event has been seen
        uint64 freezeRequestedAt;
        Window proposals;
        Window refusals;
    }

    struct Schedule {
        uint256 chainId;
        uint256 id;
        uint64 interval;
        uint64 nextDue;
        bool active;
    }

    /// @notice A rule fired and a callback was requested.
    event Decision(uint256 indexed chainId, address indexed vault, Rule indexed rule, address subject, bytes32 reason, uint256 originTx);
    /// @notice A new known attacker, first seen on `chainId`.
    event Lesson(address indexed account, uint256 indexed chainId, uint256 total);
    event Watching(uint256 indexed chainId, address indexed vault);
    event Unwatched(uint256 indexed chainId, address indexed vault);
    event SettingsChanged(uint64 burstLimit, uint64 burstWindow, uint64 refusalLimit, uint64 refusalWindow);
    event CronSubscribed(uint256 topic);
    event CronUnsubscribed(uint256 topic);
    event GasLimitSet(uint256 indexed chainId, uint64 gasLimit);
    event Withdrawn(address indexed to, uint256 amount);

    /// @notice Callback gas limit used for a chain with no setting of its own.
    uint64 public constant DEFAULT_GAS_LIMIT = 300_000;
    /// @notice Added to a chain's gas limit for payDue, which runs a whole payment (about 145k).
    uint64 public constant PAY_EXTRA_GAS = 200_000;
    uint64 public constant MIN_GAS_LIMIT = 100_000;
    uint64 public constant MAX_GAS_LIMIT = 3_000_000;
    uint256 public constant RETRY_AFTER = 10 minutes;
    uint256 public constant MAX_SCHEDULES = 20;
    uint256 public constant MAX_IMMUNIZE = 25;

    /// @notice The legacy system contract that emits the network's CRON events.
    address public constant CRON_EMITTER = 0x0000000000000000000000000000000000fffFfF;
    /// @notice Cron100: every 100 Reactive blocks (about two minutes).
    uint256 public constant CRON100 = 0xb49937fb8970e19fd46d48f7e3fb00d659deac0347f79cd7cb542f0fc1503c70;

    uint256 private constant T_PROPOSED = uint256(keccak256("PaymentProposed(uint256,address,address,uint256,bytes32)"));
    uint256 private constant T_REFUSED = uint256(keccak256("PaymentRefused(uint256,address,uint8,uint256)"));
    uint256 private constant T_FROZEN = uint256(keccak256("Frozen(address,bytes32)"));
    uint256 private constant T_UNFROZEN = uint256(keccak256("Unfrozen(address)"));
    uint256 private constant T_QUARANTINED = uint256(keccak256("Quarantined(address,bytes32)"));
    uint256 private constant T_RELEASED = uint256(keccak256("Released(address)"));
    uint256 private constant T_PAYEE_REQUESTED = uint256(keccak256("PayeeChangeRequested(bytes32,address,uint256,uint256)"));
    uint256 private constant T_SCHEDULE_SET = uint256(keccak256("ScheduleSet(uint256,bytes32,address,uint256,uint256,uint256)"));
    uint256 private constant T_SCHEDULE_CANCELLED = uint256(keccak256("ScheduleCancelled(uint256)"));
    uint256 private constant T_SCHEDULE_ADVANCED = uint256(keccak256("ScheduleAdvanced(uint256,uint256,uint256)"));
    uint256 private constant TOPICS = 10;

    address public immutable owner;
    uint64 public burstLimit = 5;
    uint64 public burstWindow = 120;
    uint64 public refusalLimit = 3;
    uint64 public refusalWindow = 600;
    uint256 public cronTopic = CRON100;
    bool public cronOn;

    mapping(uint256 chainId => uint64) public gasLimitOf;
    mapping(uint256 chainId => Watched) public watched;
    uint256[] public chains;

    /// @notice chain id => address => quarantined on that chain's vault (as last reported by the vault).
    mapping(uint256 chainId => mapping(address => bool)) public quarantinedOn;
    /// @notice chain id => address => when a quarantine was requested and not yet confirmed (0 if none).
    mapping(uint256 chainId => mapping(address => uint256)) public quarantineRequestedAt;

    /// @notice Known attackers: every address quarantined on any watched vault.
    mapping(address => bool) public knownBad;
    address[] public lessons;

    Schedule[] public schedules;
    mapping(uint256 chainId => mapping(uint256 id => uint256 indexPlusOne)) public scheduleIndex;
    uint256 public activeSchedules;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() payable {
        owner = msg.sender;
    }

    // ---- the owner ----------------------------------------------------------------------

    /// @notice Watch the GuardVault at `vault` on `chainId` (one vault per chain), and give it the
    ///         lessons learned so far (the first `MAX_IMMUNIZE`; `immunize` sends the rest).
    function watch(uint256 chainId, address vault) external onlyOwner {
        if (vault == address(0) || watched[chainId].vault != address(0)) revert AlreadyWatched();
        watched[chainId].vault = vault;
        chains.push(chainId);
        uint256[TOPICS] memory topics = _topics();
        for (uint256 i; i < TOPICS; ++i) {
            SYSTEM.subscribe(chainId, vault, topics[i], REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        }
        emit Watching(chainId, vault);
        _immunize(chainId, 0, MAX_IMMUNIZE, 0);
    }

    /// @notice Send lessons [start, start + count) to the vault on `chainId`.
    function immunize(uint256 chainId, uint256 start, uint256 count) external onlyOwner {
        if (watched[chainId].vault == address(0)) revert NotWatched();
        _immunize(chainId, start, count, 0);
    }

    function unwatch(uint256 chainId) external onlyOwner {
        address vault = watched[chainId].vault;
        if (vault == address(0)) revert NotWatched();
        uint256[TOPICS] memory topics = _topics();
        for (uint256 i; i < TOPICS; ++i) {
            SYSTEM.unsubscribe(chainId, vault, topics[i], REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        }
        delete watched[chainId];
        for (uint256 i; i < chains.length; ++i) {
            if (chains[i] == chainId) {
                chains[i] = chains[chains.length - 1];
                chains.pop();
                break;
            }
        }
        for (uint256 i; i < schedules.length; ++i) {
            if (schedules[i].chainId == chainId && schedules[i].active) _deactivate(schedules[i]);
        }
        emit Unwatched(chainId, vault);
    }

    function setSettings(uint64 burstLimit_, uint64 burstWindow_, uint64 refusalLimit_, uint64 refusalWindow_) external onlyOwner {
        if (burstLimit_ == 0 || burstWindow_ == 0 || refusalLimit_ == 0 || refusalWindow_ == 0) revert BadSettings();
        (burstLimit, burstWindow, refusalLimit, refusalWindow) = (burstLimit_, burstWindow_, refusalLimit_, refusalWindow_);
        emit SettingsChanged(burstLimit_, burstWindow_, refusalLimit_, refusalWindow_);
    }

    /// @notice Set the callback gas limit for `chainId` (the whole destination transaction's gas).
    function setGasLimit(uint256 chainId, uint64 gasLimit) external onlyOwner {
        if (gasLimit < MIN_GAS_LIMIT || gasLimit > MAX_GAS_LIMIT) revert BadSettings();
        gasLimitOf[chainId] = gasLimit;
        emit GasLimitSet(chainId, gasLimit);
    }

    function gasLimitFor(uint256 chainId) public view returns (uint64) {
        uint64 g = gasLimitOf[chainId];
        return g == 0 ? DEFAULT_GAS_LIMIT : g;
    }

    /// @notice Take funds out of this contract (it pays reaction fees from its balance, so leave enough).
    function withdraw(address payable to, uint256 amount) external onlyOwner {
        (bool ok,) = to.call{ value: amount }("");
        if (!ok) revert WithdrawFailed();
        emit Withdrawn(to, amount);
    }

    /// @notice Choose the CRON interval (a Cron1..Cron10000 topic from the docs). Applies on the next subscription.
    function setCronTopic(uint256 topic) external onlyOwner {
        if (cronOn) revert BadSettings();
        cronTopic = topic;
    }

    function chainCount() external view returns (uint256) {
        return chains.length;
    }

    function lessonCount() external view returns (uint256) {
        return lessons.length;
    }

    function scheduleCount() external view returns (uint256) {
        return schedules.length;
    }

    /// @notice Settle any debt with the system contract from this contract's balance.
    function coverDebt() external {
        _coverDebt();
    }

    // ---- retries (the network does not retry callbacks) ---------------------------------

    /// @notice Re-request a freeze that the vault has not confirmed within RETRY_AFTER. Anyone may call.
    function retryFreeze(uint256 chainId) external {
        Watched storage w = watched[chainId];
        if (!w.frozen || w.frozenConfirmed || block.timestamp < uint256(w.freezeRequestedAt) + RETRY_AFTER) revert NothingToRetry();
        w.freezeRequestedAt = uint64(block.timestamp);
        _callback(chainId, w.vault, abi.encodeWithSelector(IGuardVault.freeze.selector, address(0), bytes32("retry")), gasLimitFor(chainId));
        emit Decision(chainId, w.vault, Rule.Retry, address(0), "retry freeze", 0);
    }

    /// @notice Re-request a quarantine that the vault has not confirmed within RETRY_AFTER. Anyone may call.
    function retryQuarantine(uint256 chainId, address account) external {
        uint256 at = quarantineRequestedAt[chainId][account];
        if (at == 0 || quarantinedOn[chainId][account] || block.timestamp < at + RETRY_AFTER) revert NothingToRetry();
        quarantineRequestedAt[chainId][account] = block.timestamp;
        address vault = watched[chainId].vault;
        _callback(chainId, vault, abi.encodeWithSelector(IGuardVault.quarantine.selector, address(0), account, bytes32("retry")), gasLimitFor(chainId));
        emit Decision(chainId, vault, Rule.Retry, account, "retry quarantine", 0);
    }

    // ---- reacting -----------------------------------------------------------------------

    /// @inheritdoc IReactive
    function react(LogRecord calldata log) external onlySystem {
        if (log.contractAddress == CRON_EMITTER && log.topic0 == cronTopic) {
            _onCron();
            return;
        }
        Watched storage w = watched[log.chainId];
        if (w.vault == address(0) || log.contractAddress != w.vault) return;
        uint256 t = log.topic0;

        if (t == T_PROPOSED) {
            if (!w.frozen && _tick(w.proposals, burstWindow) > burstLimit) {
                _freeze(log, w, Rule.Burst, "burst of proposals");
            }
        } else if (t == T_REFUSED) {
            address to = address(uint160(log.topic2));
            uint8 code = uint8(log.topic3);
            if (code == uint8(IGuardVault.RefusalCode.UnknownPayee) && to != address(0) && to != w.vault) {
                _quarantine(log.chainId, to, Rule.UnknownRecipient, "unknown recipient", log.txHash);
            }
            // a refusal because the vault is already frozen says nothing new about the agent
            if (code != uint8(IGuardVault.RefusalCode.Frozen) && !w.frozen && _tick(w.refusals, refusalWindow) >= refusalLimit) {
                _freeze(log, w, Rule.RepeatedRefusals, "repeated refusals");
            }
        } else if (t == T_FROZEN) {
            w.frozen = true;
            w.frozenConfirmed = true;
        } else if (t == T_UNFROZEN) {
            w.frozen = false;
            w.frozenConfirmed = false;
            w.freezeRequestedAt = 0;
            delete w.proposals;
            delete w.refusals;
        } else if (t == T_QUARANTINED) {
            address a = address(uint160(log.topic1));
            quarantinedOn[log.chainId][a] = true;
            quarantineRequestedAt[log.chainId][a] = 0;
            _learn(a, log.chainId, log.txHash);
        } else if (t == T_RELEASED) {
            // the owner's call on this chain; the lesson stays for the other chains
            address a = address(uint160(log.topic1));
            quarantinedOn[log.chainId][a] = false;
            quarantineRequestedAt[log.chainId][a] = 0;
        } else if (t == T_PAYEE_REQUESTED) {
            address to = address(uint160(log.topic2));
            if (knownBad[to]) {
                bytes32 label = bytes32(log.topic1);
                _callback(log.chainId, w.vault, abi.encodeWithSelector(IGuardVault.vetoPayee.selector, address(0), label, to), gasLimitFor(log.chainId));
                emit Decision(log.chainId, w.vault, Rule.PayeeVeto, to, label, log.txHash);
            }
        } else if (t == T_SCHEDULE_SET) {
            (, uint256 interval, uint256 nextDue) = abi.decode(log.data, (uint256, uint256, uint256));
            _setSchedule(log.chainId, log.topic1, uint64(interval), uint64(nextDue));
        } else if (t == T_SCHEDULE_CANCELLED) {
            uint256 i = scheduleIndex[log.chainId][log.topic1];
            if (i != 0 && schedules[i - 1].active) _deactivate(schedules[i - 1]);
        } else if (t == T_SCHEDULE_ADVANCED) {
            uint256 i = scheduleIndex[log.chainId][log.topic1];
            if (i != 0) schedules[i - 1].nextDue = uint64(abi.decode(log.data, (uint256)));
        }
    }

    // ---- rules --------------------------------------------------------------------------

    /// @dev Fixed-window counter: returns the count in the current window, including this event.
    function _tick(Window storage win, uint64 length) internal returns (uint64) {
        if (block.timestamp >= uint256(win.start) + length) {
            win.start = uint64(block.timestamp);
            win.count = 0;
        }
        return ++win.count;
    }

    function _freeze(LogRecord calldata log, Watched storage w, Rule rule, bytes32 reason) internal {
        w.frozen = true; // requested; the vault's Frozen event confirms it
        w.freezeRequestedAt = uint64(block.timestamp);
        delete w.proposals;
        delete w.refusals;
        _callback(log.chainId, w.vault, abi.encodeWithSelector(IGuardVault.freeze.selector, address(0), reason), gasLimitFor(log.chainId));
        emit Decision(log.chainId, w.vault, rule, address(0), reason, log.txHash);
    }

    function _quarantine(uint256 chainId, address account, Rule rule, bytes32 reason, uint256 originTx) internal {
        if (quarantinedOn[chainId][account] || quarantineRequestedAt[chainId][account] != 0) return;
        quarantineRequestedAt[chainId][account] = block.timestamp;
        address vault = watched[chainId].vault;
        _callback(chainId, vault, abi.encodeWithSelector(IGuardVault.quarantine.selector, address(0), account, reason), gasLimitFor(chainId));
        emit Decision(chainId, vault, rule, account, reason, originTx);
    }

    /// @dev A quarantine confirmed on one chain is a lesson for all of them.
    function _learn(address account, uint256 fromChain, uint256 originTx) internal {
        if (!knownBad[account]) {
            knownBad[account] = true;
            lessons.push(account);
            emit Lesson(account, fromChain, lessons.length);
        }
        for (uint256 i; i < chains.length; ++i) {
            if (chains[i] != fromChain) _quarantine(chains[i], account, Rule.CrossChainQuarantine, "learned on another chain", originTx);
        }
    }

    function _immunize(uint256 chainId, uint256 start, uint256 count, uint256 originTx) internal {
        uint256 end = start + count;
        if (end > lessons.length) end = lessons.length;
        for (uint256 i = start; i < end; ++i) {
            _quarantine(chainId, lessons[i], Rule.CrossChainQuarantine, "learned on another chain", originTx);
        }
    }

    // ---- recurring payments (CRON) ------------------------------------------------------

    function _setSchedule(uint256 chainId, uint256 id, uint64 interval, uint64 nextDue) internal {
        uint256 i = scheduleIndex[chainId][id];
        if (i == 0) {
            if (schedules.length >= MAX_SCHEDULES) return; // over the cap: not driven by CRON
            schedules.push(Schedule(chainId, id, interval, nextDue, false));
            i = schedules.length;
            scheduleIndex[chainId][id] = i;
        }
        Schedule storage s = schedules[i - 1];
        s.interval = interval;
        s.nextDue = nextDue;
        if (!s.active) {
            s.active = true;
            if (++activeSchedules == 1) _cron(true);
        }
    }

    function _deactivate(Schedule storage s) internal {
        s.active = false;
        if (--activeSchedules == 0) _cron(false);
    }

    function _cron(bool on) internal {
        if (on == cronOn) return;
        cronOn = on;
        if (on) {
            SYSTEM.subscribe(block.chainid, CRON_EMITTER, cronTopic, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
            emit CronSubscribed(cronTopic);
        } else {
            SYSTEM.unsubscribe(block.chainid, CRON_EMITTER, cronTopic, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
            emit CronUnsubscribed(cronTopic);
        }
    }

    function _onCron() internal {
        for (uint256 i; i < schedules.length; ++i) {
            Schedule storage s = schedules[i];
            if (!s.active || block.timestamp < s.nextDue) continue;
            Watched storage w = watched[s.chainId];
            if (w.vault == address(0) || w.frozen) continue;
            // assume it is paid; the vault's ScheduleAdvanced event sets the real next due time
            s.nextDue = uint64(block.timestamp) + s.interval;
            _callback(s.chainId, w.vault, abi.encodeWithSelector(IGuardVault.payDue.selector, address(0), s.id), gasLimitFor(s.chainId) + PAY_EXTRA_GAS);
            emit Decision(s.chainId, w.vault, Rule.ScheduledPayment, address(0), bytes32(s.id), 0);
        }
    }

    // ---- plumbing -----------------------------------------------------------------------

    function _topics() internal pure returns (uint256[TOPICS] memory) {
        return [T_PROPOSED, T_REFUSED, T_FROZEN, T_UNFROZEN, T_QUARANTINED, T_RELEASED, T_PAYEE_REQUESTED, T_SCHEDULE_SET, T_SCHEDULE_CANCELLED, T_SCHEDULE_ADVANCED];
    }

    function _callback(uint256 chainId, address recipient, bytes memory payload, uint64 gasLimit) internal {
        SYSTEM.requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0({ chainId: chainId, recipient: recipient, gasLimit: gasLimit, payload: payload }));
    }
}
