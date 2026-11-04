// Pure reducer: product state is a fold over its ledger events. The same function updates
// the products table at write time and replays the chain at read time, so any direct edit
// of the products table shows up as drift.
//
// Lifecycle:  SERIAL_ISSUED (empty passport, in_production) → PROCESS_STEP × n (machine, process,
// timestamp, installed parts) → PRODUCTION_COMPLETE → PACKED → STORED → EXIT (dispatched) →
// DELIVERED → ENTRY (retailer) → SOLD → [ISSUE_REPORTED → EXIT → ENTRY → DIAGNOSED → SERVICE →
// EXIT → ENTRY → HANDED_OVER] … with RECALL, LOCK/UNLOCK, FLAG/CLEAR possible along the way.

export const STATUS = {
  IN_PRODUCTION: 'in_production',
  IN_STOCK: 'in_stock',
  IN_TRANSIT: 'in_transit',
  SOLD: 'sold',
  RETURNED: 'returned',
  RECALLED: 'recalled',
  FLAGGED: 'flagged',
  QUARANTINED: 'quarantined',
  LOCKED: 'locked',
  INSTALLED: 'installed',
  RETIRED: 'retired',
};

export const CONSUMER = 'CONSUMER';

// Where a unit with no special condition rests, given who holds it.
const restingStatus = (p, a) => (p.custodian_id === CONSUMER ? STATUS.SOLD : a.open_ticket ? STATUS.RETURNED : STATUS.IN_STOCK);

export function applyTx(p, tx) {
  const d = tx.data || {};
  const a = { ...(p.attributes || {}) };
  const next = { ...p, attributes: a, last_tx: tx.id };
  switch (tx.type) {
    case 'SERIAL_ISSUED':
      next.status = STATUS.IN_PRODUCTION;
      next.custodian_id = tx.actor_id;
      next.facility_id = tx.facility_id;
      next.pending_to = null;
      a.serial_no = d.serial_no;
      a.steps = [];
      break;
    case 'MANUFACTURED': // legacy one-shot mint
      next.status = STATUS.IN_STOCK;
      next.custodian_id = tx.actor_id;
      next.facility_id = tx.facility_id;
      next.pending_to = null;
      Object.assign(a, d.attributes || {});
      break;
    case 'PROCESS_STEP':
      a.steps = [...(a.steps || []), { process: d.process, machine_id: d.machine_id, result: d.result || 'pass', at: tx.ts, rework: !!d.rework }];
      if (d.part) a.parts = { ...(a.parts || {}), [d.part.name]: { serial: d.part.id, lot: d.part.lot } };
      if (tx.facility_id) next.facility_id = tx.facility_id;
      break;
    case 'PRODUCTION_COMPLETE':
      next.status = STATUS.IN_STOCK;
      a.produced_at = tx.ts;
      if (d.firmware) a.firmware = d.firmware;
      break;
    case 'INSTALLED': // a component unit consumed into a finished product
      next.status = STATUS.INSTALLED;
      next.facility_id = null;
      a.parent = d.parent_id;
      break;
    case 'UNINSTALLED':
      next.status = STATUS.RETIRED;
      a.removed_from = d.parent_id;
      break;
    case 'QUALITY_CHECK':
      a.qc = d.result;
      if (d.result === 'fail') next.status = STATUS.QUARANTINED;
      break;
    case 'PACKED':
      a.carton = d.carton_id || null;
      a.packed_at = tx.ts;
      break;
    case 'STORED':
      next.facility_id = tx.facility_id;
      a.bin = d.bin || null;
      break;
    case 'EXIT':
      if (next.status !== STATUS.RECALLED && next.status !== STATUS.FLAGGED) next.status = STATUS.IN_TRANSIT;
      next.pending_to = d.to_actor_id;
      next.facility_id = null;
      a.last_exit_facility = tx.facility_id;
      a.dispatched_by = tx.actor_id;
      delete a.delivered_at;
      break;
    case 'DELIVERED':
      a.delivered_at = tx.ts;
      a.pod = d.received_by || null;
      break;
    case 'ENTRY':
      next.custodian_id = tx.actor_id;
      next.facility_id = tx.facility_id;
      next.pending_to = null;
      if (d.unlicensed_facility) next.status = STATUS.FLAGGED;
      else if (p.status === STATUS.RECALLED || p.status === STATUS.FLAGGED) next.status = p.status;
      else next.status = restingStatus(next, a);
      break;
    case 'CHECKPOINT':
      if (d.temperature_c != null) a.last_temperature_c = d.temperature_c;
      if (d.excursion) a.cold_chain_breach = true;
      break;
    case 'SOLD':
      next.status = STATUS.SOLD;
      next.sold_at = tx.ts;
      next.custodian_id = CONSUMER;
      next.facility_id = null;
      if (d.warranty_until) a.warranty_until = d.warranty_until;
      a.sold_by = tx.actor_id;
      if (d.customer_ref) a.customer_ref = d.customer_ref;
      break;
    case 'ISSUE_REPORTED': // customer brings the unit back to the retailer
      next.custodian_id = tx.actor_id;
      next.facility_id = tx.facility_id;
      if (next.status !== STATUS.RECALLED) next.status = STATUS.RETURNED;
      a.open_ticket = d.ticket_id;
      a.issues = [...(a.issues || []), d.code];
      break;
    case 'DIAGNOSED':
      a.diagnosis = { process: d.process || null, machine_id: d.machine_id || null, finding: d.finding, action: d.action || 'repair' };
      break;
    case 'REPLACEMENT_ASSIGNED': // a fresh unit is earmarked to replace a customer's unit
      a.open_ticket = d.ticket_id;
      a.replaces = d.replaces;
      break;
    case 'HANDED_OVER':
      next.status = a.locked ? STATUS.LOCKED : STATUS.SOLD;
      next.custodian_id = CONSUMER;
      next.facility_id = null;
      if (!next.sold_at) next.sold_at = tx.ts;
      if (d.customer_ref) a.customer_ref = d.customer_ref;
      if (d.warranty_until) a.warranty_until = d.warranty_until;
      delete a.open_ticket;
      break;
    case 'FIRMWARE_UPDATE':
      a.firmware = d.version;
      a.firmware_updated_at = tx.ts;
      break;
    case 'SERVICE':
      if (d.physical_damage || d.liquid_damage) a.damage = true;
      if (d.replaced?.length) {
        a.replacements = [...(a.replacements || []), ...d.replaced.map((r) => ({ ...r, at: tx.ts }))];
        a.serviced_at = tx.ts;
        a.parts = { ...(a.parts || {}) };
        for (const r of d.replaced) if (r.new_part_id) a.parts[r.name] = { serial: r.new_part_id, lot: r.to_batch || null };
      }
      if (d.remedy && next.status === STATUS.RECALLED) {
        a.recall_remedied_at = tx.ts;
        next.status = restingStatus(next, a);
      }
      break;
    case 'DEFECT_REPORTED':
      a.defects = [...(a.defects || []), d.code];
      break;
    case 'WARRANTY_CLAIM':
      a.claims = [...(a.claims || []), { program_id: d.program_id || null, eligible: !!d.eligible, at: tx.ts }];
      break;
    case 'RECALL':
      next.status = STATUS.RECALLED;
      a.recall_reason = d.reason;
      delete a.recall_remedied_at;
      break;
    case 'FLAG':
      next.status = STATUS.FLAGGED;
      a.flag_reason = d.reason;
      break;
    case 'CLEAR':
      next.status = d.restore_status || restingStatus(next, a);
      delete a.flag_reason;
      delete a.cold_chain_breach;
      break;
    case 'LOCK': // device check-in found a counterfeit part
      next.status = STATUS.LOCKED;
      a.locked = true;
      a.lock_reason = d.reason;
      a.locked_at = tx.ts;
      break;
    case 'NFC_BOUND':
      a.nfc_uid = d.uid;
      break;
    case 'PART_WARNING': // same finding under a warn-only policy: recorded, device keeps working
      a.part_warning = d.reason;
      break;
    case 'UNLOCK':
      delete a.locked;
      delete a.lock_reason;
      next.status = restingStatus(next, a);
      break;
    case 'REPACKAGE':
      a.repackaged = [...(a.repackaged || []), { at: tx.ts, note: d.note || null }];
      break;
    case 'DISPOSE':
      next.status = STATUS.RETIRED;
      next.facility_id = null;
      delete a.open_ticket;
      break;
    default:
      break;
  }
  return next;
}

export function replay(baseProduct, events) {
  let p = { ...baseProduct, status: null, custodian_id: null, facility_id: null, pending_to: null, sold_at: null, attributes: {} };
  for (const e of events) p = applyTx(p, e);
  return p;
}
