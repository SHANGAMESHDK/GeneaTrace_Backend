import { ctx } from './context.js';
import { createStore } from './db/index.js';
import { Ledger } from './chain/ledger.js';
import { ensureAdmin } from './services/network.js';
import { config } from './config.js';
import { EthereumAnchor } from './chain/ethereum.js';

export async function boot(opts = {}) {
  ctx.store = await createStore(opts);
  ctx.ledger = new Ledger(ctx.store);
  await ctx.ledger.init();
  await ensureAdmin();
  ctx.ethereum = null;
  if (config.eth.enabled && opts.ethereum !== false) {
    ctx.ethereum = new EthereumAnchor(ctx.store, ctx.ledger);
    ctx.ledger.setAnchor(ctx.ethereum);
    // The worker connects in the background; the API never waits on Ethereum.
    if (opts.worker !== false) ctx.ethereum.start();
  }
  return ctx;
}

// One boot per server process. Kept on globalThis so Next.js dev reloads reuse it.
export function ready() {
  globalThis.__geneatraceBoot ||= boot().catch((e) => {
    globalThis.__geneatraceBoot = null;
    throw e;
  });
  return globalThis.__geneatraceBoot;
}
