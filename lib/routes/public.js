import { Router } from '../http/router.js';
import { rateLimit } from '../http/rateLimit.js';
import { z } from 'zod';
import { ctx } from '../context.js';
import { config } from '../config.js';
import { nodeKey } from '../chain/crypto.js';
import { asyncRoute, HttpError } from '../util.js';
import { buildPassport, scan } from '../services/passport.js';
import { raiseAlert } from '../services/alerts.js';
import { DEMO_ACCOUNTS } from '../demo.js';
import { attest } from '../services/device.js';
import { login } from '../services/auth.js';
import { verifyTap } from '../services/nfc.js';

export const publicRouter = Router();
publicRouter.use(rateLimit({ windowMs: 60_000, limit: 240 }));

publicRouter.get('/health', asyncRoute(async (_req, res) => {
  res.json({ ok: true, store: ctx.store.kind, tip: ctx.ledger.tip && { height: ctx.ledger.tip.id, hash: ctx.ledger.tip.hash }, demo: config.demoMode, ethereum: ctx.ethereum ? ctx.ethereum.summary() : { enabled: false } });
}));

publicRouter.get('/node', (_req, res) => {
  res.json({ node_id: config.nodeId, public_key: nodeKey().publicKey, algorithm: 'Ed25519', hash: 'SHA-256', consensus: `Proof-of-Authority + PoW(difficulty ${config.powDifficulty})`, ethereum: ctx.ethereum ? ctx.ethereum.summary() : { enabled: false } });
});

const scanSchema = z.object({
  id: z.string().min(3).max(64),
  s: z.string().max(200).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

publicRouter.post('/scan', asyncRoute(async (req, res) => {
  const b = scanSchema.parse(req.body);
  res.json(await scan({ id: b.id, sig: b.s, lat: b.lat, lng: b.lng, ip: req.ip, userAgent: req.get('user-agent') }));
}));

publicRouter.get('/passport/:id', asyncRoute(async (req, res) => {
  const p = await buildPassport(req.params.id.toUpperCase(), { sig: req.query.s });
  if (!p) throw new HttpError(404, 'Not a registered product');
  res.json(p);
}));

publicRouter.get('/proof/:txId', asyncRoute(async (req, res) => {
  const p = await ctx.ledger.proof(req.params.txId);
  if (!p) throw new HttpError(404, 'Transaction not found');
  res.json(p);
}));

const reportSchema = z.object({
  id: z.string().min(3).max(64),
  issue: z.enum(['suspected_fake', 'defect', 'damaged_packaging', 'adverse_reaction', 'other']),
  description: z.string().max(1000).optional(),
  contact: z.string().max(120).optional(),
});

// Consumer reports become alerts for the manufacturer and regulators.
publicRouter.post('/report', rateLimit({ windowMs: 3600_000, limit: 20 }), asyncRoute(async (req, res) => {
  const b = reportSchema.parse(req.body);
  const id = b.id.toUpperCase();
  const product = await ctx.store.get('products', id);
  const alert = await raiseAlert({
    severity: b.issue === 'adverse_reaction' || b.issue === 'suspected_fake' ? 'high' : 'medium',
    type: 'CONSUMER_REPORT',
    product_id: product ? id : null,
    batch_id: product?.batch_id,
    message: `Consumer report (${b.issue.replace('_', ' ')}) for ${id}${b.description ? `: ${b.description.slice(0, 160)}` : ''}`,
    details: { claimed_id: id, issue: b.issue, description: b.description, contact: b.contact ? 'provided' : null },
  });
  res.json({ ok: true, reference: alert.id });
}));

// Called by the device itself whenever it connects to the internet. HMAC-signed with the
// device secret, so only the genuine device can report (or avoid reporting) its parts.
const attestSchema = z.object({
  product_id: z.string().min(3).max(64),
  parts: z.array(z.object({ name: z.string().max(80), serial: z.string().max(64) })).max(40),
  nonce: z.string().min(8).max(64),
  signature: z.string().max(200),
});
publicRouter.post('/device/attest', asyncRoute(async (req, res) => {
  res.json(await attest(attestSchema.parse(req.body)));
}));

publicRouter.post('/nfc/verify', rateLimit({ windowMs: 60_000, limit: 60 }), asyncRoute(async (req, res) => {
  res.json(await verifyTap(z.object({ e: z.string().max(64), c: z.string().max(32) }).parse(req.body)));
}));

const loginSchema = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(100), code: z.string().max(6).optional() });
publicRouter.post('/login', rateLimit({ windowMs: 60_000, limit: 10 }), asyncRoute(async (req, res) => {
  const b = loginSchema.parse(req.body);
  res.json(await login(b.username, b.password, b.code));
}));

// Demo sign-ins shown on the login page. Admin is never listed.
publicRouter.get('/demo-accounts', (_req, res) => {
  if (!config.demoMode) return res.json([]);
  res.json(DEMO_ACCOUNTS.map(({ id, name, role, org, username, password }) => ({ id, name, role, org, username, password })));
});
