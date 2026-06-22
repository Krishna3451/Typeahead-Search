'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { CachePool, CacheNode } = require('../src/cachePool');
const { Stats } = require('../src/stats');

function pool() {
  return new CachePool(
    { nodeCount: 4, replicas: 80, capacity: 100, ttlMs: 1000, trendingTtlMs: 1000, jitter: 0, invalidateMaxLen: 6 },
    new Stats(10)
  );
}

test('set then get round-trips and routes to one node', () => {
  const c = pool();
  const node = c.set('ip', 'popular', [{ query: 'iphone', count: 1 }]);
  const got = c.get('ip', 'popular');
  assert.equal(got.hit, true);
  assert.equal(got.node, node);
  assert.deepEqual(got.value, [{ query: 'iphone', count: 1 }]);
});

test('missing key is a miss', () => {
  const got = pool().get('zz', 'popular');
  assert.equal(got.hit, false);
  assert.equal(got.value, null);
});

test('CacheNode honours TTL using an explicit clock', () => {
  const n = new CacheNode('x', 10);
  n.set('k', 'v', 100, 1000); // expires at 1100
  assert.equal(n.get('k', 1050), 'v');
  assert.equal(n.get('k', 1101), undefined);
});

test('CacheNode evicts the least-recently-used entry over capacity', () => {
  const n = new CacheNode('x', 2);
  n.set('a', 'A', 1000, 0);
  n.set('b', 'B', 1000, 0);
  n.get('a', 1); // touch a -> b becomes LRU
  n.set('c', 'C', 1000, 1); // over capacity -> evict b
  assert.equal(n.get('a', 2), 'A');
  assert.equal(n.get('c', 2), 'C');
  assert.equal(n.get('b', 2), undefined);
});

test('invalidateForQueries drops the affected prefixes in both modes', () => {
  const c = pool();
  c.set('ip', 'popular', [1]);
  c.set('ip', 'trending', [1]);
  const removed = c.invalidateForQueries(new Set(['iphone']));
  assert.ok(removed >= 2);
  assert.equal(c.get('ip', 'popular').hit, false);
  assert.equal(c.get('ip', 'trending').hit, false);
});

test('debug reports the owner node and hit/miss', () => {
  const c = pool();
  let d = c.debug('ip', 'popular');
  assert.equal(d.status, 'miss');
  assert.ok(c.nodeIds.includes(d.ownerNode));
  c.set('ip', 'popular', [1]);
  d = c.debug('ip', 'popular');
  assert.equal(d.status, 'hit');
});
