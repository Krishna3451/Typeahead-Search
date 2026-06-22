'use strict';

function round(x, dp = 2) {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/**
 * Process-local metrics: monotonic counters plus a fixed-size ring buffer of
 * suggestion latencies used for percentile reporting. Cheap enough to live on
 * the hot path.
 */
class Stats {
  constructor(latencySamples = 5000) {
    this.startedAt = Date.now();
    this.lastFlushError = null;
    this.counters = {
      cacheHits: 0,
      cacheMisses: 0,
      dbReads: 0,
      dbWrites: 0, // rows written to the primary store
      flushBatches: 0, // number of flush transactions
      searchesAccepted: 0,
      newQueries: 0,
      suggestServed: 0,
    };
    this._cap = latencySamples;
    this._lat = new Float64Array(latencySamples);
    this._count = 0;
    this._pos = 0;
  }

  inc(name, by = 1) {
    this.counters[name] += by;
  }

  recordLatency(ms) {
    this._lat[this._pos] = ms;
    this._pos = (this._pos + 1) % this._cap;
    if (this._count < this._cap) this._count++;
  }

  percentiles() {
    const n = this._count;
    if (n === 0) return { samples: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
    const arr = Array.from(this._lat.subarray(0, n)).sort((a, b) => a - b);
    const at = (p) => arr[Math.min(n - 1, Math.floor(p * n))];
    const mean = arr.reduce((s, x) => s + x, 0) / n;
    return {
      samples: n,
      p50: round(at(0.5), 3),
      p95: round(at(0.95), 3),
      p99: round(at(0.99), 3),
      max: round(arr[n - 1], 3),
      mean: round(mean, 3),
    };
  }

  cacheHitRate() {
    const { cacheHits: h, cacheMisses: m } = this.counters;
    return h + m === 0 ? 0 : round(h / (h + m), 4);
  }

  // searches accepted per row actually written -> how much batching saved us.
  writeReduction() {
    const { searchesAccepted: s, dbWrites: w } = this.counters;
    return w === 0 ? 0 : round(s / w, 2);
  }

  snapshot(extra = {}) {
    return {
      uptimeSec: round((Date.now() - this.startedAt) / 1000, 1),
      ...this.counters,
      cacheHitRate: this.cacheHitRate(),
      writeReductionFactor: this.writeReduction(),
      suggestLatencyMs: this.percentiles(),
      lastFlushError: this.lastFlushError,
      ...extra,
    };
  }
}

module.exports = { Stats, round };
