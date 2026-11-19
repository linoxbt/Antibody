// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ISystemContract } from "@reactive/src/interfaces/ISystemContract.sol";
import { IReactive } from "@reactive/src/interfaces/IReactive.sol";
import { AbstractReactive } from "@reactive/src/base/AbstractReactive.sol";
import { IGuardVault } from "./IGuardVault.sol";

/**
 * @title GuardReactive: watches GuardVaults on several chains from Reactive Network and acts on its own.
 * @notice For each watched vault it subscribes to the vault's events and applies Antibody's rules:
 *
 *         - Burst: more than `burstLimit` payment proposals within `burstWindow` → freeze the vault.
 *         - Repeated refusals: `refusalLimit` refused proposals within `refusalWindow` → freeze.
 *         - Unknown recipient: the agent tried to pay an address that is not a payee (the shape of an
 *           address-poisoning or prompt-injection attack) → quarantine that address on the vault.
 *
 *         It mirrors each vault's frozen flag and quarantine list from the vault's own events, so it
 *         never asks twice for the same action, and it resets its counters when the owner unfreezes.
 *         Every decision is also an event here (`Decision`), so the whole story is readable on Reactscan.
 */
contract GuardReactive is AbstractReactive {
    error NotOwner();
    error AlreadyWatched();
    error NotWatched();
    error BadSettings();

    enum Rule { None, Burst, RepeatedRefusals, UnknownRecipient }

    struct Window {
        uint64 start;
        uint64 count;
    }

    struct Watched {
        address vault;
        bool frozen;
        Window proposals;
        Window refusals;
    }

    /// @notice A rule fired and a callback was requested.
    event Decision(uint256 indexed chainId, address indexed vault, Rule indexed rule, address subject, bytes32 reason, uint256 originTx);
    event Watching(uint256 indexed chainId, address indexed vault);
    event Unwatched(uint256 indexed chainId, address indexed vault);
    event SettingsChanged(uint64 burstLimit, uint64 burstWindow, uint64 refusalLimit, uint64 refusalWindow);

    uint64 public constant CALLBACK_GAS_LIMIT = 300_000;

    uint256 private constant T_PROPOSED = uint256(keccak256("PaymentProposed(uint256,address,address,uint256,bytes32)"));
    uint256 private constant T_REFUSED = uint256(keccak256("PaymentRefused(uint256,address,uint8,uint256)"));
    uint256 private constant T_FROZEN = uint256(keccak256("Frozen(address,bytes32)"));
    uint256 private constant T_UNFROZEN = uint256(keccak256("Unfrozen(address)"));
    uint256 private constant T_QUARANTINED = uint256(keccak256("Quarantined(address,bytes32)"));
    uint256 private constant T_RELEASED = uint256(keccak256("Released(address)"));

    address public immutable owner;
    uint64 public burstLimit = 5;
    uint64 public burstWindow = 120;
    uint64 public refusalLimit = 3;
    uint64 public refusalWindow = 600;

    mapping(uint256 chainId => Watched) public watched;
    /// @notice chain id => address => quarantined on that chain's vault (as last reported by the vault).
    mapping(uint256 chainId => mapping(address => bool)) public quarantinedOn;
    /// @notice chain id => address => a quarantine callback is already on its way.
    mapping(uint256 chainId => mapping(address => bool)) public quarantinePending;
    uint256[] public chains;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() payable {
        owner = msg.sender;
    }

    // ---- the owner ----------------------------------------------------------------------

    /// @notice Watch the GuardVault at `vault` on `chainId` (one vault per chain).
    function watch(uint256 chainId, address vault) external onlyOwner {
        if (vault == address(0) || watched[chainId].vault != address(0)) revert AlreadyWatched();
        watched[chainId].vault = vault;
        chains.push(chainId);
        uint256[6] memory topics = [T_PROPOSED, T_REFUSED, T_FROZEN, T_UNFROZEN, T_QUARANTINED, T_RELEASED];
        for (uint256 i; i < topics.length; ++i) {
            SYSTEM.subscribe(chainId, vault, topics[i], REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        }
        emit Watching(chainId, vault);
    }

    function unwatch(uint256 chainId) external onlyOwner {
        address vault = watched[chainId].vault;
        if (vault == address(0)) revert NotWatched();
        uint256[6] memory topics = [T_PROPOSED, T_REFUSED, T_FROZEN, T_UNFROZEN, T_QUARANTINED, T_RELEASED];
        for (uint256 i; i < topics.length; ++i) {
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
        emit Unwatched(chainId, vault);
    }

    function setSettings(uint64 burstLimit_, uint64 burstWindow_, uint64 refusalLimit_, uint64 refusalWindow_) external onlyOwner {
        if (burstLimit_ == 0 || burstWindow_ == 0 || refusalLimit_ == 0 || refusalWindow_ == 0) revert BadSettings();
        (burstLimit, burstWindow, refusalLimit, refusalWindow) = (burstLimit_, burstWindow_, refusalLimit_, refusalWindow_);
        emit SettingsChanged(burstLimit_, burstWindow_, refusalLimit_, refusalWindow_);
    }

    function chainCount() external view returns (uint256) {
        return chains.length;
    }

    /// @notice Settle any debt with the system contract from this contract's balance.
    function coverDebt() external {
        _coverDebt();
    }

    // ---- reacting -----------------------------------------------------------------------

    /// @inheritdoc IReactive
    function react(LogRecord calldata log) external onlySystem {
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
                _quarantine(log, to);
            }
            // a refusal because the vault is already frozen says nothing new about the agent
            if (code != uint8(IGuardVault.RefusalCode.Frozen) && !w.frozen && _tick(w.refusals, refusalWindow) >= refusalLimit) {
                _freeze(log, w, Rule.RepeatedRefusals, "repeated refusals");
            }
        } else if (t == T_FROZEN) {
            w.frozen = true;
        } else if (t == T_UNFROZEN) {
            w.frozen = false;
            delete w.proposals;
            delete w.refusals;
        } else if (t == T_QUARANTINED) {
            address a = address(uint160(log.topic1));
            quarantinedOn[log.chainId][a] = true;
            quarantinePending[log.chainId][a] = false;
        } else if (t == T_RELEASED) {
            address a = address(uint160(log.topic1));
            quarantinedOn[log.chainId][a] = false;
            quarantinePending[log.chainId][a] = false;
        }
    }

    /// @dev Fixed-window counter: returns the count in the current window, including this event.
    function _tick(Window storage win, uint64 length) internal returns (uint64) {
        if (block.timestamp >= uint256(win.start) + length) {
            win.start = uint64(block.timestamp);
            win.count = 0;
        }
        return ++win.count;
    }

    function _freeze(LogRecord calldata log, Watched storage w, Rule rule, bytes32 reason) internal {
        w.frozen = true; // assume it lands; the vault's Frozen event confirms it
        delete w.proposals;
        delete w.refusals;
        _callback(log.chainId, w.vault, abi.encodeWithSelector(IGuardVault.freeze.selector, address(0), reason));
        emit Decision(log.chainId, w.vault, rule, address(0), reason, log.txHash);
    }

    function _quarantine(LogRecord calldata log, address account) internal {
        if (quarantinedOn[log.chainId][account] || quarantinePending[log.chainId][account]) return;
        quarantinePending[log.chainId][account] = true;
        address vault = watched[log.chainId].vault;
        _callback(log.chainId, vault, abi.encodeWithSelector(IGuardVault.quarantine.selector, address(0), account, bytes32("unknown recipient")));
        emit Decision(log.chainId, vault, Rule.UnknownRecipient, account, "unknown recipient", log.txHash);
    }

    function _callback(uint256 chainId, address recipient, bytes memory payload) internal {
        SYSTEM.requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0({ chainId: chainId, recipient: recipient, gasLimit: CALLBACK_GAS_LIMIT, payload: payload }));
    }
}
