import { ctx } from '../context.js';
import { HttpError, haversineKm, newId, nowIso, sha256, unique } from '../util.js';
import { replay, STATUS, CONSUMER } from './state.js';
import { verifyQr, qrUrl } from './catalog.js';
import { eligibilityFor, componentLots } from './warranty.js';
import { raiseAlert } from './alerts.js';
import { publicActor } from './network.js';
import { routeProgress } from './production.js';

const CLONE_WINDOW_H = 6;
const CLONE_DISTANCE_KM = 250;

const facilityView = (f) => f && { id: f.id, name: f.name, type: f.type, city: f.city, lat: f.lat, lng: f.lng, licensed: f.licensed, actor_id: f.actor_id };

async function lookups(actorIds, facilityIds) {
  const [actors, facilities] = await Promise.all([
    ctx.store.list('actors', { whereIn: { id: unique(actorIds.filter(Boolean)) } }),
    ctx.store.list('facilities', { whereIn: { id: unique(facilityIds.filter(Boolean)) } }),
  ]);
  return { actors: new Map(actors.map((a) => [a.id, a])), facilities: new Map(facilities.map((f) => [f.id, f])) };
}

/** Recursive bill of materials: unit → batch → component lots → their components … */
export async function componentTree(batch, overrides = new Map(), depth = 0) {
  if (!batch || depth > 6) return [];
  const out = [];
  for (const c of batch.components || []) {
    const lotId = overrides.get(c.name) || c.batch_id;
    const b = await ctx.store.get('batches', lotId);
    const maker = b && (await ctx.store.get('actors', b.manufacturer_id));
    out.push({
      name: c.name,
      batch_id: lotId,
      replaced: overrides.has(c.name),
      sku: b?.sku,
      batch_name: b?.name,
      status: b?.status,
      mfg_date: b?.mfg_date,
      manufacturer: maker ? { id: maker.id, name: maker.name } : null,
      children: await componentTree(b, new Map(), depth + 1),
    });
  }
  return out;
}

export function trustScore({ sigValid, integrity, drift, product, batch, journey, openAlerts, clone }) {
  const reasons = [];
  let score = 100;
  const hit = (n, why) => {
    score -= n;
    reasons.push({ impact: -n, reason: why });
  };
  if (sigValid === false) hit(100, 'QR signature does not match the manufacturer key');
  if (!integrity.valid) hit(100, integrity.ethereum?.mismatches?.length ? 'Ledger records differ from their Ethereum anchors' : 'Ledger records for this unit fail cryptographic verification');
  if (drift.length) hit(40, 'Database state disagrees with the ledger');
  if (product.status === STATUS.LOCKED) hit(70, `Device locked: ${product.attributes?.lock_reason || 'counterfeit part detected'}`);
  if (product.status === STATUS.RECALLED) hit(60, 'Unit is under recall');
  if (product.status === STATUS.FLAGGED) hit(45, 'Unit is flagged');
  if (product.status === STATUS.QUARANTINED) hit(45, 'Unit failed quality control');
  if (batch?.expiry_date && batch.expiry_date < nowIso().slice(0, 10)) hit(50, `Expired on ${batch.expiry_date}`);
  if (journey.some((j) => j.facility && !j.facility.licensed)) hit(35, 'Passed through an unlicensed facility');
  if (journey.some((j) => j.data?.excursion)) hit(20, 'Cold-chain temperature excursion recorded');
  if (product.attributes?.repackaged?.length) hit(10, 'Unit was repackaged by the manufacturer');
  if (clone) hit(50, 'Same ID scanned in far-apart locations – possible cloned label');
  if (openAlerts) hit(Math.min(30, openAlerts * 10), `${openAlerts} open alert(s)`);
  if (sigValid == null) reasons.push({ impact: 0, reason: 'Entered manually – label signature not checked' });
  return { score: Math.max(0, score), reasons };
}

export async function buildPassport(productId, { sig, includeInternal = false } = {}) {
  const product = await ctx.store.get('products', productId);
  if (!product) return null;
  const [batch, events, scans, alerts, tickets] = await Promise.all([
    ctx.store.get('batches', product.batch_id),
    ctx.store.list('events', { where: { product_id: product.id }, order: [['block_height', 'asc'], ['seq', 'asc']] }),
    ctx.store.list('scans', { where: { product_id: product.id }, order: [['created_at', 'desc']], limit: 50 }),
    ctx.store.list('alerts', { where: { product_id: product.id }, order: [['created_at', 'desc']] }),
    ctx.store.list('tickets', { where: { product_id: product.id }, order: [['created_at', 'desc']] }),
  ]);
  const batchEvents = await ctx.store.list('events', { where: { batch_id: product.batch_id, product_id: null }, order: [['block_height', 'asc']] });
  const { actors, facilities } = await lookups(
    [product.manufacturer_id, product.custodian_id, product.pending_to, ...events.map((e) => e.actor_id), ...events.map((e) => e.data?.to_actor_id)],
    [product.facility_id, ...events.map((e) => e.facility_id)],
  );
  const manufacturer = actors.get(product.manufacturer_id);

  const integrity = await ctx.ledger.verifyProduct(product.id, events);
  const replayed = replay(product, events);
  const drift = ['status', 'custodian_id', 'facility_id', 'pending_to', 'last_tx']
    .filter((k) => (replayed[k] ?? null) !== (product[k] ?? null))
    .map((k) => ({ field: k, database: product[k] ?? null, ledger: replayed[k] ?? null }));
  const truth = { ...product, ...replayed, scan_count: product.scan_count };

  const journey = events.map((e) => ({
    tx_id: e.id,
    type: e.type,
    ts: e.ts,
    block_height: e.block_height,
    actor: actors.get(e.actor_id) ? { id: e.actor_id, name: actors.get(e.actor_id).name, role: actors.get(e.actor_id).role } : null,
    facility: facilityView(facilities.get(e.facility_id)),
    to_actor: e.data?.to_actor_id ? { id: e.data.to_actor_id, name: actors.get(e.data.to_actor_id)?.name } : null,
    data: e.data,
    signature: e.signature,
    prev_tx: e.prev_tx,
  }));

  const sigValid = sig ? verifyQr(product, manufacturer?.public_key, sig) : null;
  const overrides = new Map((truth.attributes?.replacements || []).map((r) => [r.name, r.to_batch]));
  const components = await componentTree(batch, overrides);
  const warranty = await eligibilityFor(truth, batch, events);
  const openAlerts = alerts.filter((a) => a.status === 'open').length;
  const clone = alerts.some((a) => a.type === 'SUSPECTED_CLONE' && a.status === 'open');
  const trust = trustScore({ sigValid, integrity, drift, product: truth, batch, journey, openAlerts, clone });
  const partLots = await ctx.store.list('batches', { whereIn: { id: [...new Set(Object.values(truth.attributes?.parts || {}).map((x) => x.lot).filter(Boolean))] }, columns: ['id', 'name', 'manufacturer_id'] });
  const lotName = new Map(partLots.map((b) => [b.id, b.name]));
  const parts = Object.entries(truth.attributes?.parts || {}).map(([name, x]) => ({ name, serial: x.serial, lot: x.lot, lot_name: lotName.get(x.lot) || null }));
  const custodian = truth.custodian_id === CONSUMER ? { id: CONSUMER, name: 'Consumer (sold)' } : publicActor(actors.get(truth.custodian_id));

  return {
    product: {
      id: truth.id,
      name: truth.name,
      sku: truth.sku,
      category: truth.category,
      status: truth.status,
      attributes: truth.attributes,
      sold_at: truth.sold_at,
      created_at: product.created_at,
      scan_count: product.scan_count,
      qr_url: qrUrl(product, batch),
    },
    batch: batch && {
      id: batch.id, name: batch.name, sku: batch.sku, quantity: batch.quantity, minted: batch.minted, mfg_date: batch.mfg_date,
      expiry_date: batch.expiry_date, status: batch.status, attributes: batch.attributes,
      created_tx: batchEvents.find((e) => e.type === 'BATCH_CREATED')?.id,
    },
    manufacturer: publicActor(manufacturer),
    custodian,
    pending_to: truth.pending_to ? publicActor(actors.get(truth.pending_to)) : null,
    facility: facilityView(facilities.get(truth.facility_id)),
    journey,
    production: { ...routeProgress(truth, batch), steps: truth.attributes?.steps || [], completed_at: truth.attributes?.produced_at || null },
    parts,
    tickets: (includeInternal ? tickets : tickets.filter((t) => t.status !== 'closed')).map((t) => ({ id: t.id, kind: t.kind, code: t.code, status: t.status, created_at: t.created_at, updated_at: t.updated_at, ...(includeInternal ? { diagnosis: t.diagnosis, retailer_id: t.retailer_id, replacement_id: t.replacement_id, description: t.description } : {}) })),
    components,
    component_lots: componentLots(truth, batch),
    integrity: { ...integrity, drift, signature_valid: sigValid },
    trust,
    warranty,
    alerts: (includeInternal ? alerts : alerts.filter((a) => a.status === 'open')).map((a) => ({ id: a.id, severity: a.severity, type: a.type, message: a.message, status: a.status, created_at: a.created_at })),
    scans: includeInternal ? scans : scans.slice(0, 10).map((s) => ({ verdict: s.verdict, created_at: s.created_at, lat: s.lat, lng: s.lng })),
  };
}

/** Consumer / inspector scan. Records the scan (append-only) and returns a verdict. */
export async function scan({ id, sig, lat, lng, ip, userAgent }) {
  const claimed = String(id || '').trim().toUpperCase();
  if (!claimed) throw new HttpError(400, 'Product ID required');
  const at = nowIso();
  const geo = lat != null && lng != null ? { lat: Number(lat), lng: Number(lng) } : null;
  const ipHash = ip ? sha256(`scan:${ip}`).slice(0, 16) : null;
  const base = { id: newId('SCN', 10), claimed_id: claimed, lat: geo?.lat ?? null, lng: geo?.lng ?? null, ip_hash: ipHash, user_agent: (userAgent || '').slice(0, 200), created_at: at };

  const product = await ctx.store.get('products', claimed);
  if (!product) {
    await ctx.store.insert('scans', { ...base, product_id: null, verdict: 'COUNTERFEIT', sig_valid: false, details: { reason: 'unknown_id' } });
    await raiseAlert({
      severity: 'critical',
      type: 'COUNTERFEIT_SCAN',
      message: `Unregistered ID ${claimed} scanned${geo ? ` at ${geo.lat.toFixed(3)}, ${geo.lng.toFixed(3)}` : ''} – counterfeit in circulation`,
      details: { claimed_id: claimed, ...geo, dedupe: `cf:${claimed}` },
    });
    return { verdict: 'COUNTERFEIT', headline: 'Not a registered product', reasons: ['This ID was never minted on the GeneaTrace ledger. Do not use or consume this product; report it.'], passport: null };
  }

  const manufacturer = await ctx.store.get('actors', product.manufacturer_id);
  const sigValid = sig ? verifyQr(product, manufacturer.public_key, sig) : null;
  const recent = await ctx.store.list('scans', { where: { product_id: product.id }, gte: { created_at: new Date(Date.now() - CLONE_WINDOW_H * 3600e3).toISOString() } });
  let clone = null;
  if (geo) {
    const far = recent.find((s) => s.lat != null && haversineKm(geo, s) > CLONE_DISTANCE_KM);
    if (far) clone = { km: Math.round(haversineKm(geo, far)), at: far.created_at };
  }
  const distinctAfterSale = new Set(recent.map((s) => s.ip_hash).filter(Boolean)).size;
  if (!clone && product.status === STATUS.SOLD && distinctAfterSale >= 8) clone = { devices: distinctAfterSale };

  if (sigValid === false) {
    await raiseAlert({ severity: 'critical', type: 'FORGED_LABEL', product_id: product.id, message: `Forged QR label for real ID ${product.id} – signature invalid`, details: { ...geo, dedupe: `forged:${product.id}` } });
  }
  if (clone) {
    await raiseAlert({
      severity: 'critical',
      type: 'SUSPECTED_CLONE',
      product_id: product.id,
      batch_id: product.batch_id,
      message: clone.km ? `${product.id} scanned ${clone.km} km apart within ${CLONE_WINDOW_H}h – cloned label suspected` : `${product.id} scanned from ${clone.devices} devices after sale – cloned label suspected`,
      details: { ...clone, ...geo, dedupe: `clone:${product.id}` },
    });
  }

  const passport = await buildPassport(product.id, { sig });
  const reasons = [];
  let verdict = 'GENUINE';
  if (sigValid === false) { verdict = 'COUNTERFEIT'; reasons.push('The QR label was not issued by the manufacturer (signature mismatch).'); }
  else if (!passport.integrity.valid) { verdict = 'TAMPERED'; reasons.push(...passport.integrity.issues); }
  else if (clone) { verdict = 'SUSPECTED_CLONE'; reasons.push(clone.km ? `This exact ID was scanned ${clone.km} km away in the last ${CLONE_WINDOW_H} hours.` : 'This ID has been scanned from many devices after it was sold.'); }
  else if (passport.product.status === STATUS.LOCKED) { verdict = 'LOCKED'; reasons.push(passport.product.attributes?.lock_reason || 'A counterfeit part was detected in this device.', 'Visit an authorised service centre to restore genuine parts.'); }
  else if (passport.product.status === STATUS.RECALLED) { verdict = 'RECALLED'; reasons.push(passport.product.attributes?.recall_reason || 'Manufacturer recall in effect.'); }
  else if (passport.batch?.expiry_date && passport.batch.expiry_date < at.slice(0, 10)) { verdict = 'EXPIRED'; reasons.push(`Expired on ${passport.batch.expiry_date}.`); }
  else if ([STATUS.FLAGGED, STATUS.QUARANTINED].includes(passport.product.status) || passport.integrity.drift.length) { verdict = 'SUSPICIOUS'; reasons.push(...passport.trust.reasons.map((r) => r.reason)); }
  else reasons.push(sigValid ? 'Signed by the manufacturer and every custody step verifies on the ledger.' : 'Product found on the ledger. Scan the QR label to also verify the manufacturer signature.');

  if (passport.product.attributes?.part_warning) reasons.push(passport.product.attributes.part_warning);

  await ctx.store.insert('scans', { ...base, product_id: product.id, verdict, sig_valid: sigValid, details: clone ? { clone } : {} });
  await ctx.store.increment('products', product.id, 'scan_count');

  const HEAD = {
    GENUINE: 'Authentic product',
    COUNTERFEIT: 'Counterfeit label',
    TAMPERED: 'Records tampered',
    SUSPECTED_CLONE: 'Possible cloned label',
    RECALLED: 'Recalled – do not use',
    LOCKED: 'Device locked – non-genuine part',
    EXPIRED: 'Expired – do not use',
    SUSPICIOUS: 'Proceed with caution',
  };
  return { verdict, headline: HEAD[verdict], reasons, passport };
}

/** Forward trace: where every unit of a batch (or of products built from a component lot) is now. */
export async function forwardTrace(batchId) {
  const batch = await ctx.store.get('batches', batchId);
  if (!batch) throw new HttpError(404, 'Batch not found');
  const allBatches = await ctx.store.list('batches');
  const dependents = allBatches.filter((b) => (b.components || []).some((c) => c.batch_id === batchId));
  const ids = [batchId, ...dependents.map((b) => b.id)];
  const units = await ctx.store.list('products', { whereIn: { batch_id: ids }, columns: ['id', 'batch_id', 'status', 'custodian_id', 'facility_id', 'pending_to', 'sold_at', 'attributes'] });
  const { actors, facilities } = await lookups(units.flatMap((u) => [u.custodian_id, u.pending_to]), units.map((u) => u.facility_id));
  const locations = new Map();
  for (const u of units) {
    const key = u.custodian_id === CONSUMER ? 'CONSUMER' : `${u.custodian_id}|${u.facility_id || (u.pending_to ? 'transit' : '')}`;
    if (!locations.has(key)) {
      const f = facilities.get(u.facility_id);
      locations.set(key, {
        holder: u.custodian_id === CONSUMER ? 'Consumers' : actors.get(u.custodian_id)?.name || u.custodian_id,
        role: u.custodian_id === CONSUMER ? 'consumer' : actors.get(u.custodian_id)?.role,
        facility: facilityView(f),
        in_transit_to: u.pending_to ? actors.get(u.pending_to)?.name : null,
        units: 0,
        statuses: {},
      });
    }
    const l = locations.get(key);
    l.units += 1;
    l.statuses[u.status] = (l.statuses[u.status] || 0) + 1;
  }
  return {
    batch_id: batchId,
    dependents: dependents.map((b) => ({ id: b.id, name: b.name, sku: b.sku, minted: b.minted })),
    units: units.length,
    locations: [...locations.values()].sort((a, b) => b.units - a.units),
  };
}
