// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title GeneaTraceRegistry
 * @dev Anchors cryptographic identity commitments, Merkle-DAG roots, and revocations.
 * Does NOT store sensitive PII, full IMEI, or raw manufacturing payloads on-chain.
 */
contract GeneaTraceRegistry {
    address public owner;

    struct IdentityRecord {
        bool exists;
        bool isRevoked;
        string entityId;
        uint256 registeredAt;
    }

    struct CheckpointRecord {
        bool exists;
        string batchId;
        uint256 eventCount;
        uint256 timestamp;
        address recorder;
    }

    mapping(address => bool) public authorizedIssuers;
    mapping(bytes32 => IdentityRecord) private _commitments;
    mapping(bytes32 => CheckpointRecord) private _checkpoints;

    event IssuerAuthorized(address indexed issuer, address indexed authorizedBy);
    event IssuerDeauthorized(address indexed issuer, address indexed deauthorizedBy);
    event IdentityCommitmentRegistered(bytes32 indexed commitment, string entityId, uint256 timestamp);
    event CheckpointRecorded(bytes32 indexed merkleRoot, string batchId, uint256 eventCount, uint256 timestamp);
    event CommitmentRevoked(bytes32 indexed commitment, string reason, uint256 timestamp);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only contract owner can execute");
        _;
    }

    modifier onlyIssuer() {
        require(authorizedIssuers[msg.sender] || msg.sender == owner, "Unauthorized issuer");
        _;
    }

    constructor() {
        owner = msg.sender;
        authorizedIssuers[msg.sender] = true;
        emit IssuerAuthorized(msg.sender, msg.sender);
    }

    function authorizeIssuer(address issuer) external onlyOwner {
        require(issuer != address(0), "Invalid address");
        authorizedIssuers[issuer] = true;
        emit IssuerAuthorized(issuer, msg.sender);
    }

    function deauthorizeIssuer(address issuer) external onlyOwner {
        authorizedIssuers[issuer] = false;
        emit IssuerDeauthorized(issuer, msg.sender);
    }

    function registerIdentityCommitment(bytes32 commitment, string calldata entityId) external onlyIssuer {
        require(commitment != bytes32(0), "Invalid commitment hash");
        require(!_commitments[commitment].exists, "Identity commitment already registered");

        _commitments[commitment] = IdentityRecord({
            exists: true,
            isRevoked: false,
            entityId: entityId,
            registeredAt: block.timestamp
        });

        emit IdentityCommitmentRegistered(commitment, entityId, block.timestamp);
    }

    function recordCheckpoint(bytes32 merkleRoot, string calldata batchId, uint256 eventCount) external onlyIssuer {
        require(merkleRoot != bytes32(0), "Invalid Merkle root");
        require(!_checkpoints[merkleRoot].exists, "Checkpoint already recorded for this root");

        _checkpoints[merkleRoot] = CheckpointRecord({
            exists: true,
            batchId: batchId,
            eventCount: eventCount,
            timestamp: block.timestamp,
            recorder: msg.sender
        });

        emit CheckpointRecorded(merkleRoot, batchId, eventCount, block.timestamp);
    }

    function revokeCommitment(bytes32 commitment, string calldata reason) external onlyIssuer {
        require(_commitments[commitment].exists, "Commitment does not exist");
        require(!_commitments[commitment].isRevoked, "Commitment already revoked");

        _commitments[commitment].isRevoked = true;
        emit CommitmentRevoked(commitment, reason, block.timestamp);
    }

    function verifyCommitment(bytes32 commitment) external view returns (
        bool exists,
        bool isRevoked,
        string memory entityId,
        uint256 registeredAt
    ) {
        IdentityRecord memory rec = _commitments[commitment];
        return (rec.exists, rec.isRevoked, rec.entityId, rec.registeredAt);
    }

    function getCheckpoint(bytes32 merkleRoot) external view returns (
        bool exists,
        string memory batchId,
        uint256 eventCount,
        uint256 timestamp,
        address recorder
    ) {
        CheckpointRecord memory rec = _checkpoints[merkleRoot];
        return (rec.exists, rec.batchId, rec.eventCount, rec.timestamp, rec.recorder);
    }
}
