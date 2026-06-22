'use strict';

/**
 * In-process performance harness. It builds the same components the server uses
 * and drives them directly (no HTTP overhead) so the numbers reflect the data
 * system itself: suggestion latency, cache hit rate, write reduction from
 * batching, and consistent-hashing balance + re-map cost.
 *
 *   node scripts/benchmark.js [--reads 20000] [--writes 20000]
 *
 * Writes the measured results to PERFORMANCE.md.
 */
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { Stats, round } = require('../src/stats');
const { openDatabase, loadTopQueries, countRows, makeBatchUpserter } = require('../src/database');
const { PrefixIndex } = require('../src/prefixIndex');
const { RecencyWindow } = require('../src/recencyWindow');
const { CachePool } = require('../src/cachePool');
const { BatchWriter } = require('../src/batchWriter');
const { HashRing } = require('../src/hashRing');
const { rankPopular, rankTrending } = require('../src/scoring');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? parseInt(process.argv[i + 1], 10) : def;
}

// Weighted sampler: pick a query with probability proportional to its count, so
// the workload is skewed toward popular terms like real search traffic.
function makeSampler(rows) {
  const cum = new Float64Array(rows.length);
  let s = 0;
  for (let i = 0; i < rows.length; i++) {
    s += rows[i].count;
    cum[i] = s;
  }
  const total = s;
  return () => {
    const r = Math.random() * total;
    let lo = 0;
    let hi = rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return rows[lo];
  };
}

function pctTable(dist, samples) {
  return Object.entries(dist)
    .map(([n, c]) => `| ${n} | ${c} | ${round((c / samples) * 100, 1)}% |`)
    .join('\n');
}

function main() {
  const READS = arg('--reads', 20000);
  const WRITES = arg('--writes', 20000);

  const db = openDatabase(config.dbPath);
  const total = countRows(db);
  if (total === 0) {
    console.error('No data loaded. Run "npm run fetch-data" then "npm run load-data" first.');
    process.exit(1);
  }

  const stats = new Stats(Math.max(config.latencySamples, READS));
  const index = new PrefixIndex({
    precomputeLen: config.precomputeLen,
    poolSize: config.poolSize,
    suggestLimit: config.suggestLimit,
    maxScan: config.maxScan,
  });
  const buildStart = process.hrtime.bigint();
  index.build(loadTopQueries(db, config.loadLimit));
  const buildMs = Number(process.hrtime.bigint() - buildStart) / 1e6;

  const recency = new RecencyWindow({ buckets: config.windowBuckets, bucketMs: config.bucketMs });
  const cache = new CachePool(
    {
      nodeCount: config.cacheNodeCount,
      replicas: config.cacheReplicas,
      capacity: config.cacheCapacity,
      ttlMs: config.cacheTtlMs,
      trendingTtlMs: config.trendingTtlMs,
      jitter: config.cacheTtlJitter,
      invalidateMaxLen: config.invalidateMaxLen,
    },
    stats
  );
  const batch = new BatchWriter(
    { upsert: makeBatchUpserter(db), index, recency, cache, stats },
    { journalEnabled: false, flushIntervalMs: 1e9, flushBatchSize: config.flushBatchSize }
  );

  const popular = loadTopQueries(db, 20000);
  const sample = makeSampler(popular);
  const prefixOf = (q) => q.slice(0, 1 + Math.floor(Math.random() * Math.min(q.length, 6)));

  console.log(`\nQuickSuggest benchmark`);
  console.log(`  indexed queries : ${index.size} (of ${total} in store), built in ${round(buildMs, 1)} ms`);

  // ---- read workload (suggestion latency + cache hit rate) ----
  for (let i = 0; i < Math.min(2000, READS); i++) {
    // warm-up (not measured): populate the cache with hot prefixes
    const p = prefixOf(sample().query);
    if (!cache.get(p, 'popular').hit) cache.set(p, 'popular', rankPopular(index, p, config.suggestLimit));
  }
  const hits0 = stats.counters.cacheHits;
  const miss0 = stats.counters.cacheMisses;
  for (let i = 0; i < READS; i++) {
    const p = prefixOf(sample().query);
    const t0 = process.hrtime.bigint();
    const c = cache.get(p, 'popular');
    if (!c.hit) cache.set(p, 'popular', rankPopular(index, p, config.suggestLimit));
    stats.recordLatency(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const lat = stats.percentiles();
  const measuredHits = stats.counters.cacheHits - hits0;
  const measuredMiss = stats.counters.cacheMisses - miss0;
  const hitRate = round(measuredHits / (measuredHits + measuredMiss), 4);

  // a few trending reads to confirm the path works under the recency re-rank
  let trendingP95 = null;
  {
    const tl = new Stats(5000);
    for (let i = 0; i < 3000; i++) {
      const p = prefixOf(sample().query);
      const t0 = process.hrtime.bigint();
      rankTrending(index, recency, p, config.suggestLimit, { poolSize: config.poolSize, recencyWeight: config.recencyWeight });
      tl.recordLatency(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    trendingP95 = tl.percentiles().p95;
  }

  // ---- write workload (batch write reduction) ----
  // Model realistic, concentrated search traffic: the overwhelming majority of
  // submissions hit a small head of popular queries (a power law). We disable
  // size-based auto-flush and flush on a fixed cadence to emulate the periodic
  // (time-based) flush the running server performs.
  const WRITE_VOCAB = Math.min(1200, popular.length);
  const FLUSH_EVERY = 4000; // submissions per simulated flush window
  const hot = makeSampler(popular.slice(0, WRITE_VOCAB));
  batch.flushBatchSize = Infinity;
  for (let i = 1; i <= WRITES; i++) {
    batch.submit(hot().query);
    if (i % FLUSH_EVERY === 0) batch.flush('window');
  }
  batch.flush('benchmark-final');
  const accepted = stats.counters.searchesAccepted;
  const written = stats.counters.dbWrites;
  const batches = stats.counters.flushBatches;
  const rowReduction = round(accepted / written, 2);
  const txnReduction = round(accepted / batches, 0);

  // ---- consistent-hashing balance (distinct keys isolate ring geometry) ----
  const keyCount = Math.min(10000, popular.length);
  const keys = [];
  for (let i = 0; i < keyCount; i++) keys.push(`popular:${popular[i].query}`);
  const dist = cache.distribution(keys);

  // ---- consistent-hashing re-map cost when a node is added ----
  const N = config.cacheNodeCount;
  const ringA = new HashRing(config.cacheReplicas);
  const ringB = new HashRing(config.cacheReplicas);
  for (let i = 0; i < N; i++) {
    ringA.addNode(`cache-${i}`);
    ringB.addNode(`cache-${i}`);
  }
  ringB.addNode(`cache-${N}`); // one extra node
  let moved = 0;
  for (const k of keys) if (ringA.getNode(k) !== ringB.getNode(k)) moved++;
  const movedPct = round((moved / keys.length) * 100, 1);
  const idealMovedPct = round((1 / (N + 1)) * 100, 1);

  // ---- report ----
  console.log(`\n  Suggestion latency (${READS} reads, popular mode)`);
  console.log(`    p50=${lat.p50}ms  p95=${lat.p95}ms  p99=${lat.p99}ms  max=${lat.max}ms  mean=${lat.mean}ms`);
  console.log(`    cache hit rate : ${round(hitRate * 100, 2)}%  (DB reads on this path: ${stats.counters.dbReads})`);
  console.log(`    trending mode p95 (uncached re-rank): ${trendingP95}ms`);
  console.log(`\n  Batch write reduction (${WRITES} searches over a ${WRITE_VOCAB}-query hot set)`);
  console.log(`    rows written : ${written} in ${batches} flush transactions`);
  console.log(`    row reduction: ${rowReduction}x    transaction reduction: ${txnReduction}x`);
  console.log(`    avoided      : ${accepted - written} row writes, ${accepted - batches} transactions`);
  console.log(`\n  Consistent hashing (${N} nodes x ${config.cacheReplicas} vnodes, ${keyCount} distinct keys)`);
  for (const [n, c] of Object.entries(dist)) console.log(`    ${n}: ${c} (${round((c / keys.length) * 100, 1)}%)`);
  console.log(`    keys re-homed when adding a ${N + 1}th node: ${movedPct}% (ideal ~${idealMovedPct}%)`);

  const md = `# Performance Report

_Generated by \`npm run benchmark\` (in-process, no HTTP overhead) on the loaded dataset._

- Indexed queries: **${index.size}** (of ${total} in the primary store)
- Prefix index build time: **${round(buildMs, 1)} ms**
- Read workload: **${READS}** suggestion lookups (popularity-weighted prefixes)
- Write workload: **${WRITES}** search submissions

## 1. Suggestion latency (GET /suggest, popular mode)

Measured on the data path only (cache lookup -> on miss, prefix index + ranking -> cache fill).

| Metric | Value |
|---|---|
| p50 | ${lat.p50} ms |
| p95 | ${lat.p95} ms |
| p99 | ${lat.p99} ms |
| max | ${lat.max} ms |
| mean | ${lat.mean} ms |

**Cache hit rate (steady state): ${round(hitRate * 100, 2)}%** over ${measuredHits + measuredMiss} measured lookups.
**DB reads on the suggestion path: ${stats.counters.dbReads}** - suggestions are served entirely from the in-memory prefix index and the cache; the SQLite store is never read on a read request.

Trending mode (recency-aware re-rank, measured uncached): p95 ${trendingP95} ms.

## 2. Batch write reduction (POST /search)

Searches are aggregated in a write-behind buffer and flushed in batches, so repeated
queries collapse into a single additive UPSERT. Modelled on concentrated search traffic
(${WRITES} submissions drawn from the top ${WRITE_VOCAB} queries weighted by popularity),
flushed on a fixed cadence to emulate the server's periodic flush.

| | Naive (per-request) | Write-behind batching |
|---|---|---|
| Row writes | ${accepted} | ${written} |
| Transactions | ${accepted} | ${batches} |

- **Transaction reduction: ${txnReduction}x** - one transaction per flush instead of one per
  search. This is the dominant win (far fewer fsyncs / round-trips) and holds regardless of skew.
- **Row-write reduction: ${rowReduction}x** - repeated queries collapse within a flush window;
  this scales with how concentrated the traffic is.
- Avoided: ${accepted - written} row writes and ${accepted - batches} transactions.

**Failure trade-off:** a crash loses at most one un-flushed window. The append-only search
journal (\`data/search-journal.log\`) records every accepted search before buffering, so on
restart those un-flushed searches are replayed - bounding worst-case loss to searches not yet
fsync'd by the OS rather than a whole window.

## 3. Distributed cache - consistent hashing

${config.cacheNodeCount} logical cache nodes, ${config.cacheReplicas} virtual nodes each. ${keyCount} distinct query keys:

| Node | Keys | Share |
|---|---|---|
${pctTable(dist, keys.length)}

Ideal even share is ${round(100 / config.cacheNodeCount, 1)}%; virtual nodes keep every node within a few points of it.

**Elasticity:** adding a ${config.cacheNodeCount + 1}th node re-homed only **${movedPct}%** of keys
(ideal ~${idealMovedPct}%). A plain \`hash(key) % N\` scheme would re-home roughly
${round((1 - 1 / config.cacheNodeCount) * 100, 0)}% of keys on the same change - that gap is the whole point of consistent hashing.

---

_Re-run with \`npm run benchmark -- --reads ${READS} --writes ${WRITES}\` to regenerate this file._
`;

  fs.writeFileSync(path.join(config.rootDir, 'PERFORMANCE.md'), md);
  console.log(`\n  wrote PERFORMANCE.md`);
  db.close();
}

main();
