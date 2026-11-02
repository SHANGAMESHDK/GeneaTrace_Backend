// Seeds a realistic network and replays the complete GeneaTrace workflow:
//
//  PHONE (batch AAA, "Nova A55 5G")                     MEDICINE (batch MRC, "Merocare 1 g")
//   1-3  batch assigned, empty cryptographic serials     same
//   4-6  every process scanned: time + machine + part    7-step sterile route, two autoclaves
//   7    packed → warehouse → dispatched → delivered      cold store, distributor, pharmacy/hospital
//   8-9  retailer receives, sells with customer details   pharmacy dispenses with patient details
//   10-11 customer issue → retailer → manufacturer        patient reaction → pharmacy → manufacturer
//   12   backtrace pins laminator LAM-02                  backtrace pins autoclave AC-02
//   13   precision recall of LAM-02 units + notices       precision recall of AC-02 vials + notices
//   14-15 repaired unit back to retailer → customer       replacement vial → pharmacy → patient
//   +    third-party fake display → device LOCK            + counterfeit / diversion / cold-chain cases
//
// Usage: npm run seed            (refuses if the ledger already has members)
import { boot } from '../lib/boot.js';
import { ctx } from '../lib/context.js';
import { DEMO_ACCOUNTS } from '../lib/demo.js';
import { createActor, createFacility } from '../lib/services/network.js';
import { createBatch } from '../lib/services/catalog.js';
import { recordEvents } from '../lib/services/events.js';
import { createProgram } from '../lib/services/warranty.js';
import { createMachine } from '../lib/services/production.js';
import { scan } from '../lib/services/passport.js';
import { simulateCheckin } from '../lib/services/device.js';

const DAY = 86400e3;
const T = (daysAgo, hour = 10) => {
  const d = new Date(Date.now() - daysAgo * DAY);
  d.setUTCHours(hour, Math.floor(Math.random() * 60), 0, 0);
  return d.toISOString();
};
const dateOnly = (daysFromNow) => new Date(Date.now() + daysFromNow * DAY).toISOString().slice(0, 10);
const step = (msg) => console.log(`  • ${msg}`);

// daysAgo = null → recorded now
async function ev(actor, input, daysAgo, hour) {
  const r = await recordEvents(actor, input, { at: daysAgo == null ? undefined : T(daysAgo, hour) });
  if (r.rejected.length && !input.expectReject) console.warn(`    ! ${r.rejected.length} rejected for ${input.type}: ${r.rejected[0].reason}`);
  return r;
}
const pick = (arr, idx) => idx.map((i) => arr[i]);
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
const CUSTOMERS = ['Aarav Sharma', 'Diya Patel', 'Vihaan Reddy', 'Ananya Iyer', 'Arjun Nair', 'Ishita Gupta', 'Kabir Singh', 'Meera Pillai', 'Rohan Das', 'Sara Khan', 'Aditya Rao', 'Kavya Menon', 'Nikhil Joshi', 'Priya Kumar', 'Rahul Verma', 'Sneha Bose', 'Tanvi Shah', 'Varun Mehta', 'Zara Ali', 'Yash Kulkarni'];
const customer = (i) => ({ name: CUSTOMERS[i % CUSTOMERS.length], phone: `98${String(45000000 + i * 7919).slice(0, 8)}` });

await boot({ worker: false });
const members = await ctx.store.count('actors');
if (members > 1) {
  console.log(`Ledger already has ${members} members – skipping seed. Use "npm run reset -- --yes" first for a clean demo.`);
  process.exit(0);
}
console.log(`Seeding GeneaTrace (${ctx.store.kind} store)…`);
const admin = await ctx.store.get('actors', 'ACT-ADMIN');

// ── network ────────────────────────────────────────────────────────────────
const A = {};
for (const acc of DEMO_ACCOUNTS) A[acc.id] = (await createActor(admin, acc, { apiKey: acc.key, id: acc.id, at: T(95) })).actor;
const rogue = (await createActor(admin, { name: 'QuickMed Traders', role: 'distributor', org: 'Sub-distributor' }, { id: 'ACT-QMED01', at: T(50) })).actor;
const nova = A['ACT-NOVA01'];
const lumina = A['ACT-LUMI01'];
const retail = A['ACT-RETL01'];
const service = A['ACT-SERV01'];
const logi = A['ACT-LOGI01'];
const pharma = A['ACT-PHRM01'];
const dist = A['ACT-DIST01'];
const pharmacy = A['ACT-PHAR01'];
const hosp = A['ACT-HOSP01'];
const reg = A['ACT-REGL01'];

const fac = (owner, f) => createFacility(admin, { ...f, actor_id: owner.id }, { at: T(94) });
const F = {
  novaPlant: await fac(nova, { name: 'Nova Mobile Assembly Plant', type: 'factory', city: 'Sriperumbudur', lat: 12.9675, lng: 79.9419, license_no: 'TN-EL-30411' }),
  novaWh: await fac(nova, { name: 'Nova Finished Goods Warehouse', type: 'warehouse', city: 'Oragadam', lat: 12.8321, lng: 79.9437 }),
  luminaFab: await fac(lumina, { name: 'Lumina AMOLED Fab 2', type: 'factory', city: 'Noida', lat: 28.5355, lng: 77.391, license_no: 'UP-EL-77310' }),
  digitalHub: await fac(retail, { name: 'Digital Hub – Koramangala', type: 'store', city: 'Koramangala, Bengaluru', lat: 12.9352, lng: 77.6245 }),
  novaCare: await fac(service, { name: 'Nova Care – Indiranagar', type: 'service_center', city: 'Indiranagar, Bengaluru', lat: 12.9784, lng: 77.6408 }),
  swiftHub: await fac(logi, { name: 'SwiftRoute Transit Hub', type: 'transit_hub', city: 'Hosur', lat: 12.7409, lng: 77.8253 }),
  pharmaPlant: await fac(pharma, { name: 'Sanjeevani Sterile Injectables Plant', type: 'factory', city: 'Peenya, Bengaluru', lat: 13.0285, lng: 77.5197, license_no: 'KA-MFG-22781' }),
  pharmaCold: await fac(pharma, { name: 'Sanjeevani Cold Store', type: 'cold_storage', city: 'Peenya, Bengaluru', lat: 13.031, lng: 77.523, license_no: 'KA-CS-22782' }),
  medlinkWh: await fac(dist, { name: 'MedLink Cold Storage Hub', type: 'cold_storage', city: 'Yeshwanthpur, Bengaluru', lat: 13.028, lng: 77.5409, license_no: 'KA-WS-90121' }),
  carePlus: await fac(pharmacy, { name: 'CarePlus Pharmacy – Jayanagar', type: 'pharmacy', city: 'Jayanagar, Bengaluru', lat: 12.925, lng: 77.5938, license_no: 'KA-RP-55190' }),
  hospital: await fac(hosp, { name: 'City General Hospital Pharmacy', type: 'hospital', city: 'Central Bengaluru', lat: 12.9716, lng: 77.5946, license_no: 'KA-HP-10042' }),
};
F.bidadi = await createFacility(rogue, { name: 'QuickMed Godown', type: 'warehouse', city: 'Bidadi, Ramanagara', lat: 12.7969, lng: 77.3836 }, { at: T(49) });

const machine = (owner, facility, id, name, processes) => createMachine(owner, { id, name, facility_id: facility.id, processes }, { at: T(93) });
const ELEC = ['SMT & PCB assembly', 'Display lamination', 'Battery install', 'Final assembly', 'Software flash', 'Final QC'];
await machine(nova, F.novaPlant, 'SMT-01', 'SMT line 1', [ELEC[0]]);
await machine(nova, F.novaPlant, 'LAM-01', 'Display laminator 1', [ELEC[1]]);
await machine(nova, F.novaPlant, 'LAM-02', 'Display laminator 2', [ELEC[1]]);
await machine(nova, F.novaPlant, 'BAT-01', 'Battery cell station', [ELEC[2]]);
await machine(nova, F.novaPlant, 'ASM-01', 'Final assembly cell', [ELEC[3]]);
await machine(nova, F.novaPlant, 'FLS-01', 'Firmware flash rig', [ELEC[4]]);
await machine(nova, F.novaPlant, 'QC-01', 'End-of-line tester', [ELEC[5]]);
const MED = ['API dispensing', 'Compounding', 'Aseptic filling', 'Stoppering & sealing', 'Terminal sterilization', 'Visual inspection', 'Labelling & serialisation'];
await machine(pharma, F.pharmaPlant, 'DSP-01', 'API dispensing booth', [MED[0]]);
await machine(pharma, F.pharmaPlant, 'CMP-01', 'Compounding vessel', [MED[1]]);
await machine(pharma, F.pharmaPlant, 'FIL-01', 'Aseptic vial filler', [MED[2]]);
await machine(pharma, F.pharmaPlant, 'SEL-01', 'Stoppering & crimping line', [MED[3]]);
await machine(pharma, F.pharmaPlant, 'AC-01', 'Autoclave 1', [MED[4]]);
await machine(pharma, F.pharmaPlant, 'AC-02', 'Autoclave 2', [MED[4]]);
await machine(pharma, F.pharmaPlant, 'VIS-01', 'Visual inspection station', [MED[5]]);
await machine(pharma, F.pharmaPlant, 'LBL-01', 'Labelling & serialisation', [MED[6]]);
step('Network: 13 members, 12 facilities (1 unlicensed), 15 registered machines');

// ═════════════════════════════ PHONE: batch AAA ═════════════════════════════
// Genuine components first: display panels from Lumina, batteries from Nova's own line.
const panelsB = await createBatch(lumina, { id: 'PNL-A7', sku: 'LDC-AMOLED-66', name: '6.6" AMOLED display panel – lot A7', category: 'component', quantity: 5000, mint: 40, facility_id: F.luminaFab.id }, { at: T(66, 5) });
const PNL = panelsB.minted.map((u) => u.id);
await ev(lumina, { type: 'PRODUCTION_COMPLETE', product_ids: PNL, facility_id: F.luminaFab.id }, 65);
await ev(lumina, { type: 'EXIT', product_ids: PNL, facility_id: F.luminaFab.id, to_actor_id: nova.id }, 64);
await ev(nova, { type: 'ENTRY', product_ids: PNL, facility_id: F.novaPlant.id }, 62);
const batB = await createBatch(nova, { id: 'BAT-51', sku: 'NV-BAT-5000', name: '5000 mAh Li-ion battery – lot 51', category: 'component', quantity: 8000, mint: 30, facility_id: F.novaPlant.id }, { at: T(63, 5) });
const BAT = batB.minted.map((u) => u.id);
await ev(nova, { type: 'PRODUCTION_COMPLETE', product_ids: BAT, facility_id: F.novaPlant.id }, 62);

// Steps 1–3: batch AAA, empty cryptographic serials
const phoneB = await createBatch(nova, {
  id: 'AAA', sku: 'NV-A55', name: 'Nova A55 5G', category: 'electronics', quantity: 1000, mint: 24, facility_id: F.novaPlant.id,
  process_route: ELEC, attributes: { firmware: 'NovaOS 14.0.0', warranty_months: 12, ram: '8 GB', storage: '128 GB', color: 'Awesome Navy' },
  components: [{ batch_id: 'PNL-A7', name: 'Display panel' }, { batch_id: 'BAT-51', name: 'Battery' }],
}, { at: T(60, 6) });
const P = phoneB.minted.map((u) => u.id);
step(`Steps 1-3: batch AAA → ${P.length} empty serials, e.g. ${P[0]}`);

// Steps 4–6: every process scanned at its machine
const even = P.filter((_, i) => i % 2 === 0);
const odd = P.filter((_, i) => i % 2 === 1);
await ev(nova, { type: 'PROCESS_STEP', product_ids: [P[5]], data: { process: 'Final assembly', machine_id: 'ASM-01' }, expectReject: true }, 59, 7);
await ev(nova, { type: 'PROCESS_STEP', product_ids: P, data: { process: ELEC[0], machine_id: 'SMT-01', operator: 'Line A' } }, 59, 8);
await ev(nova, { type: 'PROCESS_STEP', product_ids: [P[7]], part_ids: ['LDC-GREY-00417'], data: { process: ELEC[1], machine_id: 'LAM-01' }, expectReject: true }, 59, 9);
await ev(nova, { type: 'PROCESS_STEP', product_ids: even, part_ids: PNL.slice(0, 12), data: { process: ELEC[1], machine_id: 'LAM-02', pressure_kpa: 182 } }, 59, 10);
await ev(nova, { type: 'PROCESS_STEP', product_ids: odd, part_ids: PNL.slice(12, 24), data: { process: ELEC[1], machine_id: 'LAM-01', pressure_kpa: 210 } }, 59, 11);
await ev(nova, { type: 'PROCESS_STEP', product_ids: P, part_ids: BAT.slice(0, 24), data: { process: ELEC[2], machine_id: 'BAT-01' } }, 58, 8);
await ev(nova, { type: 'PROCESS_STEP', product_ids: P, data: { process: ELEC[3], machine_id: 'ASM-01' } }, 58, 10);
await ev(nova, { type: 'PROCESS_STEP', product_ids: P, data: { process: ELEC[4], machine_id: 'FLS-01', image: 'NovaOS 14.0.0' } }, 58, 12);
await ev(nova, { type: 'PROCESS_STEP', product_ids: [P[9]], data: { process: ELEC[5], machine_id: 'QC-01', result: 'fail', note: 'RF calibration out of tolerance' } }, 58, 14);
await ev(nova, { type: 'PROCESS_STEP', product_ids: P, data: { process: ELEC[5], machine_id: 'QC-01', rework: false } }, 58, 16);
await ev(nova, { type: 'PRODUCTION_COMPLETE', product_ids: P, facility_id: F.novaPlant.id }, 57);
step('Steps 4-6: 6 processes × 24 units scanned with machine IDs; skipped step and fake panel blocked; 1 QC fail reworked');

// Step 7: logistics
await ev(nova, { type: 'PACKED', product_ids: P.slice(0, 12), data: { carton_id: 'CTN-AAA-001' } }, 56, 8);
await ev(nova, { type: 'PACKED', product_ids: P.slice(12), data: { carton_id: 'CTN-AAA-002' } }, 56, 9);
await ev(nova, { type: 'STORED', product_ids: P, facility_id: F.novaWh.id, data: { bin: 'FG-R4-B2' } }, 56, 15);
await ev(nova, { type: 'EXIT', product_ids: P, facility_id: F.novaWh.id, to_actor_id: retail.id, data: { invoice: 'NV-INV-20511', vehicle: 'TN-09-CX-2211' } }, 55, 7);
await ev(logi, { type: 'CHECKPOINT', product_ids: P, facility_id: F.swiftHub.id, data: { seal: 'intact' } }, 55, 15);
await ev(nova, { type: 'DELIVERED', product_ids: P, data: { received_by: 'Store manager, Digital Hub' } }, 54, 11);
// Step 8: retail takes over
await ev(retail, { type: 'ENTRY', product_ids: P, facility_id: F.digitalHub.id }, 54, 12);
step('Step 7-8: packed → warehouse → dispatched → delivered → received by Digital Hub');

// Step 9: sales with customer details (off-chain)
for (let i = 0; i < 20; i++) await ev(retail, { type: 'SOLD', product_ids: [P[i]], facility_id: F.digitalHub.id, customer: customer(i), data: { invoice: `DH-${7100 + i}` } }, 50 - i, 12);
await ev(nova, { type: 'FIRMWARE_UPDATE', product_ids: P.slice(0, 20), data: { version: 'NovaOS 14.0.2', channel: 'OTA' } }, 25, 4);
step('Step 9: 20 phones sold with customer details stored off-chain');

// Steps 10–12: customer issues → retailer → manufacturer → backtrace
const issue = (id, d, desc) => ev(retail, { type: 'ISSUE_REPORTED', product_ids: [id], facility_id: F.digitalHub.id, data: { code: 'DISPLAY_GREEN_LINE', description: desc } }, d, 13);
await issue(P[0], 20, 'Thin vertical green line appeared on the display');
await ev(retail, { type: 'EXIT', product_ids: [P[0]], facility_id: F.digitalHub.id, to_actor_id: nova.id }, 19, 9);
await ev(nova, { type: 'ENTRY', product_ids: [P[0]], facility_id: F.novaPlant.id }, 18, 10);
await issue(P[2], 18, 'Green line at the left edge');
await ev(retail, { type: 'EXIT', product_ids: [P[2]], facility_id: F.digitalHub.id, to_actor_id: nova.id }, 17, 9);
await ev(nova, { type: 'ENTRY', product_ids: [P[2]], facility_id: F.novaPlant.id }, 16, 10);
await issue(P[4], 16, 'Display shows a green stripe after a drop-free week');
await ev(nova, { type: 'DIAGNOSED', product_ids: [P[0]], data: { process: 'Display lamination', machine_id: 'LAM-02', finding: 'LAM-02 under-pressure (182 kPa vs 210 spec) caused panel delamination → green line', action: 'repair' } }, 15, 11);
step('Steps 10-12: 3 green-line returns; backtrace pins Display lamination on LAM-02');

// Step 13: precision recall of the 12 units laminated on LAM-02
const r13 = await ev(nova, { type: 'RECALL', product_ids: even, data: { reason: 'Display lamination fault on LAM-02 – free display replacement', scope: 'machine', machine_id: 'LAM-02', process: 'Display lamination' } }, 14, 9);
await ev(retail, { type: 'EXIT', product_ids: pick(P, [20, 22]), facility_id: F.digitalHub.id, to_actor_id: nova.id }, 13, 10);
await ev(nova, { type: 'ENTRY', product_ids: pick(P, [20, 22]), facility_id: F.novaWh.id }, 12, 10);
const notice6 = (await ctx.store.list('tickets', { where: { product_id: P[6], kind: 'recall' } }))[0];
await ev(retail, { type: 'ISSUE_REPORTED', product_ids: [P[6]], facility_id: F.digitalHub.id, data: { code: 'RECALL', ticket_id: notice6.id, description: 'Collected under recall' } }, 12, 15);
step(`Step 13: ${r13.accepted.length} LAM-02 units recalled (LAM-01 units untouched); recall notices sent to the retailer`);

// Steps 14–15: repaired unit back to the same retailer and customer
await ev(nova, { type: 'SERVICE', product_ids: [P[0]], facility_id: F.novaPlant.id, data: { action: 'Display re-laminated with new panel (recall remedy)', remedy: true, replaced: [{ name: 'Display panel', from_batch: 'PNL-A7', new_part_id: PNL[24] }] } }, 12, 11);
await ev(nova, { type: 'EXIT', product_ids: [P[0]], facility_id: F.novaPlant.id, to_actor_id: retail.id }, 11, 9);
await ev(retail, { type: 'ENTRY', product_ids: [P[0]], facility_id: F.digitalHub.id }, 10, 11);
await ev(retail, { type: 'HANDED_OVER', product_ids: [P[0]], facility_id: F.digitalHub.id, data: { note: 'Customer called and collected' } }, 9, 17);
// P2: repaired and on its way back; P4: still at the retailer, ready to send
await ev(nova, { type: 'DIAGNOSED', product_ids: [P[2]], data: { process: 'Display lamination', machine_id: 'LAM-02', finding: 'Same LAM-02 delamination', action: 'repair' } }, 12, 14);
await ev(nova, { type: 'SERVICE', product_ids: [P[2]], facility_id: F.novaPlant.id, data: { action: 'Display replaced (recall remedy)', remedy: true, replaced: [{ name: 'Display panel', new_part_id: PNL[25] }] } }, 11, 11);
await ev(nova, { type: 'EXIT', product_ids: [P[2]], facility_id: F.novaPlant.id, to_actor_id: retail.id }, 1, 9);
step('Steps 14-15: first unit repaired → same retailer → handed to its customer; others in progress');

await createProgram(nova, {
  name: 'Display Care – LAM-02 units', description: 'Free display replacement for Nova A55 units laminated on LAM-02.', coverage: 'Free display replacement (one-time)',
  criteria: { skus: ['NV-A55'], defect_codes: ['DISPLAY_GREEN_LINE'], exclude_damage: true, one_time: true },
}, { at: T(14, 10) });

// Third-party repair with a fake part → device locks on next internet connection
await ev(nova, { type: 'EXIT', product_ids: PNL.slice(30, 34), facility_id: F.novaPlant.id, to_actor_id: service.id }, 20);
await ev(service, { type: 'ENTRY', product_ids: PNL.slice(30, 34), facility_id: F.novaCare.id }, 19);
await simulateCheckin(P[1], { 'Display panel': 'TP-FAKE-0099' });
await ev(service, { type: 'SERVICE', product_ids: [P[1]], facility_id: F.novaCare.id, data: { action: 'Fake display removed, genuine panel installed', replaced: [{ name: 'Display panel', new_part_id: PNL[30] }] } });
await ev(service, { type: 'UNLOCK', product_ids: [P[1]], data: { reason: 'Genuine display restored at authorised centre' } });
await simulateCheckin(P[3], { Battery: 'NONAME-BAT-7781' });
step('Device lock: fake display → locked → authorised repair → unlocked; a fake-battery phone stays locked');

// ═══════════════════════════ MEDICINE: batch MRC ════════════════════════════
const medAttrs = { strength: '1 g / vial', form: 'Powder for injection', schedule: 'H', mrp_inr: 1850, temp_min_c: 2, temp_max_c: 25, storage: 'Store below 25°C' };
const mrc = await createBatch(pharma, { id: 'MRC', sku: 'MEROCARE-1G', name: 'Merocare 1 g (Meropenem for Injection)', category: 'medicine', quantity: 15000, mint: 40, facility_id: F.pharmaPlant.id, mfg_date: dateOnly(-48), expiry_date: dateOnly(680), process_route: MED, attributes: medAttrs }, { at: T(48, 5) });
const V = mrc.minted.map((u) => u.id);
const mrd = await createBatch(pharma, { id: 'MRD', sku: 'MEROCARE-1G', name: 'Merocare 1 g (Meropenem for Injection)', category: 'medicine', quantity: 15000, mint: 10, facility_id: F.pharmaPlant.id, mfg_date: dateOnly(-30), expiry_date: dateOnly(700), process_route: MED, attributes: medAttrs }, { at: T(30, 5) });
const S = mrd.minted.map((u) => u.id);
const runMed = async (ids, d, autoclave) => {
  await ev(pharma, { type: 'PROCESS_STEP', product_ids: ids, data: { process: MED[0], machine_id: 'DSP-01', api_lot: 'API-MERO-L12' } }, d, 6);
  await ev(pharma, { type: 'PROCESS_STEP', product_ids: ids, data: { process: MED[1], machine_id: 'CMP-01' } }, d, 7);
  await ev(pharma, { type: 'PROCESS_STEP', product_ids: ids, data: { process: MED[2], machine_id: 'FIL-01' } }, d, 8);
  await ev(pharma, { type: 'PROCESS_STEP', product_ids: ids, data: { process: MED[3], machine_id: 'SEL-01' } }, d, 9);
  for (const [ac, set] of Object.entries(autoclave)) await ev(pharma, { type: 'PROCESS_STEP', product_ids: set, data: { process: MED[4], machine_id: ac, cycle_temp_c: ac === 'AC-02' ? 116.5 : 121.2, cycle_min: 15 } }, d, 11);
  await ev(pharma, { type: 'PROCESS_STEP', product_ids: ids, data: { process: MED[5], machine_id: 'VIS-01' } }, d, 13);
  await ev(pharma, { type: 'PROCESS_STEP', product_ids: ids, data: { process: MED[6], machine_id: 'LBL-01' } }, d, 14);
  await ev(pharma, { type: 'PRODUCTION_COMPLETE', product_ids: ids, facility_id: F.pharmaPlant.id }, d - 1, 8);
};
await runMed(V, 47, { 'AC-01': V.slice(0, 20), 'AC-02': V.slice(20) });
await runMed(S, 29, { 'AC-01': S });
await ev(pharma, { type: 'PACKED', product_ids: V, data: { carton_id: 'SHP-MRC-01' } }, 45, 8);
await ev(pharma, { type: 'STORED', product_ids: V, facility_id: F.pharmaCold.id, data: { bin: 'CS-2-07' } }, 45, 10);
await ev(pharma, { type: 'STORED', product_ids: S, facility_id: F.pharmaCold.id, data: { bin: 'CS-2-08' } }, 27, 10);
step('Medicine steps 1-6: MRC (40 vials) and MRD (10 vials), 7 sterile processes each; MRC split across AC-01/AC-02');

await ev(pharma, { type: 'EXIT', product_ids: V, facility_id: F.pharmaCold.id, to_actor_id: dist.id, data: { invoice: 'INV-SP-88213' } }, 40, 8);
await ev(logi, { type: 'CHECKPOINT', product_ids: V, facility_id: F.swiftHub.id, data: { temperature_c: 18.4, seal: 'intact' } }, 40, 13);
await ev(pharma, { type: 'DELIVERED', product_ids: V, data: { received_by: 'MedLink GRN desk' } }, 39, 8);
await ev(dist, { type: 'ENTRY', product_ids: V, facility_id: F.medlinkWh.id, data: { temperature_c: 6.1 } }, 39, 9);
const toPharmacy = pick(V, [...range(0, 10), ...range(20, 30)]);
const toHospital = pick(V, [...range(10, 15), ...range(30, 35)]);
await ev(dist, { type: 'EXIT', product_ids: toPharmacy, facility_id: F.medlinkWh.id, to_actor_id: pharmacy.id }, 33, 8);
await ev(dist, { type: 'DELIVERED', product_ids: toPharmacy, data: { received_by: 'Pharmacist on duty' } }, 33, 13);
await ev(pharmacy, { type: 'ENTRY', product_ids: toPharmacy, facility_id: F.carePlus.id, data: { temperature_c: 21 } }, 33, 15);
await ev(dist, { type: 'EXIT', product_ids: toHospital, facility_id: F.medlinkWh.id, to_actor_id: hosp.id, data: { po: 'CGH-PO-5512' } }, 31, 8);
await ev(logi, { type: 'CHECKPOINT', product_ids: pick(V, [13, 14]), lat: 12.95, lng: 77.57, data: { temperature_c: 31.5, note: 'Reefer failure on route' } }, 31, 12);
await ev(hosp, { type: 'ENTRY', product_ids: toHospital, facility_id: F.hospital.id, data: { temperature_c: 24 } }, 31, 16);
step('Medicine step 7-8: cold store → MedLink → CarePlus pharmacy and City General Hospital');

// Counterfeit / diversion scenario (unlicensed repacker near Bidadi)
await ev(dist, { type: 'EXIT', product_ids: pick(V, [15, 16, 17, 18, 19]), facility_id: F.medlinkWh.id, to_actor_id: rogue.id }, 26, 9);
await ev(rogue, { type: 'ENTRY', product_ids: pick(V, [15, 16, 17, 18, 19]), facility_id: F.bidadi.id }, 26, 17);
await ev(rogue, { type: 'REPACKAGE', product_ids: pick(V, [15, 16, 17, 18, 19]), facility_id: F.bidadi.id, data: { note: 'relabel as branded stock' }, expectReject: true }, 24, 22);
await ev(rogue, { type: 'EXIT', product_ids: pick(V, [15, 16]), facility_id: F.bidadi.id, to_actor_id: hosp.id, expectReject: true }, 23, 9);
const fakeIds = ['MRC48201937', 'MRC48201938', 'MRC48201939', 'MRC48201940', 'MRC48201941', 'MRC48201942'];
await ev(hosp, { type: 'ENTRY', product_ids: fakeIds, facility_id: F.hospital.id, data: { supplier: 'walk-in supplier' }, expectReject: true }, 22, 11);
await ev(dist, { type: 'EXIT', product_ids: pick(V, [35, 36]), facility_id: F.medlinkWh.id, to_actor_id: hosp.id }, 21, 8);
await ev(pharmacy, { type: 'ENTRY', product_ids: pick(V, [35, 36]), facility_id: F.carePlus.id, expectReject: true }, 21, 12);
await ev(hosp, { type: 'ENTRY', product_ids: pick(V, [35, 36]), facility_id: F.hospital.id }, 21, 15);
step('Counterfeit cases: diversion to unlicensed Bidadi site flagged, relabel blocked, 6 fake serials rejected, custody breach caught');

// Step 9: dispensing with patient details
for (const [n, i] of [...range(0, 6), ...range(20, 26)].entries()) await ev(pharmacy, { type: 'SOLD', product_ids: [V[i]], facility_id: F.carePlus.id, customer: customer(n + 3), data: { invoice: `RX-${4400 + n}` } }, 30 - n, 11);
for (const [n, i] of [10, 11, 12, 30, 31, 32].entries()) await ev(hosp, { type: 'SOLD', product_ids: [V[i]], facility_id: F.hospital.id, customer: { name: `Inpatient ICU-${210 + n}` }, data: { ward: 'ICU', administered: true } }, 29 - n, 9);
await ev(hosp, { type: 'SOLD', product_ids: [V[13]], facility_id: F.hospital.id, expectReject: true }, 3, 9);
step('Medicine step 9: 12 vials dispensed and 6 administered with patient details (off-chain); cold-chain vial blocked');

// Steps 10–12: adverse reactions → pharmacy → manufacturer → backtrace
await ev(pharmacy, { type: 'ISSUE_REPORTED', product_ids: [V[20]], facility_id: F.carePlus.id, data: { code: 'PARTICULATE_MATTER', description: 'Visible particles after reconstitution; patient reported reaction' } }, 15, 10);
await ev(pharmacy, { type: 'ISSUE_REPORTED', product_ids: [V[21]], facility_id: F.carePlus.id, data: { code: 'PARTICULATE_MATTER', description: 'Cloudy solution' } }, 14, 12);
await ev(hosp, { type: 'ISSUE_REPORTED', product_ids: [V[30]], facility_id: F.hospital.id, data: { code: 'PARTICULATE_MATTER', description: 'Particles seen by ICU nurse' } }, 13, 9);
await ev(pharmacy, { type: 'EXIT', product_ids: [V[20]], facility_id: F.carePlus.id, to_actor_id: pharma.id }, 14, 16);
await ev(pharma, { type: 'ENTRY', product_ids: [V[20]], facility_id: F.pharmaPlant.id }, 13, 10);
await ev(pharma, { type: 'DIAGNOSED', product_ids: [V[20]], data: { process: 'Terminal sterilization', machine_id: 'AC-02', finding: 'AC-02 cycle at 116.5°C (spec 121°C): incomplete sterilization', action: 'replace', replacement_id: S[0] } }, 12, 11);
step('Medicine steps 10-12: 3 particulate reports; backtrace pins Terminal sterilization on AC-02');

// Step 13: precision recall of AC-02 vials
const r13m = await ev(pharma, { type: 'RECALL', product_ids: V.slice(20), data: { reason: 'Terminal sterilization fault on autoclave AC-02', scope: 'machine', machine_id: 'AC-02', process: 'Terminal sterilization' } }, 12, 15);
await ev(dist, { type: 'EXIT', product_ids: V.slice(37), facility_id: F.medlinkWh.id, to_actor_id: pharma.id }, 11, 9);
await ev(pharma, { type: 'ENTRY', product_ids: V.slice(37), facility_id: F.pharmaPlant.id }, 10, 9);
// Steps 14–15: replacement vial to the same pharmacy → patient
await ev(pharma, { type: 'EXIT', product_ids: [S[0]], facility_id: F.pharmaCold.id, to_actor_id: pharmacy.id }, 11, 14);
await ev(pharmacy, { type: 'ENTRY', product_ids: [S[0]], facility_id: F.carePlus.id }, 10, 11);
await ev(pharmacy, { type: 'HANDED_OVER', product_ids: [S[0]], facility_id: F.carePlus.id, data: { note: 'Patient contacted, replacement dispensed' } }, 9, 12);
await ev(pharma, { type: 'DISPOSE', product_ids: [V[20]], facility_id: F.pharmaPlant.id, data: { reason: 'Retained as evidence then destroyed' } }, 8, 10);
step(`Medicine steps 13-15: ${r13m.accepted.length} AC-02 vials recalled; replacement vial dispensed to the same patient`);

// Expired stock still on a shelf
const amox = await createBatch(pharma, { id: 'AMX', sku: 'AMOXYCLAV-625', name: 'Amoxyclav 625 – strip of 10', category: 'medicine', quantity: 50, mint: 10, mfg_date: dateOnly(-720), expiry_date: dateOnly(-6), facility_id: F.pharmaPlant.id, attributes: { strength: '500 mg + 125 mg', form: 'Tablet', schedule: 'H' } }, { at: T(90, 6) });
const X = amox.minted.map((u) => u.id);
await ev(pharma, { type: 'PRODUCTION_COMPLETE', product_ids: X, facility_id: F.pharmaPlant.id }, 89);
await ev(pharma, { type: 'EXIT', product_ids: X, facility_id: F.pharmaPlant.id, to_actor_id: pharmacy.id }, 88);
await ev(pharmacy, { type: 'ENTRY', product_ids: X, facility_id: F.carePlus.id }, 87);
await ev(pharmacy, { type: 'SOLD', product_ids: X.slice(0, 2), facility_id: F.carePlus.id, expectReject: true }, 1, 18);
await ev(reg, { type: 'FLAG', product_ids: pick(V, [13, 14]), data: { reason: 'Cold-chain excursion 31.5°C – hold pending stability review' } }, 1, 10);

// ── consumer scans ──────────────────────────────────────────────────────────
const prod = (id) => ctx.store.get('products', id);
for (const id of [P[0], P[10], V[0], V[1], S[0]]) {
  const p = await prod(id);
  await scan({ id, sig: p.signature, lat: 12.93 + Math.random() * 0.05, lng: 77.58 + Math.random() * 0.05, ip: `10.0.0.${Math.floor(Math.random() * 200)}` });
}
await scan({ id: 'MRC48201937', lat: 12.7969, lng: 77.3836, ip: '10.1.0.2' });
await scan({ id: 'MRC48201938', lat: 12.72, lng: 77.28, ip: '10.1.0.3' });
await scan({ id: 'AAA00000001', lat: 12.97, lng: 77.6, ip: '10.1.0.4' });
const pc = await prod(V[2]);
await scan({ id: V[2], sig: pc.signature, lat: 12.97, lng: 77.59, ip: '10.2.0.1' });
await scan({ id: V[2], sig: pc.signature, lat: 28.61, lng: 77.21, ip: '10.2.0.9' }); // Delhi minutes later → clone
const pf = await prod(V[3]);
await scan({ id: V[3], sig: `${pf.signature.slice(0, -6)}AAAAAA`, lat: 12.96, lng: 77.6, ip: '10.3.0.1' });
const pl = await prod(P[3]);
await scan({ id: P[3], sig: pl.signature, lat: 12.94, lng: 77.62, ip: '10.4.0.1' });
step('Consumer scans: genuine, counterfeit serials near Bidadi, a cloned label, a forged signature, a locked phone');

if (ctx.ethereum) {
  const s = await ctx.ethereum.drain();
  step(s.status === 'synced' ? `Ethereum: all ${s.anchored} block hashes anchored on ${ctx.ethereum.network.name}` : `Ethereum: ${s.status} – ${s.last_error || ''}`);
}
const v = await ctx.ledger.verify();
console.log(`\nDone. Chain height ${v.tip.height}, ${v.transactions} transactions, integrity ${v.valid ? 'VALID' : 'BROKEN'} (${v.duration_ms} ms).`);
console.log(`Phone passport:    /v/${P[0]}   (full 15-step history)`);
console.log(`Medicine passport: /v/${S[0]}   (replacement vial)`);
console.log(`Locked phone:      /v/${P[3]}`);
await ctx.store.close?.();
process.exit(0);
