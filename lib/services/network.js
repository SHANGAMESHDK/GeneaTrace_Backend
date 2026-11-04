import { ctx } from '../context.js';
import { config } from '../config.js';
import { actorKey } from '../chain/crypto.js';
import { HttpError, newId, rid, sha256, nowIso } from '../util.js';
import { raiseAlert } from './alerts.js';
import { hashPassword, verifyPassword, normalizeUsername, USERNAME, generatePassword } from './auth.js';

export const ROLES = ['admin', 'manufacturer', 'distributor', 'logistics', 'retailer', 'pharmacy', 'hospital', 'service_center', 'regulator'];
export const FACILITY_TYPES = ['factory', 'warehouse', 'cold_storage', 'transit_hub', 'store', 'pharmacy', 'hospital', 'service_center', 'lab'];

export const publicActor = (a) => a && { id: a.id, name: a.name, role: a.role, org: a.org, email: a.email, license_no: a.license_no, status: a.status, public_key: a.public_key, username: a.username || null, mfa: !!a.totp_enabled, signing_keys: a.signing_keys || [], webhook_url: a.webhook_url || null, created_at: a.created_at };

export async function actorByApiKey(key) {
  // Read fresh every time: a suspension or a new device key must apply to the next request.
  const [actor] = await ctx.store.list('actors', { where: { api_key_hash: sha256(key) }, limit: 1 });
  return actor || null;
}

/** Register a network member. Its public key goes on-chain so signatures stay verifiable forever. */
export async function createActor(by, input, { apiKey, id, at } = {}) {
  if (!ROLES.includes(input.role)) throw new HttpError(400, `Unknown role ${input.role}`);
  const actorId = id || newId('ACT', 6);
  const key = apiKey || `gt_${rid(32).toLowerCase()}`;
  const username = input.username ? normalizeUsername(input.username) : null;
  if (username) {
    if (!USERNAME.test(username)) throw new HttpError(400, 'Username: 3–32 characters, letters, digits, . _ -');
    const [clash] = await ctx.store.list('actors', { where: { username }, limit: 1 });
    if (clash) throw new HttpError(409, `Username "${username}" is taken`);
  }
  const password = username ? input.password || generatePassword() : null;
  if (password && password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  const row = {
    id: actorId,
    name: input.name,
    role: input.role,
    org: input.org || null,
    email: input.email || null,
    license_no: input.license_no || null,
    public_key: actorKey(actorId).publicKey,
    api_key_hash: sha256(key),
    username,
    password_hash: password ? hashPassword(password) : null,
    status: 'active',
    created_at: at || nowIso(),
  };
  await ctx.ledger.lock(() =>
    ctx.ledger.commit(
      [{
        type: 'ACTOR_REGISTERED',
        actor_id: by?.id ?? null,
        data: { actor_id: actorId, name: row.name, role: row.role, org: row.org, license_no: row.license_no, public_key: row.public_key },
      }],
      { at, apply: (t) => t.insert('actors', row) },
    ),
  );
  return { actor: publicActor(row), api_key: key, ...(username ? { username, password } : {}) };
}

export async function ensureAdmin() {
  const existing = await ctx.store.get('actors', 'ACT-ADMIN');
  if (existing) {
    const patch = {};
    if (existing.api_key_hash !== sha256(config.adminApiKey)) patch.api_key_hash = sha256(config.adminApiKey);
    if (config.adminPassword && (existing.username !== 'admin' || !verifyPassword(config.adminPassword, existing.password_hash))) {
      Object.assign(patch, { username: 'admin', password_hash: hashPassword(config.adminPassword) });
    }
    if (Object.keys(patch).length) await ctx.store.update('actors', 'ACT-ADMIN', patch);
    return existing;
  }
  const creds = config.adminPassword ? { username: 'admin', password: config.adminPassword } : {};
  const { actor } = await createActor(null, { name: 'GeneaTrace Network Admin', role: 'admin', org: 'GeneaTrace Consortium', ...creds }, { apiKey: config.adminApiKey, id: 'ACT-ADMIN' });
  return actor;
}

export async function createFacility(by, input, { at } = {}) {
  const ownerId = ['admin', 'regulator'].includes(by.role) && input.actor_id ? input.actor_id : by.id;
  const owner = await ctx.store.get('actors', ownerId);
  if (!owner) throw new HttpError(400, 'Facility owner not found');
  // Self-registered sites start unlicensed until a regulator approves them.
  const licensed = ['admin', 'regulator'].includes(by.role) ? input.licensed !== false : false;
  const row = {
    id: newId('FAC', 6),
    name: input.name,
    actor_id: ownerId,
    type: input.type,
    address: input.address || null,
    city: input.city || null,
    lat: input.lat ?? null,
    lng: input.lng ?? null,
    license_no: input.license_no || null,
    licensed,
    created_at: at || nowIso(),
  };
  await ctx.ledger.lock(() =>
    ctx.ledger.commit(
      [{ type: 'FACILITY_REGISTERED', actor_id: by.id, facility_id: row.id, data: { name: row.name, owner: ownerId, type: row.type, city: row.city, lat: row.lat, lng: row.lng, licensed } }],
      { at, apply: (t) => t.insert('facilities', row) },
    ),
  );
  return row;
}

export async function setFacilityLicense(by, facilityId, licensed, reason, { at } = {}) {
  const f = await ctx.store.get('facilities', facilityId);
  if (!f) throw new HttpError(404, 'Facility not found');
  await ctx.ledger.lock(() =>
    ctx.ledger.commit(
      [{ type: 'FACILITY_LICENSE', actor_id: by.id, facility_id: f.id, data: { licensed, reason: reason || null } }],
      { at, apply: (t) => t.update('facilities', f.id, { licensed }) },
    ),
  );
  if (!licensed) {
    const units = await ctx.store.count('products', { where: { facility_id: f.id } });
    await raiseAlert({
      severity: units ? 'critical' : 'high',
      type: 'LICENSE_REVOKED',
      facility_id: f.id,
      message: `License revoked for ${f.name}${units ? ` – ${units} unit(s) currently held there` : ''}`,
      details: { reason, units, at },
    });
  }
  return { ...f, licensed };
}
