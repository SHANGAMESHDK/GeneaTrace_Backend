// Deploys GeneaTraceAnchor and wires the backend to it:
//  - writes blockchain/deployments/<network>.json
//  - copies the ABI to backend/lib/chain/abi/GeneaTraceAnchor.js
//  - sets ETH_CONTRACT_ADDRESS (and ETH_RPC_URL for localhost) in backend/.env
const fs = require('node:fs');
const path = require('node:path');
const hre = require('hardhat');
const { writeBackendAbi } = require('./abi');

const BACKEND = path.resolve(__dirname, '..', '..', 'backend');

function setEnv(file, values) {
  if (!fs.existsSync(file)) return false;
  let text = fs.readFileSync(file, 'utf8');
  for (const [k, v] of Object.entries(values)) {
    const line = `${k}=${v}`;
    text = new RegExp(`^${k}=.*$`, 'm').test(text) ? text.replace(new RegExp(`^${k}=.*$`, 'm'), line) : `${text.trimEnd()}\n${line}\n`;
  }
  fs.writeFileSync(file, text);
  return true;
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const { chainId } = await hre.ethers.provider.getNetwork();
  const factory = await hre.ethers.getContractFactory('GeneaTraceAnchor');
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  const receipt = await contract.deploymentTransaction().wait();

  const info = { network: hre.network.name, chainId: Number(chainId), address, owner: deployer.address, deployTx: receipt.hash, block: receipt.blockNumber, deployedAt: new Date().toISOString() };
  fs.mkdirSync(path.join(__dirname, '..', 'deployments'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'deployments', `${hre.network.name}.json`), `${JSON.stringify(info, null, 2)}\n`);

  await writeBackendAbi(hre);

  const env = { ETH_CONTRACT_ADDRESS: address, ETH_CHAIN_ID: Number(chainId) };
  if (hre.network.name === 'localhost') {
    // Local Hardhat chain only: the anchoring wallet is Hardhat's built-in test account #0
    // (derived from Hardhat's public development mnemonic). Never used for real funds.
    const { mnemonic, path: hdPath } = hre.config.networks.hardhat.accounts;
    env.ETH_RPC_URL = 'http://127.0.0.1:8545';
    env.ETH_PRIVATE_KEY = hre.ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, `${hdPath}/0`).privateKey;
  }
  const wrote = setEnv(path.join(BACKEND, '.env'), env);

  console.log(`GeneaTraceAnchor deployed to ${address} on ${hre.network.name} (chain ${chainId})`);
  console.log(`  owner (anchoring wallet): ${deployer.address}`);
  console.log(wrote ? '  backend/.env updated – restart the backend to start anchoring.' : '  backend/.env not found – set ETH_CONTRACT_ADDRESS there yourself.');
  if (hre.network.name !== 'localhost') console.log('  Set ETH_RPC_URL and ETH_PRIVATE_KEY (the owner wallet) in backend/.env.');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
