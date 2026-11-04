import { ctx } from '../context.js';
import { newId, nowIso } from '../util.js';
import { notifyAlert } from './notify.js';

/**
 * Raise an alert unless an open one with the same dedupe key exists.
 * severity: critical | high | medium | low
 */
export async function raiseAlert({ severity, type, message, product_id = null, batch_id = null, facility_id = null, actor_id = null, details = {}, dedupe, refresh = false }) {
  const key = dedupe || details.dedupe || null;
  if (key) {
    const open = await ctx.store.list('alerts', { where: { status: 'open', type }, limit: 500, order: [['created_at', 'desc']] });
    const hit = open.find((a) => a.details?.dedupe === key);
    // `refresh` keeps one evolving alert (e.g. a growing defect cluster) instead of a stale one.
    if (hit) return refresh ? ctx.store.update('alerts', hit.id, { severity, message, details: { ...details, dedupe: key } }) : hit;
  }
  const [row] = await ctx.store.insert('alerts', {
    id: newId('ALR'),
    severity,
    type,
    message,
    product_id,
    batch_id,
    facility_id,
    actor_id,
    details: { ...details, dedupe: key },
    status: 'open',
    created_at: details.at || nowIso(),
  });
  notifyAlert(row).catch((e) => console.error('[notify]', e.message));
  return row;
}

export async function resolveAlert(id, actor, note) {
  const a = await ctx.store.get('alerts', id);
  if (!a) return null;
  return ctx.store.update('alerts', id, {
    status: 'resolved',
    resolved_at: nowIso(),
    resolved_by: actor.id,
    details: { ...a.details, resolution: note || null },
  });
}
