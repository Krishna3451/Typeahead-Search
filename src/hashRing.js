'use strict';

/**
 * MurmurHash3 (x86, 32-bit). We use it for both ring positions and key
 * placement, so all that matters is a strong, uniform bit avalanche - which
 * Murmur3 gives us even for the short, near-identical strings we hash for
 * virtual-node positions ("cache-0#vn0", "cache-0#vn1", ...). A weaker hash
 * clusters those positions and unbalances the ring.
 */
function murmur3_32(key, seed = 0) {
  let h = seed >>> 0;
  const len = key.length;
  const blocks = len & ~3;
  let i = 0;
  for (; i < blocks; i += 4) {
    let k =
      (key.charCodeAt(i) & 0xff) |
      ((key.charCodeAt(i + 1) & 0xff) << 8) |
      ((key.charCodeAt(i + 2) & 0xff) << 16) |
      ((key.charCodeAt(i + 3) & 0xff) << 24);
    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  let k = 0;
  switch (len & 3) {
    case 3:
      k ^= (key.charCodeAt(i + 2) & 0xff) << 16;
    // falls through
    case 2:
      k ^= (key.charCodeAt(i + 1) & 0xff) << 8;
    // falls through
    case 1:
      k ^= key.charCodeAt(i) & 0xff;
      k = Math.imul(k, 0xcc9e2d51);
      k = (k << 15) | (k >>> 17);
      k = Math.imul(k, 0x1b873593);
      h ^= k;
  }
  h ^= len;
  // fmix32 finalizer - this is what gives Murmur3 its avalanche
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Consistent-hash ring with virtual nodes. Each logical node is placed at
 * `replicas` positions on the ring; a key is owned by the first ring point
 * walking clockwise from hash(key), wrapping back to the start at the top.
 * Adding or removing a node only re-homes the keys sitting on the arcs that
 * node covered, instead of reshuffling everything (which `hash % N` would do).
 */
class HashRing {
  constructor(replicas = 120) {
    this.replicas = replicas;
    this.points = []; // [{ hash, node }] kept sorted by hash ascending
    this.nodes = new Set();
  }

  addNode(node) {
    if (this.nodes.has(node)) return;
    this.nodes.add(node);
    for (let i = 0; i < this.replicas; i++) {
      this.points.push({ hash: murmur3_32(`${node}#vn${i}`), node });
    }
    this.points.sort((a, b) => a.hash - b.hash);
  }

  removeNode(node) {
    if (!this.nodes.has(node)) return;
    this.nodes.delete(node);
    this.points = this.points.filter((p) => p.node !== node);
  }

  // index of the first ring point with hash >= h (wrapping to 0 at the top).
  _slot(h) {
    const pts = this.points;
    let lo = 0;
    let hi = pts.length - 1;
    if (h > pts[hi].hash) return 0;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].hash < h) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  getNode(key) {
    if (this.points.length === 0) return null;
    return this.points[this._slot(murmur3_32(key))].node;
  }

  // full routing detail, used by the /cache/debug endpoint.
  locate(key) {
    if (this.points.length === 0) return null;
    const keyHash = murmur3_32(key);
    const slot = this._slot(keyHash);
    const p = this.points[slot];
    return { key, keyHash, node: p.node, slotHash: p.hash, slotIndex: slot };
  }

  // owner counts for a batch of keys - used to demonstrate balanced placement.
  distribution(keys) {
    const dist = {};
    for (const n of this.nodes) dist[n] = 0;
    for (const k of keys) dist[this.getNode(k)]++;
    return dist;
  }
}

module.exports = { HashRing, murmur3_32 };
