// Shows the anchoring wallet's address and Sepolia balance, and whether it is ready to deploy.
// Usage (from blockchain/): npm run check
require('dotenv').config();
const { ethers } = require('ethers');

const MIN_ETH = 0.005; // deploy + a few hundred anchored blocks

async function main() {
  const rpc = process.env.SEPOLIA_RPC_URL;
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) return console.log('No DEPLOYER_PRIVATE_KEY in blockchain/.env.');
  const address = new ethers.Wallet(key.startsWith('0x') ? key : `0x${key}`).address;
  console.log(`Wallet:  ${address}`);
  if (!rpc) return console.log('No SEPOLIA_RPC_URL in blockchain/.env.');
  const req = new ethers.FetchRequest(rpc);
  req.timeout = 15_000;
  const provider = new ethers.JsonRpcProvider(req, 11155111, { staticNetwork: true });
  const wei = await provider.getBalance(address);
  const eth = Number(ethers.formatEther(wei));
  console.log(`Network: Sepolia (${new URL(rpc).host})`);
  console.log(`Balance: ${eth} test ETH`);
  console.log(eth >= MIN_ETH
    ? 'Ready: run  npm run deploy:sepolia'
    : `Not yet: get free Sepolia ETH for the address above from a faucet (at least ${MIN_ETH}).`);
}

main().catch((e) => {
  console.error(`Check failed: ${e.shortMessage || e.message}`);
  process.exitCode = 1;
});
