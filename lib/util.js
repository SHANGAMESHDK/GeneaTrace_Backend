import crypto from 'node:crypto';

// Crockford base32 – no I, L, O, U so IDs survive being read aloud or hand-typed.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function rid(n = 8) {
  let s = '';
  for (const b of crypto.randomBytes(n)) s += B32[b % 32];
  return s;
}

export const newId = (prefix, n = 8) => `${prefix}-${rid(n)}`;

// Cryptographic serial = batch code + 8 random digits (e.g. AAA48201937). Random, not
// sequential, so counterfeiters cannot guess valid serials; the manufacturer signature on
// the QR label makes a guessed one useless anyway.
export function newSerial(batchCode) {
  const prefix = String(batchCode).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return `${prefix}${String(crypto.randomInt(0, 1e8)).padStart(8, '0')}`;
}

export const nowIso = () => new Date().toISOString();

export function addMonths(iso, months) {
  const d = new Date(iso);
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const unique = (arr) => [...new Set(arr)];

export function groupBy(arr, fn) {
  const m = new Map();
  for (const x of arr) {
    const k = fn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

export const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
