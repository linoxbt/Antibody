// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ISystemContract } from "@reactive/src/interfaces/ISystemContract.sol";
import { IReactive } from "@reactive/src/interfaces/IReactive.sol";
import { AbstractReactive } from "@reactive/src/base/AbstractReactive.sol";
import { IGuardVault } from "./IGuardVault.sol";

/**
 * @title GuardReactive: one immune system for AI agents' vaults on several chains.
 * @notice Runs on Reactive Network. It watches up to `MAX_VAULTS` GuardVaults (any number per chain),
 *         subscribes to each vault's events, and:
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
 *         - AI risk: reports from a trusted RiskOracle (an AI scorer's judgements) at or above
 *           `riskThreshold` make the address a known attacker, quarantined on every watched vault.
 *           The model can only restrict: nothing it reports can approve, unfreeze or release.
 *
 *         It mirrors each vault's frozen flag, quarantines and schedules from the vault's own events,
 *         so it never asks twice for the same action, and every callback is idempotent on the vault
 *         side (the network may deliver a log twice). Callbacks are not retried by the network, so a
 *         freeze or quarantine that was not confirmed within `RETRY_AFTER` can be re-requested by anyone.
 *
 *         The callback gas limit is set per destination chain: it is the whole destination transaction's
 *         gas, and each chain's callback proxy keeps its own overhead out of it (about 130k on Base
 *         Sepolia, 200k on Ethereum Sepolia), so one limit does not fit every chain.
 *
 *         Roles: the owner configures everything; a registrar (a service key) may only add and remove
 *         vaults, so visitors' own vaults can be watched without handing out the owner key.
 */
contract GuardReactive is AbstractReactive {
    error NotOwner();
    error NotRegistrar();
    error AlreadyWatched();
    error NotWatched();
    error TooManyVaults();
    error BadSettings();
    error NothingToRetry();
    error WithdrawFailed();

    enum Rule { None, Burst, RepeatedRefusals, UnknownRecipient, CrossChainQuarantine, PayeeVeto, ScheduledPayment, Retry, AiRisk }

    struct Window {
        uint64 start;
        uint64 count;
    }

    struct Watched {
        bool active;
        bool frozen;            // frozen, or a freeze has been requested
        bool frozenConfirmed;   // the vault's Frozen event has been seen
        uint64 freezeRequestedAt;
        Window proposals;
        Window refusals;
    }

    struct Target {
        uint256 chainId;
        address vault;
    }

    struct Schedule {
        uint256 chainId;
        address vault;
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
    event OracleTrusted(uint256 indexed chainId, address indexed oracle);
    event RiskThresholdSet(uint8 threshold);
    event LessonsImported(address indexed from, uint256 count);
    event RegistrarSet(address indexed registrar);

    /// @notice Callback gas limit used for a chain with no setting of its own.
    uint64 public constant DEFAULT_GAS_LIMIT = 300_000;
    /// @notice Added to a chain's gas limit for payDue, which runs a whole payment (about 145k).
    uint64 public constant PAY_EXTRA_GAS = 200_000;
    uint64 public constant MIN_GAS_LIMIT = 100_000;
    uint64 public constant MAX_GAS_LIMIT = 3_000_000;
    uint256 public constant RETRY_AFTER = 10 minutes;
    /// @notice A lesson asks for a callback per vault inside one reaction (capped at 900k gas).
    uint256 public constant MAX_VAULTS = 12;
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
    uint256 private constant T_RISK = uint256(keccak256("RiskReported(address,uint8,address,bytes32,string)"));
    uint256 private constant TOPICS = 10;

    address public immutable owner;
    address public registrar;
    uint64 public burstLimit = 5;
    uint64 public burstWindow = 120;
    uint64 public refusalLimit = 3;
    uint64 public refusalWindow = 600;
    uint256 public cronTopic = CRON100;
    bool public cronOn;
    uint8 public riskThreshold = 80;

    mapping(uint256 chainId => uint64) public gasLimitOf;
    /// @notice chain id => the RiskOracle trusted on that chain (one per chain).
    mapping(uint256 chainId => address) public oracleOf;

    mapping(uint256 chainId => mapping(address vault => Watched)) public watched;
    Target[] public targets;

    /// @dev keyOf(chain, vault) => account => quarantined there (as last reported by the vault).
    mapping(bytes32 => mapping(address => bool)) private _quarantinedOn;
    /// @dev keyOf(chain, vault) => account => when a quarantine was requested and not yet confirmed.
    mapping(bytes32 => mapping(address => uint256)) private _quarantineRequestedAt;

    /// @notice Known attackers: every address quarantined on any watched vault, or reported by the AI.
    mapping(address => bool) public knownBad;
    address[] public lessons;

    Schedule[] public schedules;
    mapping(bytes32 => mapping(uint256 id => uint256 indexPlusOne)) private _scheduleIndex;
    uint256 public activeSchedules;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyRegistrar() {
        if (msg.sender != owner && msg.sender != registrar) revert NotRegistrar();
        _;
    }

    constructor() payable {
        owner = msg.sender;
    }

    function keyOf(uint256 chainId, address vault) public pure returns (bytes32) {
        return keccak256(abi.encode(chainId, vault));
    }

    function quarantinedOn(uint256 chainId, address vault, address account) external view returns (bool) {
        return _quarantinedOn[keyOf(chainId, vault)][account];
    }

    function quarantineRequestedAt(uint256 chainId, address vault, address account) external view returns (uint256) {
        return _quarantineRequestedAt[keyOf(chainId, vault)][account];
    }

    // ---- vaults (owner or registrar) ------------------------------------------------------

    /// @notice Watch the GuardVault at `vault` on `chainId` and give it the lessons learned so far
    ///         (the first `MAX_IMMUNIZE`; `immunize` sends the rest).
    function watch(uint256 chainId, address vault) external onlyRegistrar {
        if (vault == address(0) || watched[chainId][vault].active) revert AlreadyWatched();
        if (targets.length >= MAX_VAULTS) revert TooManyVaults();
        watched[chainId][vault].active = true;
        targets.push(Target(chainId, vault));
        uint256[TOPICS] memory topics = _topics();
        for (uint256 i; i < TOPICS; ++i) {
            SYSTEM.subscribe(chainId, vault, topics[i], REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        }
        emit Watching(chainId, vault);
        _immunize(chainId, vault, 0, MAX_IMMUNIZE, 0);
    }

    function unwatch(uint256 chainId, address vault) external onlyRegistrar {
        if (!watched[chainId][vault].active) revert NotWatched();
        uint256[TOPICS] memory topics = _topics();
        for (uint256 i; i < TOPICS; ++i) {
            SYSTEM.unsubscribe(chainId, vault, topics[i], REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        }
        delete watched[chainId][vault];
        for (uint256 i; i < targets.length; ++i) {
            if (targets[i].chainId == chainId && targets[i].vault == vault) {
                targets[i] = targets[targets.length - 1];
                targets.pop();
                break;
            }
        }
        for (uint256 i; i < schedules.length; ++i) {
            if (schedules[i].chainId == chainId && schedules[i].vault == vault && schedules[i].active) _deactivate(schedules[i]);
        }
        emit Unwatched(chainId, vault);
    }

    /// @notice Send lessons [start, start + count) to a watched vault.
    function immunize(uint256 chainId, address vault, uint256 start, uint256 count) external onlyRegistrar {
        if (!watched[chainId][vault].active) revert NotWatched();
        _immunize(chainId, vault, start, count, 0);
    }

    // ---- the owner ------------------------------------------------------------------------

    function setRegistrar(address registrar_) external onlyOwner {
        registrar = registrar_;
        emit RegistrarSet(registrar_);
    }

    function setSettings(uint64 burstLimit_, uint64 burstWindow_, uint64 refusalLimit_, uint64 refusalWindow_) external onlyOwner {
        if (burstLimit_ == 0 || burstWindow_ == 0 || refusalLimit_ == 0 || refusalWindow_ == 0) revert BadSettings();
        (burstLimit, burstWindow, refusalLimit, refusalWindow) = (burstLimit_, burstWindow_, refusalLimit_, refusalWindow_);
        emit SettingsChanged(burstLimit_, burstWindow_, refusalLimit_, refusalWindow_);
    }

    /// @notice Trust the RiskOracle at `oracle` on `chainId`: its reports at or above the threshold quarantine.
    function trustOracle(uint256 chainId, address oracle) external onlyOwner {
        address old = oracleOf[chainId];
        if (old != address(0)) SYSTEM.unsubscribe(chainId, old, T_RISK, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        oracleOf[chainId] = oracle;
        if (oracle != address(0)) SYSTEM.subscribe(chainId, oracle, T_RISK, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        emit OracleTrusted(chainId, oracle);
    }

    function setRiskThreshold(uint8 threshold) external onlyOwner {
        if (threshold == 0 || threshold > 100) revert BadSettings();
        riskThreshold = threshold;
        emit RiskThresholdSet(threshold);
    }

    /// @notice Copy lessons [start, start + count) from an earlier GuardReactive on this chain.
    function importLessons(address from, uint256 start, uint256 count) external onlyOwner {
        GuardReactive old = GuardReactive(payable(from));
        uint256 end = start + count;
        uint256 n = old.lessonCount();
        if (end > n) end = n;
        uint256 added;
        for (uint256 i = start; i < end; ++i) {
            address a = old.lessons(i);
            if (!knownBad[a]) {
                knownBad[a] = true;
                lessons.push(a);
                ++added;
                emit Lesson(a, block.chainid, lessons.length);
            }
        }
        emit LessonsImported(from, added);
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

    function vaultCount() external view returns (uint256) {
        return targets.length;
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
    function retryFreeze(uint256 chainId, address vault) external {
        Watched storage w = watched[chainId][vault];
        if (!w.active || !w.frozen || w.frozenConfirmed || block.timestamp < uint256(w.freezeRequestedAt) + RETRY_AFTER) revert NothingToRetry();
        w.freezeRequestedAt = uint64(block.timestamp);
        _callback(chainId, vault, abi.encodeWithSelector(IGuardVault.freeze.selector, address(0), bytes32("retry")), gasLimitFor(chainId));
        emit Decision(chainId, vault, Rule.Retry, address(0), "retry freeze", 0);
    }

    /// @notice Re-request a quarantine that the vault has not confirmed within RETRY_AFTER. Anyone may call.
    function retryQuarantine(uint256 chainId, address vault, address account) external {
        bytes32 k = keyOf(chainId, vault);
        uint256 at = _quarantineRequestedAt[k][account];
        if (at == 0 || _quarantinedOn[k][account] || block.timestamp < at + RETRY_AFTER) revert NothingToRetry();
        _quarantineRequestedAt[k][account] = block.timestamp;
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
        if (log.topic0 == T_RISK && log.contractAddress == oracleOf[log.chainId] && log.contractAddress != address(0)) {
            _onRisk(log);
            return;
        }
        Watched storage w = watched[log.chainId][log.contractAddress];
        if (!w.active) return;
        address vault = log.contractAddress;
        bytes32 k = keyOf(log.chainId, vault);
        uint256 t = log.topic0;

        if (t == T_PROPOSED) {
            if (!w.frozen && _tick(w.proposals, burstWindow) > burstLimit) {
                _freeze(log, w, Rule.Burst, "burst of proposals");
            }
        } else if (t == T_REFUSED) {
            address to = address(uint160(log.topic2));
            uint8 code = uint8(log.topic3);
            if (code == uint8(IGuardVault.RefusalCode.UnknownPayee) && to != address(0) && to != vault) {
                _quarantine(log.chainId, vault, to, Rule.UnknownRecipient, "unknown recipient", log.txHash);
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
            _quarantinedOn[k][a] = true;
            _quarantineRequestedAt[k][a] = 0;
            _learn(a, log.chainId, vault, log.txHash);
        } else if (t == T_RELEASED) {
            // the owner's call on this vault; the lesson stays for the others
            address a = address(uint160(log.topic1));
            _quarantinedOn[k][a] = false;
            _quarantineRequestedAt[k][a] = 0;
        } else if (t == T_PAYEE_REQUESTED) {
            address to = address(uint160(log.topic2));
            if (knownBad[to]) {
                bytes32 label = bytes32(log.topic1);
                _callback(log.chainId, vault, abi.encodeWithSelector(IGuardVault.vetoPayee.selector, address(0), label, to), gasLimitFor(log.chainId));
                emit Decision(log.chainId, vault, Rule.PayeeVeto, to, label, log.txHash);
            }
        } else if (t == T_SCHEDULE_SET) {
            (, uint256 interval, uint256 nextDue) = abi.decode(log.data, (uint256, uint256, uint256));
            _setSchedule(log.chainId, vault, log.topic1, uint64(interval), uint64(nextDue));
        } else if (t == T_SCHEDULE_CANCELLED) {
            uint256 i = _scheduleIndex[k][log.topic1];
            if (i != 0 && schedules[i - 1].active) _deactivate(schedules[i - 1]);
        } else if (t == T_SCHEDULE_ADVANCED) {
            uint256 i = _scheduleIndex[k][log.topic1];
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
        _callback(log.chainId, log.contractAddress, abi.encodeWithSelector(IGuardVault.freeze.selector, address(0), reason), gasLimitFor(log.chainId));
        emit Decision(log.chainId, log.contractAddress, rule, address(0), reason, log.txHash);
    }

    function _quarantine(uint256 chainId, address vault, address account, Rule rule, bytes32 reason, uint256 originTx) internal {
        bytes32 k = keyOf(chainId, vault);
        if (_quarantinedOn[k][account] || _quarantineRequestedAt[k][account] != 0) return;
        _quarantineRequestedAt[k][account] = block.timestamp;
        _callback(chainId, vault, abi.encodeWithSelector(IGuardVault.quarantine.selector, address(0), account, reason), gasLimitFor(chainId));
        emit Decision(chainId, vault, rule, account, reason, originTx);
    }

    /// @dev A quarantine confirmed on one vault is a lesson for all of them.
    function _learn(address account, uint256 fromChain, address fromVault, uint256 originTx) internal {
        if (!knownBad[account]) {
            knownBad[account] = true;
            lessons.push(account);
            emit Lesson(account, fromChain, lessons.length);
        }
        for (uint256 i; i < targets.length; ++i) {
            Target memory tg = targets[i];
            if (tg.chainId != fromChain || tg.vault != fromVault) {
                _quarantine(tg.chainId, tg.vault, account, Rule.CrossChainQuarantine, "learned on another vault", originTx);
            }
        }
    }

    /// @dev An AI risk report: at or above the threshold, a known attacker everywhere (the model can only restrict).
    function _onRisk(LogRecord calldata log) internal {
        address subject = address(uint160(log.topic1));
        uint256 score = log.topic2;
        if (score < riskThreshold || subject == address(0)) return;
        if (!knownBad[subject]) {
            knownBad[subject] = true;
            lessons.push(subject);
            emit Lesson(subject, log.chainId, lessons.length);
        }
        for (uint256 i; i < targets.length; ++i) {
            _quarantine(targets[i].chainId, targets[i].vault, subject, Rule.AiRisk, "AI risk score", log.txHash);
        }
    }

    function _immunize(uint256 chainId, address vault, uint256 start, uint256 count, uint256 originTx) internal {
        uint256 end = start + count;
        if (end > lessons.length) end = lessons.length;
        for (uint256 i = start; i < end; ++i) {
            _quarantine(chainId, vault, lessons[i], Rule.CrossChainQuarantine, "learned on another vault", originTx);
        }
    }

    // ---- recurring payments (CRON) ------------------------------------------------------

    function _setSchedule(uint256 chainId, address vault, uint256 id, uint64 interval, uint64 nextDue) internal {
        bytes32 k = keyOf(chainId, vault);
        uint256 i = _scheduleIndex[k][id];
        if (i == 0) {
            if (schedules.length >= MAX_SCHEDULES) return; // over the cap: not driven by CRON
            schedules.push(Schedule(chainId, vault, id, interval, nextDue, false));
            i = schedules.length;
            _scheduleIndex[k][id] = i;
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
            Watched storage w = watched[s.chainId][s.vault];
            if (!w.active || w.frozen) continue;
            // assume it is paid; the vault's ScheduleAdvanced event sets the real next due time
            s.nextDue = uint64(block.timestamp) + s.interval;
            _callback(s.chainId, s.vault, abi.encodeWithSelector(IGuardVault.payDue.selector, address(0), s.id), gasLimitFor(s.chainId) + PAY_EXTRA_GAS);
            emit Decision(s.chainId, s.vault, Rule.ScheduledPayment, address(0), bytes32(s.id), 0);
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
