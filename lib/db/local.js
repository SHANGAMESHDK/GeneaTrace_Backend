import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from '../util.js';
import { APPEND_ONLY, TABLES, matches, sortRows, pickColumns } from './query.js';

/** JSON-file store with the same interface as PgStore. For offline dev and tests. */
export class LocalStore {
  kind = 'local';

  constructor(file) {
    this.file = file;
    this.data = {};
    this.timer = null;
  }

  async init() {
    if (this.file && fs.existsSync(this.file)) this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    for (const t of TABLES) this.data[t] ||= [];
    this.index = Object.fromEntries(TABLES.map((t) => [t, new Map(this.data[t].map((r) => [r.id, r]))]));
  }

  persist() {
    if (!this.file) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 150);
  }

  flush() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  async insert(table, rows) {
    const list = Array.isArray(rows) ? rows : [rows];
    const idx = this.index[table];
    for (const r of list) if (idx.has(r.id)) throw Object.assign(new Error(`duplicate key ${r.id} in ${table}`), { code: '23505' });
    const out = list.map((r) => {
      const row = structuredClone({ created_at: nowIso(), ...r });
      this.data[table].push(row);
      idx.set(row.id, row);
      return structuredClone(row);
    });
    this.persist();
    return out;
  }

  async update(table, id, patch) {
    if (APPEND_ONLY.has(table)) throw Object.assign(new Error(`GeneaTrace ledger is append-only: UPDATE on ${table} is not allowed`), { code: 'P0001' });
    const row = this.index[table].get(id);
    if (!row) return null;
    Object.assign(row, structuredClone(patch));
    if ('updated_at' in row) row.updated_at = nowIso();
    this.persist();
    return structuredClone(row);
  }

  async saveProducts(products) {
    for (const p of products) {
      const { id, status, custodian_id, facility_id, pending_to, attributes, last_tx, sold_at } = p;
      await this.update('products', id, { status, custodian_id, facility_id, pending_to, attributes, last_tx, sold_at });
    }
  }

  async increment(table, id, column) {
    const row = this.index[table].get(id);
    if (row) row[column] = (row[column] || 0) + 1;
    this.persist();
  }

  /** Bypasses append-only protection. Only used by the tamper demo to prove detection works. */
  async unsafeUpdate(table, id, patch) {
    const row = this.index[table].get(id);
    if (!row) return null;
    Object.assign(row, patch);
    this.persist();
    return structuredClone(row);
  }

  async get(table, id) {
    const r = this.index[table].get(id);
    return r ? structuredClone(r) : null;
  }

  async list(table, opts = {}) {
    let rows = this.data[table].filter((r) => matches(r, opts));
    if (opts.order) rows = sortRows(rows, opts.order);
    const off = opts.offset || 0;
    if (opts.limit != null || off) rows = rows.slice(off, opts.limit != null ? off + opts.limit : undefined);
    return rows.map((r) => (opts.columns ? pickColumns(r, opts.columns) : structuredClone(r)));
  }

  async count(table, opts = {}) {
    return this.data[table].filter((r) => matches(r, opts)).length;
  }

  async tx(fn) {
    return fn(this);
  }

  async close() {
    clearTimeout(this.timer);
    this.flush();
  }
}
