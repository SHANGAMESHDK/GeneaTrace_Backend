import { ctx } from '../context.js';
import { HttpError, unique } from '../util.js';

// Who sees what. Regulators and the network admin oversee everything; every other company
// sees only the units it made, holds, is receiving, or has itself recorded events on.
export const SEES_ALL = new Set(['admin', 'regulator']);
export const seesAll = (actor) => SEES_ALL.has(actor.role);

/** Visible product IDs for an actor, or null when the actor sees everything. */
export async function visibleProductIds(actor) {
  if (seesAll(actor)) return null;
  const col = ['id'];
  const [made, held, incoming, touched] = await Promise.all([
    ctx.store.list('products', { where: { manufacturer_id: actor.id }, columns: col }),
    ctx.store.list('products', { where: { custodian_id: actor.id }, columns: col }),
    ctx.store.list('products', { where: { pending_to: actor.id }, columns: col }),
    ctx.store.list('events', { where: { actor_id: actor.id }, columns: ['product_id'] }),
  ]);
  return new Set([...made, ...held, ...incoming].map((p) => p.id).concat(touched.map((e) => e.product_id).filter(Boolean)));
}

/** Batches an actor may open: its own, or batches containing a unit it can see. */
export async function visibleBatchIds(actor, productIds) {
  if (seesAll(actor)) return null;
  const ids = productIds ?? (await visibleProductIds(actor));
  const [own, fromUnits] = await Promise.all([
    ctx.store.list('batches', { where: { manufacturer_id: actor.id }, columns: ['id'] }),
    ids.size ? ctx.store.list('products', { whereIn: { id: [...ids] }, columns: ['batch_id'] }) : [],
  ]);
  return new Set([...own.map((b) => b.id), ...fromUnits.map((p) => p.batch_id)]);
}

export async function assertProductVisible(actor, productId) {
  if (seesAll(actor)) return;
  const ids = await visibleProductIds(actor);
  if (!ids.has(productId)) throw new HttpError(404, 'Product not found');
}

/** Batch codes the actor manufactures – used to match counterfeit serials claiming them. */
export async function ownBatchCodes(actor) {
  const rows = await ctx.store.list('batches', { where: { manufacturer_id: actor.id }, columns: ['id'] });
  return rows.map((b) => b.id.replace(/[^A-Z0-9]/gi, '').toUpperCase());
}

/** Alerts relevant to an actor: raised by/about it, its units or batches, its facilities, its brand. */
export async function filterAlerts(actor, alerts) {
  if (seesAll(actor)) return alerts;
  const ids = await visibleProductIds(actor);
  const [batches, facilities, codes] = await Promise.all([
    visibleBatchIds(actor, ids),
    ctx.store.list('facilities', { where: { actor_id: actor.id }, columns: ['id'] }),
    ownBatchCodes(actor),
  ]);
  const fac = new Set(facilities.map((f) => f.id));
  const claims = (a) => {
    const claimed = String(a.details?.claimed_id || '').toUpperCase();
    const listed = (a.details?.ids || []).map((x) => String(x).toUpperCase());
    return [claimed, ...listed].some((x) => x && codes.some((c) => x.startsWith(c)));
  };
  return alerts.filter((a) => a.actor_id === actor.id || (a.product_id && ids.has(a.product_id)) || (a.batch_id && batches.has(a.batch_id)) || (a.facility_id && fac.has(a.facility_id)) || claims(a));
}

export const intersect = (ids, list) => (ids ? unique(list).filter((x) => ids.has(x)) : unique(list));
