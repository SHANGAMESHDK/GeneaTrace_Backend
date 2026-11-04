import { config } from '../config.js';
import { sha256 } from '../util.js';
import { ctx } from '../context.js';

// GS1 identifiers and EPCIS 2.0 export, so partners can read Geneatrace data in the formats
// their own track-and-trace systems already use.

/** Normalises a GTIN-8/12/13/14 to 14 digits, or returns null if the check digit is wrong. */
export function normalizeGtin(raw) {
  const s = String(raw || '').replace(/\s/g, '');
  if (!/^(\d{8}|\d{12,14})$/.test(s)) return null;
  const g = s.padStart(14, '0');
  const sum = [...g.slice(0, 13)].reduce((n, d, i) => n + Number(d) * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(g[13]) ? g : null;
}

export const digitalLinkPath = (gtin, lot, serial) => `/01/${gtin}/10/${encodeURIComponent(lot)}/21/${encodeURIComponent(serial)}`;

// Business step, disposition and action for each ledger event (GS1 Core Business Vocabulary).
const EPCIS = {
  SERIAL_ISSUED: ['commissioning', 'active', 'ADD'],
  PROCESS_STEP: ['inspecting', 'in_progress', 'OBSERVE'],
  QUALITY_CHECK: ['inspecting', 'in_progress', 'OBSERVE'],
  PRODUCTION_COMPLETE: ['accepting', 'active', 'OBSERVE'],
  PACKED: ['packing', 'in_progress', 'OBSERVE'],
  STORED: ['storing', 'in_progress', 'OBSERVE'],
  EXIT: ['shipping', 'in_transit', 'OBSERVE'],
  DELIVERED: ['arriving', 'in_transit', 'OBSERVE'],
  ENTRY: ['receiving', 'in_progress', 'OBSERVE'],
  SOLD: ['retail_selling', 'retail_sold', 'OBSERVE'],
  RECALL: ['holding', 'recalled', 'OBSERVE'],
  SERVICE: ['repairing', 'in_progress', 'OBSERVE'],
  INSTALLED: ['installing', 'in_progress', 'OBSERVE'],
  UNINSTALLED: ['removing', 'in_progress', 'OBSERVE'],
  DISPOSE: ['destroying', 'destroyed', 'DELETE'],
};

const epcFor = (productId, batch) => {
  const gtin = batch?.attributes?.gtin;
  return gtin ? `https://id.gs1.org/01/${gtin}/21/${encodeURIComponent(productId)}` : `${config.publicAppUrl}/v/${encodeURIComponent(productId)}`;
};

/** Ledger events → EPCIS 2.0 JSON-LD. Customer details are off-chain and never included. */
export function epcisDocument(events, batches) {
  const eventList = events.filter((e) => EPCIS[e.type] && e.product_id).map((e) => {
    const [bizStep, disposition, action] = EPCIS[e.type];
    const location = e.facility_id ? { id: `${config.publicAppUrl}/facility/${e.facility_id}` } : undefined;
    return {
      type: 'ObjectEvent',
      eventTime: e.ts,
      eventTimeZoneOffset: '+00:00',
      eventID: `ni:///sha-256;${sha256(e.id)}?ver=CBV2.0`,
      epcList: [epcFor(e.product_id, batches.get(e.batch_id))],
      action,
      bizStep,
      disposition,
      readPoint: location,
      bizLocation: location,
      'gt:tx': e.id,
      'gt:block': e.block_height,
      'gt:type': e.type,
      'gt:machine': e.data?.machine_id,
    };
  });
  return {
    '@context': ['https://ref.gs1.org/standards/epcis/epcis-context.jsonld', { gt: `${config.publicAppUrl}/epcis/` }],
    type: 'EPCISDocument',
    schemaVersion: '2.0',
    creationDate: new Date().toISOString(),
    epcisBody: { eventList },
  };
}

/** Label data expected on Indian QR-coded medicines; lists what a batch still needs. */
export async function labelCheck(batch) {
  const maker = await ctx.store.get('actors', batch.manufacturer_id);
  const [site] = await ctx.store.list('facilities', { where: { actor_id: batch.manufacturer_id }, limit: 1 });
  const a = batch.attributes || {};
  const fields = {
    unique_product_code: a.gtin,
    brand_name: a.brand_name || batch.name,
    generic_name: a.generic_name,
    manufacturer_name: maker?.name,
    manufacturer_address: site?.address || site?.city,
    batch_number: batch.id,
    manufacturing_date: batch.mfg_date,
    expiry_date: batch.expiry_date,
    manufacturing_licence: maker?.license_no,
  };
  const missing = Object.entries(fields).filter(([, v]) => !v).map(([k]) => k);
  return { fields, missing, ready: missing.length === 0 };
}
