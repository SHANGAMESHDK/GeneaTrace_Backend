import { ctx } from '../context.js';
import { canonical, verifySig } from '../chain/crypto.js';
import { HttpError, nowIso, sha256 } from '../util.js';
import { verifyPassword } from './auth.js';

// Company-held signing keys. The server signs every transaction with a key derived from
// LEDGER_SECRET, so that signature alone cannot prove the company acted. Once a company
// registers a device key, each request must also carry a signature made on that device with a
// private key the server never sees. It is sealed as a COMPANY_ATTESTATION in the same block,
// and the chain audit reports any company event that lacks one.

const MAX_SKEW_MS = 5 * 60e3;
const seen = new Map();

export const keyProofMessage = (actorId, publicKey) => `geneatrace-key:${actorId}:${publicKey}`;
export const intentMessage = (intent) => canonical(intent);
export const requestHash = (body) => sha256(canonical(body));

function useNonce(nonce, now) {
  for (const [n, exp] of seen) if (exp < now) seen.delete(n);
  if (seen.has(nonce)) throw new HttpError(409, 'This signed request was already used');
  seen.set(nonce, now + 2 * MAX_SKEW_MS);
}

/** Returns the attestation to seal with the request, or null if the company has no device keys. */
export function checkAttestation(actor, body) {
  const keys = actor.signing_keys || [];
  if (!keys.length) return null;
  const { attestation: att, ...rest } = body;
  if (!att?.signature || !att.public_key || !att.nonce || !att.ts) {
    throw new HttpError(428, 'This company signs events on registered devices. Register this device under Security.', { signature_required: true });
  }
  if (!keys.some((k) => k.public_key === att.public_key)) {
    throw new HttpError(403, 'This device key is not registered for your company. Register it under Security.', { signature_required: true });
  }
  const now = Date.now();
  if (Math.abs(now - Date.parse(att.ts)) > MAX_SKEW_MS) throw new HttpError(400, 'Signed request is too old. Check this device clock.');
  const intent = { actor_id: actor.id, type: rest.type, payload: requestHash(rest), nonce: att.nonce, ts: att.ts };
  if (!verifySig(att.public_key, intentMessage(intent), att.signature)) throw new HttpError(401, 'Device signature does not match this request');
  useNonce(att.nonce, now);
  return { public_key: att.public_key, intent, signature: att.signature };
}

async function commitKeyChange(actor, type, data, keys) {
  await ctx.ledger.lock(() =>
    ctx.ledger.commit([{ type, actor_id: actor.id, data }], { apply: (t) => t.update('actors', actor.id, { signing_keys: keys }) }),
  );
  return keys;
}

export async function registerSigningKey(actor, { public_key: publicKey, label, proof, password }) {
  if (actor.password_hash && !verifyPassword(password, actor.password_hash)) throw new HttpError(401, 'Password is wrong');
  if (!verifySig(publicKey, keyProofMessage(actor.id, publicKey), proof)) throw new HttpError(400, 'Key proof failed: this device does not hold the private key');
  const keys = actor.signing_keys || [];
  if (keys.some((k) => k.public_key === publicKey)) return keys;
  if (keys.length >= 20) throw new HttpError(400, 'At most 20 device keys per company');
  const entry = { public_key: publicKey, label: label || 'Device', added_at: nowIso() };
  return commitKeyChange(actor, 'KEY_REGISTERED', { public_key: publicKey, label: entry.label }, [...keys, entry]);
}

export async function revokeSigningKey(actor, { public_key: publicKey, password }) {
  if (actor.password_hash && !verifyPassword(password, actor.password_hash)) throw new HttpError(401, 'Password is wrong');
  const keys = actor.signing_keys || [];
  if (!keys.some((k) => k.public_key === publicKey)) throw new HttpError(404, 'Key not found');
  return commitKeyChange(actor, 'KEY_REVOKED', { public_key: publicKey }, keys.filter((k) => k.public_key !== publicKey));
}
