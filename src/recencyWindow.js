'use strict';

/**
 * Sliding-window recency tracker. Time is sliced into fixed buckets held in a
 * ring; a query's "recent" weight is the sum of its hits across the live
 * buckets. When time advances we clear the buckets that scrolled off the back
 * and subtract them from a rolling aggregate, so:
 *
 *   - recentCount() and top() are O(1) / O(active) - no per-read decay math, and
 *   - a one-off spike naturally ages out once it leaves the window, which is
 *     exactly what stops a briefly-popular query from being over-ranked forever.
 *
 * `nowFn` is injectable so tests can travel through time deterministically.
 */
class RecencyWindow {
  constructor(opts = {}) {
    this.buckets = opts.buckets ?? 60;
    this.bucketMs = opts.bucketMs ?? 10000;
    this.now = opts.nowFn ?? Date.now;
    this.ring = Array.from({ length: this.buckets }, () => new Map());
    this.agg = new Map(); // query -> summed hits across all live buckets
    this.epoch = Math.floor(this.now() / this.bucketMs);
  }

  windowMs() {
    return this.buckets * this.bucketMs;
  }

  _advance() {
    const epoch = Math.floor(this.now() / this.bucketMs);
    let steps = epoch - this.epoch;
    if (steps <= 0) return;
    steps = Math.min(steps, this.buckets); // more than a full window away => clear everything
    for (let s = 1; s <= steps; s++) {
      const idx = (this.epoch + s) % this.buckets;
      const bucket = this.ring[idx];
      for (const [q, c] of bucket) {
        const left = (this.agg.get(q) || 0) - c;
        if (left > 0) this.agg.set(q, left);
        else this.agg.delete(q);
      }
      bucket.clear();
    }
    this.epoch = epoch;
  }

  record(query, n = 1) {
    this._advance();
    const bucket = this.ring[this.epoch % this.buckets];
    bucket.set(query, (bucket.get(query) || 0) + n);
    this.agg.set(query, (this.agg.get(query) || 0) + n);
  }

  recentCount(query) {
    this._advance();
    return this.agg.get(query) || 0;
  }

  top(n) {
    this._advance();
    return [...this.agg.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([query, recent]) => ({ query, recent }));
  }

  activeWithPrefix(prefix) {
    this._advance();
    const out = [];
    for (const q of this.agg.keys()) if (q.startsWith(prefix)) out.push(q);
    return out;
  }

  get activeSize() {
    return this.agg.size;
  }
}

module.exports = { RecencyWindow };
