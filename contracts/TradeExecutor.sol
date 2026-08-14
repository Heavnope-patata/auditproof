// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IGroth16Verifier {
    function verifyProof(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[10] calldata pubSignals
    ) external view returns (bool);
}

interface IAsset {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

contract TradeExecutor {
    uint256 private constant IDX_IS_COMPLIANT = 0;
    uint256 private constant IDX_POLICY_HASH = 1;
    uint256 private constant IDX_TRADE_HASH = 2;
    uint256 private constant IDX_THOUGHT_COMMIT = 3;
    uint256 private constant IDX_WITNESS_KEYS_START = 4;

    struct AuditRecord {
        uint256 policyHash;
        uint256 thoughtCommit;
        address agent;
        uint64 recordedAt;
        bool compliant;
        bool executed;
    }

    IGroth16Verifier public immutable verifier;
    IAsset public immutable asset;
    address public immutable complianceOfficer;

    uint256 public registeredPolicyHash;

    uint256[6] public registeredWitnessKeys;

    mapping(uint256 => AuditRecord) private auditRecords;
    uint256[] public auditedTradeHashes;

    event PolicyRegistered(uint256 indexed policyHash, address indexed by, uint64 at);
    event ComplianceRecorded(
        uint256 indexed tradeHash,
        uint256 indexed policyHash,
        uint256 thoughtCommit,
        address indexed agent,
        bool compliant,
        uint64 recordedAt
    );
    event TradeExecuted(
        uint256 indexed tradeHash,
        address indexed agent,
        address counterparty,
        uint256 amount
    );
    event TradeBlocked(uint256 indexed tradeHash, address indexed agent, string reason);

    modifier onlyComplianceOfficer() {
        require(msg.sender == complianceOfficer, "AuditProof: not compliance officer");
        _;
    }

    constructor(
        address verifier_,
        address asset_,
        uint256 policyHash_,
        uint256[6] memory witnessKeys_
    ) {
        verifier = IGroth16Verifier(verifier_);
        asset = IAsset(asset_);
        complianceOfficer = msg.sender;
        registeredPolicyHash = policyHash_;
        registeredWitnessKeys = witnessKeys_;
        emit PolicyRegistered(policyHash_, msg.sender, uint64(block.timestamp));
    }

    function registerPolicy(uint256 policyHash_) external onlyComplianceOfficer {
        registeredPolicyHash = policyHash_;
        emit PolicyRegistered(policyHash_, msg.sender, uint64(block.timestamp));
    }

    function submitComplianceProof(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[10] calldata pubSignals
    ) external returns (bool compliant) {
        require(verifier.verifyProof(pA, pB, pC, pubSignals), "AuditProof: invalid proof");
        require(
            pubSignals[IDX_POLICY_HASH] == registeredPolicyHash,
            "AuditProof: policy hash mismatch"
        );
        for (uint256 i = 0; i < 6; i++) {
            require(
                pubSignals[IDX_WITNESS_KEYS_START + i] == registeredWitnessKeys[i],
                "AuditProof: unregistered witness key"
            );
        }

        uint256 tradeHash = pubSignals[IDX_TRADE_HASH];
        require(auditRecords[tradeHash].recordedAt == 0, "AuditProof: trade already recorded");

        compliant = pubSignals[IDX_IS_COMPLIANT] == 1;
        auditRecords[tradeHash] = AuditRecord({
            policyHash: pubSignals[IDX_POLICY_HASH],
            thoughtCommit: pubSignals[IDX_THOUGHT_COMMIT],
            agent: msg.sender,
            recordedAt: uint64(block.timestamp),
            compliant: compliant,
            executed: false
        });
        auditedTradeHashes.push(tradeHash);

        emit ComplianceRecorded(
            tradeHash,
            pubSignals[IDX_POLICY_HASH],
            pubSignals[IDX_THOUGHT_COMMIT],
            msg.sender,
            compliant,
            uint64(block.timestamp)
        );

        if (!compliant) {
            emit TradeBlocked(tradeHash, msg.sender, "compliance check failed");
        }
    }

    function executeTrade(uint256 tradeHash, address counterparty, uint256 amount) external {
        AuditRecord storage rec = auditRecords[tradeHash];
        require(rec.recordedAt != 0, "AuditProof: no compliance record for this trade");
        require(rec.agent == msg.sender, "AuditProof: caller is not the attesting agent");
        require(!rec.executed, "AuditProof: trade already executed");
        require(rec.compliant, "AuditProof: trade violates compliance policy");

        rec.executed = true;
        require(asset.transferFrom(msg.sender, counterparty, amount), "AuditProof: transfer failed");
        emit TradeExecuted(tradeHash, msg.sender, counterparty, amount);
    }

    function getAuditRecord(uint256 tradeHash)
        external
        view
        returns (
            bool exists,
            bool compliant,
            bool executed,
            uint256 policyHash,
            uint256 thoughtCommit,
            address agent,
            uint64 recordedAt
        )
    {
        AuditRecord memory rec = auditRecords[tradeHash];
        return (
            rec.recordedAt != 0,
            rec.compliant,
            rec.executed,
            rec.policyHash,
            rec.thoughtCommit,
            rec.agent,
            rec.recordedAt
        );
    }

    function auditCount() external view returns (uint256) {
        return auditedTradeHashes.length;
    }
}