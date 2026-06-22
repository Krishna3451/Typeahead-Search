'use strict';

const { round } = require('./stats');

/**
 * Basic ranking (mode=popular): sort matching queries purely by overall
 * all-time count. Historically popular queries always come first.
 */
function rankPopular(index, prefix, limit) {
  return index
    .matchPool(prefix, limit)
    .slice(0, limit)
    .map((e) => ({ query: e.q, count: e.c }));
}

/**
 * Recency-aware ranking (mode=trending):
 *
 *     score = log1p(count) + recencyWeight * recentCount
 *
 * The historical term is squashed with log1p so it cannot dwarf everything -
 * that headroom is what lets a modest burst of recent searches pull a query up.
 * The recent term comes from the sliding window, so the boost fades on its own
 * once the burst ages out (no permanent over-ranking).
 *
 * Candidates = the popular pool for the prefix UNION any query currently active
 * in the recency window that matches the prefix. The union matters: a freshly
 * trending query that is not in the historical top pool still gets surfaced.
 */
function rankTrending(index, recency, prefix, limit, opts) {
  const pool = index.matchPool(prefix, opts.poolSize);
  const seen = new Set(pool.map((e) => e.q));
  for (const q of recency.activeWithPrefix(prefix)) {
    if (!seen.has(q)) {
      const e = index.get(q);
      if (e) {
        pool.push(e);
        seen.add(q);
      }
    }
  }
  const scored = pool.map((e) => {
    const recent = recency.recentCount(e.q);
    return {
      query: e.q,
      count: e.c,
      recent,
      score: round(Math.log1p(e.c) + opts.recencyWeight * recent, 3),
    };
  });
  scored.sort((a, b) => b.score - a.score || b.count - a.count);
  return scored.slice(0, limit);
}

module.exports = { rankPopular, rankTrending };
