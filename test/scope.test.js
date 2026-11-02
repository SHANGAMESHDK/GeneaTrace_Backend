// Data visibility: each company sees only its own units; regulators and admin see everything.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = '';
const { boot } = await import('../lib/boot.js');
const { ctx } = await import('../lib/context.js');
const { createActor, createFacility } = await import('../lib/services/network.js');
const { createBatch } = await import('../lib/services/catalog.js');
const { recordEvents } = await import('../lib/services/events.js');
const { apiRouter } = await import('../lib/routes/api.js');

const A = {};
let phones;
let vials;
const keys = {};

// Call the real API routes as a given company.
async function call(who, method, path, body) {
  const headers = { 'x-api-key': keys[who] };
  const url = new URL(`http://x${path}`);
  const res = await apiRouter.dispatch({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: body || {}, params: {}, ip: 'test', get: (h) => headers[h.toLowerCase()] }).catch((e) => ({ status_: e.status || 500, body: { error: e.message } }));
  return { status: res.status_, body: res.body };
}

before(async () => {
  await boot({ databaseUrl: '', file: null, ethereum: false });
  const admin = await ctx.store.get('actors', 'ACT-ADMIN');
  for (const [k, role] of Object.entries({ nova: 'manufacturer', pharma: 'manufacturer', retail: 'retailer', pharmacy: 'pharmacy', reg: 'regulator' })) {
    const r = await createActor(admin, { name: k, role });
    A[k] = r.actor;
    keys[k] = r.api_key;
  }
  const fac = {};
  for (const [k, owner] of Object.entries({ plant: 'nova', store: 'retail', lab: 'pharma', shop: 'pharmacy' })) fac[k] = await createFacility(admin, { name: k, type: 'factory', actor_id: A[owner].id });
  phones = (await createBatch(A.nova, { id: 'PHN', sku: 'P', name: 'Phone', category: 'electronics', quantity: 10, mint: 3, facility_id: fac.plant.id })).minted.map((u) => u.id);
  vials = (await createBatch(A.pharma, { id: 'VIA', sku: 'V', name: 'Vial', category: 'medicine', quantity: 10, mint: 3, facility_id: fac.lab.id })).minted.map((u) => u.id);
  await recordEvents(A.nova, { type: 'PRODUCTION_COMPLETE', product_ids: phones });
  await recordEvents(A.pharma, { type: 'PRODUCTION_COMPLETE', product_ids: vials });
  // One phone goes to the retailer; a counterfeit vial serial is presented to the pharmacy.
  await recordEvents(A.nova, { type: 'EXIT', product_ids: [phones[0]], facility_id: fac.plant.id, to_actor_id: A.retail.id });
  await recordEvents(A.retail, { type: 'ENTRY', product_ids: [phones[0]], facility_id: fac.store.id });
  await recordEvents(A.pharmacy, { type: 'ENTRY', product_ids: ['VIA99999999'], facility_id: fac.shop.id });
});

test('a pharma company does not see phone passports', async () => {
  const r = await call('pharma', 'GET', '/products');
  const ids = r.body.items.map((p) => p.id);
  assert.deepEqual(new Set(ids), new Set(vials));
  assert.equal((await call('pharma', 'GET', `/products/${phones[1]}`)).status, 404);
  assert.equal((await call('pharma', 'GET', `/scanner/${phones[1]}`)).status, 404);
});

test('a retailer sees only units it holds or handled', async () => {
  const r = await call('retail', 'GET', '/products');
  assert.deepEqual(r.body.items.map((p) => p.id), [phones[0]]);
  assert.equal((await call('retail', 'GET', `/products/${phones[0]}`)).status, 200);
  assert.equal((await call('retail', 'GET', `/products/${phones[1]}`)).status, 404);
});

test('batches: makers see their own; others see only batches they hold units of, without the trace', async () => {
  const pharmaBatches = (await call('pharma', 'GET', '/batches')).body.map((b) => b.id);
  assert.deepEqual(pharmaBatches, ['VIA']);
  assert.equal((await call('pharma', 'GET', '/batches/PHN')).status, 404);
  const retailView = await call('retail', 'GET', '/batches/PHN');
  assert.equal(retailView.status, 200);
  assert.equal(retailView.body.restricted, true);
  assert.equal(retailView.body.trace, null);
  assert.deepEqual(retailView.body.units.map((u) => u.id), [phones[0]]);
  const makerView = await call('nova', 'GET', '/batches/PHN');
  assert.equal(makerView.body.units.length, 3);
  assert.ok(makerView.body.trace);
});

test('events, alerts and the dashboard are scoped too', async () => {
  const ev = (await call('pharma', 'GET', '/events?limit=500')).body;
  assert.ok(ev.length > 0 && ev.every((e) => vials.includes(e.product_id)));
  // The counterfeit "VIA…" serial alert concerns pharma (its batch code) and the pharmacy, not Nova.
  const pharmaAlerts = (await call('pharma', 'GET', '/alerts')).body.map((a) => a.type);
  const novaAlerts = (await call('nova', 'GET', '/alerts')).body.map((a) => a.type);
  assert.ok(pharmaAlerts.includes('UNREGISTERED_UNITS'));
  assert.ok(!novaAlerts.includes('UNREGISTERED_UNITS'));
  const dash = (await call('pharma', 'GET', '/analytics/overview')).body;
  assert.equal(dash.totals.products, 3);
  assert.equal(dash.totals.batches, 1);
});

test('regulators see the whole network', async () => {
  const r = await call('reg', 'GET', '/products?limit=500');
  assert.equal(r.body.total, 6);
  assert.equal((await call('reg', 'GET', `/products/${phones[1]}`)).status, 200);
  assert.equal((await call('reg', 'GET', '/analytics/overview')).body.totals.products, 6);
});

test('ledger explorer hides other companies’ transactions', async () => {
  const [tx] = await ctx.store.list('events', { where: { product_id: phones[1] }, limit: 1 });
  assert.equal((await call('pharma', 'GET', `/chain/tx/${tx.id}`)).status, 404);
  const block = await call('pharma', 'GET', `/chain/blocks/${tx.block_height}`);
  assert.ok(block.body.txs.every((t) => !phones.includes(t.product_id)));
  assert.ok(block.body.hidden > 0);
});
