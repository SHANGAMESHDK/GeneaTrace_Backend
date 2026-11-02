import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = '';
const { boot } = await import('../lib/boot.js');
const { ctx } = await import('../lib/context.js');
const { createActor, createFacility, setFacilityLicense } = await import('../lib/services/network.js');
const { createBatch } = await import('../lib/services/catalog.js');
const { recordEvents } = await import('../lib/services/events.js');
const { scan, buildPassport } = await import('../lib/services/passport.js');
const { merkleRoot, merkleProof, verifyProof } = await import('../lib/chain/merkle.js');

let admin, maker, dist, shop, plant, wh, store, units;

before(async () => {
  await boot({ databaseUrl: '', file: null, ethereum: false }); // in-memory
  admin = await ctx.store.get('actors', 'ACT-ADMIN');
  maker = (await createActor(admin, { name: 'Maker', role: 'manufacturer' })).actor;
  dist = (await createActor(admin, { name: 'Dist', role: 'distributor' })).actor;
  shop = (await createActor(admin, { name: 'Shop', role: 'pharmacy' })).actor;
  plant = await createFacility(admin, { name: 'Plant', type: 'factory', actor_id: maker.id, lat: 13, lng: 77.5 });
  wh = await createFacility(admin, { name: 'WH', type: 'warehouse', actor_id: dist.id, lat: 13.1, lng: 77.6 });
  store = await createFacility(admin, { name: 'Store', type: 'pharmacy', actor_id: shop.id, lat: 12.9, lng: 77.6 });
  const b = await createBatch(maker, { id: 'TST', sku: 'X', name: 'Test drug', category: 'medicine', quantity: 10, mint: 5, facility_id: plant.id, attributes: { temp_min_c: 2, temp_max_c: 8 } });
  units = b.minted.map((u) => u.id);
  await recordEvents(maker, { type: 'PRODUCTION_COMPLETE', product_ids: units });
});

test('merkle proofs verify for every leaf, odd and even sizes', () => {
  for (const n of [1, 2, 3, 7, 8]) {
    const leaves = Array.from({ length: n }, (_, i) => `leaf${i}`.padEnd(64, '0'));
    const root = merkleRoot(leaves);
    leaves.forEach((l, i) => assert.ok(verifyProof(l, merkleProof(leaves, i), root)));
  }
});

test('minting caps at batch quantity; finished units sit with the manufacturer', async () => {
  const p = await ctx.store.get('products', units[0]);
  assert.equal(p.custodian_id, maker.id);
  assert.equal(p.status, 'in_stock');
  await assert.rejects(createBatch(maker, { id: 'TMY', sku: 'Y', name: 'Too many', category: 'medicine', quantity: 2, mint: 3 }));
});

test('exit → entry transfers custody; only the consignee can receive', async () => {
  const exit = await recordEvents(maker, { type: 'EXIT', product_ids: units.slice(0, 3), facility_id: plant.id, to_actor_id: dist.id });
  assert.equal(exit.accepted.length, 3);
  const wrong = await recordEvents(shop, { type: 'ENTRY', product_ids: [units[0]], facility_id: store.id });
  assert.equal(wrong.accepted.length, 0);
  assert.ok(wrong.alerts.some((a) => a.type === 'CUSTODY_BREACH'));
  const ok = await recordEvents(dist, { type: 'ENTRY', product_ids: units.slice(0, 3), facility_id: wh.id });
  assert.equal(ok.accepted.length, 3);
  assert.equal((await ctx.store.get('products', units[0])).custodian_id, dist.id);
});

test('unknown IDs are rejected and raise a counterfeit alert', async () => {
  const r = await recordEvents(dist, { type: 'ENTRY', product_ids: ['GT-FAKE0-00000'], facility_id: wh.id });
  assert.equal(r.rejected[0].code, 'UNKNOWN');
  assert.ok(r.alerts.some((a) => a.type === 'UNREGISTERED_UNITS'));
});

test('non-manufacturer repackaging is blocked as a tamper attempt', async () => {
  const r = await recordEvents(dist, { type: 'REPACKAGE', product_ids: [units[0]] });
  assert.equal(r.accepted.length, 0);
  assert.ok(r.alerts.some((a) => a.type === 'TAMPER_ATTEMPT' && a.severity === 'critical'));
});

test('cold-chain excursion blocks sale', async () => {
  await recordEvents(dist, { type: 'EXIT', product_ids: [units[1]], facility_id: wh.id, to_actor_id: shop.id });
  const cp = await recordEvents(dist, { type: 'CHECKPOINT', product_ids: [units[1]], data: { temperature_c: 15 } });
  assert.ok(cp.alerts.some((a) => a.type === 'COLD_CHAIN_EXCURSION'));
  await recordEvents(shop, { type: 'ENTRY', product_ids: [units[1]], facility_id: store.id });
  const sale = await recordEvents(shop, { type: 'SOLD', product_ids: [units[1]], facility_id: store.id });
  assert.equal(sale.accepted.length, 0);
});

test('entry into an unlicensed facility flags the unit', async () => {
  await setFacilityLicense(admin, store.id, false, 'inspection failed');
  await recordEvents(dist, { type: 'EXIT', product_ids: [units[2]], facility_id: wh.id, to_actor_id: shop.id });
  const r = await recordEvents(shop, { type: 'ENTRY', product_ids: [units[2]], facility_id: store.id });
  assert.ok(r.alerts.some((a) => a.type === 'UNLICENSED_FACILITY'));
  assert.equal((await ctx.store.get('products', units[2])).status, 'flagged');
});

test('scan verdicts: genuine, forged signature, unknown ID', async () => {
  const p = await ctx.store.get('products', units[3]);
  assert.equal((await scan({ id: p.id, sig: p.signature })).verdict, 'GENUINE');
  assert.equal((await scan({ id: p.id, sig: `${p.signature.slice(0, -4)}AAAA` })).verdict, 'COUNTERFEIT');
  assert.equal((await scan({ id: 'GT-NOPE0-NOPE0' })).verdict, 'COUNTERFEIT');
});

test('same label scanned in two distant cities is a suspected clone', async () => {
  const p = await ctx.store.get('products', units[4]);
  await scan({ id: p.id, sig: p.signature, lat: 12.97, lng: 77.59 });
  const r = await scan({ id: p.id, sig: p.signature, lat: 28.61, lng: 77.21 });
  assert.equal(r.verdict, 'SUSPECTED_CLONE');
});

test('chain verifies, and a direct edit of a sealed event is detected', async () => {
  assert.equal((await ctx.ledger.verify()).valid, true);
  const [tx] = await ctx.store.list('events', { where: { product_id: units[0], type: 'EXIT' }, limit: 1 });
  await assert.rejects(ctx.store.update('events', tx.id, { data: {} }), /append-only/);
  await ctx.store.unsafeUpdate('events', tx.id, { data: { ...tx.data, forged: true } });
  const v = await ctx.ledger.verify();
  assert.equal(v.valid, false);
  assert.ok(v.issues.some((i) => i.tx === tx.id));
  const passport = await buildPassport(units[0]);
  assert.equal(passport.integrity.valid, false);
  assert.equal(passport.trust.score, 0);
});
