import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { ctx } from '../context.js';
import { config } from '../config.js';
import { HttpError, newId, nowIso } from '../util.js';

// Pushes serious alerts out of the app: a signed webhook per company, and email when an email
// provider key is configured. A failed delivery is logged and never fails the ledger write.

const PRIVATE = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd]|fe80)/i;

/** Webhooks run from the server, so internal addresses are refused. */
export async function assertPublicUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new HttpError(400, 'Webhook URL is not valid');
  }
  if (u.protocol !== 'https:') throw new HttpError(400, 'Webhook URL must use https');
  const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some((a) => PRIVATE.test(a.address))) throw new HttpError(400, 'Webhook URL must be a public address');
}

export const webhookSecret = (actorId) => crypto.createHmac('sha256', config.ledgerSecret).update(`webhook:${actorId}`).digest('base64url');

async function log(actorId, alertId, channel, status, error = null) {
  await ctx.store.insert('notifications', { id: newId('NTF'), actor_id: actorId, alert_id: alertId, channel, status, error, created_at: nowIso() });
}

async function sendWebhook(actor, alert) {
  try {
    await assertPublicUrl(actor.webhook_url);
    const body = JSON.stringify({ event: 'alert', alert: { id: alert.id, severity: alert.severity, type: alert.type, message: alert.message, product_id: alert.product_id, batch_id: alert.batch_id, created_at: alert.created_at } });
    const signature = crypto.createHmac('sha256', webhookSecret(actor.id)).update(body).digest('hex');
    const res = await fetch(actor.webhook_url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json', 'x-geneatrace-signature': signature }, body });
    await log(actor.id, alert.id, 'webhook', res.ok ? 'sent' : 'failed', res.ok ? null : `HTTP ${res.status}`);
  } catch (e) {
    await log(actor.id, alert.id, 'webhook', 'failed', e.message);
  }
}

export async function sendEmail(to, subject, text) {
  if (!config.resendApiKey || !to) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.resendApiKey}` },
    body: JSON.stringify({ from: config.emailFrom, to, subject, text }),
  });
  if (!res.ok) throw new Error(`Email provider returned ${res.status}`);
  return true;
}

/** Called for every new alert. Only high and critical alerts leave the app. */
export async function notifyAlert(alert) {
  if (!['high', 'critical'].includes(alert.severity)) return;
  const batch = alert.batch_id ? await ctx.store.get('batches', alert.batch_id) : null;
  const ids = [...new Set([alert.actor_id, batch?.manufacturer_id].filter(Boolean))];
  if (!ids.length) return;
  for (const actor of await ctx.store.list('actors', { whereIn: { id: ids } })) {
    if (actor.webhook_url) await sendWebhook(actor, alert);
    if (config.resendApiKey && actor.email) {
      await sendEmail(actor.email, `GeneaTrace ${alert.severity} alert: ${alert.type}`, alert.message)
        .then(() => log(actor.id, alert.id, 'email', 'sent'))
        .catch((e) => log(actor.id, alert.id, 'email', 'failed', e.message));
    }
  }
}

/** Emails customers who agreed to safety notices at the point of sale. */
export async function notifyRecallCustomers(productIds, reason) {
  if (!config.resendApiKey || !productIds.length) return 0;
  const sales = await ctx.store.list('sales', { whereIn: { product_id: productIds } });
  let sent = 0;
  for (const s of sales) {
    if (!s.consent_at || !s.customer_email) continue;
    await sendEmail(s.customer_email, 'Important safety recall for your product', `Your product ${s.product_id} has been recalled: ${reason}. Please contact the store where you bought it.`)
      .then(() => { sent++; })
      .catch((e) => console.error('[notify] recall email failed', e.message));
  }
  return sent;
}
