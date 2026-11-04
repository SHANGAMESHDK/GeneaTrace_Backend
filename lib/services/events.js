import crypto from 'node:crypto';
import { ctx } from '../context.js';
import { config } from '../config.js';
import { HttpError, addMonths, newId, nowIso, sha256, unique } from '../util.js';
import { applyTx, STATUS, CONSUMER } from './state.js';
import { raiseAlert } from './alerts.js';
import { evaluate, componentLots } from './warranty.js';
import { routeProgress, backtrace } from './production.js';
import { notifyRecallCustomers } from './notify.js';

// Who may record what. Admin may do anything.
const HANDLERS = ['manufacturer', 'distributor', 'logistics', 'retailer', 'pharmacy', 'hospital', 'service_center'];
const RETAIL = ['retailer', 'pharmacy', 'hospital', 'service_center'];
export const EVENT_RULES = {
  // production (manufacturer login + /scanner)
  PROCESS_STEP: { roles: ['manufacturer'], label: 'Process step', stage: 'production' },
  PRODUCTION_COMPLETE: { roles: ['manufacturer'], label: 'Production complete', stage: 'production' },
  QUALITY_CHECK: { roles: ['manufacturer'], label: 'Quality check', stage: 'production' },
  // logistics
  PACKED: { roles: ['manufacturer', 'distributor'], label: 'Packed', stage: 'logistics' },
  STORED: { roles: ['manufacturer', 'distributor', 'logistics'], label: 'Stored in warehouse', stage: 'logistics' },
  EXIT: { roles: HANDLERS, label: 'Dispatched (exit)', stage: 'logistics' },
  CHECKPOINT: { roles: [...HANDLERS, 'regulator'], label: 'Transit checkpoint', stage: 'logistics' },
  DELIVERED: { roles: ['manufacturer', 'distributor', 'logistics'], label: 'Delivered (proof of delivery)', stage: 'logistics' },
  ENTRY: { roles: HANDLERS, label: 'Received (entry)', stage: 'logistics' },
  // retail
  SOLD: { roles: ['retailer', 'pharmacy', 'hospital', 'manufacturer'], label: 'Sold to customer', stage: 'retail' },
  ISSUE_REPORTED: { roles: RETAIL, label: 'Customer issue – unit returned', stage: 'service' },
  HANDED_OVER: { roles: RETAIL, label: 'Handed back to customer', stage: 'service' },
  // service
  DIAGNOSED: { roles: ['manufacturer'], label: 'Diagnosed (backtrace)', stage: 'service' },
  SERVICE: { roles: ['service_center', 'manufacturer'], label: 'Service / repair', stage: 'service' },
  UNLOCK: { roles: ['manufacturer', 'service_center'], label: 'Unlock device', stage: 'service' },
  FIRMWARE_UPDATE: { roles: ['manufacturer', 'service_center'], label: 'Firmware update', stage: 'service' },
  DEFECT_REPORTED: { roles: ['service_center', 'retailer', 'pharmacy', 'hospital', 'regulator', 'manufacturer'], label: 'Defect report', stage: 'service' },
  WARRANTY_CLAIM: { roles: ['service_center', 'manufacturer'], label: 'Warranty claim', stage: 'service' },
  // control
  RECALL: { roles: ['manufacturer', 'regulator'], label: 'Recall', stage: 'control' },
  FLAG: { roles: ['regulator'], label: 'Regulatory flag', stage: 'control' },
  CLEAR: { roles: ['regulator'], label: 'Clear flag', stage: 'control' },
  REPACKAGE: { roles: ['manufacturer'], label: 'Repackage / relabel', stage: 'control' },
  DISPOSE: { roles: ['manufacturer', 'regulator', 'pharmacy', 'hospital', 'service_center'], label: 'Dispose', stage: 'control' },
};
export const EVENT_TYPES = Object.keys(EVENT_RULES);

const today = (at) => (at || nowIso()).slice(0, 10);
const isExpired = (batch, at) => batch?.expiry_date && batch.expiry_date < today(at);
const MOVING = new Set([STATUS.IN_PRODUCTION, STATUS.INSTALLED]);

function validate(type, p, batch, actor, input, at, x) {
  const own = p.custodian_id === actor.id || actor.role === 'admin';
  const a = p.attributes || {};
  if (p.status === STATUS.RETIRED) return 'Unit has been retired / disposed';
  if (p.status === STATUS.INSTALLED && !['RECALL', 'FLAG'].includes(type)) return `This is a component already installed in ${a.parent}`;
  switch (type) {
    case 'PROCESS_STEP': {
      if (!own) return 'Unit is not at your facility';
      const rework = p.status === STATUS.RETURNED && p.manufacturer_id === actor.id;
      if (p.status !== STATUS.IN_PRODUCTION && !rework) return `Unit is ${p.status} – process steps are only recorded during production or rework`;
      const route = batch?.attributes?.process_route || [];
      const proc = input.data.process;
      if (!rework && route.length) {
        if (!route.includes(proc)) return `"${proc}" is not in this batch's process route`;
        const prog = routeProgress(p, batch);
        if (proc !== prog.next && !prog.done.includes(proc) && !prog.failed.includes(proc)) return `Out of sequence: "${prog.next}" must be completed before "${proc}"`;
      }
      if (x.part === null) return `Part ${x.partId} is not a registered genuine component (possible counterfeit part)`;
      if (x.part) {
        if (x.part.category !== 'component') return `${x.part.id} is not a component`;
        if (x.part.status === STATUS.INSTALLED) return `Part ${x.part.id} is already installed in ${x.part.attributes?.parent}`;
        if (x.part.custodian_id !== actor.id) return `Part ${x.part.id} is not in your stock`;
        if (x.part.status !== STATUS.IN_STOCK) return `Part ${x.part.id} is ${x.part.status}`;
        if (batch?.components?.length && !batch.components.some((c) => c.batch_id === x.part.batch_id)) return `Part lot ${x.part.batch_id} is not in this product's bill of materials`;
      }
      return null;
    }
    case 'PRODUCTION_COMPLETE': {
      if (!own) return 'Unit is not at your facility';
      if (p.status !== STATUS.IN_PRODUCTION) return `Unit is ${p.status}, not in production`;
      const prog = routeProgress(p, batch);
      if (!prog.complete) return `Missing process steps: ${prog.route.filter((r) => !prog.done.includes(r)).join(', ')}`;
      return null;
    }
    case 'QUALITY_CHECK':
      return own ? null : 'Only the current custodian can record QC';
    case 'PACKED':
      if (!own) return 'You are not the current custodian of this unit';
      return p.status === STATUS.IN_STOCK ? null : `Unit is ${p.status}; only finished stock can be packed`;
    case 'STORED':
      if (!own) return 'You are not the current custodian of this unit';
      if (!input.facility_id) return 'Select the warehouse facility';
      return p.status === STATUS.IN_STOCK || p.status === STATUS.RETURNED ? null : `Unit is ${p.status}`;
    case 'EXIT':
      if (!own) return 'You are not the current custodian of this unit';
      if (MOVING.has(p.status)) return 'Production is not complete for this unit';
      if (p.pending_to) return 'Unit is already in transit';
      if (p.status === STATUS.QUARANTINED) return 'Unit is quarantined after a failed QC';
      if (p.status === STATUS.SOLD) return 'Unit has already been sold';
      if ([STATUS.RECALLED, STATUS.FLAGGED].includes(p.status) && input.to_actor_id !== p.manufacturer_id && input.to.role !== 'regulator') {
        return `Unit is ${p.status}: it may only be returned to the manufacturer or a regulator`;
      }
      return null;
    case 'DELIVERED':
      if (!p.pending_to) return 'Unit is not in transit';
      return a.dispatched_by === actor.id || ['logistics', 'admin'].includes(actor.role) ? null : 'Only the dispatching party or carrier can confirm delivery';
    case 'ENTRY':
      if (!p.pending_to) return 'Unit was never dispatched (no matching EXIT)';
      if (p.pending_to !== actor.id) return `Unit is consigned to ${p.pending_to}, not to you`;
      return null;
    case 'CHECKPOINT':
      return null;
    case 'SOLD':
      if (!own) return 'You are not the current custodian of this unit';
      if (p.status === STATUS.RECALLED) return 'Unit is under RECALL – sale blocked';
      if (p.status === STATUS.FLAGGED) return 'Unit is flagged by a regulator – sale blocked';
      if (a.open_ticket) return 'Unit belongs to an open service case – use "Handed back to customer"';
      if (p.status !== STATUS.IN_STOCK) return `Unit is ${p.status}, not in stock`;
      if (isExpired(batch, at)) return `Batch expired on ${batch.expiry_date} – sale blocked`;
      if (a.cold_chain_breach) return 'Cold-chain excursion on record – sale blocked until a regulator clears it';
      return null;
    case 'ISSUE_REPORTED':
      if (p.custodian_id !== CONSUMER) return 'Only units that are with a customer can be returned';
      if (input.data.ticket_id) {
        const t = x.tickets.get(input.data.ticket_id);
        if (!t || t.product_id !== p.id) return 'Ticket does not belong to this unit';
      }
      return null;
    case 'DIAGNOSED':
      if (!own || p.manufacturer_id !== actor.id) return 'Only the manufacturer holding the returned unit can diagnose it';
      if (!a.open_ticket) return 'No open service case on this unit';
      if (input.data.action === 'replace') {
        const r = x.replacement;
        if (!r) return 'Select a replacement unit';
        if (r.sku !== p.sku) return 'Replacement must be the same model';
        if (r.custodian_id !== actor.id || r.status !== STATUS.IN_STOCK || r.attributes?.open_ticket) return `Replacement ${r.id} is not available in your stock`;
      }
      return null;
    case 'HANDED_OVER':
      if (!own) return 'You are not holding this unit';
      if (!a.open_ticket) return 'No open service case – use "Sold to customer" for new sales';
      if (p.status === STATUS.RECALLED) return 'Unit is under recall and has not been remedied';
      return null;
    case 'SERVICE':
      for (const r of input.data.replaced || []) {
        if (!r.new_part_id) continue;
        const part = x.parts.get(r.new_part_id);
        if (!part) return `Replacement part ${r.new_part_id} is not a registered genuine component`;
        if (part.status !== STATUS.IN_STOCK || part.custodian_id !== actor.id) return `Part ${r.new_part_id} is not available in your stock`;
      }
      if (input.data.remedy && p.manufacturer_id !== actor.id) return 'Only the manufacturer can remedy a recall';
      return null;
    case 'UNLOCK':
      if (!a.locked) return 'Device is not locked';
      if (!(a.serviced_at > a.locked_at)) return 'Install a genuine part (Service / repair) before unlocking';
      return null;
    case 'FIRMWARE_UPDATE':
      return p.category === 'electronics' ? null : 'Firmware updates apply to electronics only';
    case 'RECALL':
      if (actor.role === 'manufacturer' && p.manufacturer_id !== actor.id) return 'Only the original manufacturer can recall this unit';
      return p.status === STATUS.RECALLED ? 'Already recalled' : null;
    case 'REPACKAGE':
      return p.manufacturer_id === actor.id || actor.role === 'admin' ? null : 'Only the original manufacturer may repackage';
    case 'CLEAR':
      return p.status === STATUS.FLAGGED ? null : 'Unit is not flagged';
    default:
      return null;
  }
}

// Keyed, so a public sale ID cannot be used to guess a customer's phone number from the chain.
const customerRef = (saleId, c) => crypto.createHmac('sha256', config.ledgerSecret).update(`customer:${saleId}:${c?.name || ''}:${c?.phone || ''}:${c?.email || ''}`).digest('hex').slice(0, 20);

/**
 * Record one event type for one or many units in a single block.
 * Every accepted unit gets its own signed transaction; every rejection is explained and,
 * where it smells of fraud, turned into an alert.
 */
export async function recordEvents(actor, input, { at, attestation } = {}) {
  const { type } = input;
  const rule = EVENT_RULES[type];
  if (!rule) throw new HttpError(400, `Unknown event type ${type}`);
  const data = { ...(input.data || {}) };
  input.data = data;

  if (type === 'EXIT') {
    if (!input.to_actor_id) throw new HttpError(400, 'EXIT requires to_actor_id (the receiving party)');
    if (input.to_actor_id === actor.id) throw new HttpError(400, 'Cannot dispatch to yourself');
    input.to = await ctx.store.get('actors', input.to_actor_id);
    if (!input.to || input.to.status !== 'active') throw new HttpError(400, 'Receiving party is not an active network member');
  }
  if (['DEFECT_REPORTED', 'ISSUE_REPORTED'].includes(type) && !data.code) throw new HttpError(400, `${type} requires data.code`);
  if (type === 'FIRMWARE_UPDATE' && !data.version) throw new HttpError(400, 'FIRMWARE_UPDATE requires data.version');
  if (type === 'QUALITY_CHECK' && !['pass', 'fail'].includes(data.result)) throw new HttpError(400, 'QUALITY_CHECK requires data.result = pass | fail');
  if (['RECALL', 'FLAG'].includes(type) && !data.reason) throw new HttpError(400, `${type} requires data.reason`);
  if (type === 'DIAGNOSED' && !data.finding) throw new HttpError(400, 'DIAGNOSED requires data.finding');
  let machine = null;
  if (type === 'PROCESS_STEP') {
    if (!data.process) throw new HttpError(400, 'PROCESS_STEP requires data.process');
    if (!data.machine_id) throw new HttpError(400, 'PROCESS_STEP requires data.machine_id');
    machine = await ctx.store.get('machines', String(data.machine_id).toUpperCase());
    if (!machine || machine.status !== 'active') throw new HttpError(400, `Machine ${data.machine_id} is not registered`);
    if (machine.actor_id !== actor.id && actor.role !== 'admin') throw new HttpError(403, `Machine ${machine.id} belongs to another manufacturer`);
    if (machine.processes.length && !machine.processes.includes(data.process)) throw new HttpError(422, `Machine ${machine.id} is not qualified for "${data.process}" (qualified: ${machine.processes.join(', ')})`);
    data.machine_id = machine.id;
    data.result ||= 'pass';
    if (!input.facility_id) input.facility_id = machine.facility_id;
  }

  const facility = input.facility_id ? await ctx.store.get('facilities', input.facility_id) : null;
  if (input.facility_id && !facility) throw new HttpError(400, 'Facility not found');
  if (facility && facility.actor_id !== actor.id && !['admin', 'regulator', 'logistics'].includes(actor.role)) {
    throw new HttpError(403, 'You can only record events at facilities you operate');
  }

  return ctx.ledger.lock(async () => {
    const rawIds = (input.product_ids || []).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
    // A scanned carton stands for every unit packed inside it.
    const cartons = rawIds.filter((s) => s.startsWith('CTN-'));
    const cartonRows = cartons.length ? await ctx.store.list('cartons', { whereIn: { id: cartons } }) : [];
    const missingCarton = cartons.find((c) => !cartonRows.some((r) => r.id === c));
    if (missingCarton) throw new HttpError(404, `Carton ${missingCarton} is not on the ledger`);
    let ids = unique(rawIds.flatMap((s) => (s.startsWith('CTN-') ? cartonRows.find((r) => r.id === s).units : [s])));
    if (input.batch_id && !ids.length) {
      ids = (await ctx.store.list('products', { where: { batch_id: input.batch_id }, columns: ['id'] })).map((p) => p.id);
    }
    if (!ids.length) throw new HttpError(400, 'No product IDs supplied');
    if (ids.length > 5000) throw new HttpError(400, 'At most 5000 units per request');
    // part_ids[i] belongs to product_ids[i] (one scanned part per unit, e.g. display panel)
    const partFor = new Map();
    (input.part_ids || []).forEach((pid, i) => pid && rawIds[i] && partFor.set(rawIds[i], String(pid).trim().toUpperCase()));
    if (data.part_id && ids.length === 1) partFor.set(ids[0], String(data.part_id).trim().toUpperCase());
    delete data.part_id;

    const products = await ctx.store.list('products', { whereIn: { id: ids } });
    const found = new Map(products.map((p) => [p.id, p]));
    const batchIds = unique(products.map((p) => p.batch_id));
    const batches = new Map((await ctx.store.list('batches', { whereIn: { id: batchIds } })).map((b) => [b.id, b]));
    const programs = type === 'WARRANTY_CLAIM' ? await ctx.store.list('programs', { where: { active: true } }) : [];
    // Parts already paired with these units, so a re-scanned step can retire the part it replaces.
    const pairedIds = type === 'PROCESS_STEP' ? products.flatMap((p) => Object.values(p.attributes?.parts || {}).map((x) => x.serial)) : [];
    const partIds = unique([...partFor.values(), ...pairedIds, ...(data.replaced || []).map((r) => r.new_part_id).filter(Boolean)]);
    const parts = new Map((partIds.length ? await ctx.store.list('products', { whereIn: { id: partIds } }) : []).map((p) => [p.id, p]));
    const replacement = data.replacement_id ? await ctx.store.get('products', String(data.replacement_id).toUpperCase()) : null;
    const ticketIds = unique([data.ticket_id, ...products.map((p) => p.attributes?.open_ticket)].filter(Boolean));
    const tickets = new Map((ticketIds.length ? await ctx.store.list('tickets', { whereIn: { id: ticketIds } }) : []).map((t) => [t.id, t]));
    const roleOk = actor.role === 'admin' || rule.roles.includes(actor.role);

    const accepted = [];
    const rejected = [];
    const usedParts = new Set();
    for (const id of ids) {
      const p = found.get(id);
      const partId = partFor.get(id);
      const x = { tickets, parts, replacement, partId, part: partId ? (parts.get(partId) ?? null) : undefined };
      if (partId && usedParts.has(partId)) {
        rejected.push({ product_id: id, reason: `Part ${partId} scanned twice`, code: type });
        continue;
      }
      if (!p) rejected.push({ product_id: id, reason: 'Unknown ID – not minted on the ledger (possible counterfeit)', code: 'UNKNOWN' });
      else if (!roleOk) rejected.push({ product_id: id, reason: `${actor.role} may not record ${rule.label}`, code: 'ROLE' });
      else {
        const why = validate(type, p, batches.get(p.batch_id), actor, input, at, x);
        if (why) rejected.push({ product_id: id, reason: why, code: /Out of sequence/.test(why) ? 'SEQUENCE' : /genuine component/.test(why) ? 'PART_UNKNOWN' : type, part_id: partId });
        else {
          accepted.push(p);
          if (partId) usedParts.add(partId);
        }
      }
    }

    const lat = input.lat ?? facility?.lat ?? null;
    const lng = input.lng ?? facility?.lng ?? null;
    const geo = lat != null && lng != null ? { lat, lng } : {};
    const drafts = [];
    const claims = [];
    const newTickets = [];
    const newSales = [];
    const ticketUpdates = new Map();
    const touchTicket = (id, patch) => id && ticketUpdates.set(id, { ...(ticketUpdates.get(id) || {}), ...patch });
    const ts = at || nowIso();

    for (const p of accepted) {
      const batch = batches.get(p.batch_id);
      const a = p.attributes || {};
      const d = { ...data, ...geo };
      delete d.replacement_id;
      const extra = [];
      const ticket = tickets.get(a.open_ticket);
      if (a.open_ticket && ['EXIT', 'ENTRY', 'SERVICE', 'DIAGNOSED', 'HANDED_OVER', 'DELIVERED', 'STORED', 'PROCESS_STEP'].includes(type)) d.ticket_id = a.open_ticket;

      switch (type) {
        case 'PROCESS_STEP': {
          d.machine_name = machine.name;
          if (p.status === STATUS.RETURNED) d.rework = true;
          const part = parts.get(partFor.get(p.id));
          if (part) {
            const bom = (batch?.components || []).find((c) => c.batch_id === part.batch_id);
            d.part = { id: part.id, name: data.part_name || bom?.name || part.name, lot: part.batch_id };
            const old = parts.get(a.parts?.[d.part.name]?.serial);
            if (old && old.id !== part.id && old.attributes?.parent === p.id) {
              d.part.replaces = old.id;
              found.set(old.id, old);
              extra.push({ type: 'UNINSTALLED', product_id: old.id, batch_id: old.batch_id, actor_id: actor.id, facility_id: facility?.id || null, data: { parent_id: p.id, replaced_by: part.id, process: data.process }, prev_tx: old.last_tx });
            }
            found.set(part.id, part);
            extra.push({ type: 'INSTALLED', product_id: part.id, batch_id: part.batch_id, actor_id: actor.id, facility_id: facility?.id || null, data: { parent_id: p.id, process: data.process, machine_id: machine.id }, prev_tx: part.last_tx });
          }
          break;
        }
        case 'PRODUCTION_COMPLETE':
          if (batch?.attributes?.firmware) d.firmware = batch.attributes.firmware;
          d.steps = (a.steps || []).length;
          break;
        case 'EXIT':
          Object.assign(d, { to_actor_id: input.to.id, to_actor_name: input.to.name });
          if (ticket) touchTicket(ticket.id, { status: input.to.id === ticket.manufacturer_id ? 'sent_to_manufacturer' : 'returning_to_retailer' });
          break;
        case 'ENTRY':
          d.from_actor_id = p.custodian_id;
          if (facility && !facility.licensed) d.unlicensed_facility = true;
          if (ticket) touchTicket(ticket.id, { status: actor.id === ticket.manufacturer_id ? 'at_manufacturer' : 'ready_for_customer' });
          break;
        case 'SOLD': {
          if (batch?.attributes?.warranty_months) d.warranty_until = addMonths(ts, batch.attributes.warranty_months);
          const saleId = newId('SAL', 8);
          const c = input.customer || {};
          d.customer_ref = customerRef(saleId, c);
          d.sale_id = saleId;
          newSales.push({ id: saleId, product_id: p.id, retailer_id: actor.id, customer_name: c.name || null, customer_phone: c.phone || null, customer_email: c.email || null, invoice: data.invoice || null, price: c.price ?? data.price ?? null, customer_ref: d.customer_ref, replaces: null, consent_at: c.consent ? ts : null, created_at: ts });
          break;
        }
        case 'ISSUE_REPORTED': {
          const recallTicket = data.ticket_id ? tickets.get(data.ticket_id) : null;
          const id = recallTicket?.id || newId('TCK', 6);
          d.ticket_id = id;
          d.sold_by = a.sold_by || null;
          d.firmware = a.firmware || null;
          d.component_lots = componentLots(p, batch);
          if (a.firmware_updated_at) d.days_since_update = Math.round((Date.parse(ts) - Date.parse(a.firmware_updated_at)) / 86400000);
          if (recallTicket) touchTicket(id, { status: 'collected', retailer_id: actor.id });
          else {
            const [sale] = await ctx.store.list('sales', { where: { product_id: p.id }, order: [['created_at', 'desc']], limit: 1 });
            newTickets.push({ id, kind: 'issue', product_id: p.id, batch_id: p.batch_id, retailer_id: actor.id, manufacturer_id: p.manufacturer_id, sale_id: sale?.id || null, code: data.code, description: data.description || null, status: 'reported', diagnosis: {}, replacement_id: null, created_at: ts, updated_at: ts });
          }
          break;
        }
        case 'DIAGNOSED':
          if (data.action === 'replace' && replacement) {
            d.replacement_id = replacement.id;
            found.set(replacement.id, replacement);
            extra.push({ type: 'REPLACEMENT_ASSIGNED', product_id: replacement.id, batch_id: replacement.batch_id, actor_id: actor.id, data: { ticket_id: a.open_ticket, replaces: p.id }, prev_tx: replacement.last_tx });
          }
          touchTicket(a.open_ticket, { status: 'diagnosed', diagnosis: { process: data.process || null, machine_id: data.machine_id || null, finding: data.finding, action: data.action || 'repair', at: ts, by: actor.id }, ...(d.replacement_id ? { replacement_id: d.replacement_id } : {}) });
          break;
        case 'SERVICE':
          for (const r of data.replaced || []) {
            const part = r.new_part_id && parts.get(r.new_part_id);
            if (!part) continue;
            r.to_batch = part.batch_id;
            found.set(part.id, part);
            extra.push({ type: 'INSTALLED', product_id: part.id, batch_id: part.batch_id, actor_id: actor.id, facility_id: facility?.id || null, data: { parent_id: p.id, service: true }, prev_tx: part.last_tx });
          }
          d.replaced = data.replaced;
          if (ticket) touchTicket(ticket.id, { status: 'repaired' });
          break;
        case 'HANDED_OVER': {
          if (a.replaces) {
            const [orig] = await ctx.store.list('sales', { where: { product_id: a.replaces }, order: [['created_at', 'desc']], limit: 1 });
            const saleId = newId('SAL', 8);
            d.customer_ref = customerRef(saleId, orig || {});
            d.replaces = a.replaces;
            if (batch?.attributes?.warranty_months) d.warranty_until = addMonths(ts, batch.attributes.warranty_months);
            newSales.push({ id: saleId, product_id: p.id, retailer_id: actor.id, customer_name: orig?.customer_name || null, customer_phone: orig?.customer_phone || null, customer_email: orig?.customer_email || null, invoice: data.invoice || null, price: 0, customer_ref: d.customer_ref, replaces: a.replaces, created_at: ts });
          }
          touchTicket(a.open_ticket, { status: 'closed' });
          break;
        }
        case 'WARRANTY_CLAIM': {
          const history = await ctx.store.list('events', { where: { product_id: p.id }, order: [['block_height', 'asc'], ['seq', 'asc']] });
          const pool = programs.filter((g) => g.manufacturer_id === p.manufacturer_id && (!d.program_id || g.id === d.program_id));
          const results = pool.map((g) => evaluate(g, p, batch, history, at));
          const best = results.find((r) => r.eligible) || results[0];
          Object.assign(d, best ? { program_id: best.program_id, eligible: best.eligible, checks: best.checks } : { eligible: false, checks: [{ label: 'Active program', ok: false }] });
          claims.push({ product_id: p.id, ...d });
          break;
        }
        case 'DEFECT_REPORTED':
          d.firmware = a.firmware || null;
          d.component_lots = componentLots(p, batch);
          if (a.firmware_updated_at) d.days_since_update = Math.round((Date.parse(ts) - Date.parse(a.firmware_updated_at)) / 86400000);
          break;
        default:
          break;
      }
      if (type === 'CHECKPOINT' || type === 'ENTRY') {
        const { temp_min_c: lo, temp_max_c: hi } = batch?.attributes || {};
        if (d.temperature_c != null && lo != null && (d.temperature_c < lo || d.temperature_c > hi)) d.excursion = true;
      }
      drafts.push({ type, product_id: p.id, batch_id: p.batch_id, actor_id: actor.id, facility_id: facility?.id || null, data: d, prev_tx: p.last_tx });
      drafts.push(...extra);
    }
    if (type === 'RECALL' && accepted.length) {
      for (const bid of unique(accepted.map((p) => p.batch_id))) {
        drafts.push({ type: 'BATCH_RECALLED', batch_id: bid, actor_id: actor.id, data: { reason: data.reason, units: accepted.filter((p) => p.batch_id === bid).length, scope: data.scope || 'batch', machine_id: data.machine_id || null } });
      }
    }

    const packedInto = type === 'PACKED' && String(data.carton_id || '').toUpperCase().startsWith('CTN-') ? String(data.carton_id).toUpperCase() : null;
    const carton = packedInto ? await ctx.store.get('cartons', packedInto) : null;
    if (attestation && drafts.length) drafts.push({ type: 'COMPANY_ATTESTATION', actor_id: actor.id, data: attestation });

    let sealed = null;
    if (drafts.length) {
      sealed = await ctx.ledger.commit(drafts, {
        at,
        apply: async (t, txs) => {
          const next = [];
          for (const x of txs) {
            if (!x.product_id) continue;
            const n = applyTx(found.get(x.product_id), x);
            found.set(n.id, n);
            next.push(n);
          }
          await t.saveProducts([...new Map(next.map((n) => [n.id, n])).values()]);
          if (packedInto && accepted.length) {
            const units = accepted.map((p) => p.id);
            if (carton) await t.update('cartons', carton.id, { units: unique([...carton.units, ...units]) });
            else await t.insert('cartons', { id: packedInto, actor_id: actor.id, units, created_at: at || nowIso() });
          }
          if (newTickets.length) await t.insert('tickets', newTickets);
          if (newSales.length) await t.insert('sales', newSales);
          for (const [id, patch] of ticketUpdates) await t.update('tickets', id, patch);
          // A full-batch recall marks the batch; a precision (machine-scoped) recall does not.
          for (const x of txs) if (x.type === 'BATCH_RECALLED' && x.data.scope !== 'machine') await t.update('batches', x.batch_id, { status: 'recalled' });
        },
      });
    }

    const alerts = await postChecks(type, actor, facility, accepted, rejected, sealed, batches, at);
    if (type === 'RECALL' && accepted.length) notifyRecallCustomers(accepted.map((p) => p.id), data.reason).catch((e) => console.error('[notify]', e.message));
    return {
      ok: accepted.length > 0,
      type,
      block: sealed && { height: sealed.block.id, hash: sealed.block.hash },
      accepted: (sealed?.txs || []).filter((x) => x.product_id && x.type === type).map((x) => ({ product_id: x.product_id, tx_id: x.id })),
      rejected,
      claims,
      tickets: [...newTickets.map((t) => t.id), ...ticketUpdates.keys()],
      alerts: alerts.map((a) => ({ id: a.id, severity: a.severity, type: a.type, message: a.message })),
    };
  });
}

// Anomaly rules that turn ledger activity into actionable alerts.
async function postChecks(type, actor, facility, accepted, rejected, sealed, batches, at) {
  const out = [];
  const push = async (a) => out.push(await raiseAlert({ actor_id: actor.id, ...a, details: { ...a.details, at } }));

  const unknown = rejected.filter((r) => r.code === 'UNKNOWN');
  if (unknown.length) {
    await push({
      severity: 'critical',
      type: 'UNREGISTERED_UNITS',
      facility_id: facility?.id,
      message: `${actor.name} presented ${unknown.length} unit ID(s) that were never minted – likely counterfeit stock in the supply chain`,
      details: { ids: unknown.slice(0, 50).map((r) => r.product_id), count: unknown.length, event: type },
    });
  }
  const role = rejected.filter((r) => r.code === 'ROLE');
  if (role.length) {
    await push({
      severity: type === 'REPACKAGE' ? 'critical' : 'medium',
      type: type === 'REPACKAGE' ? 'TAMPER_ATTEMPT' : 'UNAUTHORIZED_ACTION',
      product_id: role[0].product_id,
      message: type === 'REPACKAGE'
        ? `${actor.name} (${actor.role}) attempted to repackage/relabel ${role.length} unit(s) – blocked`
        : `${actor.name} (${actor.role}) attempted ${EVENT_RULES[type].label} on ${role.length} unit(s) without permission`,
      details: { ids: role.slice(0, 50).map((r) => r.product_id), event: type },
    });
  }
  const custody = rejected.filter((r) => r.code === 'ENTRY');
  if (custody.length) {
    await push({
      severity: 'high',
      type: 'CUSTODY_BREACH',
      product_id: custody[0].product_id,
      facility_id: facility?.id,
      message: `${actor.name} tried to receive ${custody.length} unit(s) not consigned to them`,
      details: { ids: custody.slice(0, 50).map((r) => r.product_id), reasons: [...new Set(custody.map((r) => r.reason))] },
    });
  }
  const blockedSale = rejected.filter((r) => r.code === 'SOLD' && /RECALL|expired|flagged|Cold-chain/i.test(r.reason));
  if (blockedSale.length) {
    await push({
      severity: 'critical',
      type: 'BLOCKED_SALE',
      product_id: blockedSale[0].product_id,
      message: `${actor.name} attempted to sell ${blockedSale.length} recalled/expired/flagged unit(s) – blocked at point of sale`,
      details: { ids: blockedSale.slice(0, 50).map((r) => r.product_id), reasons: [...new Set(blockedSale.map((r) => r.reason))] },
    });
  }
  const seq = rejected.filter((r) => r.code === 'SEQUENCE');
  if (seq.length) {
    await push({
      severity: 'medium',
      type: 'PROCESS_SKIPPED',
      product_id: seq[0].product_id,
      facility_id: facility?.id,
      message: `${actor.name} tried to record a process step out of sequence on ${seq.length} unit(s) – blocked (${seq[0].reason})`,
      details: { ids: seq.slice(0, 50).map((r) => r.product_id) },
    });
  }
  const fakeParts = rejected.filter((r) => r.code === 'PART_UNKNOWN');
  if (fakeParts.length) {
    await push({
      severity: 'critical',
      type: 'COUNTERFEIT_PART',
      product_id: fakeParts[0].product_id,
      facility_id: facility?.id,
      message: `Unregistered component(s) ${fakeParts.map((r) => r.part_id).filter(Boolean).slice(0, 5).join(', ')} presented on the production line – install blocked`,
      details: { ids: fakeParts.map((r) => r.product_id), parts: fakeParts.map((r) => r.part_id) },
    });
  }
  if (!sealed) return out;
  const txs = sealed.txs.filter((x) => x.product_id && x.type === type);

  if (type === 'ENTRY' && txs.some((x) => x.data.unlicensed_facility)) {
    await push({
      severity: 'critical',
      type: 'UNLICENSED_FACILITY',
      facility_id: facility.id,
      batch_id: accepted[0]?.batch_id,
      message: `${txs.length} unit(s) entered unlicensed site "${facility.name}"${facility.city ? `, ${facility.city}` : ''} – units auto-flagged`,
      details: { ids: txs.slice(0, 50).map((x) => x.product_id), dedupe: `unlic:${facility.id}:${sealed.block.id}` },
    });
  }
  const excursions = txs.filter((x) => x.data.excursion);
  if (excursions.length) {
    const b = batches.get(excursions[0].batch_id);
    await push({
      severity: 'high',
      type: 'COLD_CHAIN_EXCURSION',
      batch_id: b?.id,
      facility_id: facility?.id,
      message: `Temperature ${excursions[0].data.temperature_c}°C outside ${b?.attributes?.temp_min_c}–${b?.attributes?.temp_max_c}°C for ${excursions.length} unit(s) of ${b?.name}`,
      details: { ids: excursions.slice(0, 50).map((x) => x.product_id) },
    });
  }
  if (type === 'RECALL') {
    // Step 13: every unit already with a customer becomes a recall case for the retailer that sold it.
    const ts = at || nowIso();
    const notices = accepted
      .filter((p) => p.custodian_id === CONSUMER && !p.attributes?.open_ticket && p.attributes?.sold_by)
      .map((p) => ({ id: newId('TCK', 6), kind: 'recall', product_id: p.id, batch_id: p.batch_id, retailer_id: p.attributes.sold_by, manufacturer_id: p.manufacturer_id, sale_id: null, code: 'RECALL', description: txs[0]?.data?.reason || null, status: 'recall_notice', diagnosis: {}, replacement_id: null, created_at: ts, updated_at: ts }));
    if (notices.length) await ctx.store.insert('tickets', notices);
    for (const bid of unique(accepted.map((p) => p.batch_id))) {
      const units = accepted.filter((p) => p.batch_id === bid);
      const withCustomers = units.filter((p) => p.custodian_id === CONSUMER || p.attributes?.open_ticket).length;
      const scope = txs[0]?.data?.scope === 'machine' ? ` processed on ${txs[0].data.machine_id}` : '';
      await push({
        severity: 'critical',
        type: 'RECALL_ISSUED',
        batch_id: bid,
        message: `Recall issued for ${batches.get(bid)?.name} (${bid}): ${units.length} unit(s)${scope}, ${withCustomers} with customers – ${notices.filter((n) => n.batch_id === bid).length} recall notice(s) sent to retailers`,
        details: { reason: txs[0]?.data?.reason, scope: txs[0]?.data?.scope || 'batch' },
      });
    }
  }
  if (type === 'DEFECT_REPORTED' || type === 'ISSUE_REPORTED') {
    const code = txs[0]?.data?.code;
    if (code && code !== 'RECALL') {
      out.push(...(await defectClusterCheck(code, at)));
      // Step 12 automation: has the same issue been reported before in this batch?
      for (const bid of unique(accepted.map((p) => p.batch_id))) {
        const bt = await backtrace(accepted.find((p) => p.batch_id === bid).id, code);
        if (bt.affected.length >= 2) {
          out.push(await raiseAlert({
            severity: bt.suspect ? 'high' : 'medium',
            type: 'PROCESS_FAULT',
            batch_id: bid,
            actor_id: actor.id,
            message: bt.summary,
            details: { code, affected: bt.affected, suspect: bt.suspect && { process: bt.suspect.process, machine_id: bt.suspect.machine_id }, scope: bt.scope.count, dedupe: `fault:${bid}:${code}`, at },
            refresh: true,
          }));
        }
      }
    }
  }
  return out;
}

/**
 * Detect systemic defects: one defect code concentrating in one component lot, at a much
 * higher rate than alternative lots of the same part. Parts with a single lot (fitted in
 * every unit) cannot discriminate and are skipped, avoiding false positives.
 */
export async function defectClusterCheck(code, at) {
  if (!code) return [];
  const [reports, batches, units] = await Promise.all([
    ctx.store.list('events', { whereIn: { type: ['DEFECT_REPORTED', 'ISSUE_REPORTED'] } }),
    ctx.store.list('batches', { columns: ['id', 'components'] }),
    ctx.store.list('products', { columns: ['batch_id'] }),
  ]);
  const perBatch = new Map();
  for (const u of units) perBatch.set(u.batch_id, (perBatch.get(u.batch_id) || 0) + 1);
  const fleet = new Map();
  const part = new Map();
  for (const b of batches) {
    for (const c of b.components || []) {
      fleet.set(c.batch_id, (fleet.get(c.batch_id) || 0) + (perBatch.get(b.id) || 0));
      part.set(c.batch_id, c.name);
    }
  }
  const same = reports.filter((r) => r.data?.code === code && r.data?.component_lots);
  const hits = new Map();
  for (const r of same) for (const lot of r.data.component_lots || []) hits.set(lot, new Set([...(hits.get(lot) || []), r.product_id]));
  const rate = (lot) => (fleet.get(lot) ? (hits.get(lot)?.size || 0) / fleet.get(lot) : 0);

  const out = [];
  for (const [lot, set] of hits) {
    if (set.size < 3) continue;
    const alternatives = [...fleet.keys()].filter((l) => l !== lot && part.get(l) === part.get(lot));
    if (!alternatives.length) continue;
    const baseline = alternatives.reduce((s, l) => s + rate(l), 0) / alternatives.length;
    if (rate(lot) < Math.max(baseline * 2, 0.02)) continue;
    const rs = same.filter((r) => (r.data.component_lots || []).includes(lot));
    const postUpdate = rs.filter((r) => r.data.days_since_update != null && r.data.days_since_update <= 45).length;
    const ratio = baseline ? `${(rate(lot) / baseline).toFixed(1)}x the rate of other ${part.get(lot).toLowerCase()} lots` : `no reports from other ${part.get(lot).toLowerCase()} lots`;
    out.push(await raiseAlert({
      severity: 'high',
      type: 'DEFECT_CLUSTER',
      batch_id: lot,
      message: `${set.size} "${code}" reports trace to ${part.get(lot).toLowerCase()} lot ${lot} (${Math.round(rate(lot) * 100)}% of units, ${ratio})${postUpdate ? `; ${postUpdate} began within 45 days of a firmware update` : ''}`,
      details: { code, lot, units: set.size, rate: rate(lot), baseline, post_update: postUpdate, dedupe: `cluster:${code}:${lot}`, at },
      refresh: true,
    }));
  }
  return out;
}
