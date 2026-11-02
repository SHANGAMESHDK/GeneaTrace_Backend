// Wipes the GeneaTrace ledger. Supabase: drops only the `geneatrace` schema. Local: deletes the file.
// Usage (from backend/): npm run reset -- --yes
import fs from 'node:fs';
import pg from 'pg';
import { config } from '../lib/config.js';

if (!process.argv.includes('--yes')) {
  console.log('This permanently deletes the GeneaTrace ledger. Re-run with: npm run reset -- --yes');
  process.exit(1);
}
if (config.databaseUrl) {
  const local = /localhost|127\.0\.0\.1/.test(config.databaseUrl);
  const c = new pg.Client({ connectionString: config.databaseUrl, ssl: local ? false : { rejectUnauthorized: false } });
  await c.connect();
  await c.query('drop schema if exists geneatrace cascade');
  await c.end();
  console.log('Dropped schema "geneatrace" on Supabase. It is recreated on next start.');
} else {
  fs.rmSync(config.localDbFile, { force: true });
  console.log(`Deleted ${config.localDbFile}`);
}
if (config.eth.enabled) {
  console.log('Note: Ethereum anchors are permanent. The contract still holds anchors for the old chain,');
  console.log('so deploy a fresh contract before seeding again: npm run chain:deploy (from geneatrace-platform).');
}
