'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { rankPopular, rankTrending } = require('../src/scoring');
const { PrefixIndex } = require('../src/prefixIndex');
const { RecencyWindow } = require('../src/recencyWindow');

function setup() {
  const index = new PrefixIndex({ precomputeLen: 3, poolSize: 20, suggestLimit: 10 });
  index.build([
    { query: 'java', count: 100000 },
    { query: 'javascript', count: 50000 },
    { query: 'java tutorial', count: 1000 },
  ]);
  const recency = new RecencyWindow({ buckets: 6, bucketMs: 1000, nowFn: () => 0 });
  return { index, recency };
}

test('popular mode ranks by overall all-time count', () => {
  const { index } = setup();
  const r = rankPopular(index, 'java', 10).map((s) => s.query);
  assert.deepEqual(r, ['java', 'javascript', 'java tutorial']);
});

test('trending mode falls back to popularity when nothing is recent', () => {
  const { index, recency } = setup();
  const r = rankTrending(index, recency, 'java', 10, { poolSize: 20, recencyWeight: 2.5 });
  assert.equal(r[0].query, 'java');
});

test('a recent burst lifts a low-count query above an all-time-popular one', () => {
  const { index, recency } = setup();
  for (let i = 0; i < 20; i++) recency.record('java tutorial');
  const r = rankTrending(index, recency, 'java', 10, { poolSize: 20, recencyWeight: 2.5 });
  assert.equal(r[0].query, 'java tutorial');
  assert.ok(r[0].score > r.find((x) => x.query === 'java').score);
});
