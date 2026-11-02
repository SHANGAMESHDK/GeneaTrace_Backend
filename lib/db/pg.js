import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { ROOT } from '../config.js';
import { JSON_COLUMNS } from './query.js';

const SCHEMA = 'geneatrace';
const IDENT = /^[a-z_][a-z0-9_]*$/;
const id = (s) => {
  if (!IDENT.test(s)) throw new Error(`Invalid identifier: ${s}`);
  return `"${s}"`;
};
const T = (table) => `${SCHEMA}.${id(table)}`;

/** Supabase Postgres store. Talks straight to the database over the pooler connection string. */
export class PgStore {
  kind = 'supabase';

  constructor(url, client = null) {
    this.client = client;
    if (!client) {
      const local = /localhost|127\.0\.0\.1/.test(url);
      this.pool = new pg.Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 8 });
      this.pool.on('error', (e) => console.error('[pg] idle client error', e.message));
    }
  }

  q(text, params) {
    return (this.client || this.pool).query(text, params);
  }

  async init() {
    const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '0001_geneatrace.sql'), 'utf8');
    await this.q(sql);
  }

  norm(table, row) {
    for (const k of ['created_at', 'updated_at', 'resolved_at']) if (row[k] instanceof Date) row[k] = row[k].toISOString();
    return row;
  }

  ser(table, col, v) {
    return (JSON_COLUMNS[table] || []).includes(col) && v != null ? JSON.stringify(v) : v;
  }

  async insert(table, rows) {
    const list = Array.isArray(rows) ? rows : [rows];
    const out = [];
    for (let i = 0; i < list.length; i += 400) {
      const chunk = list.slice(i, i + 400);
      const cols = [...new Set(chunk.flatMap(Object.keys))];
      const params = [];
      const values = chunk.map((r) => `(${cols.map((c) => (c in r ? `$${params.push(this.ser(table, c, r[c]))}` : 'DEFAULT')).join(',')})`);
      const res = await this.q(`insert into ${T(table)} (${cols.map(id).join(',')}) values ${values.join(',')} returning *`, params);
      out.push(...res.rows.map((r) => this.norm(table, r)));
    }
    return out;
  }

  async update(table, rowId, patch) {
    const cols = Object.keys(patch);
    const params = [rowId];
    const sets = cols.map((c) => `${id(c)} = $${params.push(this.ser(table, c, patch[c]))}`);
    if (table === 'products' || table === 'tickets') sets.push('updated_at = now()');
    const res = await this.q(`update ${T(table)} set ${sets.join(', ')} where id = $1 returning *`, params);
    return res.rows[0] ? this.norm(table, res.rows[0]) : null;
  }

  /** One round trip for any number of custody updates. */
  async saveProducts(products) {
    if (!products.length) return;
    const payload = products.map(({ id: pid, status, custodian_id, facility_id, pending_to, attributes, last_tx, sold_at }) => ({
      id: pid, status, custodian_id, facility_id, pending_to, attributes, last_tx, sold_at,
    }));
    await this.q(
      `update ${T('products')} p set status = v.status, custodian_id = v.custodian_id, facility_id = v.facility_id,
         pending_to = v.pending_to, attributes = v.attributes, last_tx = v.last_tx, sold_at = v.sold_at, updated_at = now()
       from jsonb_to_recordset($1::jsonb) as v(id text, status text, custodian_id text, facility_id text, pending_to text,
         attributes jsonb, last_tx text, sold_at text)
       where p.id = v.id`,
      [JSON.stringify(payload)],
    );
  }

  async increment(table, rowId, column) {
    await this.q(`update ${T(table)} set ${id(column)} = ${id(column)} + 1 where id = $1`, [rowId]);
  }

  /** Attempts a raw edit. On Supabase the append-only trigger rejects it – which is the point. */
  async unsafeUpdate(table, rowId, patch) {
    return this.update(table, rowId, patch);
  }

  async get(table, rowId) {
    const res = await this.q(`select * from ${T(table)} where id = $1`, [rowId]);
    return res.rows[0] ? this.norm(table, res.rows[0]) : null;
  }

  where(opts, params) {
    const cl = [];
    for (const [k, v] of Object.entries(opts.where || {})) cl.push(v === null ? `${id(k)} is null` : `${id(k)} = $${params.push(v)}`);
    for (const [k, arr] of Object.entries(opts.whereIn || {})) cl.push(arr.length ? `${id(k)} = any($${params.push(arr)})` : 'false');
    for (const [k, v] of Object.entries(opts.gte || {})) cl.push(`${id(k)} >= $${params.push(v)}`);
    for (const [k, v] of Object.entries(opts.lte || {})) cl.push(`${id(k)} <= $${params.push(v)}`);
    if (opts.search?.q) {
      const p = `$${params.push(`%${opts.search.q}%`)}`;
      cl.push(`(${opts.search.cols.map((c) => `${id(c)}::text ilike ${p}`).join(' or ')})`);
    }
    return cl.length ? ` where ${cl.join(' and ')}` : '';
  }

  async list(table, opts = {}) {
    const params = [];
    const cols = opts.columns ? opts.columns.map(id).join(',') : '*';
    let sql = `select ${cols} from ${T(table)}${this.where(opts, params)}`;
    if (opts.order) sql += ` order by ${opts.order.map(([c, d]) => `${id(c)} ${d === 'desc' ? 'desc' : 'asc'}`).join(', ')}`;
    if (opts.limit != null) sql += ` limit ${Number(opts.limit)}`;
    if (opts.offset) sql += ` offset ${Number(opts.offset)}`;
    const res = await this.q(sql, params);
    return res.rows.map((r) => this.norm(table, r));
  }

  async count(table, opts = {}) {
    const params = [];
    const res = await this.q(`select count(*)::int as n from ${T(table)}${this.where(opts, params)}`, params);
    return res.rows[0].n;
  }

  async tx(fn) {
    if (this.client) return fn(this);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const out = await fn(new PgStore(null, client));
      await client.query('commit');
      return out;
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool?.end();
  }
}
