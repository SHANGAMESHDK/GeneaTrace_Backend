import { ctx } from '../context.js';
import { config } from '../config.js';
import { actorKey, sign, verifySig } from '../chain/crypto.js';
import { HttpError, newSerial, nowIso } from '../util.js';
import { STATUS } from './state.js';

export const CATEGORIES = ['electronics', 'medicine', 'component', 'food', 'apparel', 'automotive', 'cosmetics', 'other'];
export const MAX_MINT = 2000;
export const BATCH_CODE = /^[A-Z0-9][A-Z0-9-]{1,19}$/;

// QR payload = product ID signed by the manufacturer's on-chain key. A cloned label still
// verifies, but then clone detection on scans kicks in; a forged or random one never does.
export const qrMessage = (p) => `${p.id}|${p.batch_id}|${p.manufacturer_id}`;
export const signQr = (p) => sign(actorKey(p.manufacturer_id), qrMessage(p));
export const verifyQr = (p, manufacturerPub, sig) => verifySig(manufacturerPub, qrMessage(p), sig);
export const qrUrl = (p) => `${config.publicAppUrl}/v/${p.id}?s=${p.signature}`;

export async function createBatch(by, input, { at } = {}) {
  if (!['manufacturer', 'admin'].includes(by.role)) throw new HttpError(403, 'Only manufacturers can create batches');
  if (!CATEGORIES.includes(input.category)) throw new HttpError(400, `Unknown category ${input.category}`);
  const quantity = Number(input.quantity);
  if (!(quantity > 0)) throw new HttpError(400, 'Quantity must be positive');
  const mint = Number(input.mint ?? Math.min(quantity, MAX_MINT));
  if (mint > quantity) throw new HttpError(422, `Cannot mint ${mint} units: batch quantity is ${quantity}`);
  if (mint > MAX_MINT) throw new HttpError(400, `Mint at most ${MAX_MINT} units per request; mint the rest later`);

  const code = String(input.id || '').trim().toUpperCase();
  if (!BATCH_CODE.test(code)) throw new HttpError(400, 'Batch code must be 2–20 characters: A–Z, 0–9 or "-" (e.g. AAA)');
  const route = (input.process_route || input.attributes?.process_route || []).map((s) => String(s).trim()).filter(Boolean);
  if (new Set(route).size !== route.length) throw new HttpError(400, 'Process route steps must be unique');

  const components = [];
  for (const c of input.components || []) {
    const cb = await ctx.store.get('batches', c.batch_id);
    if (!cb) throw new HttpError(400, `Component batch ${c.batch_id} is not on the ledger`);
    if (cb.status === 'recalled') throw new HttpError(422, `Component batch ${c.batch_id} is recalled and cannot be used`);
    components.push({ name: c.name || cb.name, batch_id: cb.id, sku: cb.sku });
  }
  if (input.facility_id) {
    const f = await ctx.store.get('facilities', input.facility_id);
    if (!f || (f.actor_id !== by.id && by.role !== 'admin')) throw new HttpError(400, 'Facility must be one of your sites');
  }

  const batch = {
    id: code,
    sku: input.sku,
    name: input.name,
    category: input.category,
    manufacturer_id: by.role === 'admin' && input.manufacturer_id ? input.manufacturer_id : by.id,
    quantity,
    minted: 0,
    mfg_date: input.mfg_date || (at || nowIso()).slice(0, 10),
    expiry_date: input.expiry_date || null,
    attributes: { ...(input.attributes || {}), process_route: route },
    components,
    status: 'active',
    created_at: at || nowIso(),
  };
  if (await ctx.store.get('batches', batch.id)) throw new HttpError(409, `Batch ${batch.id} already exists`);

  return ctx.ledger.lock(async () => {
    const header = {
      type: 'BATCH_CREATED',
      batch_id: batch.id,
      actor_id: by.id,
      facility_id: input.facility_id || null,
      data: { sku: batch.sku, name: batch.name, category: batch.category, quantity, mfg_date: batch.mfg_date, expiry_date: batch.expiry_date, components, attributes: batch.attributes },
    };
    const res = await mintUnits(by, batch, mint, input.facility_id || null, input.unit_attributes, { at, header, isNew: true });
    return { batch: { ...batch, minted: mint }, ...res };
  });
}

export async function mintMore(by, batchId, count, facilityId, { at } = {}) {
  return ctx.ledger.lock(async () => {
    const batch = await ctx.store.get('batches', batchId);
    if (!batch) throw new HttpError(404, 'Batch not found');
    if (batch.manufacturer_id !== by.id && by.role !== 'admin') throw new HttpError(403, 'Not your batch');
    const n = Number(count);
    if (!(n > 0) || n > MAX_MINT) throw new HttpError(400, `Count must be 1–${MAX_MINT}`);
    if (batch.minted + n > batch.quantity) throw new HttpError(422, `Batch quantity is ${batch.quantity}; only ${batch.quantity - batch.minted} more unit(s) may be minted`);
    return mintUnits(by, batch, n, facilityId || null, null, { at });
  });
}

// Must run inside ledger.lock().
// Issues "null container" serials: a signed passport with no history yet. Every production
// step is appended later from the process scanner.
async function mintUnits(by, batch, count, facilityId, _unitAttributes, { at, header, isNew }) {
  const ts = at || nowIso();
  const ids = new Set();
  while (ids.size < count) {
    const want = count - ids.size;
    const fresh = [...new Set(Array.from({ length: want }, () => newSerial(batch.id)))].filter((x) => !ids.has(x));
    const taken = new Set((await ctx.store.list('products', { whereIn: { id: fresh }, columns: ['id'] })).map((r) => r.id));
    for (const x of fresh) if (!taken.has(x)) ids.add(x);
  }
  const serials = [...ids];
  const products = [];
  for (let i = 0; i < count; i++) {
    const serial = batch.minted + i + 1;
    const attrs = { serial_no: serial, steps: [] };
    const p = {
      id: serials[i],
      batch_id: batch.id,
      sku: batch.sku,
      name: batch.name,
      category: batch.category,
      manufacturer_id: batch.manufacturer_id,
      status: STATUS.IN_PRODUCTION,
      custodian_id: by.id,
      facility_id: facilityId,
      pending_to: null,
      attributes: attrs,
      last_tx: null,
      sold_at: null,
      scan_count: 0,
      created_at: ts,
      updated_at: ts,
    };
    p.signature = signQr(p);
    products.push(p);
  }
  const drafts = [
    ...(header ? [header] : []),
    ...products.map((p) => ({
      type: 'SERIAL_ISSUED',
      product_id: p.id,
      batch_id: batch.id,
      actor_id: by.id,
      facility_id: facilityId,
      data: { sku: p.sku, serial_no: p.attributes.serial_no, qr_sig: p.signature.slice(0, 16) },
    })),
  ];
  const { block, txs } = await ctx.ledger.commit(drafts, {
    at,
    apply: async (t, sealed) => {
      const byProduct = new Map(sealed.filter((x) => x.product_id).map((x) => [x.product_id, x.id]));
      for (const p of products) p.last_tx = byProduct.get(p.id);
      if (isNew) await t.insert('batches', { ...batch, minted: count });
      else await t.update('batches', batch.id, { minted: batch.minted + count });
      if (products.length) await t.insert('products', products);
    },
  });
  return { block: { height: block.id, hash: block.hash }, minted: products.map((p) => ({ id: p.id, serial_no: p.attributes.serial_no, qr_url: qrUrl(p) })), tx_count: txs.length };
}
