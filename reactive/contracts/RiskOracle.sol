// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/**
 * @title RiskOracle: where an AI risk scorer puts its judgements on-chain.
 * @notice An authorized scorer (an AI model's service key) reports that an address looks malicious,
 *         with a score from 0 to 100, a hash of the evidence it read, and a short reason. The oracle
 *         changes nothing by itself: GuardReactive subscribes to its reports and, above a threshold,
 *         quarantines the address on every vault it watches. A report can only restrict; there is no
 *         way for the model to approve, unfreeze or release anything.
 */
contract RiskOracle {
    error NotOwner();
    error NotScorer();
    error BadScore();

    event RiskReported(address indexed subject, uint8 indexed score, address indexed scorer, bytes32 evidenceHash, string reason);
    event ScorerSet(address indexed scorer, bool allowed);

    address public immutable owner;
    mapping(address => bool) public scorers;
    uint256 public reportCount;

    constructor() {
        owner = msg.sender;
    }

    function setScorer(address scorer, bool allowed) external {
        if (msg.sender != owner) revert NotOwner();
        scorers[scorer] = allowed;
        emit ScorerSet(scorer, allowed);
    }

    /// @param evidenceHash keccak256 of the text the scorer read (kept off-chain).
    /// @param reason a short human-readable reason (at most 160 bytes are kept).
    function report(address subject, uint8 score, bytes32 evidenceHash, string calldata reason) external {
        if (!scorers[msg.sender]) revert NotScorer();
        if (score > 100 || subject == address(0)) revert BadScore();
        ++reportCount;
        emit RiskReported(subject, score, msg.sender, evidenceHash, bytes(reason).length > 160 ? reason[:160] : reason);
    }
}
