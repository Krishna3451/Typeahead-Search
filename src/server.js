'use strict';

const path = require('path');
const express = require('express');

const config = require('./config');
const { Stats } = require('./stats');
const { openDatabase, loadTopQueries, countRows, makeBatchUpserter } = require('./database');
const { PrefixIndex } = require('./prefixIndex');
const { RecencyWindow } = require('./recencyWindow');
const { CachePool } = require('./cachePool');
const { BatchWriter } = require('./batchWriter');
const { createRouter } = require('./routes');

function bootstrap() {
  const stats = new Stats(config.latencySamples);

  console.log(`[boot] opening primary store ${config.dbPath}`);
  const db = openDatabase(config.dbPath);
  const total = countRows(db);
  if (total === 0) {
    console.warn('[boot] WARNING: the queries table is empty.');
    console.warn('[boot] Run "npm run fetch-data" then "npm run load-data" (or "npm run load-data -- --synthetic 150000").');
  }

  console.log(`[boot] building prefix index from the top ${Math.min(config.loadLimit, total)} of ${total} queries...`);
  const t0 = Date.now();
  const index = new PrefixIndex({
    precomputeLen: config.precomputeLen,
    poolSize: config.poolSize,
    suggestLimit: config.suggestLimit,
    maxScan: config.maxScan,
  });
  index.build(loadTopQueries(db, config.loadLimit));
  console.log(`[boot] prefix index ready: ${index.size} queries in ${Date.now() - t0} ms`);

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
  console.log(`[boot] cache pool: ${config.cacheNodeCount} logical nodes x ${config.cacheReplicas} vnodes on the ring`);

  const batch = new BatchWriter(
    { upsert: makeBatchUpserter(db), index, recency, cache, stats },
    {
      journalPath: config.journalPath,
      journalEnabled: config.journalEnabled,
      flushIntervalMs: config.flushIntervalMs,
      flushBatchSize: config.flushBatchSize,
    }
  );
  batch.start();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use('/', createRouter({ config, index, recency, cache, batch, stats, countRows: () => countRows(db) }));
  app.use(express.static(path.join(config.rootDir, 'public')));

  const server = app.listen(config.port, () => {
    console.log(`[boot] QuickSuggest is up: http://localhost:${config.port}`);
  });

  let closing = false;
  const shutdown = (sig) => {
    if (closing) return;
    closing = true;
    console.log(`\n[boot] ${sig} received - flushing buffer and shutting down...`);
    batch.stop();
    server.close(() => {
      try {
        db.close();
      } catch (_) {
        /* ignore */
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return { app, server, db, index, recency, cache, batch, stats };
}

if (require.main === module) bootstrap();

module.exports = { bootstrap };
