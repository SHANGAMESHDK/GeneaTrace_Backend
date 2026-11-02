const fs = require('node:fs');
const path = require('node:path');

// The backend imports the ABI as an ES module so it works in Node scripts and Next.js alike.
async function writeBackendAbi(hre) {
  const artifact = await hre.artifacts.readArtifact('GeneaTraceAnchor');
  const dir = path.resolve(__dirname, '..', '..', 'backend', 'lib', 'chain', 'abi');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'GeneaTraceAnchor.js');
  fs.writeFileSync(file, `// Generated from blockchain/contracts/GeneaTraceAnchor.sol – run \`npm run export-abi\` in blockchain/.\nexport const GENEATRACE_ANCHOR_ABI = ${JSON.stringify(artifact.abi, null, 2)};\n`);
  return file;
}

module.exports = { writeBackendAbi };
