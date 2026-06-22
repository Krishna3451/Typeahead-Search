'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BatchWriter } = require('../src/batchWriter');
const { PrefixIndex } = require('../src/prefixIndex');
const { RecencyWindow } = require('../src/recencyWindow');
const { CachePool } = require('../src/cachePool');
const { Stats } = require('../src/stats');

function makeDeps() {
  const written = [];
  const index = new PrefixIndex({ precomputeLen: 3, poolSize: 20, suggestLimit: 10 });
  index.build([{ query: 'apple', count: 10 }]);
  const recency = new RecencyWindow({ buckets: 6, bucketMs: 1000, nowFn: () => 0 });
  const cache = new CachePool(
    { nodeCount: 2, replicas: 40, capacity: 100, ttlMs: 1000, trendingTtlMs: 1000, jitter: 0, invalidateMaxLen: 6 },
    new Stats(10)
  );
  const stats = new Stats(10);
  const upsert = (entries) => {
    for (const [q, inc] of entries) written.push([q, inc]);
  };
  return { deps: { upsert, index, recency, cache, stats }, written, stats };
}

test('repeated queries aggregate into one row within a flush window', () => {
  const { deps, written } = makeDeps();
  const w = new BatchWriter(deps, { journalEnabled: false, flushIntervalMs: 1e9, flushBatchSize: 1e9 });
  w.submit('apple');
  w.submit('apple');
  w.submit('banana');
  w.flush();
  const rows = new Map(written);
  assert.equal(rows.get('apple'), 2);
  assert.equal(rows.get('banana'), 1);
});

test('buffer flushes automatically once it reaches the batch size', () => {
  const { deps, stats } = makeDeps();
  const w = new BatchWriter(deps, { journalEnabled: false, flushIntervalMs: 1e9, flushBatchSize: 2 });
  w.submit('a');
  assert.equal(stats.counters.flushBatches, 0);
  w.submit('b'); // 2 distinct -> triggers a flush
  assert.equal(stats.counters.flushBatches, 1);
});

test('un-flushed searches in the journal are replayed on startup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-'));
  const journalPath = path.join(dir, 'search-journal.log');
  fs.writeFileSync(journalPath, 'apple\nbanana\napple\n'); // simulate a crash before flush

  const { deps, written } = makeDeps();
  const w = new BatchWriter(deps, { journalEnabled: true, journalPath, flushIntervalMs: 1e9, flushBatchSize: 1e9 });
  w.start(); // recovers + flushes

  const rows = new Map(written);
  assert.equal(rows.get('apple'), 2);
  assert.equal(rows.get('banana'), 1);
  assert.equal(w.recovered, 3);
  assert.equal(fs.readFileSync(journalPath, 'utf8'), ''); // truncated after a successful flush

  w.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
