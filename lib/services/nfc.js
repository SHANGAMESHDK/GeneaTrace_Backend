import crypto from 'node:crypto';
import { ctx } from '../context.js';
import { config } from '../config.js';
import { HttpError, nowIso } from '../util.js';
import { applyTx } from './state.js';
import { raiseAlert } from './alerts.js';

// NFC tags on the pack (NXP NTAG 424 DNA, Secure Dynamic Messaging). Every tap the chip encrypts
// its UID and a rising counter and adds a CMAC, so the URL is different each time and only this
// server can check it. A photographed QR can be copied; a tap cannot be replayed.

const UID = /^[0-9A-F]{14}$/;
// The same counter again this soon is one tap (page refresh), not a copied link.
const SAME_TAP_MS = 60_000;

const derive = (label) => crypto.createHmac('sha256', config.ledgerSecret).update(label).digest().subarray(0, 16);
export const metaKey = () => derive('nfc-meta');
export const fileKey = (uid) => derive(`nfc-file:${uid}`);

function aesBlock(key, block) {
  const c = crypto.createCipheriv('aes-128-ecb', key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(block), c.final()]);
}

function shiftLeft(b) {
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) out[i] = ((b[i] << 1) | (i < 15 ? b[i + 1] >> 7 : 0)) & 255;
  if (b[0] & 128) out[15] ^= 0x87;
  return out;
}

const xor = (a, b) => Buffer.from(a.map((v, i) => v ^ b[i]));

/** AES-CMAC (RFC 4493). */
export function cmac(key, msg) {
  const k1 = shiftLeft(aesBlock(key, Buffer.alloc(16)));
  const k2 = shiftLeft(k1);
  const blocks = Math.max(Math.ceil(msg.length / 16), 1);
  const full = msg.length > 0 && msg.length % 16 === 0;
  const tail = Buffer.alloc(16);
  msg.copy(tail, 0, (blocks - 1) * 16);
  if (!full) tail[msg.length % 16] = 0x80;
  let x = Buffer.alloc(16);
  for (let i = 0; i < blocks - 1; i++) x = aesBlock(key, xor(x, msg.subarray(i * 16, i * 16 + 16)));
  return aesBlock(key, xor(x, xor(tail, full ? k1 : k2)));
}

/** Decrypts the tag's PICC data into UID and read counter, or null if it is not valid. */
export function decryptPicc(key, hex) {
  if (!/^[0-9a-fA-F]{32}$/.test(String(hex))) return null;
  const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16));
  d.setAutoPadding(false);
  const p = Buffer.concat([d.update(Buffer.from(hex, 'hex')), d.final()]);
  if (p[0] !== 0xc7) return null;
  return { uid: p.subarray(1, 8).toString('hex').toUpperCase(), counter: p.readUIntLE(8, 3) };
}

/** The 8-byte SDM MAC for a UID and counter (NXP AN12196). */
export function sdmMac(key, uid, counter) {
  const sv2 = Buffer.alloc(16);
  Buffer.from([0x3c, 0xc3, 0x00, 0x01, 0x00, 0x80]).copy(sv2);
  Buffer.from(uid, 'hex').copy(sv2, 6);
  sv2.writeUIntLE(counter, 13, 3);
  const mac = cmac(cmac(key, sv2), Buffer.alloc(0));
  return Buffer.from([1, 3, 5, 7, 9, 11, 13, 15].map((i) => mac[i])).toString('hex').toUpperCase();
}

function encryptPicc(key, uid, counter) {
  const p = Buffer.alloc(16);
  p[0] = 0xc7;
  Buffer.from(uid, 'hex').copy(p, 1);
  p.writeUIntLE(counter, 8, 3);
  crypto.randomBytes(5).copy(p, 11);
  const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16));
  c.setAutoPadding(false);
  return Buffer.concat([c.update(p), c.final()]).toString('hex').toUpperCase();
}

const tapUrl = (e, c) => `${config.publicAppUrl}/n?e=${e}&c=${c}`;

/** Pairs a chip with a passport on the ledger and returns what the tag writer must program. */
export async function bindTag(actor, productId, rawUid) {
  const uid = String(rawUid || '').replace(/[\s:]/g, '').toUpperCase();
  if (!UID.test(uid)) throw new HttpError(400, 'Tag UID must be 14 hex characters');
  return ctx.ledger.lock(async () => {
    const p = await ctx.store.get('products', String(productId).toUpperCase());
    if (!p || (p.manufacturer_id !== actor.id && actor.role !== 'admin')) throw new HttpError(404, 'Product not found');
    if (p.attributes?.nfc_uid) throw new HttpError(409, `${p.id} already has a tag`);
    if (await ctx.store.get('nfc_tags', uid)) throw new HttpError(409, 'This tag is already paired with another product');
    await ctx.ledger.commit(
      [{ type: 'NFC_BOUND', product_id: p.id, batch_id: p.batch_id, actor_id: actor.id, data: { uid }, prev_tx: p.last_tx }],
      {
        apply: async (t, txs) => {
          await t.insert('nfc_tags', { id: uid, product_id: p.id, last_counter: 0, last_seen_at: null, created_at: nowIso() });
          await t.saveProducts([applyTx(p, txs[0])]);
        },
      },
    );
    return { uid, product_id: p.id, url_template: tapUrl('{PICC_DATA}', '{CMAC}'), meta_read_key: metaKey().toString('hex'), file_read_key: fileKey(uid).toString('hex') };
  });
}

async function reject(productId, batchId, message, key) {
  await raiseAlert({ severity: 'critical', type: 'NFC_REJECTED', product_id: productId, batch_id: batchId, message, details: { dedupe: key } });
}

/** Public check of one tap. Never returns which step failed to an unknown tag. */
export async function verifyTap({ e, c }) {
  const invalid = { verdict: 'COUNTERFEIT', reason: 'This tag was not issued by the manufacturer.' };
  const picc = decryptPicc(metaKey(), e);
  if (!picc) return invalid;
  const tag = await ctx.store.get('nfc_tags', picc.uid);
  const given = Buffer.from(String(c || '').toUpperCase());
  const want = Buffer.from(sdmMac(fileKey(picc.uid), picc.uid, picc.counter));
  if (!tag || given.length !== want.length || !crypto.timingSafeEqual(given, want)) return invalid;

  const product = await ctx.store.get('products', tag.product_id);
  const now = Date.now();
  const sameTap = picc.counter === tag.last_counter && now - Date.parse(tag.last_seen_at || 0) < SAME_TAP_MS;
  if (picc.counter <= tag.last_counter && !sameTap) {
    await reject(product.id, product.batch_id, `${product.id}: an old NFC link was reused (tap ${picc.counter}, tag is at ${tag.last_counter}). Someone may be passing off a copied link.`, `nfc-replay:${tag.id}`);
    return { verdict: 'SUSPECTED_CLONE', reason: 'This link was already used. Tap the real tag on the pack again.' };
  }
  if (!sameTap) await ctx.store.update('nfc_tags', tag.id, { last_counter: picc.counter, last_seen_at: new Date(now).toISOString() });
  return { verdict: 'GENUINE', product_id: product.id, signature: product.signature, taps: picc.counter };
}

/** Demo without hardware: produces the URL a real tag would produce on its next tap. */
export async function simulateTap(actor, productId) {
  if (!config.demoMode) throw new HttpError(403, 'Tag simulation is only available in demo mode');
  const p = await ctx.store.get('products', String(productId).toUpperCase());
  if (!p?.attributes?.nfc_uid || (p.manufacturer_id !== actor.id && actor.role !== 'admin')) throw new HttpError(404, 'No tag on this product');
  const uid = p.attributes.nfc_uid;
  const tag = await ctx.store.get('nfc_tags', uid);
  const counter = tag.last_counter + 1;
  return { url: tapUrl(encryptPicc(metaKey(), uid, counter), sdmMac(fileKey(uid), uid, counter)) };
}
