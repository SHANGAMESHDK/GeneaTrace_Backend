// Company device keys, two-factor sign-in, GS1/EPCIS, cartons, warn-only parts and data erasure.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL = '';
const { boot } = await import('../lib/boot.js');
const { ctx } = await import('../lib/context.js');
const { createActor, createFacility } = await import('../lib/services/network.js');
const { createBatch, qrUrl } = await import('../lib/services/catalog.js');
const { recordEvents } = await import('../lib/services/events.js');
const { simulateCheckin } = await import('../lib/services/device.js');
const { apiRouter } = await import('../lib/routes/api.js');
const { normalizeGtin } = await import('../lib/services/standards.js');
const { keyProofMessage, intentMessage, requestHash } = await import('../lib/services/attestation.js');
const { totp } = await import('../lib/services/mfa.js');
const { login, setCredentials } = await import('../lib/services/auth.js');

const A = {};
const keys = {};
const F = {};
const GTIN = '08901234567890';

async function call(who, method, path, body) {
  const headers = { 'x-api-key': keys[who] };
  const url = new URL(`http://x${path}`);
  const res = await apiRouter.dispatch({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: body || {}, params: {}, ip: 'test', get: (h) => headers[h.toLowerCase()] }).catch((e) => ({ status_: e.status || 500, body: { error: e.message, details: e.details } }));
  return { status: res.status_, body: res.body };
}
const ok = async (actor, input) => {
  const r = await recordEvents(actor, input);
  assert.equal(r.rejected.length, 0, r.rejected[0]?.reason);
  return r;
};

before(async () => {
  await boot({ databaseUrl: '', file: null, ethereum: false });
  const admin = await ctx.store.get('actors', 'ACT-ADMIN');
  for (const [k, role] of Object.entries({ maker: 'manufacturer', signer: 'manufacturer', shop: 'retailer', other: 'manufacturer' })) {
    const r = await createActor(admin, { name: k, role });
    A[k] = r.actor;
    keys[k] = r.api_key;
    F[k] = await createFacility(admin, { name: k, type: 'factory', actor_id: r.actor.id });
  }
});

test('GTIN check digits are enforced and batches get GS1 Digital Link labels', async () => {
  assert.equal(normalizeGtin('8901234567890'), GTIN);
  assert.equal(normalizeGtin('8901234567895'), null);
  await assert.rejects(createBatch(A.maker, { id: 'BAD', sku: 'X', name: 'Bad', category: 'medicine', quantity: 1, attributes: { gtin: '123' } }), /GTIN/);
  const r = await createBatch(A.maker, { id: 'GS1', sku: 'X', name: 'Vial', category: 'medicine', quantity: 9, mint: 3, facility_id: F.maker.id, attributes: { gtin: GTIN, generic_name: 'Amoxicillin' } });
  const p = await ctx.store.get('products', r.minted[0].id);
  const b = await ctx.store.get('batches', 'GS1');
  assert.match(qrUrl(p, b), new RegExp(`/01/${GTIN}/10/GS1/21/${p.id}\\?s=`));
});

test('EPCIS export is standard shaped, scoped, and has no customer data', async () => {
  const id = (await ctx.store.list('products', { where: { batch_id: 'GS1' }, limit: 1 }))[0].id;
  const doc = (await call('maker', 'GET', `/epcis?product_id=${id}`)).body;
  assert.equal(doc.type, 'EPCISDocument');
  assert.equal(doc.schemaVersion, '2.0');
  assert.equal(doc.epcisBody.eventList[0].bizStep, 'commissioning');
  assert.equal(doc.epcisBody.eventList[0].epcList[0], `https://id.gs1.org/01/${GTIN}/21/${id}`);
  assert.equal((await call('other', 'GET', `/epcis?product_id=${id}`)).status, 404);
  assert.equal((await call('other', 'GET', '/epcis?batch_id=GS1')).body.epcisBody.eventList.length, 0);
});

test('label check reports what a medicine batch is missing', async () => {
  const r = await call('maker', 'GET', '/batches/GS1/label-check');
  assert.equal(r.body.ready, false);
  assert.ok(r.body.missing.includes('manufacturing_licence'));
  assert.ok(!r.body.missing.includes('generic_name'));
  assert.equal((await call('other', 'GET', '/batches/GS1/label-check')).status, 404);
});

test('a company device key is required once registered, and the audit catches forged events', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const signText = (m) => crypto.sign(null, Buffer.from(m), privateKey).toString('base64url');
  const units = (await createBatch(A.signer, { id: 'SGN', sku: 'S', name: 'Unit', category: 'other', quantity: 9, mint: 3, facility_id: F.signer.id })).minted.map((u) => u.id);

  const stolen = await call('signer', 'POST', '/me/signing-keys', { public_key: pub, proof: signText('wrong message') });
  assert.equal(stolen.status, 400);
  assert.equal((await call('signer', 'POST', '/me/signing-keys', { public_key: pub, label: 'Line 1', proof: signText(keyProofMessage(A.signer.id, pub)) })).status, 201);

  const body = { type: 'PRODUCTION_COMPLETE', product_ids: [units[0]] };
  const unsigned = await call('signer', 'POST', '/events', body);
  assert.equal(unsigned.status, 428);

  const attest = (b, nonce = crypto.randomUUID(), ts = new Date().toISOString()) => {
    const intent = { actor_id: A.signer.id, type: b.type, payload: requestHash(b), nonce, ts };
    return { ...b, attestation: { public_key: pub, nonce, ts, signature: signText(intentMessage(intent)) } };
  };
  const signed = attest(body);
  const good = await call('signer', 'POST', '/events', signed);
  assert.equal(good.status, 200);
  assert.equal(good.body.accepted.length, 1);
  assert.equal((await call('signer', 'POST', '/events', signed)).status, 409);

  const altered = { ...attest({ type: 'PRODUCTION_COMPLETE', product_ids: [units[1]] }), product_ids: [units[2]] };
  assert.equal((await call('signer', 'POST', '/events', altered)).status, 401);
  assert.equal((await ctx.ledger.verify()).valid, true);

  // A server-side forgery: someone with the server secret records an event as this company.
  await recordEvents(await ctx.store.get('actors', A.signer.id), { type: 'PRODUCTION_COMPLETE', product_ids: [units[1]] });
  const audit = await ctx.ledger.verify();
  assert.equal(audit.valid, false);
  assert.ok(audit.issues.some((i) => /no company device signature/.test(i.problem)));
});

test('two-factor sign-in needs a current code, once', async () => {
  await setCredentials(A.other.id, { username: 'other2fa', password: 'Password@123' });
  const setup = (await call('other', 'POST', '/me/2fa/setup')).body;
  assert.equal((await call('other', 'POST', '/me/2fa/enable', { code: '000000' })).status, 400);
  assert.equal((await call('other', 'POST', '/me/2fa/enable', { code: totp(setup.secret, Math.floor(Date.now() / 30000) - 1) })).status, 200);
  await assert.rejects(login('other2fa', 'Password@123'), (e) => e.details?.mfa_required === true);
  const code = totp(setup.secret);
  assert.ok((await login('other2fa', 'Password@123', code)).token);
  await assert.rejects(login('other2fa', 'Password@123', code), /not valid/);
  const row = await ctx.store.get('actors', A.other.id);
  assert.ok(!row.totp_secret.includes(setup.secret));
  assert.ok(!JSON.stringify((await call('maker', 'GET', '/actors')).body).includes('totp_secret'));
});

test('repeated wrong passwords lock the account for a while', async () => {
  await setCredentials(A.shop.id, { username: 'lockme', password: 'Password@123' });
  for (let i = 0; i < 8; i++) await assert.rejects(login('lockme', 'nope'), /Wrong username/);
  await assert.rejects(login('lockme', 'Password@123'), /Too many/);
});

test('one carton scan moves every unit inside', async () => {
  const units = (await createBatch(A.maker, { id: 'CTN', sku: 'C', name: 'Box', category: 'other', quantity: 9, mint: 3, facility_id: F.maker.id })).minted.map((u) => u.id);
  await ok(A.maker, { type: 'PRODUCTION_COMPLETE', product_ids: units });
  await ok(A.maker, { type: 'PACKED', product_ids: units, facility_id: F.maker.id, data: { carton_id: 'ctn-0001' } });
  assert.deepEqual((await call('maker', 'GET', '/cartons/CTN-0001')).body.units.sort(), [...units].sort());
  const moved = await ok(A.maker, { type: 'EXIT', product_ids: ['CTN-0001'], facility_id: F.maker.id, to_actor_id: A.shop.id });
  assert.equal(moved.accepted.length, 3);
  await assert.rejects(recordEvents(A.maker, { type: 'STORED', product_ids: ['CTN-9999'], facility_id: F.maker.id }), /not on the ledger/);
  assert.equal((await call('other', 'GET', '/cartons/CTN-0001')).status, 404);
});

test('warn-only batches record a fake part but never lock the device', async () => {
  const [unit] = (await createBatch(A.maker, { id: 'WRN', sku: 'W', name: 'Phone', category: 'electronics', quantity: 9, mint: 1, facility_id: F.maker.id, attributes: { part_policy: 'warn' } })).minted.map((u) => u.id);
  const r = await simulateCheckin(unit, { Display: 'FAKE-PANEL' });
  assert.equal(r.locked, false);
  const p = await ctx.store.get('products', unit);
  assert.notEqual(p.status, 'locked');
  assert.match(p.attributes.part_warning, /FAKE-PANEL/);
  assert.ok((await ctx.store.list('alerts', { where: { type: 'NON_GENUINE_PART' } })).length > 0);
});

test('a retailer can export and erase a customer, and only its own', async () => {
  const [unit] = (await createBatch(A.maker, { id: 'SAL', sku: 'S', name: 'Phone', category: 'other', quantity: 9, mint: 1, facility_id: F.maker.id })).minted.map((u) => u.id);
  await ok(A.maker, { type: 'PRODUCTION_COMPLETE', product_ids: [unit] });
  await ok(A.maker, { type: 'EXIT', product_ids: [unit], facility_id: F.maker.id, to_actor_id: A.shop.id });
  await ok(A.shop, { type: 'ENTRY', product_ids: [unit], facility_id: F.shop.id });
  await ok(A.shop, { type: 'SOLD', product_ids: [unit], facility_id: F.shop.id, customer: { name: 'Asha', phone: '9000000000', consent: true } });
  const [sale] = await ctx.store.list('sales', { where: { product_id: unit } });
  assert.ok(sale.consent_at);
  assert.equal((await call('shop', 'GET', `/sales/${sale.id}/export`)).body.customer_name, 'Asha');
  assert.equal((await call('maker', 'POST', `/sales/${sale.id}/erase`)).status, 404);
  const erased = (await call('shop', 'POST', `/sales/${sale.id}/erase`)).body;
  assert.equal(erased.customer_name, null);
  assert.equal(erased.customer_phone, null);
  assert.ok(erased.erased_at);
});

test('webhooks cannot point at internal addresses', async () => {
  for (const url of ['http://example.com/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest', 'https://10.0.0.5/hook']) {
    assert.equal((await call('maker', 'POST', '/me/webhook', { url })).status, 400, url);
  }
});
