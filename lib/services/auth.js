import crypto from 'node:crypto';
import { ctx } from '../context.js';
import { config } from '../config.js';
import { HttpError, sha256 } from '../util.js';
import { publicActor } from './network.js';

const TOKEN_TTL_MS = 12 * 3600e3;
const b64 = (buf) => Buffer.from(buf).toString('base64url');

/** scrypt$<salt>$<hash> */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${b64(salt)}$${b64(crypto.scryptSync(password, salt, 32))}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !password) return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64url');
  const got = crypto.scryptSync(password, Buffer.from(salt, 'base64url'), want.length);
  return crypto.timingSafeEqual(want, got);
}

export const normalizeUsername = (u) => String(u || '').trim().toLowerCase();
export const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;

// A password change (new hash) invalidates every token issued before it.
const fingerprint = (actor) => sha256(`pw:${actor.password_hash || ''}`).slice(0, 12);
const sign = (payload) => crypto.createHmac('sha256', config.ledgerSecret).update(`session:${payload}`).digest('base64url');

export function issueToken(actor) {
  const payload = b64(JSON.stringify({ a: actor.id, e: Date.now() + TOKEN_TTL_MS, f: fingerprint(actor) }));
  return `gts_${payload}.${sign(payload)}`;
}

/** Returns the actor for a valid session token, or null. */
export async function actorBySession(token) {
  const [payload, sig] = String(token).slice(4).split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return null;
  }
  if (!claims.a || !(claims.e > Date.now())) return null;
  const actor = await ctx.store.get('actors', claims.a);
  if (!actor || actor.status !== 'active' || fingerprint(actor) !== claims.f) return null;
  return actor;
}

// Slows password guessing against one account, however many addresses it comes from.
const MAX_FAILS = 8;
const LOCK_MS = 15 * 60e3;
const failures = new Map();

function failed(u) {
  const f = failures.get(u) || { count: 0, until: 0 };
  f.count++;
  if (f.count >= MAX_FAILS) Object.assign(f, { count: 0, until: Date.now() + LOCK_MS });
  if (failures.size > 10_000) failures.clear();
  failures.set(u, f);
}

export async function login(username, password, code) {
  const u = normalizeUsername(username);
  if ((failures.get(u)?.until || 0) > Date.now()) throw new HttpError(429, 'Too many failed sign-ins. Try again in 15 minutes.');
  const [actor] = u ? await ctx.store.list('actors', { where: { username: u }, limit: 1 }) : [];
  // Same error whether the user exists or not.
  if (!actor || !verifyPassword(password, actor.password_hash)) {
    failed(u);
    throw new HttpError(401, 'Wrong username or password');
  }
  if (actor.status !== 'active') throw new HttpError(403, 'This account is suspended');
  if (actor.totp_enabled) {
    if (!code) throw new HttpError(401, 'Enter the 6-digit code from your authenticator app', { mfa_required: true });
    const { checkCode } = await import('./mfa.js');
    if (!(await checkCode(actor, code))) {
      failed(u);
      throw new HttpError(401, 'That code is not valid', { mfa_required: true });
    }
  }
  failures.delete(u);
  return { token: issueToken(actor), expires_in: TOKEN_TTL_MS / 1000, actor: publicActor(actor) };
}

/** Sets (or generates) a member's login. Returns the plain password once. */
export async function setCredentials(actorId, { username, password } = {}) {
  const actor = await ctx.store.get('actors', actorId);
  if (!actor) throw new HttpError(404, 'Member not found');
  const u = normalizeUsername(username ?? actor.username);
  if (!USERNAME.test(u)) throw new HttpError(400, 'Username: 3–32 characters, letters, digits, . _ -');
  const [clash] = await ctx.store.list('actors', { where: { username: u }, limit: 1 });
  if (clash && clash.id !== actorId) throw new HttpError(409, `Username "${u}" is taken`);
  const plain = password || generatePassword();
  if (plain.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  await ctx.store.update('actors', actorId, { username: u, password_hash: hashPassword(plain) });
  return { username: u, password: plain };
}

export function generatePassword() {
  const words = ['Amber', 'Cedar', 'Delta', 'Falcon', 'Harbor', 'Indigo', 'Jasper', 'Maple', 'Nova', 'Orbit', 'Pixel', 'Quartz', 'River', 'Summit', 'Tiger', 'Velvet'];
  const pick = () => words[crypto.randomInt(words.length)];
  return `${pick()}${pick()}@${crypto.randomInt(100, 1000)}`;
}

export async function changePassword(actor, current, next) {
  if (!verifyPassword(current, actor.password_hash)) throw new HttpError(401, 'Current password is wrong');
  if (!next || next.length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
  await ctx.store.update('actors', actor.id, { password_hash: hashPassword(next) });
  return { ok: true };
}
