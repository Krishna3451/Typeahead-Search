'use strict';

const express = require('express');
const { rankPopular, rankTrending } = require('./scoring');

/**
 * Normalise user input the same way the dataset was normalised: lowercase,
 * collapse runs of whitespace to a single space, and drop leading spaces. A
 * trailing space is intentionally kept so the prefix "new " can match
 * "new york" but not "newcastle".
 */
function normalize(input) {
  return String(input ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^\s+/, '');
}

function pickMode(raw) {
  return raw === 'trending' ? 'trending' : 'popular';
}

function createRouter(ctx) {
  const { config, index, recency, cache, batch, stats, countRows } = ctx;
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      indexedQueries: index.size,
      pendingWrites: batch.pending,
      uptimeSec: stats.snapshot().uptimeSec,
    });
  });

  // GET /suggest?q=<prefix>&mode=popular|trending
  router.get('/suggest', (req, res) => {
    const t0 = process.hrtime.bigint();
    const prefix = normalize(req.query.q);
    const mode = pickMode(req.query.mode);

    if (prefix === '') {
      stats.inc('suggestServed');
      return res.json({ prefix, mode, source: 'empty', node: null, suggestions: [] });
    }

    const cached = cache.get(prefix, mode);
    let suggestions;
    let source;
    let node = cached.node;

    if (cached.hit) {
      suggestions = cached.value;
      source = 'cache';
    } else {
      suggestions =
        mode === 'trending'
          ? rankTrending(index, recency, prefix, config.suggestLimit, {
              poolSize: config.poolSize,
              recencyWeight: config.recencyWeight,
            })
          : rankPopular(index, prefix, config.suggestLimit);
      node = cache.set(prefix, mode, suggestions);
      source = 'index';
    }

    stats.inc('suggestServed');
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    stats.recordLatency(elapsedMs);
    res.json({ prefix, mode, source, node, latencyMs: Math.round(elapsedMs * 1000) / 1000, suggestions });
  });

  // POST /search  { query }
  router.post('/search', (req, res) => {
    const query = normalize(req.body && req.body.query);
    if (query === '') return res.status(400).json({ error: 'query is required' });
    batch.submit(query);
    res.json({ message: 'Searched' });
  });

  // GET /trending?n=10
  router.get('/trending', (req, res) => {
    const n = Math.max(1, Math.min(50, parseInt(req.query.n, 10) || config.trendingLimit));
    const trending = recency.top(n).map((t) => {
      const e = index.get(t.query);
      return { query: t.query, recent: t.recent, count: e ? e.c : 0 };
    });
    res.json({ windowMs: recency.windowMs(), activeQueries: recency.activeSize, trending });
  });

  // GET /cache/debug?prefix=<prefix>&mode=popular|trending
  router.get('/cache/debug', (req, res) => {
    const prefix = normalize(req.query.prefix);
    res.json(cache.debug(prefix, pickMode(req.query.mode)));
  });

  // GET /cache/distribution?samples=N  -> shows the consistent-hash balance
  router.get('/cache/distribution', (req, res) => {
    const n = index.entries.length || 1;
    const samples = Math.max(100, Math.min(50000, parseInt(req.query.samples, 10) || 5000, n));
    // evenly-spaced, distinct real queries as keys -> isolates ring balance
    const step = Math.max(1, Math.floor(n / samples));
    const keys = [];
    for (let i = 0; i < samples; i++) {
      const e = index.entries[(i * step) % n];
      keys.push(`popular:${e ? e.q : i}`);
    }
    const distribution = cache.distribution(keys);
    const percent = {};
    for (const [k, v] of Object.entries(distribution)) percent[k] = Math.round((v / samples) * 1000) / 10;
    res.json({
      nodes: cache.nodeIds,
      replicasPerNode: config.cacheReplicas,
      samples,
      distribution,
      percent,
      idealPercent: Math.round((100 / cache.nodeIds.length) * 10) / 10,
    });
  });

  // GET /stats  -> latency percentiles, cache hit rate, write reduction, ...
  router.get('/stats', (_req, res) => {
    res.json(
      stats.snapshot({
        indexedQueries: index.size,
        pendingWrites: batch.pending,
        recoveredFromJournal: batch.recovered,
        cacheNodes: cache.nodeIds,
        cacheNodeSizes: cache.nodeSizes(),
        recencyActiveQueries: recency.activeSize,
        recencyWindowMs: recency.windowMs(),
        primaryStoreRows: countRows ? countRows() : undefined,
      })
    );
  });

  return router;
}

module.exports = { createRouter, normalize };
