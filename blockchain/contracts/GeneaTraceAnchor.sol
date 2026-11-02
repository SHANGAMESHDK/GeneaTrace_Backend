// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title GeneaTraceAnchor
/// @notice Public, append-only anchor for the GeneaTrace ledger. The GeneaTrace node writes the
///         SHA-256 hash of every ledger block here, strictly in height order. A block hash commits
///         to the block's Merkle root, its previous block and every signed event inside it, so
///         once anchored, no record in Supabase can be rewritten without the mismatch being
///         provable against Ethereum. No product, customer or business data is stored on-chain.
contract GeneaTraceAnchor {
    /// @notice Account allowed to anchor (the GeneaTrace node wallet).
    address public owner;

    // index = ledger block height
    bytes32[] private _blockHashes;

    event BlockAnchored(uint256 indexed height, bytes32 blockHash, bytes32 merkleRoot, uint32 txCount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error HeightMismatch(uint256 expected, uint256 given);
    error LengthMismatch();
    error EmptyHash(uint256 height);
    error ZeroAddress();

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Anchor consecutive ledger blocks starting at `fromHeight`.
    ///         Anchors can only be appended – there is no function to change or delete one.
    function anchorBlocks(
        uint256 fromHeight,
        bytes32[] calldata blockHashes,
        bytes32[] calldata merkleRoots,
        uint32[] calldata txCounts
    ) external onlyOwner {
        if (fromHeight != _blockHashes.length) revert HeightMismatch(_blockHashes.length, fromHeight);
        uint256 n = blockHashes.length;
        if (merkleRoots.length != n || txCounts.length != n) revert LengthMismatch();
        for (uint256 i; i < n; ++i) {
            if (blockHashes[i] == bytes32(0)) revert EmptyHash(fromHeight + i);
            _blockHashes.push(blockHashes[i]);
            emit BlockAnchored(fromHeight + i, blockHashes[i], merkleRoots[i], txCounts[i]);
        }
    }

    /// @notice Number of ledger blocks anchored so far (= next height expected).
    function anchoredCount() external view returns (uint256) {
        return _blockHashes.length;
    }

    /// @notice Anchored hash of a ledger block, or zero if not anchored yet.
    function anchorOf(uint256 height) external view returns (bytes32) {
        return height < _blockHashes.length ? _blockHashes[height] : bytes32(0);
    }

    /// @notice Up to `count` anchored hashes starting at `fromHeight` (for bulk verification).
    function anchorsFrom(uint256 fromHeight, uint256 count) external view returns (bytes32[] memory out) {
        uint256 total = _blockHashes.length;
        if (fromHeight >= total) return new bytes32[](0);
        uint256 end = fromHeight + count > total ? total : fromHeight + count;
        out = new bytes32[](end - fromHeight);
        for (uint256 i = fromHeight; i < end; ++i) out[i - fromHeight] = _blockHashes[i];
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
