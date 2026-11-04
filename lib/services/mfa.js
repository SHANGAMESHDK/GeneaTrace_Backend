import crypto from 'node:crypto';
import { ctx } from '../context.js';
import { config } from '../config.js';
import { HttpError } from '../util.js';
import { verifyPassword } from './auth.js';

// Time-based one-time codes (RFC 6238), compatible with Google Authenticator and similar apps.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;

function base32(buf) {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  return bits.match(/.{1,5}/g).map((c) => B32[parseInt(c.padEnd(5, '0'), 2)]).join('');
}

function unbase32(s) {
  const bits = [...s].map((c) => B32.indexOf(c).toString(2).padStart(5, '0')).join('');
  return Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
}

export function totp(secret, step = Math.floor(Date.now() / 1000 / STEP)) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(counter).digest();
  const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

// Secrets are encrypted at rest; a database leak alone does not reveal them.
const sealKey = () => crypto.createHmac('sha256', config.ledgerSecret).update('totp-seal').digest();

function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', sealKey(), iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

function unseal(stored) {
  const [iv, tag, body] = stored.split('.').map((s) => Buffer.from(s, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', sealKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}

/** Checks a code one step either side of now. Each step can be used once. */
export async function checkCode(actor, code) {
  if (!actor.totp_secret || !/^\d{6}$/.test(String(code || ''))) return false;
  const secret = unseal(actor.totp_secret);
  const now = Math.floor(Date.now() / 1000 / STEP);
  for (const step of [now - 1, now, now + 1]) {
    const want = Buffer.from(totp(secret, step));
    if (crypto.timingSafeEqual(want, Buffer.from(String(code))) && step > Number(actor.totp_last_step || 0)) {
      await ctx.store.update('actors', actor.id, { totp_last_step: step });
      return true;
    }
  }
  return false;
}

export async function startSetup(actor) {
  if (actor.totp_enabled) throw new HttpError(409, 'Two-factor sign-in is already on');
  const secret = base32(crypto.randomBytes(20));
  await ctx.store.update('actors', actor.id, { totp_secret: seal(secret), totp_last_step: 0 });
  const label = encodeURIComponent(`GeneaTrace:${actor.username || actor.id}`);
  return { secret, otpauth_url: `otpauth://totp/${label}?secret=${secret}&issuer=GeneaTrace&digits=6&period=${STEP}` };
}

export async function enable(actor, code) {
  if (!(await checkCode(actor, code))) throw new HttpError(400, 'That code is not valid. Check your phone clock and try again.');
  await ctx.store.update('actors', actor.id, { totp_enabled: true });
  return { enabled: true };
}

export async function disable(actor, { password, code }) {
  if (!verifyPassword(password, actor.password_hash)) throw new HttpError(401, 'Password is wrong');
  if (!(await checkCode(actor, code))) throw new HttpError(400, 'That code is not valid');
  await ctx.store.update('actors', actor.id, { totp_enabled: false, totp_secret: null, totp_last_step: 0 });
  return { enabled: false };
}
