// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IPayable } from "@reactive/src/interfaces/IPayable.sol";
import { AbstractPayer } from "@reactive/src/base/AbstractPayer.sol";

/**
 * @title GuardMemory: an AI agent's memory, with provenance, guarded by Reactive Network.
 * @notice Persistent memory makes attacks persistent; provenance makes them reversible.
 *
 *         The agent records what it learns as entries: the hash of the content (the text itself stays
 *         off-chain, wherever the agent keeps it), the **source** it came from (the counterparty, e.g.
 *         the address in an invoice or an email's sender) and a kind. Before the agent acts on a
 *         memory, it asks `usable(id)`.
 *
 *         GuardMemory speaks GuardReactive's language: the same `quarantine` and `freeze` callbacks
 *         and the same `Quarantined` / `Frozen` events as a GuardVault. So the GuardReactive that
 *         protects the agent's wallets protects its memory too, in both directions:
 *         - an attacker learned anywhere (a refused payment, an AI risk report, another vault) is
 *           quarantined here: every memory from that source becomes unusable at once, retroactively,
 *           and new memories from it are refused;
 *         - a poisoned source found here (the owner quarantines it) is a lesson for GuardReactive:
 *           it is quarantined on every watched vault, so the agent can never pay it either.
 *
 *         Callback fees are paid from this contract's native balance (AbstractPayer).
 */
contract GuardMemory is AbstractPayer {
    error NotOwner();
    error NotWriter();
    error NotGuardian(address sender, address guardian);
    error UnknownEntry(uint256 id);
    error UriTooLong();
    error WithdrawFailed();

    /// @dev Why a write was refused (an event, not a revert, so GuardReactive and the agent see it).
    enum Refusal { None, Frozen, QuarantinedSource }
    /// @dev What `recall` says about an entry.
    enum Status { Usable, QuarantinedSource, Forgotten }

    struct Entry {
        bytes32 contentHash; // keccak256 of the content, which stays off-chain
        address source;      // where it came from
        bytes32 kind;        // e.g. "invoice", "contact", "instruction"
        uint64 at;           // when it was written
        bool forgotten;      // the owner withdrew this one entry
    }

    // The events GuardReactive subscribes to (same signatures as IGuardVault's).
    event Frozen(address indexed by, bytes32 reason);
    event Unfrozen(address indexed by);
    event Quarantined(address indexed account, bytes32 reason);
    event Released(address indexed account);
    // Memory's own.
    event Remembered(uint256 indexed id, address indexed source, bytes32 indexed kind, bytes32 contentHash, string uri);
    event MemoryRefused(address indexed source, bytes32 indexed contentHash, uint8 reason);
    event Forgotten(uint256 indexed id, bytes32 reason);
    event WriterSet(address indexed writer);
    event GuardianSet(address indexed guardian);
    event Withdrawn(address indexed to, uint256 amount);

    uint256 public constant MAX_URI = 200;

    address public immutable owner;
    address public writer; // the agent
    address public guardian; // GuardReactive
    bool public frozen;
    mapping(address account => bool) public quarantined;

    Entry[] internal _entries; // id = index + 1
    mapping(address source => uint256[] ids) internal _bySource;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev Callbacks come through the proxy, which writes the sending reactive contract into the first argument.
    modifier onlyGuardian(address reactive) {
        _onlyServiceProvider();
        if (guardian == address(0) || reactive != guardian) revert NotGuardian(reactive, guardian);
        _;
    }

    /// @param callbackProxy_ This chain's Reactive callback proxy.
    /// @param writer_ The AI agent's address: it may write memories, nothing else.
    constructor(IPayable callbackProxy_, address writer_) payable AbstractPayer(callbackProxy_) {
        owner = msg.sender;
        writer = writer_;
        emit WriterSet(writer_);
    }

    // ---- the agent ------------------------------------------------------------------------

    /**
     * @notice Record a memory. Refused (as an event) when memory is frozen or the source is quarantined.
     * @return id The new entry's id, or 0 when refused.
     */
    function remember(bytes32 contentHash, address source, bytes32 kind, string calldata uri) external returns (uint256 id) {
        if (msg.sender != writer && msg.sender != owner) revert NotWriter();
        if (bytes(uri).length > MAX_URI) revert UriTooLong();
        if (frozen) {
            emit MemoryRefused(source, contentHash, uint8(Refusal.Frozen));
            return 0;
        }
        if (quarantined[source]) {
            emit MemoryRefused(source, contentHash, uint8(Refusal.QuarantinedSource));
            return 0;
        }
        _entries.push(Entry(contentHash, source, kind, uint64(block.timestamp), false));
        id = _entries.length;
        _bySource[source].push(id);
        emit Remembered(id, source, kind, contentHash, uri);
    }

    // ---- reading -----------------------------------------------------------------------------

    /// @notice An entry and whether the agent may act on it.
    function recall(uint256 id) external view returns (Entry memory e, Status status) {
        e = _entry(id);
        status = e.forgotten ? Status.Forgotten : quarantined[e.source] ? Status.QuarantinedSource : Status.Usable;
    }

    /// @notice True when the agent may act on this memory.
    function usable(uint256 id) public view returns (bool) {
        Entry storage e = _entry(id);
        return !e.forgotten && !quarantined[e.source];
    }

    /// @notice `usable` for many entries at once.
    function usableMany(uint256[] calldata ids) external view returns (bool[] memory out) {
        out = new bool[](ids.length);
        for (uint256 i; i < ids.length; ++i) out[i] = ids[i] != 0 && ids[i] <= _entries.length && usable(ids[i]);
    }

    function entryCount() external view returns (uint256) {
        return _entries.length;
    }

    /// @notice Every entry that came from a source (to audit what an attacker managed to plant).
    function entriesFrom(address source) external view returns (uint256[] memory) {
        return _bySource[source];
    }

    // ---- the guardian (GuardReactive, through the callback proxy) ---------------------------------

    function freeze(address reactive, bytes32 reason) external onlyGuardian(reactive) {
        frozen = true;
        emit Frozen(reactive, reason);
    }

    /// @notice Quarantine a source: every memory from it becomes unusable. Idempotent.
    function quarantine(address reactive, address account, bytes32 reason) external onlyGuardian(reactive) {
        quarantined[account] = true;
        emit Quarantined(account, reason);
    }

    // ---- the owner ------------------------------------------------------------------------------

    /// @notice A poisoned source found in memory: quarantine it here, and GuardReactive learns it everywhere.
    function quarantineSource(address source, bytes32 reason) external onlyOwner {
        quarantined[source] = true;
        emit Quarantined(source, reason);
    }

    function release(address source) external onlyOwner {
        quarantined[source] = false;
        emit Released(source);
    }

    function forget(uint256 id, bytes32 reason) external onlyOwner {
        _entry(id).forgotten = true;
        emit Forgotten(id, reason);
    }

    function freezeNow(bytes32 reason) external onlyOwner {
        frozen = true;
        emit Frozen(msg.sender, reason);
    }

    function unfreeze() external onlyOwner {
        frozen = false;
        emit Unfrozen(msg.sender);
    }

    function setWriter(address writer_) external onlyOwner {
        writer = writer_;
        emit WriterSet(writer_);
    }

    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    function withdraw(address to, uint256 amount) external onlyOwner {
        (bool ok,) = payable(to).call{ value: amount }("");
        if (!ok) revert WithdrawFailed();
        emit Withdrawn(to, amount);
    }

    function coverDebt() external {
        _coverDebt();
    }

    // ---- internals ----------------------------------------------------------------------------

    function _entry(uint256 id) internal view returns (Entry storage) {
        if (id == 0 || id > _entries.length) revert UnknownEntry(id);
        return _entries[id - 1];
    }
}
