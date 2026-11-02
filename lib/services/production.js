import { ctx } from '../context.js';
import { HttpError, newId, nowIso, unique } from '../util.js';
import { CONSUMER } from './state.js';

/** Register a production machine at one of your facilities (recorded on-chain). */
export async function createMachine(by, input, { at } = {}) {
  const f = await ctx.store.get('facilities', input.facility_id);
  if (!f) throw new HttpError(400, 'Facility not found');
  if (f.actor_id !== by.id && by.role !== 'admin') throw new HttpError(403, 'Machines can only be added to your own facilities');
  const id = String(input.id || newId('MCH', 5)).toUpperCase();
  if (await ctx.store.get('machines', id)) throw new HttpError(409, `Machine ${id} already exists`);
  const row = {
    id,
    name: input.name,
    facility_id: f.id,
    actor_id: f.actor_id,
    processes: (input.processes || []).map((s) => String(s).trim()).filter(Boolean),
    status: 'active',
    created_at: at || nowIso(),
  };
  await ctx.ledger.lock(() =>
    ctx.ledger.commit([{ type: 'MACHINE_REGISTERED', actor_id: by.id, facility_id: f.id, data: { machine_id: id, name: row.name, processes: row.processes } }], {
      at,
      apply: (t) => t.insert('machines', row),
    }),
  );
  return row;
}

/** Route progress for one unit: which steps are done (last result pass) and what is next. */
export function routeProgress(product, batch) {
  const route = batch?.attributes?.process_route || [];
  const last = new Map();
  for (const s of product.attributes?.steps || []) last.set(s.process, s);
  const done = route.filter((r) => last.get(r)?.result === 'pass');
  return {
    route,
    done,
    failed: route.filter((r) => last.get(r)?.result === 'fail'),
    next: route.find((r) => last.get(r)?.result !== 'pass') || null,
    complete: route.every((r) => last.get(r)?.result === 'pass'),
  };
}

/**
 * Backtrace an issue on one unit (step 12):
 *  1. its own production history (process, machine, time),
 *  2. every unit in the same batch with the same issue reported,
 *  3. which process + machine the affected units have in common versus the rest of the batch,
 *  4. the precise recall scope: units of the batch that went through the suspect machine.
 */
export async function backtrace(productId, codeHint) {
  const product = await ctx.store.get('products', productId);
  if (!product) throw new HttpError(404, 'Product not found');
  const batch = await ctx.store.get('batches', product.batch_id);
  const [batchUnits, steps, issues, tickets, machines] = await Promise.all([
    ctx.store.list('products', { where: { batch_id: batch.id }, columns: ['id', 'status', 'custodian_id', 'attributes'] }),
    ctx.store.list('events', { where: { batch_id: batch.id, type: 'PROCESS_STEP' }, columns: ['product_id', 'data', 'ts'] }),
    ctx.store.list('events', { where: { batch_id: batch.id }, columns: ['product_id', 'type', 'data', 'ts'] }),
    ctx.store.list('tickets', { where: { product_id: productId }, order: [['created_at', 'desc']] }),
    ctx.store.list('machines'),
  ]);
  const machineName = new Map(machines.map((m) => [m.id, m.name]));
  const code = codeHint || tickets.find((t) => t.kind === 'issue')?.code || product.attributes?.issues?.at(-1) || product.attributes?.defects?.at(-1) || null;

  const reports = issues.filter((e) => ['ISSUE_REPORTED', 'DEFECT_REPORTED'].includes(e.type) && e.data?.code && e.data.code !== 'RECALL' && (!code || e.data.code === code));
  const affected = unique(reports.map((e) => e.product_id));
  const affectedSet = new Set(affected);

  // unit → process → machine (last pass of each process)
  const path = new Map();
  for (const s of steps) {
    if (!path.has(s.product_id)) path.set(s.product_id, new Map());
    path.get(s.product_id).set(s.data.process, s.data.machine_id);
  }
  const correlation = [];
  for (const process of batch.attributes?.process_route || [...new Set(steps.map((s) => s.data.process))]) {
    const byMachine = new Map();
    for (const [unit, procs] of path) {
      const m = procs.get(process);
      if (!m) continue;
      if (!byMachine.has(m)) byMachine.set(m, { total: 0, affected: 0 });
      const c = byMachine.get(m);
      c.total++;
      if (affectedSet.has(unit)) c.affected++;
    }
    for (const [machine, c] of byMachine) {
      correlation.push({
        process, machine_id: machine, machine_name: machineName.get(machine) || machine,
        units: c.total, affected: c.affected,
        affected_share: affected.length ? c.affected / affected.length : 0,
        rate: c.total ? c.affected / c.total : 0,
        discriminative: byMachine.size > 1,
      });
    }
  }
  // Suspect: a machine that every affected unit went through, in a process where units were
  // split across machines (otherwise it cannot tell good units from bad ones).
  const suspect = affected.length
    ? correlation.filter((c) => c.discriminative && c.affected_share >= 0.8).sort((a, b) => b.affected_share - a.affected_share || b.rate - a.rate)[0] || null
    : null;
  const scopeIds = suspect ? [...path].filter(([, procs]) => procs.get(suspect.process) === suspect.machine_id).map(([u]) => u) : [];
  const unitMap = new Map(batchUnits.map((u) => [u.id, u]));
  const scopeUnits = scopeIds.map((id) => unitMap.get(id)).filter(Boolean);

  const recommendation = affected.length >= 2 && suspect
    ? 'recall'
    : affected.length >= 2
      ? 'investigate'
      : 'repair';
  return {
    product_id: productId,
    batch_id: batch.id,
    code,
    unit_steps: (product.attributes?.steps || []).map((s) => ({ ...s, machine_name: machineName.get(s.machine_id) || s.machine_id })),
    unit_parts: product.attributes?.parts || {},
    affected,
    batch_units: batchUnits.length,
    correlation,
    suspect,
    scope: {
      units: scopeIds,
      count: scopeIds.length,
      with_consumers: scopeUnits.filter((u) => u.custodian_id === CONSUMER || u.attributes?.open_ticket).length,
      // recalled now, or recalled earlier and already remedied
      already_recalled: scopeUnits.filter((u) => u.status === 'recalled' || u.attributes?.recall_remedied_at).length,
    },
    recommendation,
    summary: suspect
      ? `${affected.length} unit(s) in batch ${batch.id} reported "${code}". All ${suspect.affected} passed "${suspect.process}" on ${suspect.machine_name} (${suspect.machine_id}), which processed ${suspect.units} of ${batchUnits.length} units: ${Math.round(suspect.rate * 100)}% failure rate on that machine.`
      : affected.length > 1
        ? `${affected.length} unit(s) in batch ${batch.id} reported "${code}", but no single process/machine explains them.`
        : `First "${code || 'issue'}" report in batch ${batch.id}. Repair this unit and keep monitoring.`,
  };
}
