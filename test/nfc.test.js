// NFC tags: the crypto against published values, then pairing, taps, copies and forgeries.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = '';
process.env.DEMO_MODE = 'true';
const { boot } = await import('../lib/boot.js');
const { ctx } = await import('../lib/context.js');
const { createActor, createFacility } = await import('../lib/services/network.js');
const { createBatch } = await import('../lib/services/catalog.js');
const { cmac, decryptPicc, sdmMac, bindTag, verifyTap, simulateTap } = await import('../lib/services/nfc.js');

const A = {};
let unit;
const parts = (url) => Object.fromEntries(new URL(url).searchParams);

before(async () => {
  await boot({ databaseUrl: '', file: null, ethereum: false });
  const admin = await ctx.store.get('actors', 'ACT-ADMIN');
  for (const k of ['maker', 'rival']) A[k] = (await createActor(admin, { name: k, role: 'manufacturer' })).actor;
  const f = await createFacility(admin, { name: 'lab', type: 'factory', actor_id: A.maker.id });
  [unit] = (await createBatch(A.maker, { id: 'NFC', sku: 'N', name: 'Vial', category: 'medicine', quantity: 5, mint: 2, facility_id: f.id })).minted.map((u) => u.id);
});

test('AES-CMAC matches the RFC 4493 vectors', () => {
  const key = Buffer.from('2b7e151628aed2a6abf7158809cf4f3c', 'hex');
  assert.equal(cmac(key, Buffer.alloc(0)).toString('hex'), 'bb1d6929e95937287fa37d129b756746');
  assert.equal(cmac(key, Buffer.from('6bc1bee22e409f96e93d7e117393172a', 'hex')).toString('hex'), '070a16b46b4d4144f79bdd9dd04a287c');
  assert.equal(cmac(key, Buffer.from('6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411', 'hex')).toString('hex'), 'dfa66747de9ae63030ca32611497c827');
});

test('reads a published NTAG 424 DNA sample tap', () => {
  const zero = Buffer.alloc(16);
  const picc = decryptPicc(zero, 'EF963FF7828658A599F3041510671E88');
  assert.deepEqual(picc, { uid: '04DE5F1EACC040', counter: 61 });
  assert.equal(sdmMac(zero, picc.uid, picc.counter), '94EED9EE65337086');
});

test('only the maker can pair a tag, once', async () => {
  await assert.rejects(bindTag(A.rival, unit, '04AABBCCDDEE01'), /not found/);
  await assert.rejects(bindTag(A.maker, unit, 'XYZ'), /14 hex/);
  const r = await bindTag(A.maker, unit, '04:AA:BB:CC:DD:EE:01');
  assert.equal(r.uid, '04AABBCCDDEE01');
  assert.equal(r.file_read_key.length, 32);
  await assert.rejects(bindTag(A.maker, unit, '04AABBCCDDEE02'), /already has a tag/);
  assert.equal((await ctx.store.get('products', unit)).attributes.nfc_uid, '04AABBCCDDEE01');
  assert.equal((await ctx.ledger.verify()).valid, true);
});

test('each tap verifies once; a refresh is fine; a copied old link is caught', async () => {
  const first = parts((await simulateTap(A.maker, unit)).url);
  const ok = await verifyTap(first);
  assert.equal(ok.verdict, 'GENUINE');
  assert.equal(ok.product_id, unit);
  assert.equal((await verifyTap(first)).verdict, 'GENUINE');

  const second = parts((await simulateTap(A.maker, unit)).url);
  assert.equal((await verifyTap(second)).verdict, 'GENUINE');

  assert.equal((await verifyTap(first)).verdict, 'SUSPECTED_CLONE');
  assert.ok((await ctx.store.list('alerts', { where: { type: 'NFC_REJECTED' } })).length > 0);
});

test('a forged or altered tap fails', async () => {
  const good = parts((await simulateTap(A.maker, unit)).url);
  assert.equal((await verifyTap({ e: good.e, c: '0000000000000000' })).verdict, 'COUNTERFEIT');
  assert.equal((await verifyTap({ e: 'EF963FF7828658A599F3041510671E88', c: '94EED9EE65337086' })).verdict, 'COUNTERFEIT');
  assert.equal((await verifyTap({ e: 'nonsense', c: '' })).verdict, 'COUNTERFEIT');
  assert.equal((await verifyTap(good)).verdict, 'GENUINE');
});
