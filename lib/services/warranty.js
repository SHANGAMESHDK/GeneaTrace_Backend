import { ctx } from '../context.js';
import { HttpError, newId, nowIso, addMonths } from '../util.js';

/**
 * Replacement / warranty programs with machine-checkable criteria, e.g. a free display
 * replacement for one panel lot. Every eligibility decision is reproducible from the chain.
 *
 * criteria: { skus?, component_lots?, defect_codes?, purchased_after?, purchased_before?,
 *             max_age_months?, exclude_damage?, one_time? }
 */
export async function createProgram(by, input, { at } = {}) {
  const row = {
    id: newId('PRG', 6),
    name: input.name,
    manufacturer_id: by.role === 'admin' && input.manufacturer_id ? input.manufacturer_id : by.id,
    description: input.description || null,
    coverage: input.coverage || null,
    criteria: input.criteria || {},
    active: true,
    created_at: at || nowIso(),
  };
  await ctx.ledger.lock(() =>
    ctx.ledger.commit([{ type: 'PROGRAM_CREATED', actor_id: by.id, data: { program_id: row.id, name: row.name, coverage: row.coverage, criteria: row.criteria } }], {
      at,
      apply: (t) => t.insert('programs', row),
    }),
  );
  return row;
}

export async function setProgramActive(by, id, active) {
  const p = await ctx.store.get('programs', id);
  if (!p) throw new HttpError(404, 'Program not found');
  if (by.role !== 'admin' && p.manufacturer_id !== by.id) throw new HttpError(403, 'Not your program');
  return ctx.store.update('programs', id, { active });
}

/** Effective component lots for a unit: batch BOM, adjusted for parts swapped at service. */
export function componentLots(product, batch) {
  const lots = new Map((batch?.components || []).map((c) => [c.name, c.batch_id]));
  for (const r of product.attributes?.replacements || []) if (r.name && r.to_batch) lots.set(r.name, r.to_batch);
  return [...lots.values()];
}

export function evaluate(program, product, batch, events, now = nowIso()) {
  const c = program.criteria || {};
  const checks = [];
  const add = (label, ok, detail) => checks.push({ label, ok: !!ok, detail });

  if (c.skus?.length) add('Model covered', c.skus.includes(product.sku), product.sku);
  if (c.component_lots?.length) {
    const lots = componentLots(product, batch);
    const hit = lots.filter((l) => c.component_lots.includes(l));
    add('Affected component lot', hit.length > 0, hit.length ? hit.join(', ') : `Unit uses ${lots.join(', ') || 'no tracked lots'}`);
  }
  if (c.defect_codes?.length) {
    const reported = events.filter((e) => e.type === 'DEFECT_REPORTED' && c.defect_codes.includes(e.data?.code));
    add('Covered defect reported on-chain', reported.length > 0, reported.length ? c.defect_codes.join(', ') : 'No matching defect report');
  }
  if (c.purchased_after || c.purchased_before || c.max_age_months) {
    const sold = product.sold_at;
    if (!sold) add('Purchase recorded', false, 'No sale on record');
    else {
      if (c.purchased_after) add(`Purchased after ${c.purchased_after.slice(0, 10)}`, sold >= c.purchased_after, sold.slice(0, 10));
      if (c.purchased_before) add(`Purchased before ${c.purchased_before.slice(0, 10)}`, sold <= c.purchased_before, sold.slice(0, 10));
      if (c.max_age_months) add(`Within ${c.max_age_months} months of purchase`, addMonths(sold, c.max_age_months) >= now, sold.slice(0, 10));
    }
  }
  if (c.exclude_damage) add('No physical or liquid damage on record', !product.attributes?.damage, product.attributes?.damage ? 'Damage recorded at service' : 'Clean');
  if (c.one_time) {
    const used = events.some((e) => e.type === 'WARRANTY_CLAIM' && e.data?.program_id === program.id && e.data?.eligible);
    add('Not previously claimed under this program', !used, used ? 'Already redeemed' : 'Unused');
  }
  if (product.status === 'retired') add('Unit in service', false, 'Unit retired');

  return { program_id: program.id, program: program.name, coverage: program.coverage, eligible: checks.every((x) => x.ok), checks };
}

export async function eligibilityFor(product, batch, events) {
  const programs = await ctx.store.list('programs', { where: { manufacturer_id: product.manufacturer_id, active: true } });
  const now = nowIso();
  const standard = product.attributes?.warranty_until
    ? { active: product.attributes.warranty_until >= now, until: product.attributes.warranty_until }
    : null;
  return { standard, programs: programs.map((p) => evaluate(p, product, batch, events, now)) };
}
