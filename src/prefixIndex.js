'use strict';

/**
 * In-memory prefix index backed by a lexicographically SORTED ARRAY (not a
 * trie). Every query starting with a prefix forms a contiguous slice of that
 * array, which we locate with binary search. To avoid rescanning a huge slice
 * for short, hot prefixes ("a", "ip", ...), prefixes up to `precomputeLen` keep
 * a maintained top-K bucket that is updated incrementally as counts change.
 *
 *   entries  : [{ q, c }]  sorted by q ascending           (membership + range scans)
 *   byQuery  : Map q -> entry ref                            (O(1) count updates)
 *   short    : Map prefix(<=precomputeLen) -> entry refs[]   (desc by c, capped)
 */
class PrefixIndex {
  constructor(opts = {}) {
    this.precomputeLen = opts.precomputeLen ?? 3;
    this.poolKeep = Math.max(opts.poolSize ?? 60, (opts.suggestLimit ?? 10) * 2);
    this.maxScan = opts.maxScan ?? 50000;
    this.entries = [];
    this.byQuery = new Map();
    this.short = new Map();
  }

  build(rows) {
    this.entries = rows.map((r) => ({ q: r.query, c: r.count }));
    this.entries.sort((a, b) => (a.q < b.q ? -1 : a.q > b.q ? 1 : 0));
    this.byQuery = new Map(this.entries.map((e) => [e.q, e]));
    this._buildShort();
  }

  // Group every entry into its prefix buckets once, then sort + trim each bucket.
  _buildShort() {
    this.short.clear();
    for (const e of this.entries) {
      const maxL = Math.min(e.q.length, this.precomputeLen);
      for (let L = 1; L <= maxL; L++) {
        const p = e.q.slice(0, L);
        let arr = this.short.get(p);
        if (!arr) {
          arr = [];
          this.short.set(p, arr);
        }
        arr.push(e);
      }
    }
    for (const arr of this.short.values()) {
      arr.sort((a, b) => b.c - a.c);
      if (arr.length > this.poolKeep) arr.length = this.poolKeep;
    }
  }

  get size() {
    return this.entries.length;
  }

  get(query) {
    return this.byQuery.get(query);
  }

  // first index with entries[i].q >= target
  _lowerBound(target) {
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.entries[mid].q < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  _insertSorted(entry) {
    this.entries.splice(this._lowerBound(entry.q), 0, entry);
  }

  /**
   * Increment a query's count, creating the entry if it is new. Short-prefix
   * buckets are repaired incrementally so they stay correct without a rebuild.
   */
  bump(query, delta = 1) {
    let e = this.byQuery.get(query);
    let isNew = false;
    if (!e) {
      e = { q: query, c: 0 };
      this.byQuery.set(query, e);
      this._insertSorted(e); // O(n) splice, but new queries are rare vs repeats
      isNew = true;
    }
    e.c += delta;
    const maxL = Math.min(query.length, this.precomputeLen);
    for (let L = 1; L <= maxL; L++) this._reoffer(query.slice(0, L), e);
    return { isNew, count: e.c };
  }

  _reoffer(prefix, e) {
    let arr = this.short.get(prefix);
    if (!arr) {
      arr = [];
      this.short.set(prefix, arr);
    }
    if (!arr.includes(e)) {
      if (arr.length >= this.poolKeep && e.c <= arr[arr.length - 1].c) return; // would not make the cut
      arr.push(e);
    }
    arr.sort((a, b) => b.c - a.c);
    if (arr.length > this.poolKeep) arr.length = this.poolKeep;
  }

  /**
   * Candidate pool for a prefix: up to `pool` entry refs, descending by count.
   * Short prefixes are served from the maintained bucket; longer prefixes scan
   * their (small) contiguous slice and partial-sort the top `pool`.
   */
  matchPool(prefix, pool) {
    if (prefix.length <= this.precomputeLen) {
      const arr = this.short.get(prefix);
      return arr ? arr.slice(0, pool) : [];
    }
    const out = [];
    let scanned = 0;
    for (let i = this._lowerBound(prefix); i < this.entries.length; i++) {
      const e = this.entries[i];
      if (!e.q.startsWith(prefix)) break;
      out.push(e);
      if (++scanned >= this.maxScan) break;
    }
    out.sort((a, b) => b.c - a.c);
    return out.slice(0, pool);
  }
}

module.exports = { PrefixIndex };
