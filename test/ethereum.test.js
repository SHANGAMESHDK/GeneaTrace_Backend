// Integration test against a local Hardhat chain (npm run node in blockchain/).
// Skipped automatically when no chain is listening on 127.0.0.1:8545.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ethers } from 'ethers';

process.env.DATABASE_URL = '';
const RPC = 'http://127.0.0.1:8545';
const ARTIFACT = new URL('../../blockchain/artifacts/contracts/GeneaTraceAnchor.sol/GeneaTraceAnchor.json', import.meta.url);
// Hardhat's built-in development account #9 (public test mnemonic) – keeps clear of the app's account #0.
const TEST_MNEMONIC = 'test test test test test test test test test test test junk';

let up = false;
try {
  await new ethers.JsonRpcProvider(RPC).getBlockNumber();
  up = fs.existsSync(ARTIFACT);
} catch {
  up = false;
}

const { boot } = await import('../lib/boot.js');
const { ctx } = await import('../lib/context.js');
const { EthereumAnchor } = await import('../lib/chain/ethereum.js');
const { createActor } = await import('../lib/services/network.js');

let anchor;

before(async () => {
  if (!up) return;
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = ethers.HDNodeWallet.fromPhrase(TEST_MNEMONIC, undefined, "m/44'/60'/0'/0/9").connect(provider);
  const { abi, bytecode } = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
  const contract = await new ethers.ContractFactory(abi, bytecode, wallet).deploy();
  await contract.waitForDeployment();
  await boot({ databaseUrl: '', file: null, ethereum: false });
  anchor = new EthereumAnchor(ctx.store, ctx.ledger, { rpcUrl: RPC, privateKey: wallet.privateKey, contract: await contract.getAddress(), chainId: 31337, explorerUrl: '', intervalMs: 60_000, batch: 2 });
  ctx.ledger.setAnchor(anchor);
  await anchor.init();
  const admin = await ctx.store.get('actors', 'ACT-ADMIN');
  for (let i = 0; i < 3; i++) await createActor(admin, { name: `Member ${i}`, role: 'retailer' });
});

test('every ledger block hash is anchored on Ethereum in order', { skip: !up && 'no local chain' }, async () => {
  const state = await anchor.drain();
  const blocks = await ctx.store.list('blocks', { order: [['id', 'asc']] });
  assert.equal(state.status, 'synced');
  assert.equal(state.anchored, blocks.length);
  const v = await anchor.verify(blocks);
  assert.equal(v.issues.length, 0);
  const receipts = await anchor.receipts([0, blocks.length - 1]);
  assert.match(receipts.get(0).tx_hash, /^0x[0-9a-f]{64}$/);
});

test('a block rewritten in the database is caught by its Ethereum anchor', { skip: !up && 'no local chain' }, async () => {
  const [last] = await ctx.store.list('blocks', { order: [['id', 'desc']], limit: 1 });
  await ctx.store.unsafeUpdate('blocks', last.id, { hash: `0000${'f'.repeat(60)}` });
  const blocks = await ctx.store.list('blocks', { order: [['id', 'asc']] });
  const v = await anchor.verify(blocks);
  assert.ok(v.issues.some((i) => i.height === last.id && /differs from its Ethereum anchor/.test(i.problem)));
  const check = await anchor.check([{ id: last.id, hash: `0000${'f'.repeat(60)}` }]);
  assert.deepEqual(check.mismatches, [last.id]);
});
