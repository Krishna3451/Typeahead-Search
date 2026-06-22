'use strict';

const { HashRing } = require('./hashRing');

/**
 * One logical cache node: an LRU map with per-entry TTL. A JS Map preserves
 * insertion order, which gives us LRU almost for free - re-insert a key on hit
 * to mark it most-recently-used, and evict the oldest key (the first one the
 * iterator yields) when we exceed capacity.
 */
class CacheNode {
  constructor(id, capacity) {
    this.id = id;
    this.capacity = capacity;
    this.store = new Map(); // key -> { value, expires }
  }

  get(key, now) {
    const e = this.store.get(key);
    if (e === undefined) return undefined;
    if (e.expires <= now) {
      this.store.delete(key);
      return undefined;
    }
    this.store.delete(key); // touch: move to most-recently-used position
    this.store.set(key, e);
    return e.value;
  }

  peek(key, now) {
    const e = this.store.get(key);
    if (e === undefined) return undefined;
    if (e.expires <= now) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  set(key, value, ttlMs, now) {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expires: now + ttlMs });
    if (this.store.size > this.capacity) {
      this.store.delete(this.store.keys().next().value); // evict oldest
    }
  }

  delete(key) {
    return this.store.delete(key);
  }

  get size() {
    return this.store.size;
  }
}

/**
 * A pool of logical cache nodes fronted by a consistent-hash ring. Each prefix
 * key deterministically belongs to exactly one node; the /cache/debug endpoint
 * exposes that routing. Swapping these in-process nodes for real Redis/memcached
 * processes would not change anything above this layer.
 */
class CachePool {
  constructor(opts, stats) {
    this.stats = stats;
    this.ttlMs = opts.ttlMs;
    this.trendingTtlMs = opts.trendingTtlMs;
    this.jitter = opts.jitter;
    this.invalidateMaxLen = opts.invalidateMaxLen;
    this.ring = new HashRing(opts.replicas);
    this.nodes = new Map();
    for (let i = 0; i < opts.nodeCount; i++) {
      const id = `cache-${i}`;
      this.ring.addNode(id);
      this.nodes.set(id, new CacheNode(id, opts.capacity));
    }
  }

  keyOf(prefix, mode) {
    return `${mode}:${prefix}`;
  }

  _node(cacheKey) {
    return this.nodes.get(this.ring.getNode(cacheKey));
  }

  _ttl(mode) {
    const base = mode === 'trending' ? this.trendingTtlMs : this.ttlMs;
    const delta = base * this.jitter;
    return Math.max(1, Math.round(base + (Math.random() * 2 - 1) * delta));
  }

  get(prefix, mode) {
    const key = this.keyOf(prefix, mode);
    const node = this._node(key);
    const value = node.get(key, Date.now());
    if (value === undefined) {
      this.stats.inc('cacheMisses');
      return { value: null, node: node.id, hit: false };
    }
    this.stats.inc('cacheHits');
    return { value, node: node.id, hit: true };
  }

  set(prefix, mode, value) {
    const key = this.keyOf(prefix, mode);
    const node = this._node(key);
    node.set(key, value, this._ttl(mode), Date.now());
    return node.id;
  }

  /**
   * Targeted invalidation: drop cached suggestions for every prefix touched by
   * the just-flushed queries, in both ranking modes. Bounded by invalidateMaxLen
   * so one long query cannot invalidate an unbounded number of keys. This is
   * what keeps suggestions consistent with new counts without waiting for TTL.
   */
  invalidateForQueries(queries) {
    const prefixes = new Set();
    for (const q of queries) {
      const maxL = Math.min(q.length, this.invalidateMaxLen);
      for (let L = 1; L <= maxL; L++) prefixes.add(q.slice(0, L));
    }
    let removed = 0;
    for (const p of prefixes) {
      for (const mode of ['popular', 'trending']) {
        const key = this.keyOf(p, mode);
        if (this._node(key).delete(key)) removed++;
      }
    }
    return removed;
  }

  debug(prefix, mode) {
    const key = this.keyOf(prefix, mode);
    const loc = this.ring.locate(key);
    const node = this.nodes.get(loc.node);
    const entry = node.peek(key, Date.now());
    return {
      prefix,
      mode,
      cacheKey: key,
      keyHash: loc.keyHash,
      ownerNode: loc.node,
      ringSlotHash: loc.slotHash,
      status: entry ? 'hit' : 'miss',
      ttlRemainingMs: entry ? Math.max(0, entry.expires - Date.now()) : null,
    };
  }

  distribution(keys) {
    return this.ring.distribution(keys);
  }

  nodeSizes() {
    const out = {};
    for (const [id, node] of this.nodes) out[id] = node.size;
    return out;
  }

  get nodeIds() {
    return [...this.nodes.keys()];
  }
}

module.exports = { CachePool, CacheNode };
