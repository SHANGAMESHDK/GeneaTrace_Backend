import { ethers } from 'ethers';
import { config } from '../config.js';
import { nowIso } from '../util.js';
import { GENEATRACE_ANCHOR_ABI } from './abi/GeneaTraceAnchor.js';

const NETWORKS = {
  1: { name: 'Ethereum mainnet', explorer: 'https://etherscan.io' },
  11155111: { name: 'Sepolia testnet', explorer: 'https://sepolia.etherscan.io' },
  17000: { name: 'Holesky testnet', explorer: 'https://holesky.etherscan.io' },
  31337: { name: 'Local Hardhat chain', explorer: '' },
};
const hex = (h) => (h.startsWith('0x') ? h : `0x${h}`).toLowerCase();

/**
 * Anchors every ledger block hash into the GeneaTraceAnchor contract on Ethereum, strictly in
 * height order, and checks the database against those anchors. Supabase keeps the full detail;
 * Ethereum keeps the tamper-proof fingerprint.
 */
export class EthereumAnchor {
  constructor(store, ledger, cfg = config.eth) {
    this.store = store;
    this.ledger = ledger;
    this.cfg = cfg;
    this.provider = new ethers.JsonRpcProvider(cfg.rpcUrl, cfg.chainId || undefined, cfg.chainId ? { staticNetwork: true } : undefined);
    this.wallet = new ethers.Wallet(cfg.privateKey, this.provider);
    this.contract = new ethers.Contract(cfg.contract, GENEATRACE_ANCHOR_ABI, this.wallet);
    this.state = { status: 'starting', anchored: 0, chain_id: cfg.chainId, contract: cfg.contract, wallet: this.wallet.address, last_tx: null, last_error: null, checked_at: null };
    this.busy = false;
    this.timer = null;
  }

  get network() {
    const n = NETWORKS[this.state.chain_id] || { name: `Chain ${this.state.chain_id}`, explorer: '' };
    return { ...n, explorer: this.cfg.explorerUrl || n.explorer };
  }

  txUrl(hash) {
    return this.network.explorer && hash ? `${this.network.explorer}/tx/${hash}` : null;
  }

  async init() {
    try {
      const net = await this.provider.getNetwork();
      this.state.chain_id = Number(net.chainId);
      if ((await this.provider.getCode(this.cfg.contract)) === '0x') return this.fail('no_contract', `No contract at ${this.cfg.contract} on this network – run the deploy script`);
      const owner = await this.contract.owner();
      if (owner.toLowerCase() !== this.wallet.address.toLowerCase()) return this.fail('not_owner', `Wallet ${this.wallet.address} is not the contract owner (${owner})`);
      this.state.status = 'ready';
    } catch (e) {
      this.fail('unreachable', e.shortMessage || e.message);
    }
    return this.state;
  }

  fail(status, message) {
    this.state.status = status;
    this.state.last_error = message;
    return this.state;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.cfg.intervalMs);
    this.timer.unref?.();
    this.tick();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Called after every sealed block: anchor soon rather than waiting for the next interval. */
  nudge() {
    if (this.timer) setTimeout(() => this.tick(), 200).unref?.();
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (['starting', 'unreachable', 'no_contract'].includes(this.state.status)) await this.init();
      if (['ready', 'syncing', 'synced'].includes(this.state.status)) await this.syncOnce();
    } catch (e) {
      this.state.last_error = e.shortMessage || e.message;
      if (/ECONNREFUSED|network|fetch failed/i.test(this.state.last_error)) this.state.status = 'unreachable';
    } finally {
      this.state.checked_at = nowIso();
      this.busy = false;
    }
  }

  /** Anchors the next run of unanchored blocks. Returns how many were anchored. */
  async syncOnce() {
    const count = Number(await this.contract.anchoredCount());
    this.state.anchored = count;
    const total = (this.ledger.tip?.id ?? -1) + 1;
    if (count > total) {
      this.fail('ahead', `Contract holds ${count} anchors but the ledger has ${total} blocks – the database was reset; deploy a fresh contract`);
      return 0;
    }
    if (count === total) {
      this.state.status = 'synced';
      return 0;
    }
    this.state.status = 'syncing';
    const blocks = await this.store.list('blocks', { gte: { id: count }, order: [['id', 'asc']], limit: this.cfg.batch, columns: ['id', 'hash', 'merkle_root', 'tx_count'] });
    const run = blocks.filter((b, i) => b.id === count + i);
    if (!run.length) return 0;
    const tx = await this.contract.anchorBlocks(count, run.map((b) => hex(b.hash)), run.map((b) => hex(b.merkle_root)), run.map((b) => b.tx_count));
    const receipt = await tx.wait();
    const at = nowIso();
    await this.store.insert('anchors', run.map((b) => ({
      id: this.anchorId(b.id), height: b.id, block_hash: b.hash, chain_id: this.state.chain_id, contract: this.cfg.contract.toLowerCase(),
      tx_hash: receipt.hash, eth_block: receipt.blockNumber, anchored_at: at,
    })));
    this.state.anchored = count + run.length;
    this.state.last_tx = receipt.hash;
    this.state.last_error = null;
    this.state.status = this.state.anchored === total ? 'synced' : 'syncing';
    return run.length;
  }

  /** Anchor everything outstanding (used by the seed script). */
  async drain({ timeoutMs = 120_000 } = {}) {
    const end = Date.now() + timeoutMs;
    if (['starting', 'unreachable', 'no_contract'].includes(this.state.status)) await this.init();
    while (Date.now() < end && ['ready', 'syncing', 'synced'].includes(this.state.status)) {
      const n = await this.syncOnce();
      if (!n && this.state.status === 'synced') break;
    }
    return this.state;
  }

  anchorId(height) {
    return `${this.state.chain_id}:${this.cfg.contract.toLowerCase()}:${height}`;
  }

  async receipts(heights) {
    if (!heights.length) return new Map();
    const rows = await this.store.list('anchors', { whereIn: { id: heights.map((h) => this.anchorId(h)) } });
    return new Map(rows.map((r) => [r.height, { ...r, eth_block: Number(r.eth_block), tx_url: this.txUrl(r.tx_hash) }]));
  }

  async onchainRange(from, count) {
    const out = [];
    for (let i = from; i < from + count; i += 500) {
      const part = await this.contract.anchorsFrom(i, Math.min(500, from + count - i));
      out.push(...part.map((h) => h.toLowerCase()));
      if (part.length < Math.min(500, from + count - i)) break;
    }
    return out;
  }

  /** Compares the given blocks with their on-chain anchors. */
  async check(blocks) {
    if (!blocks.length) return { anchored: 0, of: 0, mismatches: [], pending: [] };
    const sorted = [...blocks].sort((a, b) => a.id - b.id);
    const from = sorted[0].id;
    const hashes = await this.onchainRange(from, sorted.at(-1).id - from + 1);
    const mismatches = [];
    const pending = [];
    let anchored = 0;
    for (const b of sorted) {
      const onchain = hashes.at(b.id - from);
      if (!onchain || onchain === ethers.ZeroHash) pending.push(b.id);
      else if (onchain !== hex(b.hash)) mismatches.push(b.id);
      else anchored++;
    }
    return { anchored, of: sorted.length, mismatches, pending };
  }

  /** Whole-chain check used by GET /api/chain/verify. */
  async verify(blocks) {
    const issues = [];
    let anchored = 0;
    try {
      anchored = Number(await this.contract.anchoredCount());
      const hashes = await this.onchainRange(0, anchored);
      const byId = new Map(blocks.map((b) => [b.id, b]));
      hashes.forEach((h, height) => {
        const b = byId.get(height);
        if (!b) issues.push({ height, problem: `Block #${height} is anchored on Ethereum but missing from the database` });
        else if (h !== hex(b.hash)) issues.push({ height, problem: `Block #${height} differs from its Ethereum anchor (database was altered)` });
      });
    } catch (e) {
      return { ...this.summary(), error: e.shortMessage || e.message, issues };
    }
    return { ...this.summary(), anchored, total: blocks.length, pending: Math.max(blocks.length - anchored, 0), issues };
  }

  summary() {
    return {
      enabled: true,
      status: this.state.status,
      network: this.network.name,
      chain_id: this.state.chain_id,
      contract: this.cfg.contract,
      contract_url: this.network.explorer ? `${this.network.explorer}/address/${this.cfg.contract}` : null,
      wallet: this.wallet.address,
      anchored: this.state.anchored,
      last_tx: this.state.last_tx,
      last_tx_url: this.txUrl(this.state.last_tx),
      last_error: this.state.last_error,
      checked_at: this.state.checked_at,
    };
  }
}
