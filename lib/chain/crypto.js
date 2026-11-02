import crypto from 'node:crypto';
import { config } from '../config.js';

// Deterministic JSON: sorted keys, undefined dropped. Hashes must not depend on key order
// (Postgres jsonb reorders keys on the way back).
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

// Ed25519 PKCS#8 DER prefix; append a 32-byte seed to get a private key.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const cache = new Map();

/** Ed25519 key pair derived from LEDGER_SECRET + label, so private keys never touch the database. */
export function keyFor(label) {
  if (cache.has(label)) return cache.get(label);
  const seed = crypto.createHmac('sha256', config.ledgerSecret).update(`geneatrace:${label}`).digest();
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
  const kp = { privateKey, publicKey };
  cache.set(label, kp);
  return kp;
}

export const nodeKey = () => keyFor('node');
export const actorKey = (actorId) => keyFor(`actor:${actorId}`);

export function sign(kp, message) {
  return crypto.sign(null, Buffer.from(message), kp.privateKey).toString('base64url');
}

const pubCache = new Map();
export function verifySig(publicKeyB64, message, signature) {
  if (!publicKeyB64 || !signature) return false;
  try {
    let key = pubCache.get(publicKeyB64);
    if (!key) {
      key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
      pubCache.set(publicKeyB64, key);
    }
    return crypto.verify(null, Buffer.from(message), key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}
