const hre = require('hardhat');
const { writeBackendAbi } = require('./abi');

hre.run('compile').then(() => writeBackendAbi(hre)).then((f) => console.log(`ABI written to ${f}`)).catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
