import { config } from '../config.js';
import { LocalStore } from './local.js';
import { PgStore } from './pg.js';

export async function createStore(opts = {}) {
  const url = opts.databaseUrl ?? config.databaseUrl;
  const store = url ? new PgStore(url) : new LocalStore(opts.file === undefined ? config.localDbFile : opts.file);
  await store.init();
  return store;
}
