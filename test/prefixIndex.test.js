'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PrefixIndex } = require('../src/prefixIndex');

function build() {
  const idx = new PrefixIndex({ precomputeLen: 3, poolSize: 20, suggestLimit: 10 });
  idx.build([
    { query: 'apple', count: 100 },
    { query: 'app', count: 300 },
    { query: 'application', count: 50 },
    { query: 'apply', count: 80 },
    { query: 'banana', count: 200 },
    { query: 'band', count: 150 },
  ]);
  return idx;
}

test('short-prefix lookup returns matches sorted by count desc', () => {
  const idx = build();
  const r = idx.matchPool('app', 10).map((e) => e.q);
  assert.deepEqual(r, ['app', 'apple', 'apply', 'application']);
});

test('long-prefix lookup falls back to a range scan', () => {
  const idx = build();
  const r = idx.matchPool('appl', 10).map((e) => e.q); // length 4 > precomputeLen
  assert.deepEqual(r, ['apple', 'apply', 'application']);
});

test('no match returns an empty list', () => {
  const idx = build();
  assert.deepEqual(idx.matchPool('xyz', 10), []);
});

test('bump updates a count and re-orders the bucket', () => {
  const idx = build();
  idx.bump('apply', 1000); // apply -> 1080, now ahead of app(300)
  assert.equal(idx.matchPool('app', 10)[0].q, 'apply');
});

test('bump inserts a brand-new query and indexes its prefixes', () => {
  const idx = build();
  const res = idx.bump('appstore', 5);
  assert.equal(res.isNew, true);
  assert.ok(idx.get('appstore'));
  assert.ok(idx.matchPool('apps', 10).map((e) => e.q).includes('appstore'));
});
