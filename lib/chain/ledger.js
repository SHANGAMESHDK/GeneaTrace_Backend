import crypto from 'node:crypto';
import { config } from '../config.js';
import { HttpError, nowIso, sha256, groupBy } from '../util.js';
import { canonical, sign, verifySig, nodeKey, actorKey } from './crypto.js';
import { merkleRoot, merkleProof, verifyProof } from './merkle.js';

export const GENESIS_PREV = '0'.repeat(64);

// Network administration records. Everything else a company does needs its device signature
// once it has registered a device key.
const NOT_ATTESTED = new Set(['ACTOR_REGISTERED', 'FACILITY_REGISTERED', 'FACILITY_LICENSE', 'MACHINE_REGISTERED', 'BATCH_CREATED', 'SERIAL_ISSUED', 'KEY_REGISTERED', 'KEY_REVOKED', 'COMPANY_ATTESTATION']);

// Exactly the fields covered by a transaction hash. Anything else on the row is derived.
export function txCore(tx) {
  return {
    type: tx.type,
    product_id: tx.product_id ?? null,
    batch_id: tx.batch_id ?? null,
    actor_id: tx.actor_id ?? null,
    facility_id: tx.facility_id ?? null,
    data: tx.data ?? {},
    prev_tx: tx.prev_tx ?? null,
    salt: tx.salt,
    ts: tx.ts,
  };
}
export const txHash = (tx) => sha256(canonical(txCore(tx)));

export function blockHeader(b) {
  return {
    height: b.id,
    prev_hash: b.prev_hash,
    merkle_root: b.merkle_root,
    ts: b.ts,
    tx_count: b.tx_count,
    validator: b.validator,
    difficulty: b.difficulty,
    nonce: b.nonce,
  };
}
export const blockHash = (b) => sha256(canonical(blockHeader(b)));

function mine(block) {
  const target = '0'.repeat(block.difficulty);
  for (let nonce = 0; ; nonce++) {
    block.nonce = nonce;
    const h = blockHash(block);
    if (h.startsWith(target)) return h;
  }
}

export class Ledger {
  constructor(store) {
    this.store = store;
    this.tip = null;
    this.queue = Promise.resolve();
    this.anchor = null; // EthereumAnchor, when anchoring is configured
  }

  setAnchor(anchor) {
    this.anchor = anchor;
  }

  async init() {
    const [tip] = await this.store.list('blocks', { order: [['id', 'desc']], limit: 1 });
    this.tip = tip || null;
    if (!this.tip) await this.commit([], { note: 'genesis' });
  }

  /** Serialise every ledger write; validation must read state inside the lock. */
  lock(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * Seal drafts into one block. `apply(t, txs, block)` runs in the same DB transaction so
   * derived state (product custody, etc.) can never drift from what the chain says.
   * Must be called inside lock().
   */
  async commit(drafts, { apply, at } = {}) {
    // `at` back-dates the events (imports, seeding); blocks always seal at real time, monotonically.
    const ts = at || nowIso();
    const sealedAt = [nowIso(), this.tip?.ts || ''].sort().pop();
    const lastByProduct = new Map();
    const txs = drafts.map((d, seq) => {
      const pid = d.product_id ?? null;
      const tx = {
        type: d.type,
        product_id: pid,
        batch_id: d.batch_id ?? null,
        actor_id: d.actor_id ?? null,
        facility_id: d.facility_id ?? null,
        data: d.data ?? {},
        prev_tx: pid ? (lastByProduct.has(pid) ? lastByProduct.get(pid) : (d.prev_tx ?? null)) : null,
        salt: crypto.randomBytes(6).toString('hex'),
        ts,
      };
      tx.id = txHash(tx);
      tx.signature = sign(tx.actor_id ? actorKey(tx.actor_id) : nodeKey(), tx.id);
      tx.seq = seq;
      if (pid) lastByProduct.set(pid, tx.id);
      return tx;
    });

    const prev = this.tip;
    const block = {
      id: prev ? prev.id + 1 : 0,
      prev_hash: prev ? prev.hash : GENESIS_PREV,
      merkle_root: merkleRoot(txs.map((t) => t.id)),
      ts: sealedAt,
      tx_count: txs.length,
      validator: config.nodeId,
      difficulty: config.powDifficulty,
      nonce: 0,
    };
    block.hash = mine(block);
    block.signature = sign(nodeKey(), block.hash);
    for (const t of txs) t.block_height = block.id;

    try {
      await this.store.tx(async (t) => {
        await t.insert('blocks', block);
        if (txs.length) await t.insert('events', txs);
        if (apply) await apply(t, txs, block);
      });
    } catch (e) {
      if (e.code === '23505') {
        // Another node sealed this height first – resync and let the caller retry.
        const [tip] = await this.store.list('blocks', { order: [['id', 'desc']], limit: 1 });
        this.tip = tip;
        throw new HttpError(409, 'Ledger tip moved, please retry');
      }
      throw e;
    }
    this.tip = block;
    this.anchor?.nudge();
    return { block, txs };
  }

  /** Full audit: recompute every hash, signature, Merkle root and product link from raw rows. */
  async verify() {
    const started = Date.now();
    const [blocks, events, actors] = await Promise.all([
      this.store.list('blocks', { order: [['id', 'asc']] }),
      this.store.list('events', { order: [['block_height', 'asc'], ['seq', 'asc']] }),
      this.store.list('actors'),
    ]);
    const nodePub = nodeKey().publicKey;
    const byBlock = groupBy(events, (e) => e.block_height);
    const registered = new Map();
    const lastByProduct = new Map();
    const companyKeys = new Map();
    const usedNonces = new Set();
    const issues = [];
    let prev = null;

    for (const b of blocks) {
      const expected = prev ? prev.id + 1 : 0;
      if (b.id !== expected) issues.push({ height: b.id, problem: `Missing block(s) before height ${b.id}` });
      if (b.prev_hash !== (prev ? prev.hash : GENESIS_PREV)) issues.push({ height: b.id, problem: 'Broken link: prev_hash does not match previous block' });
      if (blockHash(b) !== b.hash) issues.push({ height: b.id, problem: 'Block header altered: hash mismatch' });
      if (!b.hash.startsWith('0'.repeat(b.difficulty))) issues.push({ height: b.id, problem: 'Proof-of-work not satisfied' });
      if (!verifySig(nodePub, b.hash, b.signature)) issues.push({ height: b.id, problem: 'Invalid validator signature' });

      const txs = byBlock.get(b.id) || [];
      if (txs.length !== b.tx_count) issues.push({ height: b.id, problem: `Expected ${b.tx_count} transactions, found ${txs.length}` });
      for (const tx of txs) {
        if (txHash(tx) !== tx.id) issues.push({ height: b.id, tx: tx.id, problem: 'Transaction content altered after sealing' });
        if (tx.type === 'ACTOR_REGISTERED') registered.set(tx.data.actor_id, tx.data.public_key);
        const pub = tx.actor_id ? registered.get(tx.actor_id) : nodePub;
        if (!pub) issues.push({ height: b.id, tx: tx.id, problem: `Signer ${tx.actor_id} was never registered on-chain` });
        else if (!verifySig(pub, tx.id, tx.signature)) issues.push({ height: b.id, tx: tx.id, problem: 'Invalid signer signature' });
        if (tx.product_id) {
          const expectPrev = lastByProduct.get(tx.product_id) ?? null;
          if ((tx.prev_tx ?? null) !== expectPrev) issues.push({ height: b.id, tx: tx.id, problem: `Product chain broken for ${tx.product_id}` });
          lastByProduct.set(tx.product_id, tx.id);
        }
      }
      const attested = new Set();
      for (const tx of txs) {
        if (!companyKeys.has(tx.actor_id)) companyKeys.set(tx.actor_id, new Set());
        const keys = companyKeys.get(tx.actor_id);
        if (tx.type === 'KEY_REGISTERED') keys.add(tx.data.public_key);
        if (tx.type === 'KEY_REVOKED') keys.delete(tx.data.public_key);
        if (tx.type !== 'COMPANY_ATTESTATION') continue;
        const { public_key: key, intent, signature } = tx.data;
        const fresh = !usedNonces.has(intent?.nonce);
        usedNonces.add(intent?.nonce);
        if (fresh && keys.has(key) && intent?.actor_id === tx.actor_id && verifySig(key, canonical(intent), signature)) attested.add(tx.actor_id);
        else issues.push({ height: b.id, tx: tx.id, problem: 'Invalid company device signature' });
      }
      for (const tx of txs) {
        if (tx.actor_id && companyKeys.get(tx.actor_id)?.size && !NOT_ATTESTED.has(tx.type) && !tx.type.startsWith('PROGRAM_') && !attested.has(tx.actor_id)) {
          issues.push({ height: b.id, tx: tx.id, problem: `Event by ${tx.actor_id} has no company device signature` });
        }
      }
      if (merkleRoot(txs.map((t) => t.id)) !== b.merkle_root) issues.push({ height: b.id, problem: 'Merkle root mismatch: transactions added, removed or edited' });
      prev = b;
    }
    for (const a of actors) {
      const reg = registered.get(a.id);
      if (reg && reg !== a.public_key) issues.push({ actor: a.id, problem: `Public key of ${a.name} substituted in database` });
    }
    return {
      valid: issues.length === 0,
      blocks: blocks.length,
      transactions: events.length,
      tip: prev ? { height: prev.id, hash: prev.hash } : null,
      issues,
      node_public_key: nodePub,
      checked_at: nowIso(),
      duration_ms: Date.now() - started,
    };
  }

  /** Fast per-product integrity check used by every passport view. */
  async verifyProduct(productId, events) {
    const issues = [];
    const heights = [...new Set(events.map((e) => e.block_height))];
    const [blocks, blockTxs, actors] = await Promise.all([
      this.store.list('blocks', { whereIn: { id: heights } }),
      this.store.list('events', { whereIn: { block_height: heights }, order: [['block_height', 'asc'], ['seq', 'asc']], columns: ['id', 'block_height', 'seq'] }),
      this.store.list('actors', { columns: ['id', 'public_key'] }),
    ]);
    const blockMap = new Map(blocks.map((b) => [b.id, b]));
    const txByBlock = groupBy(blockTxs, (e) => e.block_height);
    const keys = new Map(actors.map((a) => [a.id, a.public_key]));
    const nodePub = nodeKey().publicKey;
    let prevId = null;
    for (const tx of events) {
      if (txHash(tx) !== tx.id) issues.push(`Event ${tx.type} at block #${tx.block_height} was altered`);
      const pub = tx.actor_id ? keys.get(tx.actor_id) : nodePub;
      if (!verifySig(pub, tx.id, tx.signature)) issues.push(`Event ${tx.type} has an invalid signature`);
      if ((tx.prev_tx ?? null) !== prevId) issues.push(`Event ${tx.type} is not linked to the previous event`);
      prevId = tx.id;
      const b = blockMap.get(tx.block_height);
      if (!b) issues.push(`Block #${tx.block_height} missing`);
      else {
        if (blockHash(b) !== b.hash) issues.push(`Block #${b.id} header altered`);
        const ids = (txByBlock.get(b.id) || []).map((t) => t.id);
        if (merkleRoot(ids) !== b.merkle_root) issues.push(`Block #${b.id} Merkle root mismatch`);
      }
    }
    let ethereum = null;
    if (this.anchor) {
      try {
        ethereum = { ...(await this.anchor.check(blocks)), network: this.anchor.network.name };
        for (const h of ethereum.mismatches) issues.push(`Block #${h} differs from its Ethereum anchor`);
      } catch (e) {
        ethereum = { error: e.shortMessage || e.message, network: this.anchor.network.name };
      }
    }
    return { valid: issues.length === 0, issues, events: events.length, head: prevId, ethereum };
  }

  async proof(txId) {
    const tx = await this.store.get('events', txId);
    if (!tx) return null;
    const block = await this.store.get('blocks', tx.block_height);
    const ids = (await this.store.list('events', { where: { block_height: tx.block_height }, order: [['seq', 'asc']], columns: ['id'] })).map((t) => t.id);
    const path = merkleProof(ids, ids.indexOf(tx.id));
    return {
      tx_id: tx.id,
      block: { height: block.id, hash: block.hash, merkle_root: block.merkle_root, ts: block.ts, signature: block.signature },
      path,
      verified: verifyProof(tx.id, path, block.merkle_root) && txHash(tx) === tx.id,
      node_public_key: nodeKey().publicKey,
      ethereum: await this.anchorInfo(block),
    };
  }

  async anchorInfo(block) {
    if (!this.anchor) return null;
    try {
      const [check, receipts] = await Promise.all([this.anchor.check([block]), this.anchor.receipts([block.id])]);
      const r = receipts.get(block.id);
      return {
        network: this.anchor.network.name,
        chain_id: this.anchor.state.chain_id,
        contract: this.anchor.cfg.contract,
        status: check.mismatches.length ? 'mismatch' : check.anchored ? 'anchored' : 'pending',
        tx_hash: r?.tx_hash || null,
        tx_url: r?.tx_url || null,
        eth_block: r?.eth_block || null,
      };
    } catch (e) {
      return { network: this.anchor.network.name, status: 'unreachable', error: e.shortMessage || e.message };
    }
  }
}
