'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Tiny .env reader so we don't pull in a dependency just for configuration.
 * Lines look like KEY=value; real process environment variables take priority.
 */
function loadDotEnv(rootDir) {
  const file = path.join(rootDir, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

const ROOT = path.resolve(__dirname, '..');
loadDotEnv(ROOT);

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const str = (v, d) => (v === undefined || v === '' ? d : v);
const bool = (v, d) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(v));

const config = {
  rootDir: ROOT,
  port: num(process.env.PORT, 3000),

  // ---- primary store (SQLite) ----
  dbPath: path.resolve(ROOT, str(process.env.DB_PATH, 'data/quicksuggest.db')),
  dataDir: path.resolve(ROOT, str(process.env.DATA_DIR, 'data')),
  loadLimit: num(process.env.LOAD_LIMIT, 300000), // top-N queries pulled into memory at boot

  // ---- suggestions ----
  suggestLimit: num(process.env.SUGGEST_LIMIT, 10),
  precomputeLen: num(process.env.PRECOMPUTE_LEN, 3), // prefixes up to this length keep a maintained top-K
  poolSize: num(process.env.POOL_SIZE, 60), // candidate pool size for the recency re-rank
  maxScan: num(process.env.MAX_SCAN, 50000), // safety cap on a long-prefix range scan

  // ---- distributed cache ----
  cacheNodeCount: num(process.env.CACHE_NODES, 4),
  cacheReplicas: num(process.env.CACHE_REPLICAS, 160), // virtual nodes per logical node
  cacheCapacity: num(process.env.CACHE_CAPACITY, 5000), // max entries per node before LRU eviction
  cacheTtlMs: num(process.env.CACHE_TTL_MS, 30000),
  trendingTtlMs: num(process.env.TRENDING_TTL_MS, 5000), // trending results go stale faster
  cacheTtlJitter: num(process.env.CACHE_TTL_JITTER, 0.15), // +/- fraction to avoid synchronized expiry
  invalidateMaxLen: num(process.env.INVALIDATE_MAX_LEN, 6),

  // ---- write-behind batching ----
  flushIntervalMs: num(process.env.FLUSH_INTERVAL_MS, 2000),
  flushBatchSize: num(process.env.FLUSH_BATCH_SIZE, 200),
  journalEnabled: bool(process.env.JOURNAL_ENABLED, true),
  journalPath: path.resolve(ROOT, str(process.env.JOURNAL_PATH, 'data/search-journal.log')),

  // ---- recency window (trending) ----
  windowBuckets: num(process.env.WINDOW_BUCKETS, 60),
  bucketMs: num(process.env.BUCKET_MS, 10000), // 60 buckets x 10s = 10-minute sliding window
  trendingLimit: num(process.env.TRENDING_LIMIT, 10),
  recencyWeight: num(process.env.RECENCY_WEIGHT, 2.5), // weight of the recent term in the trending score

  // ---- metrics ----
  latencySamples: num(process.env.LATENCY_SAMPLES, 5000),
};

module.exports = config;
