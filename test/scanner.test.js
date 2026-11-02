// Process scanner: re-scanning a part-install step with a new part retires the part it replaces.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = '';
const { boot } = await import('../lib/boot.js');
const { ctx } = await import('../lib/context.js');
const { createActor, createFacility } = await import('../lib/services/network.js');
const { createBatch } = await import('../lib/services/catalog.js');
const { recordEvents } = await import('../lib/services/events.js');
const { createMachine } = await import('../lib/services/production.js');

const A = {};
let phone;
let panels;
const get = (id) => ctx.store.get('products', id);
const ok = async (actor, input) => {
  const r = await recordEvents(actor, input);
  assert.equal(r.rejected.length, 0, `${input.type} rejected: ${r.rejected[0]?.reason}`);
  return r;
};

before(async () => {
  await boot({ databaseUrl: '', file: null, ethereum: false });
  const admin = await ctx.store.get('actors', 'ACT-ADMIN');
  for (const [k, role] of Object.entries({ maker: 'manufacturer', supplier: 'manufacturer' })) A[k] = (await createActor(admin, { name: k, role })).actor;
  const plant = await createFacility(admin, { name: 'plant', type: 'factory', actor_id: A.maker.id });
  const fab = await createFacility(admin, { name: 'fab', type: 'factory', actor_id: A.supplier.id });
  await createMachine(A.maker, { id: 'LAM-X', name: 'Laminator', facility_id: plant.id, processes: ['Display lamination'] });
  panels = (await createBatch(A.supplier, { id: 'PNX', sku: 'P', name: 'Panel', category: 'component', quantity: 5, mint: 3, facility_id: fab.id })).minted.map((u) => u.id);
  await ok(A.supplier, { type: 'PRODUCTION_COMPLETE', product_ids: panels });
  await ok(A.supplier, { type: 'EXIT', product_ids: panels, facility_id: fab.id, to_actor_id: A.maker.id });
  await ok(A.maker, { type: 'ENTRY', product_ids: panels, facility_id: plant.id });
  [phone] = (await createBatch(A.maker, {
    id: 'PHX', sku: 'X', name: 'Phone', category: 'electronics', quantity: 5, mint: 1, facility_id: plant.id,
    process_route: ['Display lamination'], components: [{ batch_id: 'PNX', name: 'Display panel' }],
  })).minted.map((u) => u.id);
});

test('a failed lamination re-done with a new panel retires the first panel', async () => {
  await ok(A.maker, { type: 'PROCESS_STEP', product_ids: [phone], part_ids: [panels[0]], data: { process: 'Display lamination', machine_id: 'LAM-X', result: 'fail' } });
  assert.equal((await get(panels[0])).status, 'installed');

  await ok(A.maker, { type: 'PROCESS_STEP', product_ids: [phone], part_ids: [panels[1]], data: { process: 'Display lamination', machine_id: 'LAM-X' } });
  const unit = await get(phone);
  assert.equal(unit.attributes.parts['Display panel'].serial, panels[1]);
  const first = await get(panels[0]);
  assert.equal(first.status, 'retired');
  assert.equal(first.attributes.removed_from, phone);
  assert.equal((await get(panels[1])).status, 'installed');
  assert.equal((await ctx.ledger.verify()).valid, true);
});
