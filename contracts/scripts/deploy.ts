import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying GeneaTraceRegistry with account:", deployer.address);

  const RegistryFactory = await ethers.getContractFactory("GeneaTraceRegistry");
  const registry = await RegistryFactory.deploy();
  await registry.waitForDeployment();

  const targetAddress = await registry.getAddress();
  console.log("GeneaTraceRegistry deployed to:", targetAddress);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
