// Writes every table to one JSON file with a SHA-256, so a copy of the ledger exists outside the
// database. Usage (from backend/): npm run backup -- [output-folder]
// The file holds customer details from the sales table: store it encrypted.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { boot } from '../lib/boot.js';
import { ctx } from '../lib/context.js';
import { TABLES } from '../lib/db/query.js';

await boot({ ethereum: false });
const tables = {};
for (const t of TABLES) tables[t] = await ctx.store.list(t);
const tip = ctx.ledger.tip && { height: ctx.ledger.tip.id, hash: ctx.ledger.tip.hash };
const body = JSON.stringify({ created_at: new Date().toISOString(), tip, tables });
const dir = process.argv[2] || 'backups';
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `geneatrace-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(file, body);
console.log(`${file}\nsha256 ${crypto.createHash('sha256').update(body).digest('hex')}`);
process.exit(0);
