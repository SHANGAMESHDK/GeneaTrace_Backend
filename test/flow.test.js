// Walks the full GeneaTrace workflow end to end – the 15-step phone flow, the third-party
// part lock, and the same flow for medicine (with a replacement instead of a repair).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = '';
const { boot } = await import('../lib/boot.js');
const { ctx } = await import('../lib/context.js');
const { createActor, createFacility } = await import('../lib/services/network.js');
const { createBatch } = await import('../lib/services/catalog.js');
const { recordEvents } = await import('../lib/services/events.js');
const { createMachine, backtrace } = await import('../lib/services/production.js');
const { simulateCheckin } = await import('../lib/services/device.js');
const { scan, buildPassport } = await import('../lib/services/passport.js');

const A = {};
const F = {};
let phones;
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
  for (const [k, role] of Object.entries({ nova: 'manufacturer', lumina: 'manufacturer', retail: 'retailer', service: 'service_center', pharma: 'manufacturer', pharmacy: 'pharmacy' })) {
    A[k] = (await createActor(admin, { name: k, role })).actor;
  }
  const fac = (key, owner, type) => createFacility(admin, { name: key, type, actor_id: A[owner].id, lat: 13, lng: 77.6 }).then((f) => (F[key] = f));
  await fac('plant', 'nova', 'factory');
  await fac('wh', 'nova', 'warehouse');
  await fac('store', 'retail', 'store');
  await fac('fab', 'lumina', 'factory');
  await fac('care', 'service', 'service_center');
  await fac('pharmaPlant', 'pharma', 'factory');
  await fac('pharmacy', 'pharmacy', 'pharmacy');
  for (const [id, procs] of Object.entries({ 'SMT-01': ['SMT'], 'LAM-01': ['Display lamination'], 'LAM-02': ['Display lamination'], 'ASM-01': ['Final assembly'], 'QC-01': ['Final QC'] })) {
    await createMachine(A.nova, { id, name: id, facility_id: F.plant.id, processes: procs });
  }
  // Genuine display panels from the component maker, shipped to the phone maker.
  const pb = await createBatch(A.lumina, { id: 'PNL-A', sku: 'PNL', name: 'AMOLED panel', category: 'component', quantity: 20, mint: 10, facility_id: F.fab.id });
  panels = pb.minted.map((u) => u.id);
  await ok(A.lumina, { type: 'PRODUCTION_COMPLETE', product_ids: panels });
  await ok(A.lumina, { type: 'EXIT', product_ids: panels, facility_id: F.fab.id, to_actor_id: A.nova.id });
  await ok(A.nova, { type: 'ENTRY', product_ids: panels, facility_id: F.plant.id });
});

test('steps 1-3: batch AAA issues empty cryptographic serials', async () => {
  const b = await createBatch(A.nova, {
    id: 'AAA', sku: 'NV-A55', name: 'Nova A55', category: 'electronics', quantity: 100, mint: 6, facility_id: F.plant.id,
    process_route: ['SMT', 'Display lamination', 'Final assembly', 'Final QC'], attributes: { firmware: 'OS 1.0', warranty_months: 12 },
    components: [{ batch_id: 'PNL-A', name: 'Display panel' }],
  });
  phones = b.minted.map((u) => u.id);
  for (const id of phones) assert.match(id, /^AAA\d{8}$/);
  const p = await get(phones[0]);
  assert.equal(p.status, 'in_production');
  assert.deepEqual(p.attributes.steps, []);
});

test('steps 4-6: each scanned process step is pushed with machine and timestamp', async () => {
  const skip = await recordEvents(A.nova, { type: 'PROCESS_STEP', product_ids: [phones[0]], data: { process: 'Final assembly', machine_id: 'ASM-01' } });
  assert.equal(skip.rejected[0].code, 'SEQUENCE');
  await assert.rejects(recordEvents(A.nova, { type: 'PROCESS_STEP', product_ids: phones, data: { process: 'SMT', machine_id: 'LAM-01' } }), /not qualified/);

  await ok(A.nova, { type: 'PROCESS_STEP', product_ids: phones, data: { process: 'SMT', machine_id: 'SMT-01' } });
  const fake = await recordEvents(A.nova, { type: 'PROCESS_STEP', product_ids: [phones[0]], part_ids: ['FAKE-PANEL-1'], data: { process: 'Display lamination', machine_id: 'LAM-02' } });
  assert.equal(fake.rejected[0].code, 'PART_UNKNOWN');
  assert.ok(fake.alerts.some((a) => a.type === 'COUNTERFEIT_PART'));

  const even = [0, 2, 4].map((i) => phones[i]);
  const odd = [1, 3, 5].map((i) => phones[i]);
  await ok(A.nova, { type: 'PROCESS_STEP', product_ids: even, part_ids: panels.slice(0, 3), data: { process: 'Display lamination', machine_id: 'LAM-02' } });
  await ok(A.nova, { type: 'PROCESS_STEP', product_ids: odd, part_ids: panels.slice(3, 6), data: { process: 'Display lamination', machine_id: 'LAM-01' } });
  await ok(A.nova, { type: 'PROCESS_STEP', product_ids: phones, data: { process: 'Final assembly', machine_id: 'ASM-01' } });
  const early = await recordEvents(A.nova, { type: 'PRODUCTION_COMPLETE', product_ids: [phones[0]] });
  assert.match(early.rejected[0].reason, /Missing process steps: Final QC/);
  await ok(A.nova, { type: 'PROCESS_STEP', product_ids: phones, data: { process: 'Final QC', machine_id: 'QC-01' } });
  await ok(A.nova, { type: 'PRODUCTION_COMPLETE', product_ids: phones });

  const p = await get(phones[0]);
  assert.equal(p.status, 'in_stock');
  assert.equal(p.attributes.steps.length, 4);
  assert.equal(p.attributes.steps[1].machine_id, 'LAM-02');
  assert.equal(p.attributes.parts['Display panel'].serial, panels[0]);
  assert.equal((await get(panels[0])).status, 'installed');
});

test('step 7-8: packed, warehoused, dispatched, delivered, received by retail', async () => {
  await ok(A.nova, { type: 'PACKED', product_ids: phones, data: { carton_id: 'CTN-1' } });
  await ok(A.nova, { type: 'STORED', product_ids: phones, facility_id: F.wh.id, data: { bin: 'A-01' } });
  await ok(A.nova, { type: 'EXIT', product_ids: phones, facility_id: F.wh.id, to_actor_id: A.retail.id });
  await ok(A.nova, { type: 'DELIVERED', product_ids: phones, data: { received_by: 'Store manager' } });
  await ok(A.retail, { type: 'ENTRY', product_ids: phones, facility_id: F.store.id });
  assert.equal((await get(phones[0])).custodian_id, A.retail.id);
});

test('step 9: sale stores customer details off-chain, only a hash on-chain', async () => {
  for (const [i, id] of phones.entries()) {
    await ok(A.retail, { type: 'SOLD', product_ids: [id], facility_id: F.store.id, customer: { name: `Customer ${i}`, phone: `90000000${i}` }, data: { invoice: `INV-${i}` } });
  }
  const [sale] = await ctx.store.list('sales', { where: { product_id: phones[0] } });
  assert.equal(sale.customer_name, 'Customer 0');
  const [tx] = await ctx.store.list('events', { where: { product_id: phones[0], type: 'SOLD' } });
  assert.equal(tx.data.customer_ref, sale.customer_ref);
  assert.ok(!JSON.stringify(tx.data).includes('Customer 0'));
});

test('steps 10-12: issue reported, unit returned, backtrace pins the machine', async () => {
  const r = await ok(A.retail, { type: 'ISSUE_REPORTED', product_ids: [phones[0]], facility_id: F.store.id, data: { code: 'GREEN_LINE', description: 'Vertical green line' } });
  const ticketId = r.tickets[0];
  let t = await ctx.store.get('tickets', ticketId);
  assert.equal(t.status, 'reported');
  assert.equal((await get(phones[0])).status, 'returned');

  await ok(A.retail, { type: 'EXIT', product_ids: [phones[0]], facility_id: F.store.id, to_actor_id: A.nova.id });
  assert.equal((await ctx.store.get('tickets', ticketId)).status, 'sent_to_manufacturer');
  await ok(A.nova, { type: 'ENTRY', product_ids: [phones[0]], facility_id: F.plant.id });
  assert.equal((await ctx.store.get('tickets', ticketId)).status, 'at_manufacturer');

  // A second unit with the same issue in the same batch
  const r2 = await ok(A.retail, { type: 'ISSUE_REPORTED', product_ids: [phones[2]], facility_id: F.store.id, data: { code: 'GREEN_LINE' } });
  assert.ok(r2.alerts.some((a) => a.type === 'PROCESS_FAULT'));
  const bt = await backtrace(phones[0], 'GREEN_LINE');
  assert.equal(bt.suspect.machine_id, 'LAM-02');
  assert.equal(bt.suspect.process, 'Display lamination');
  assert.equal(bt.recommendation, 'recall');
  assert.deepEqual(new Set(bt.scope.units), new Set([phones[0], phones[2], phones[4]]));

  await ok(A.nova, { type: 'DIAGNOSED', product_ids: [phones[0]], data: { process: 'Display lamination', machine_id: 'LAM-02', finding: 'Lamination pressure drift', action: 'repair' } });
  t = await ctx.store.get('tickets', ticketId);
  assert.equal(t.status, 'diagnosed');
  assert.equal(t.diagnosis.machine_id, 'LAM-02');
});

test('step 13: precision recall of units from the faulty machine notifies retailers', async () => {
  const bt = await backtrace(phones[0], 'GREEN_LINE');
  const r = await ok(A.nova, { type: 'RECALL', product_ids: bt.scope.units, data: { reason: 'Display lamination defect on LAM-02', scope: 'machine', machine_id: 'LAM-02' } });
  assert.equal(r.accepted.length, 3);
  const notices = await ctx.store.list('tickets', { where: { kind: 'recall' } });
  assert.deepEqual(notices.map((n) => n.product_id), [phones[4]]); // only the one still with its customer
  assert.equal(notices[0].retailer_id, A.retail.id);
  assert.equal((await get(phones[1])).status, 'sold'); // LAM-01 units untouched
});

test('steps 14-15: repaired unit goes back to the same retailer and the customer', async () => {
  const blocked = await recordEvents(A.nova, { type: 'EXIT', product_ids: [phones[0]], facility_id: F.plant.id, to_actor_id: A.retail.id });
  assert.match(blocked.rejected[0].reason, /recalled/);
  await ok(A.nova, { type: 'SERVICE', product_ids: [phones[0]], facility_id: F.plant.id, data: { action: 'Display replaced', remedy: true, replaced: [{ name: 'Display panel', from_batch: 'PNL-A', new_part_id: panels[6] }] } });
  const repaired = await get(phones[0]);
  assert.equal(repaired.status, 'returned');
  assert.equal(repaired.attributes.parts['Display panel'].serial, panels[6]);
  await ok(A.nova, { type: 'EXIT', product_ids: [phones[0]], facility_id: F.plant.id, to_actor_id: A.retail.id });
  await ok(A.retail, { type: 'ENTRY', product_ids: [phones[0]], facility_id: F.store.id });
  await ok(A.retail, { type: 'HANDED_OVER', product_ids: [phones[0]], facility_id: F.store.id });
  const [t] = await ctx.store.list('tickets', { where: { product_id: phones[0], kind: 'issue' } });
  assert.equal(t.status, 'closed');
  const p = await get(phones[0]);
  assert.equal(p.status, 'sold');
  assert.equal(p.custodian_id, 'CONSUMER');
});

test('third-party fake part locks the device; authorised repair unlocks it', async () => {
  const ok1 = await simulateCheckin(phones[1]);
  assert.equal(ok1.locked, false);
  const r = await simulateCheckin(phones[1], { 'Display panel': 'TP-FAKE-0099' });
  assert.equal(r.locked, true);
  assert.equal((await get(phones[1])).status, 'locked');
  assert.equal((await scan({ id: phones[1] })).verdict, 'LOCKED');
  assert.equal((await recordEvents(A.service, { type: 'UNLOCK', product_ids: [phones[1]] })).rejected.length, 1);

  await ok(A.nova, { type: 'EXIT', product_ids: [panels[7]], facility_id: F.plant.id, to_actor_id: A.service.id });
  await ok(A.service, { type: 'ENTRY', product_ids: [panels[7]], facility_id: F.care.id });
  await ok(A.service, { type: 'SERVICE', product_ids: [phones[1]], facility_id: F.care.id, data: { action: 'Genuine display installed', replaced: [{ name: 'Display panel', new_part_id: panels[7] }] } });
  await ok(A.service, { type: 'UNLOCK', product_ids: [phones[1]], data: { reason: 'Genuine part restored' } });
  assert.equal((await get(phones[1])).status, 'sold');
});

test('medicine: same flow, pharmacy return answered with a replacement vial', async () => {
  for (const [id, procs] of Object.entries({ 'FIL-01': ['Aseptic filling'], 'AC-01': ['Terminal sterilization'], 'AC-02': ['Terminal sterilization'] })) {
    await createMachine(A.pharma, { id, name: id, facility_id: F.pharmaPlant.id, processes: procs });
  }
  const route = ['Aseptic filling', 'Terminal sterilization'];
  const mk = async (id) => (await createBatch(A.pharma, { id, sku: 'MERO-1G', name: 'Meropenem 1 g', category: 'medicine', quantity: 10, mint: 3, facility_id: F.pharmaPlant.id, process_route: route, expiry_date: '2030-01-01' })).minted.map((u) => u.id);
  const vials = await mk('MRC');
  const spare = await mk('MRD');
  for (const set of [vials, spare]) {
    await ok(A.pharma, { type: 'PROCESS_STEP', product_ids: set, data: { process: 'Aseptic filling', machine_id: 'FIL-01' } });
    await ok(A.pharma, { type: 'PROCESS_STEP', product_ids: set, data: { process: 'Terminal sterilization', machine_id: set === vials ? 'AC-02' : 'AC-01' } });
    await ok(A.pharma, { type: 'PRODUCTION_COMPLETE', product_ids: set });
  }
  await ok(A.pharma, { type: 'EXIT', product_ids: vials, facility_id: F.pharmaPlant.id, to_actor_id: A.pharmacy.id });
  await ok(A.pharmacy, { type: 'ENTRY', product_ids: vials, facility_id: F.pharmacy.id });
  await ok(A.pharmacy, { type: 'SOLD', product_ids: [vials[0]], facility_id: F.pharmacy.id, customer: { name: 'Patient A', phone: '9111111111' }, data: { invoice: 'RX-1' } });

  const r = await ok(A.pharmacy, { type: 'ISSUE_REPORTED', product_ids: [vials[0]], facility_id: F.pharmacy.id, data: { code: 'PARTICULATE_MATTER' } });
  await ok(A.pharmacy, { type: 'EXIT', product_ids: [vials[0]], facility_id: F.pharmacy.id, to_actor_id: A.pharma.id });
  await ok(A.pharma, { type: 'ENTRY', product_ids: [vials[0]], facility_id: F.pharmaPlant.id });
  await ok(A.pharma, { type: 'DIAGNOSED', product_ids: [vials[0]], data: { process: 'Terminal sterilization', machine_id: 'AC-02', finding: 'Sterilization cycle under temperature', action: 'replace', replacement_id: spare[0] } });
  assert.equal((await ctx.store.get('tickets', r.tickets[0])).replacement_id, spare[0]);
  await ok(A.pharma, { type: 'EXIT', product_ids: [spare[0]], facility_id: F.pharmaPlant.id, to_actor_id: A.pharmacy.id });
  await ok(A.pharmacy, { type: 'ENTRY', product_ids: [spare[0]], facility_id: F.pharmacy.id });
  await ok(A.pharmacy, { type: 'HANDED_OVER', product_ids: [spare[0]], facility_id: F.pharmacy.id });

  const [sale] = await ctx.store.list('sales', { where: { product_id: spare[0] } });
  assert.equal(sale.customer_name, 'Patient A');
  assert.equal(sale.replaces, vials[0]);
  assert.equal((await ctx.store.get('tickets', r.tickets[0])).status, 'closed');
  const passport = await buildPassport(spare[0]);
  assert.equal(passport.product.status, 'sold');
  assert.equal(passport.production.complete, true);
});

test('the whole history still verifies cryptographically', async () => {
  const v = await ctx.ledger.verify();
  assert.equal(v.valid, true, JSON.stringify(v.issues.slice(0, 3)));
});
