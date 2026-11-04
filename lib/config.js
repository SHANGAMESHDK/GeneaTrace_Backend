import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Backend folder: from this file's location (scripts, tests) or the working directory (Next.js bundles).
const here = path.dirname(fileURLToPath(import.meta.url));
// (A bundler may bake in the build machine's path, so only trust it if it exists here.)
const fromFile = path.resolve(here, '..');
export const ROOT = path.basename(here) === 'lib' && fs.existsSync(path.join(fromFile, 'supabase')) ? fromFile : process.cwd();
dotenv.config({ path: path.join(ROOT, '.env') });

const DEV_SECRET = 'dev-only-insecure-ledger-secret-change-me';

export const config = {
  port: Number(process.env.PORT) || 8080,
  env: process.env.NODE_ENV || 'development',
  // Supabase → Project Settings → Database → Connection string (URI). Empty = local file store.
  databaseUrl: process.env.DATABASE_URL || '',
  localDbFile: process.env.LOCAL_DB_FILE || path.join(ROOT, 'data', 'local-ledger.json'),
  // Every signing key (node + actors) is derived from this secret. Rotating it invalidates the chain.
  ledgerSecret: process.env.LEDGER_SECRET || DEV_SECRET,
  adminApiKey: process.env.ADMIN_API_KEY || 'gt_admin_dev_key',
  // Password for username "admin". Empty = admin signs in with the API key only.
  adminPassword: process.env.ADMIN_PASSWORD || '',
  demoMode: (process.env.DEMO_MODE ?? 'true') === 'true',
  powDifficulty: Math.min(Math.max(Number(process.env.POW_DIFFICULTY) || 3, 1), 5),
  publicAppUrl: (process.env.PUBLIC_APP_URL || 'http://localhost:5173').replace(/\/$/, ''),
  corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()),
  nodeId: process.env.NODE_ID || 'geneatrace-node-1',
  // Optional email alerts (resend.com). Empty = webhooks and in-app alerts only.
  resendApiKey: process.env.RESEND_API_KEY || '',
  emailFrom: process.env.EMAIL_FROM || 'GeneaTrace <alerts@geneatrace.app>',
  // Ethereum anchoring: on when RPC URL, anchoring wallet key and contract address are all set.
  eth: {
    rpcUrl: process.env.ETH_RPC_URL || '',
    privateKey: process.env.ETH_PRIVATE_KEY || '',
    contract: process.env.ETH_CONTRACT_ADDRESS || '',
    chainId: Number(process.env.ETH_CHAIN_ID) || null,
    explorerUrl: (process.env.ETH_EXPLORER_URL || '').replace(/\/$/, ''),
    intervalMs: Math.max(Number(process.env.ETH_ANCHOR_INTERVAL_MS) || 5000, 1000),
    batch: Math.min(Math.max(Number(process.env.ETH_ANCHOR_BATCH) || 50, 1), 200),
  },
};
config.eth.enabled = !!(config.eth.rpcUrl && config.eth.privateKey && config.eth.contract);

// Checked when the server boots, not on import: `next build` loads this module in production
// mode on a build machine that has no secrets.
export function assertProductionConfig() {
  if (config.env !== 'production') return;
  if (config.ledgerSecret === DEV_SECRET) throw new Error('LEDGER_SECRET must be set in production');
  if (config.adminApiKey === 'gt_admin_dev_key') throw new Error('ADMIN_API_KEY must be set in production (the default key is public)');
}
