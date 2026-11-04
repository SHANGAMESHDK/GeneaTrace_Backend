import crypto from 'node:crypto';
import { ctx } from '../context.js';
import { config } from '../config.js';
import { HttpError, nowIso } from '../util.js';
import { canonical } from '../chain/crypto.js';
import { applyTx, STATUS } from './state.js';
import { raiseAlert } from './alerts.js';

// Each device gets a secret at serial issue (in production: burned into the secure element).
// Here it is derived from LEDGER_SECRET so no secret is stored in the database.
const deviceSecret = (productId) => crypto.createHmac('sha256', config.ledgerSecret).update(`device:${productId}`).digest();

const reportMessage = (productId, parts, nonce) => canonical({ product_id: productId, parts: [...parts].sort((a, b) => a.name.localeCompare(b.name)), nonce });

/** What the phone itself computes when it phones home. */
export function signDeviceReport(productId, parts, nonce) {
  return crypto.createHmac('sha256', deviceSecret(productId)).update(reportMessage(productId, parts, nonce)).digest('base64url');
}

/**
 * Device check-in (runs every time the device gets internet). Compares the parts the device
 * reports with the parts paired to it on the ledger. A part that was never minted as a genuine
 * component means a third-party replacement with a fake part → cryptographic LOCK on-chain.
 */
export async function attest({ product_id: rawId, parts = [], nonce, signature }) {
  const productId = String(rawId || '').toUpperCase();
  const product = await ctx.store.get('products', productId);
  if (!product) throw new HttpError(404, 'Unknown device');
  if (product.category !== 'electronics') throw new HttpError(400, 'Device attestation applies to electronics');
  const expected = signDeviceReport(productId, parts, nonce);
  if (!signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new HttpError(401, 'Device signature invalid – report not from this device');
  }

  const paired = product.attributes?.parts || {};
  const reportedIds = parts.map((p) => String(p.serial || '').toUpperCase()).filter(Boolean);
  const known = new Map((reportedIds.length ? await ctx.store.list('products', { whereIn: { id: reportedIds } }) : []).map((p) => [p.id, p]));
  const checks = parts.map((r) => {
    const serial = String(r.serial || '').toUpperCase();
    const pair = paired[r.name];
    if (pair && pair.serial === serial) return { name: r.name, serial, verdict: 'genuine', detail: `Paired at ${pair.lot}` };
    const unit = known.get(serial);
    if (!unit || unit.category !== 'component') return { name: r.name, serial, verdict: 'counterfeit', detail: 'Serial was never minted by any registered component maker' };
    if (unit.attributes?.parent && unit.attributes.parent !== productId) return { name: r.name, serial, verdict: 'counterfeit', detail: `Genuine serial cloned from device ${unit.attributes.parent}` };
    return { name: r.name, serial, verdict: 'unpaired', detail: 'Genuine part, but not installed by an authorised service centre' };
  });
  for (const name of Object.keys(paired)) if (!parts.some((r) => r.name === name)) checks.push({ name, serial: null, verdict: 'missing', detail: 'Paired part not reported' });

  const counterfeit = checks.filter((c) => c.verdict === 'counterfeit');
  let locked = !!product.attributes?.locked;
  let tx = null;
  const batch = await ctx.store.get('batches', product.batch_id);
  // 'warn' keeps the device working and shows the part on its passport, for markets whose repair
  // laws do not allow software to block a part. 'lock' is the default.
  const warnOnly = batch?.attributes?.part_policy === 'warn';
  if (counterfeit.length && warnOnly) {
    const reason = `Non-genuine ${counterfeit.map((c) => c.name.toLowerCase()).join(', ')} detected (${counterfeit.map((c) => c.serial).join(', ')})`;
    if (product.attributes?.part_warning !== reason) {
      const sealed = await ctx.ledger.lock(async () => {
        const fresh = await ctx.store.get('products', productId);
        return ctx.ledger.commit(
          [{ type: 'PART_WARNING', product_id: productId, batch_id: fresh.batch_id, actor_id: null, data: { reason, parts: counterfeit, nonce }, prev_tx: fresh.last_tx }],
          { apply: (t, txs) => t.saveProducts([applyTx(fresh, txs[0])]) },
        );
      });
      tx = sealed.txs[0].id;
      await raiseAlert({ severity: 'high', type: 'NON_GENUINE_PART', product_id: productId, batch_id: product.batch_id, message: `${productId}: ${reason}. Device left working under the warn-only policy.`, details: { parts: counterfeit, dedupe: `warn:${productId}:${tx}` } });
    }
  } else if (counterfeit.length && !locked) {
    const reason = `Counterfeit ${counterfeit.map((c) => c.name.toLowerCase()).join(', ')} detected (${counterfeit.map((c) => c.serial).join(', ')})`;
    const sealed = await ctx.ledger.lock(async () => {
      const fresh = await ctx.store.get('products', productId);
      return ctx.ledger.commit(
        [{ type: 'LOCK', product_id: productId, batch_id: fresh.batch_id, actor_id: null, data: { reason, parts: counterfeit, nonce }, prev_tx: fresh.last_tx }],
        { apply: (t, txs) => t.saveProducts([applyTx(fresh, txs[0])]) },
      );
    });
    tx = sealed.txs[0].id;
    locked = true;
    await raiseAlert({
      severity: 'critical',
      type: 'DEVICE_LOCKED',
      product_id: productId,
      batch_id: product.batch_id,
      message: `${productId} locked: ${reason}. Likely an unauthorised third-party repair.`,
      details: { parts: counterfeit, dedupe: `lock:${productId}:${tx}` },
    });
  } else if (checks.some((c) => c.verdict === 'unpaired')) {
    await raiseAlert({
      severity: 'medium',
      type: 'UNPAIRED_PART',
      product_id: productId,
      message: `${productId} reports a genuine but unpaired part – repair outside the authorised network`,
      details: { parts: checks.filter((c) => c.verdict === 'unpaired'), dedupe: `unpaired:${productId}` },
    });
  }
  return {
    product_id: productId,
    locked,
    status: locked ? STATUS.LOCKED : 'ok',
    message: locked
      ? 'Device locked. A non-genuine part was detected. Visit an authorised service centre to restore it.'
      : counterfeit.length ? 'Non-genuine part detected. The device still works; this is recorded on its passport.'
      : checks.some((c) => c.verdict === 'unpaired') ? 'Genuine part detected that was not paired by an authorised centre.' : 'All parts genuine and paired.',
    checks,
    lock_tx: tx,
    checked_at: nowIso(),
  };
}

/** Console simulator: builds the report the device would send and signs it with the device key. */
export async function simulateCheckin(productId, overrides = {}) {
  const product = await ctx.store.get('products', String(productId).toUpperCase());
  if (!product) throw new HttpError(404, 'Product not found');
  const paired = product.attributes?.parts || {};
  const parts = Object.entries(paired).map(([name, p]) => ({ name, serial: overrides[name] || p.serial }));
  for (const [name, serial] of Object.entries(overrides)) if (!paired[name]) parts.push({ name, serial });
  const nonce = crypto.randomBytes(8).toString('hex');
  return attest({ product_id: product.id, parts, nonce, signature: signDeviceReport(product.id, parts, nonce) });
}
