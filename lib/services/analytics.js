import { ctx } from '../context.js';

const day = (iso) => String(iso).slice(0, 10);

export async function overview() {
  const s = ctx.store;
  const since = new Date(Date.now() - 60 * 86400e3).toISOString();
  const [products, batches, actors, facilities, blocks, events, scans, openAlerts, recentEvents, recentScans, statusRows, recentBlocks, alerts] = await Promise.all([
    s.count('products'),
    s.count('batches'),
    s.count('actors'),
    s.count('facilities'),
    s.count('blocks'),
    s.count('events'),
    s.count('scans'),
    s.count('alerts', { where: { status: 'open' } }),
    s.list('events', { gte: { ts: since }, columns: ['type', 'ts'], order: [['ts', 'desc']], limit: 20000 }),
    s.list('scans', { gte: { created_at: since }, columns: ['verdict', 'created_at', 'lat', 'lng', 'claimed_id'], order: [['created_at', 'desc']], limit: 5000 }),
    s.list('products', { columns: ['status', 'category'] }),
    s.list('blocks', { order: [['id', 'desc']], limit: 8 }),
    s.list('alerts', { where: { status: 'open' }, order: [['created_at', 'desc']], limit: 8 }),
  ]);

  const days = [];
  for (let i = 59; i >= 0; i--) days.push(day(new Date(Date.now() - i * 86400e3).toISOString()));
  const activity = days.map((d) => ({ day: d, events: 0, entries: 0, exits: 0, scans: 0, threats: 0 }));
  const idx = new Map(activity.map((a) => [a.day, a]));
  for (const e of recentEvents) {
    const a = idx.get(day(e.ts));
    if (!a) continue;
    a.events++;
    if (e.type === 'ENTRY') a.entries++;
    if (e.type === 'EXIT') a.exits++;
  }
  const verdicts = {};
  for (const sc of recentScans) {
    verdicts[sc.verdict] = (verdicts[sc.verdict] || 0) + 1;
    const a = idx.get(day(sc.created_at));
    if (a) {
      a.scans++;
      if (sc.verdict !== 'GENUINE') a.threats++;
    }
  }
  const byStatus = {};
  const byCategory = {};
  for (const p of statusRows) {
    byStatus[p.status] = (byStatus[p.status] || 0) + 1;
    byCategory[p.category] = (byCategory[p.category] || 0) + 1;
  }
  const hotspots = recentScans.filter((x) => x.verdict !== 'GENUINE' && x.lat != null).slice(0, 200);

  return {
    totals: { products, batches, actors, facilities, blocks, events, scans, open_alerts: openAlerts },
    activity,
    verdicts,
    by_status: byStatus,
    by_category: byCategory,
    hotspots,
    recent_blocks: recentBlocks.map((b) => ({ height: b.id, hash: b.hash, tx_count: b.tx_count, ts: b.ts })),
    recent_alerts: alerts,
  };
}

/** Defect intelligence: which component lots, firmware versions and models a defect concentrates in. */
export async function defects() {
  const [reports, products, batches, updates] = await Promise.all([
    ctx.store.list('events', { whereIn: { type: ['DEFECT_REPORTED', 'ISSUE_REPORTED'] }, order: [['ts', 'asc']] }),
    ctx.store.list('products', { columns: ['id', 'batch_id', 'sku', 'attributes', 'status'] }),
    ctx.store.list('batches'),
    ctx.store.list('events', { where: { type: 'FIRMWARE_UPDATE' }, columns: ['product_id', 'data', 'ts'] }),
  ]);
  const batchMap = new Map(batches.map((b) => [b.id, b]));
  // Fleet size per component lot / firmware for defect *rates*, not just counts.
  const lotFleet = new Map();
  const lotPart = new Map();
  const fwFleet = new Map();
  const machineFleet = new Map();
  const stationsOf = (p) => {
    const last = new Map();
    for (const st of p?.attributes?.steps || []) last.set(st.process, st.machine_id);
    return [...last].map(([process, machine]) => `${process}|${machine}`);
  };
  for (const p of products) {
    for (const k of stationsOf(p)) machineFleet.set(k, (machineFleet.get(k) || 0) + 1);
    const b = batchMap.get(p.batch_id);
    for (const c of b?.components || []) {
      lotFleet.set(c.batch_id, (lotFleet.get(c.batch_id) || 0) + 1);
      lotPart.set(c.batch_id, c.name);
    }
    if (p.attributes?.firmware) fwFleet.set(p.attributes.firmware, (fwFleet.get(p.attributes.firmware) || 0) + 1);
  }
  const codes = new Map();
  for (const r of reports) {
    if (r.data?.code === 'RECALL') continue;
    const code = r.data?.code || 'UNKNOWN';
    if (!codes.has(code)) codes.set(code, { code, reports: 0, units: new Set(), lots: new Map(), firmware: new Map(), skus: new Map(), machines: new Map(), post_update: 0, timeline: new Map() });
    const c = codes.get(code);
    c.reports++;
    c.units.add(r.product_id);
    for (const lot of r.data?.component_lots || []) c.lots.set(lot, (c.lots.get(lot) || 0) + 1);
    const fw = r.data?.firmware || 'n/a';
    c.firmware.set(fw, (c.firmware.get(fw) || 0) + 1);
    const p = products.find((x) => x.id === r.product_id);
    if (p) c.skus.set(p.sku, (c.skus.get(p.sku) || 0) + 1);
    if (p && !c.units_seen?.has(p.id)) {
      (c.units_seen ||= new Set()).add(p.id);
      for (const k of stationsOf(p)) c.machines.set(k, (c.machines.get(k) || 0) + 1);
    }
    if (r.data?.days_since_update != null && r.data.days_since_update <= 45) c.post_update++;
    const d = day(r.ts);
    c.timeline.set(d, (c.timeline.get(d) || 0) + 1);
  }
  const lotName = (id) => batchMap.get(id)?.name || id;
  return {
    total_reports: reports.length,
    firmware_rollouts: [...new Set(updates.map((u) => u.data?.version))].map((v) => ({
      version: v,
      units: updates.filter((u) => u.data?.version === v).length,
      first: updates.filter((u) => u.data?.version === v).map((u) => u.ts).sort()[0],
    })),
    codes: [...codes.values()].map((c) => ({
      code: c.code,
      reports: c.reports,
      units: c.units.size,
      post_update_share: c.reports ? c.post_update / c.reports : 0,
      by_lot: [...c.lots].map(([lot, n]) => ({ lot, name: lotName(lot), part: lotPart.get(lot) || 'Component', reports: n, fleet: lotFleet.get(lot) || 0, rate: lotFleet.get(lot) ? n / lotFleet.get(lot) : 0 })).sort((a, b) => b.rate - a.rate),
      by_firmware: [...c.firmware].map(([fw, n]) => ({ firmware: fw, reports: n, fleet: fwFleet.get(fw) || 0 })),
      by_sku: [...c.skus].map(([sku, n]) => ({ sku, reports: n })),
      by_machine: [...c.machines].map(([k, n]) => {
        const [process, machine_id] = k.split('|');
        const fleet = machineFleet.get(k) || 0;
        return { process, machine_id, units: n, fleet, rate: fleet ? n / fleet : 0, share: c.units.size ? n / c.units.size : 0 };
      }).sort((a, b) => b.share - a.share || b.rate - a.rate),
      timeline: [...c.timeline].map(([d, n]) => ({ day: d, reports: n })),
    })),
  };
}
