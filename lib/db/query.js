// Shared query vocabulary for both stores:
// { where: {col: value|null}, whereIn: {col: [..]}, gte: {col: v}, lte: {col: v},
//   search: {q, cols: [..]}, order: [[col, 'asc'|'desc'], ...], limit, offset, columns: [..] }

export const TABLES = ['actors', 'facilities', 'blocks', 'events', 'batches', 'products', 'scans', 'alerts', 'programs', 'machines', 'sales', 'tickets', 'anchors', 'cartons', 'notifications', 'nfc_tags'];
export const APPEND_ONLY = new Set(['blocks', 'events', 'scans']);
export const JSON_COLUMNS = {
  events: ['data'],
  batches: ['attributes', 'components'],
  products: ['attributes'],
  scans: ['details'],
  alerts: ['details'],
  programs: ['criteria'],
  machines: ['processes'],
  tickets: ['diagnosis'],
  actors: ['signing_keys'],
  cartons: ['units'],
};

const toTime = (v) => (v instanceof Date ? v.toISOString() : v);

export function matches(r, { where, whereIn, gte, lte, search } = {}) {
  if (where) for (const [k, v] of Object.entries(where)) if (v === null ? r[k] != null : r[k] !== v) return false;
  if (whereIn) for (const [k, arr] of Object.entries(whereIn)) if (!arr.includes(r[k])) return false;
  if (gte) for (const [k, v] of Object.entries(gte)) if (!(toTime(r[k]) >= v)) return false;
  if (lte) for (const [k, v] of Object.entries(lte)) if (!(toTime(r[k]) <= v)) return false;
  if (search?.q) {
    const q = search.q.toLowerCase();
    if (!search.cols.some((c) => String(r[c] ?? '').toLowerCase().includes(q))) return false;
  }
  return true;
}

export function sortRows(rows, order) {
  return [...rows].sort((a, b) => {
    for (const [col, dir] of order) {
      const x = a[col];
      const y = b[col];
      if (x === y) continue;
      const c = x == null ? -1 : y == null ? 1 : x < y ? -1 : 1;
      return dir === 'desc' ? -c : c;
    }
    return 0;
  });
}

export function pickColumns(r, cols) {
  const o = {};
  for (const c of cols) o[c] = r[c];
  return o;
}
