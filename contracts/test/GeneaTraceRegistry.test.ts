import { expect } from "chai";
import { ethers } from "hardhat";

describe("GeneaTraceRegistry", function () {
  let registry: any;
  let owner: any;
  let issuer: any;
  let unauthorized: any;

  beforeEach(async function () {
    [owner, issuer, unauthorized] = await ethers.getSigners();
    const RegistryFactory = await ethers.getContractFactory("GeneaTraceRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();
  });

  it("should authorize an issuer", async function () {
    await registry.authorizeIssuer(issuer.address);
    expect(await registry.authorizedIssuers(issuer.address)).to.be.true;
  });

  it("should record a Merkle root checkpoint", async function () {
    const rootBytes = ethers.keccak256(ethers.toUtf8Bytes("merkle-root-batch-abc"));
    await registry.recordCheckpoint(rootBytes, "ABC", 100);

    const cp = await registry.getCheckpoint(rootBytes);
    expect(cp.exists).to.be.true;
    expect(cp.batchId).to.equal("ABC");
    expect(cp.eventCount).to.equal(100);
  });

  it("should reject duplicate checkpoint root", async function () {
    const rootBytes = ethers.keccak256(ethers.toUtf8Bytes("merkle-root-batch-abc"));
    await registry.recordCheckpoint(rootBytes, "ABC", 100);
    await expect(
      registry.recordCheckpoint(rootBytes, "ABC", 100)
    ).to.be.revertedWith("Checkpoint already recorded for this root");
  });

  it("should register identity commitments and prevent duplicates", async function () {
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("device-commitment-s24-001"));
    await registry.registerIdentityCommitment(commitment, "GT-DEV-00000851");

    const info = await registry.verifyCommitment(commitment);
    expect(info.exists).to.be.true;
    expect(info.isRevoked).to.be.false;
    expect(info.entityId).to.equal("GT-DEV-00000851");

    await expect(
      registry.registerIdentityCommitment(commitment, "GT-DEV-00000851")
    ).to.be.revertedWith("Identity commitment already registered");
  });

  it("should support revocation", async function () {
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("revocation-test-commitment"));
    await registry.registerIdentityCommitment(commitment, "GT-DEV-REVOKED");
    await registry.revokeCommitment(commitment, "Compromised secure element");

    const info = await registry.verifyCommitment(commitment);
    expect(info.isRevoked).to.be.true;
  });
});
