import { Router } from '../http/router.js';
import { z } from 'zod';
import { ctx } from '../context.js';
import { asyncRoute, HttpError } from '../util.js';
import { actorByApiKey, createActor, createFacility, setFacilityLicense, publicActor, ROLES, FACILITY_TYPES } from '../services/network.js';
import { createBatch, mintMore, qrUrl, CATEGORIES } from '../services/catalog.js';
import { recordEvents, EVENT_RULES } from '../services/events.js';
import { buildPassport, forwardTrace, componentTree } from '../services/passport.js';
import { createProgram, setProgramActive } from '../services/warranty.js';
import { resolveAlert } from '../services/alerts.js';
import { overview, defects } from '../services/analytics.js';
import { CONSUMER } from '../services/state.js';
import { createMachine, backtrace, routeProgress } from '../services/production.js';
import { simulateCheckin } from '../services/device.js';
import { actorBySession, setCredentials, changePassword } from '../services/auth.js';
import { seesAll, visibleProductIds, visibleBatchIds, assertProductVisible, filterAlerts, ownBatchCodes } from '../services/scope.js';

export const apiRouter = Router();

// ── auth ────────────────────────────────────────────────────────────────────
apiRouter.use(asyncRoute(async (req, _res, next) => {
  const key = req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!key) throw new HttpError(401, 'API key required');
  const actor = key.startsWith('gts_') ? await actorBySession(key) : await actorByApiKey(key);
  if (!actor || actor.status !== 'active') throw new HttpError(401, key.startsWith('gts_') ? 'Session expired – please sign in again' : 'Invalid or revoked API key');
  req.actor = actor;
  next();
}));

const allow = (...roles) => (req, _res, next) => (req.actor.role === 'admin' || roles.includes(req.actor.role) ? next() : next(new HttpError(403, `Requires role: ${roles.join(' or ')}`)));

apiRouter.get('/me', asyncRoute(async (req, res) => {
  const facilities = await ctx.store.list('facilities', { where: { actor_id: req.actor.id } });
  res.json({ actor: publicActor(req.actor), facilities, meta: { roles: ROLES, facility_types: FACILITY_TYPES, categories: CATEGORIES, event_rules: EVENT_RULES } });
}));

// ── network ─────────────────────────────────────────────────────────────────
apiRouter.get('/actors', asyncRoute(async (_req, res) => {
  res.json((await ctx.store.list('actors', { order: [['created_at', 'asc']] })).map(publicActor));
}));

const actorSchema = z.object({
  name: z.string().min(2).max(120), role: z.enum(ROLES), org: z.string().max(120).optional(), email: z.string().email().optional().or(z.literal('')),
  license_no: z.string().max(60).optional(), username: z.string().min(3).max(32).optional(), password: z.string().min(8).max(100).optional(),
});
apiRouter.post('/actors', allow('admin'), asyncRoute(async (req, res) => {
  res.status(201).json(await createActor(req.actor, actorSchema.parse(req.body)));
}));

apiRouter.patch('/actors/:id/status', allow('admin'), asyncRoute(async (req, res) => {
  const status = z.enum(['active', 'suspended']).parse(req.body.status);
  if (req.params.id === 'ACT-ADMIN') throw new HttpError(400, 'Cannot suspend the network admin');
  res.json(publicActor(await ctx.store.update('actors', req.params.id, { status })));
}));

// Admin sets or resets a member's username/password; the new password is returned once.
apiRouter.patch('/actors/:id/credentials', allow('admin'), asyncRoute(async (req, res) => {
  const b = z.object({ username: z.string().min(3).max(32).optional(), password: z.string().min(8).max(100).optional() }).parse(req.body || {});
  res.json(await setCredentials(req.params.id, b));
}));

apiRouter.post('/me/password', asyncRoute(async (req, res) => {
  const b = z.object({ current: z.string().max(100), next: z.string().min(8).max(100) }).parse(req.body);
  res.json(await changePassword(req.actor, b.current, b.next));
}));

apiRouter.get('/facilities', asyncRoute(async (_req, res) => {
  res.json(await ctx.store.list('facilities', { order: [['created_at', 'asc']] }));
}));

const facilitySchema = z.object({
  name: z.string().min(2).max(120), type: z.enum(FACILITY_TYPES), actor_id: z.string().optional(), address: z.string().max(200).optional(),
  city: z.string().max(80).optional(), lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(),
  license_no: z.string().max(60).optional(), licensed: z.boolean().optional(),
});
apiRouter.post('/facilities', asyncRoute(async (req, res) => {
  res.status(201).json(await createFacility(req.actor, facilitySchema.parse(req.body)));
}));

apiRouter.patch('/facilities/:id/license', allow('regulator'), asyncRoute(async (req, res) => {
  const b = z.object({ licensed: z.boolean(), reason: z.string().max(300).optional() }).parse(req.body);
  res.json(await setFacilityLicense(req.actor, req.params.id, b.licensed, b.reason));
}));

// ── batches & minting ───────────────────────────────────────────────────────
apiRouter.get('/batches', asyncRoute(async (req, res) => {
  const opts = { order: [['created_at', 'desc']] };
  if (req.query.category) opts.where = { category: String(req.query.category) };
  if (req.query.q) opts.search = { q: String(req.query.q), cols: ['id', 'name', 'sku'] };
  const allowed = await visibleBatchIds(req.actor);
  if (allowed) opts.whereIn = { id: [...allowed] };
  const [batches, actors] = await Promise.all([ctx.store.list('batches', opts), ctx.store.list('actors', { columns: ['id', 'name'] })]);
  const names = new Map(actors.map((a) => [a.id, a.name]));
  res.json(batches.map((b) => ({ ...b, manufacturer_name: names.get(b.manufacturer_id) })));
}));

const batchSchema = z.object({
  id: z.string().min(2).max(20),
  process_route: z.array(z.string().min(1).max(80)).max(40).optional(),
  sku: z.string().min(1).max(60), name: z.string().min(2).max(160), category: z.enum(CATEGORIES),
  quantity: z.number().int().positive().max(10_000_000), mint: z.number().int().min(0).max(2000).optional(),
  mfg_date: z.string().max(10).optional(), expiry_date: z.string().max(10).optional().or(z.literal('')),
  facility_id: z.string().optional(), attributes: z.record(z.any()).optional(),
  components: z.array(z.object({ batch_id: z.string(), name: z.string().optional() })).optional(),
});
apiRouter.post('/batches', allow('manufacturer'), asyncRoute(async (req, res) => {
  const b = batchSchema.parse(req.body);
  if (!b.expiry_date) delete b.expiry_date;
  res.status(201).json(await createBatch(req.actor, b));
}));

apiRouter.post('/batches/:id/mint', allow('manufacturer'), asyncRoute(async (req, res) => {
  const b = z.object({ count: z.number().int().positive().max(2000), facility_id: z.string().optional() }).parse(req.body);
  res.status(201).json(await mintMore(req.actor, req.params.id, b.count, b.facility_id));
}));

apiRouter.get('/batches/:id', asyncRoute(async (req, res) => {
  const batch = await ctx.store.get('batches', req.params.id);
  if (!batch) throw new HttpError(404, 'Batch not found');
  const owner = seesAll(req.actor) || batch.manufacturer_id === req.actor.id;
  const visible = owner ? null : await visibleProductIds(req.actor);
  if (visible && !(await visibleBatchIds(req.actor, visible)).has(batch.id)) throw new HttpError(404, 'Batch not found');
  let [units, events, alerts, maker] = await Promise.all([
    ctx.store.list('products', { where: { batch_id: batch.id }, order: [['created_at', 'asc']] }),
    ctx.store.list('events', { where: { batch_id: batch.id, product_id: null }, order: [['block_height', 'asc']] }),
    ctx.store.list('alerts', { where: { batch_id: batch.id }, order: [['created_at', 'desc']] }),
    ctx.store.get('actors', batch.manufacturer_id),
  ]);
  if (visible) {
    // Not the maker: only this company's own units of the batch, no network-wide trace.
    units = units.filter((u) => visible.has(u.id));
    events = [];
    alerts = await filterAlerts(req.actor, alerts);
  }
  const statusCounts = {};
  for (const u of units) statusCounts[u.status] = (statusCounts[u.status] || 0) + 1;
  res.json({
    restricted: !owner,
    batch,
    manufacturer: publicActor(maker),
    units: units.map((u) => ({ id: u.id, status: u.status, custodian_id: u.custodian_id, facility_id: u.facility_id, pending_to: u.pending_to, serial_no: u.attributes?.serial_no, firmware: u.attributes?.firmware, qr_url: qrUrl(u), scan_count: u.scan_count })),
    status_counts: statusCounts,
    components: await componentTree(batch),
    trace: owner ? await forwardTrace(batch.id) : null,
    events,
    alerts,
  });
}));

// ── products / passports ────────────────────────────────────────────────────
apiRouter.get('/products', asyncRoute(async (req, res) => {
  const where = {};
  for (const k of ['status', 'category', 'batch_id', 'custodian_id', 'pending_to']) if (req.query[k]) where[k] = String(req.query[k]);
  if (req.query.mine === '1') where.custodian_id = req.actor.id;
  const opts = { where, order: [['updated_at', 'desc']], limit: Math.min(Number(req.query.limit) || 100, 1000), offset: Number(req.query.offset) || 0 };
  if (req.query.q) opts.search = { q: String(req.query.q), cols: ['id', 'name', 'sku', 'batch_id'] };
  const visible = await visibleProductIds(req.actor);
  if (visible) opts.whereIn = { id: [...visible] };
  const [rows, total, actors] = await Promise.all([ctx.store.list('products', opts), ctx.store.count('products', opts), ctx.store.list('actors', { columns: ['id', 'name'] })]);
  const names = new Map(actors.map((a) => [a.id, a.name]));
  res.json({
    total,
    items: rows.map((p) => ({ ...p, custodian_name: p.custodian_id === CONSUMER ? 'Consumer' : names.get(p.custodian_id), manufacturer_name: names.get(p.manufacturer_id), pending_to_name: names.get(p.pending_to) })),
  });
}));

apiRouter.get('/products/:id', asyncRoute(async (req, res) => {
  await assertProductVisible(req.actor, req.params.id.toUpperCase());
  const p = await buildPassport(req.params.id.toUpperCase(), { includeInternal: true });
  if (!p) throw new HttpError(404, 'Product not found');
  res.json(p);
}));

// ── events: the only way state changes ─────────────────────────────────────
const eventSchema = z.object({
  type: z.enum(Object.keys(EVENT_RULES)),
  product_ids: z.array(z.string().max(64)).max(5000).optional(),
  batch_id: z.string().optional(),
  facility_id: z.string().optional().nullable(),
  to_actor_id: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  data: z.record(z.any()).optional(),
  part_ids: z.array(z.string().max(64).nullable()).max(5000).optional(),
  customer: z.object({ name: z.string().max(120).optional(), phone: z.string().max(30).optional(), email: z.string().max(120).optional(), price: z.number().optional() }).optional(),
});
apiRouter.post('/events', asyncRoute(async (req, res) => {
  const b = eventSchema.parse(req.body);
  if (b.facility_id === null) delete b.facility_id;
  res.json(await recordEvents(req.actor, b));
}));

apiRouter.get('/events', asyncRoute(async (req, res) => {
  const where = {};
  for (const k of ['type', 'actor_id', 'facility_id', 'batch_id', 'product_id']) if (req.query[k]) where[k] = String(req.query[k]);
  const opts = { where, order: [['block_height', 'desc'], ['seq', 'desc']], limit: Math.min(Number(req.query.limit) || 100, 1000) };
  const visible = await visibleProductIds(req.actor);
  if (visible) opts.whereIn = { product_id: [...visible] };
  res.json(await ctx.store.list('events', opts));
}));

// ── production: machines, route progress, backtrace ─────────────────────────
apiRouter.get('/machines', asyncRoute(async (req, res) => {
  const where = req.query.mine === '1' ? { actor_id: req.actor.id } : {};
  res.json(await ctx.store.list('machines', { where, order: [['id', 'asc']] }));
}));

const machineSchema = z.object({ id: z.string().min(2).max(20).optional(), name: z.string().min(2).max(120), facility_id: z.string(), processes: z.array(z.string().max(80)).max(40).optional() });
apiRouter.post('/machines', allow('manufacturer'), asyncRoute(async (req, res) => {
  res.status(201).json(await createMachine(req.actor, machineSchema.parse(req.body)));
}));

// Scanner lookup: everything a production station needs for one scanned serial.
apiRouter.get('/scanner/:id', asyncRoute(async (req, res) => {
  const p = await ctx.store.get('products', req.params.id.toUpperCase());
  if (!p) throw new HttpError(404, 'Serial not found on the ledger');
  await assertProductVisible(req.actor, p.id);
  const batch = await ctx.store.get('batches', p.batch_id);
  res.json({
    product: { id: p.id, name: p.name, sku: p.sku, category: p.category, status: p.status, custodian_id: p.custodian_id, batch_id: p.batch_id, serial_no: p.attributes?.serial_no, parts: p.attributes?.parts || {}, open_ticket: p.attributes?.open_ticket || null },
    batch: { id: batch.id, name: batch.name, components: batch.components },
    progress: routeProgress(p, batch),
    steps: p.attributes?.steps || [],
  });
}));

apiRouter.get('/products/:id/backtrace', asyncRoute(async (req, res) => {
  const p = await ctx.store.get('products', req.params.id.toUpperCase());
  if (!p || (!seesAll(req.actor) && p.manufacturer_id !== req.actor.id)) throw new HttpError(404, 'Product not found');
  res.json(await backtrace(req.params.id.toUpperCase(), req.query.code ? String(req.query.code) : undefined));
}));

// ── retail: sales (customer data is off-chain, visible only to the selling retailer) ──
apiRouter.get('/sales', asyncRoute(async (req, res) => {
  const where = ['admin', 'regulator'].includes(req.actor.role) ? {} : { retailer_id: req.actor.id };
  const rows = await ctx.store.list('sales', { where, order: [['created_at', 'desc']], limit: 500 });
  const products = await ctx.store.list('products', { whereIn: { id: rows.map((r) => r.product_id) }, columns: ['id', 'name', 'status'] });
  const pm = new Map(products.map((p) => [p.id, p]));
  res.json(rows.map((r) => ({ ...r, product_name: pm.get(r.product_id)?.name, product_status: pm.get(r.product_id)?.status })));
}));

// ── service cases ───────────────────────────────────────────────────────────
async function decorateTickets(rows) {
  const [actors, products, sales] = await Promise.all([
    ctx.store.list('actors', { columns: ['id', 'name'] }),
    ctx.store.list('products', { whereIn: { id: rows.map((t) => t.product_id) }, columns: ['id', 'name', 'status', 'custodian_id', 'pending_to', 'attributes'] }),
    ctx.store.list('sales', { whereIn: { id: rows.map((t) => t.sale_id).filter(Boolean) } }),
  ]);
  const an = new Map(actors.map((a) => [a.id, a.name]));
  const pm = new Map(products.map((p) => [p.id, p]));
  const sm = new Map(sales.map((x) => [x.id, x]));
  return rows.map((t) => {
    const p = pm.get(t.product_id);
    return {
      ...t,
      retailer_name: an.get(t.retailer_id),
      manufacturer_name: an.get(t.manufacturer_id),
      product_name: p?.name,
      product_status: p?.status,
      custodian_id: p?.custodian_id,
      pending_to: p?.pending_to,
      sale: sm.get(t.sale_id) || null,
    };
  });
}
const ticketScope = (actor) => (['admin', 'regulator'].includes(actor.role) ? {} : actor.role === 'manufacturer' ? { manufacturer_id: actor.id } : { retailer_id: actor.id });

apiRouter.get('/tickets', asyncRoute(async (req, res) => {
  const where = ticketScope(req.actor);
  if (req.query.status) where.status = String(req.query.status);
  if (req.query.kind) where.kind = String(req.query.kind);
  let rows = await ctx.store.list('tickets', { where, order: [['updated_at', 'desc']], limit: 500 });
  // Retailers must not see customer contact data of sales made by another retailer.
  rows = await decorateTickets(rows);
  if (!['retailer', 'pharmacy', 'hospital', 'service_center', 'admin'].includes(req.actor.role)) rows = rows.map((t) => ({ ...t, sale: t.sale && { id: t.sale.id, customer_ref: t.sale.customer_ref, created_at: t.sale.created_at } }));
  res.json(rows);
}));

apiRouter.get('/tickets/:id', asyncRoute(async (req, res) => {
  const t = await ctx.store.get('tickets', req.params.id);
  if (!t) throw new HttpError(404, 'Case not found');
  const scope = ticketScope(req.actor);
  if (Object.entries(scope).some(([k, v]) => t[k] !== v)) throw new HttpError(403, 'Not your case');
  const [decorated] = await decorateTickets([t]);
  const ids = [t.product_id, t.replacement_id].filter(Boolean);
  const events = (await ctx.store.list('events', { whereIn: { product_id: ids }, order: [['block_height', 'asc'], ['seq', 'asc']] }))
    .filter((e) => e.data?.ticket_id === t.id || (e.type === 'RECALL' && t.kind === 'recall'));
  if (req.actor.role === 'manufacturer' && decorated.sale) decorated.sale = { id: decorated.sale.id, customer_ref: decorated.sale.customer_ref, created_at: decorated.sale.created_at };
  res.json({ ticket: decorated, events, backtrace: ['manufacturer', 'admin', 'regulator'].includes(req.actor.role) ? await backtrace(t.product_id, t.code !== 'RECALL' ? t.code : undefined) : null });
}));

// ── device lock (simulator for the demo; real devices call POST /api/public/device/attest) ──
apiRouter.post('/devices/:id/checkin', asyncRoute(async (req, res) => {
  await assertProductVisible(req.actor, req.params.id.toUpperCase());
  const overrides = z.record(z.string().max(64)).optional().parse(req.body?.replace_parts) || {};
  res.json(await simulateCheckin(req.params.id, overrides));
}));

// ── chain explorer ──────────────────────────────────────────────────────────
apiRouter.get('/chain/blocks', asyncRoute(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 25, 200);
  const before = req.query.before != null ? Number(req.query.before) : null;
  const opts = { order: [['id', 'desc']], limit };
  if (before != null) opts.lte = { id: before - 1 };
  const blocks = await ctx.store.list('blocks', opts);
  const receipts = ctx.ethereum ? await ctx.ethereum.receipts(blocks.map((b) => b.id)) : new Map();
  const anchored = ctx.ethereum?.state.anchored ?? 0;
  res.json({
    height: ctx.ledger.tip?.id ?? -1,
    ethereum: ctx.ethereum ? ctx.ethereum.summary() : { enabled: false },
    blocks: blocks.map((b) => ({ ...b, anchor: ctx.ethereum ? { anchored: b.id < anchored, tx_hash: receipts.get(b.id)?.tx_hash || null, tx_url: receipts.get(b.id)?.tx_url || null } : null })),
  });
}));

apiRouter.get('/chain/blocks/:height', asyncRoute(async (req, res) => {
  const block = await ctx.store.get('blocks', Number(req.params.height));
  if (!block) throw new HttpError(404, 'Block not found');
  let txs = await ctx.store.list('events', { where: { block_height: block.id }, order: [['seq', 'asc']], limit: 500 });
  let hidden = 0;
  const visible = await visibleProductIds(req.actor);
  if (visible) {
    const batches = await visibleBatchIds(req.actor, visible);
    const keep = txs.filter((t) => t.actor_id === req.actor.id || (t.product_id ? visible.has(t.product_id) : t.batch_id && batches.has(t.batch_id)));
    hidden = txs.length - keep.length;
    txs = keep;
  }
  res.json({ block, txs, hidden, ethereum: await ctx.ledger.anchorInfo(block) });
}));

apiRouter.get('/chain/tx/:id', asyncRoute(async (req, res) => {
  const tx = await ctx.store.get('events', req.params.id);
  if (!tx) throw new HttpError(404, 'Transaction not found');
  const visible = await visibleProductIds(req.actor);
  if (visible && tx.actor_id !== req.actor.id) {
    const ok = tx.product_id ? visible.has(tx.product_id) : tx.batch_id && (await visibleBatchIds(req.actor, visible)).has(tx.batch_id);
    if (!ok) throw new HttpError(404, 'Transaction not found');
  }
  res.json({ tx, proof: await ctx.ledger.proof(tx.id) });
}));

apiRouter.get('/chain/verify', asyncRoute(async (_req, res) => {
  const result = await ctx.ledger.verify();
  if (ctx.ethereum) {
    const blocks = await ctx.store.list('blocks', { columns: ['id', 'hash'], order: [['id', 'asc']] });
    result.ethereum = await ctx.ethereum.verify(blocks);
    result.issues.push(...result.ethereum.issues);
    result.valid = result.issues.length === 0;
  } else result.ethereum = { enabled: false };
  res.json(result);
}));

// Demonstrates tamper evidence: edits a sealed transaction behind the ledger's back.
apiRouter.post('/chain/tamper-demo', allow('admin'), asyncRoute(async (req, res) => {
  const txId = z.string().parse(req.body.tx_id);
  const tx = await ctx.store.get('events', txId);
  if (!tx) throw new HttpError(404, 'Transaction not found');
  try {
    await ctx.store.unsafeUpdate('events', txId, { data: { ...tx.data, tampered: true, note: 'edited directly in the database' } });
  } catch (e) {
    return res.json({ blocked: true, message: `Database refused the edit: ${e.message}` });
  }
  res.json({ blocked: false, message: 'Row edited directly in the store. Run chain verification to see it detected.', verify: await ctx.ledger.verify() });
}));

// ── alerts ──────────────────────────────────────────────────────────────────
apiRouter.get('/alerts', asyncRoute(async (req, res) => {
  const where = {};
  for (const k of ['status', 'severity', 'type', 'batch_id', 'product_id']) if (req.query[k]) where[k] = String(req.query[k]);
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  if (seesAll(req.actor)) return res.json(await ctx.store.list('alerts', { where, order: [['created_at', 'desc']], limit }));
  const rows = await ctx.store.list('alerts', { where, order: [['created_at', 'desc']], limit: 2000 });
  res.json((await filterAlerts(req.actor, rows)).slice(0, limit));
}));

apiRouter.patch('/alerts/:id/resolve', allow('regulator', 'manufacturer'), asyncRoute(async (req, res) => {
  const existing = await ctx.store.get('alerts', req.params.id);
  if (!existing || !(await filterAlerts(req.actor, [existing])).length) throw new HttpError(404, 'Alert not found');
  const a = await resolveAlert(req.params.id, req.actor, req.body?.note);
  if (!a) throw new HttpError(404, 'Alert not found');
  res.json(a);
}));

// ── programs & analytics ───────────────────────────────────────────────────
apiRouter.get('/programs', asyncRoute(async (_req, res) => {
  res.json(await ctx.store.list('programs', { order: [['created_at', 'desc']] }));
}));

const programSchema = z.object({
  name: z.string().min(3).max(160), description: z.string().max(1000).optional(), coverage: z.string().max(200).optional(),
  criteria: z.object({
    skus: z.array(z.string()).optional(), component_lots: z.array(z.string()).optional(), defect_codes: z.array(z.string()).optional(),
    purchased_after: z.string().optional(), purchased_before: z.string().optional(), max_age_months: z.number().int().positive().optional(),
    exclude_damage: z.boolean().optional(), one_time: z.boolean().optional(),
  }),
});
apiRouter.post('/programs', allow('manufacturer'), asyncRoute(async (req, res) => {
  res.status(201).json(await createProgram(req.actor, programSchema.parse(req.body)));
}));

apiRouter.patch('/programs/:id', allow('manufacturer'), asyncRoute(async (req, res) => {
  res.json(await setProgramActive(req.actor, req.params.id, z.boolean().parse(req.body.active)));
}));

async function scopeFor(actor) {
  const ids = await visibleProductIds(actor);
  if (!ids) return null;
  return { ids, batches: await visibleBatchIds(actor, ids), codes: await ownBatchCodes(actor), filterAlerts: (rows) => filterAlerts(actor, rows) };
}
apiRouter.get('/analytics/overview', asyncRoute(async (req, res) => res.json(await overview(await scopeFor(req.actor)))));
apiRouter.get('/analytics/defects', asyncRoute(async (req, res) => res.json(await defects(await scopeFor(req.actor)))));
