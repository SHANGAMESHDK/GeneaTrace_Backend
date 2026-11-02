const assert = require('node:assert/strict');
const { ethers } = require('hardhat');

const h = (s) => ethers.sha256(ethers.toUtf8Bytes(s));

describe('GeneaTraceAnchor', () => {
  let anchor;
  let owner;
  let stranger;

  beforeEach(async () => {
    [owner, stranger] = await ethers.getSigners();
    anchor = await (await ethers.getContractFactory('GeneaTraceAnchor')).deploy();
  });

  it('anchors consecutive blocks and reads them back', async () => {
    await anchor.anchorBlocks(0, [h('b0'), h('b1')], [h('m0'), h('m1')], [0, 3]);
    await anchor.anchorBlocks(2, [h('b2')], [h('m2')], [5]);
    assert.equal(await anchor.anchoredCount(), 3n);
    assert.equal(await anchor.anchorOf(1), h('b1'));
    assert.equal(await anchor.anchorOf(9), ethers.ZeroHash);
    assert.deepEqual([...(await anchor.anchorsFrom(1, 10))], [h('b1'), h('b2')]);
    assert.deepEqual([...(await anchor.anchorsFrom(5, 10))], []);
  });

  it('emits BlockAnchored with the Merkle root and tx count', async () => {
    const tx = await anchor.anchorBlocks(0, [h('b0')], [h('m0')], [7]);
    const log = (await tx.wait()).logs.map((l) => anchor.interface.parseLog(l)).find((e) => e.name === 'BlockAnchored');
    assert.equal(log.args.height, 0n);
    assert.equal(log.args.merkleRoot, h('m0'));
    assert.equal(log.args.txCount, 7n);
  });

  it('refuses gaps, rewrites and mismatched arrays', async () => {
    await anchor.anchorBlocks(0, [h('b0')], [h('m0')], [1]);
    await assert.rejects(anchor.anchorBlocks(0, [h('evil')], [h('m')], [1]), /HeightMismatch/);
    await assert.rejects(anchor.anchorBlocks(5, [h('b5')], [h('m5')], [1]), /HeightMismatch/);
    await assert.rejects(anchor.anchorBlocks(1, [h('b1')], [], [1]), /LengthMismatch/);
    await assert.rejects(anchor.anchorBlocks(1, [ethers.ZeroHash], [h('m1')], [1]), /EmptyHash/);
    assert.equal(await anchor.anchorOf(0), h('b0'));
  });

  it('only the owner can anchor or hand over ownership', async () => {
    await assert.rejects(anchor.connect(stranger).anchorBlocks(0, [h('b0')], [h('m0')], [1]), /NotOwner/);
    await anchor.transferOwnership(stranger.address);
    assert.equal(await anchor.owner(), stranger.address);
    await assert.rejects(anchor.anchorBlocks(0, [h('b0')], [h('m0')], [1]), /NotOwner/);
    await anchor.connect(stranger).anchorBlocks(0, [h('b0')], [h('m0')], [1]);
    assert.equal(await anchor.anchoredCount(), 1n);
    assert.equal(owner.address === stranger.address, false);
  });
});
