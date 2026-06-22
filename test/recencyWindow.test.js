'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { RecencyWindow } = require('../src/recencyWindow');

// A controllable clock so we can travel through time deterministically.
function clock(start = 0) {
  let t = start;
  const fn = () => t;
  fn.set = (v) => {
    t = v;
  };
  return fn;
}

test('recentCount sums hits inside the window', () => {
  const w = new RecencyWindow({ buckets: 6, bucketMs: 1000, nowFn: clock(0) });
  w.record('a');
  w.record('a');
  w.record('b');
  assert.equal(w.recentCount('a'), 2);
  assert.equal(w.recentCount('b'), 1);
});

test('hits age out once they scroll past the window edge', () => {
  const c = clock(0);
  const w = new RecencyWindow({ buckets: 3, bucketMs: 1000, nowFn: c }); // 3-second window
  w.record('a');
  c.set(3000); // advance a full window
  assert.equal(w.recentCount('a'), 0);
});

test('top returns the highest recent counts', () => {
  const w = new RecencyWindow({ buckets: 6, bucketMs: 1000, nowFn: clock(0) });
  w.record('a', 5);
  w.record('b', 2);
  w.record('c', 9);
  assert.deepEqual(w.top(2).map((t) => t.query), ['c', 'a']);
});

test('activeWithPrefix filters the active set', () => {
  const w = new RecencyWindow({ buckets: 6, bucketMs: 1000, nowFn: clock(0) });
  w.record('apple');
  w.record('apricot');
  w.record('banana');
  assert.deepEqual(w.activeWithPrefix('ap').sort(), ['apple', 'apricot']);
});
