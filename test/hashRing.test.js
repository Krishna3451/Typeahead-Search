'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { HashRing, murmur3_32 } = require('../src/hashRing');

test('murmur3_32 is deterministic and stays within 32 bits', () => {
  assert.equal(murmur3_32('hello'), murmur3_32('hello'));
  const h = murmur3_32('quicksuggest');
  assert.ok(h >= 0 && h <= 0xffffffff);
  assert.notEqual(murmur3_32('a'), murmur3_32('b'));
});

test('a key always routes to the same node', () => {
  const ring = new HashRing(100);
  ['a', 'b', 'c'].forEach((n) => ring.addNode(n));
  const owner = ring.getNode('popular:iphone');
  assert.ok(['a', 'b', 'c'].includes(owner));
  assert.equal(ring.getNode('popular:iphone'), owner);
});

test('virtual nodes keep the ring balanced', () => {
  const ring = new HashRing(160);
  for (let i = 0; i < 4; i++) ring.addNode(`n${i}`);
  const keys = Array.from({ length: 8000 }, (_, i) => `key-${i}`);
  const dist = ring.distribution(keys);
  const ideal = keys.length / 4;
  for (const count of Object.values(dist)) {
    assert.ok(Math.abs(count - ideal) / ideal < 0.15, `node share ${count} too far from ${ideal}`);
  }
});

test('adding a node re-homes only a small fraction of keys', () => {
  const replicas = 160;
  const N = 4;
  const before = new HashRing(replicas);
  const after = new HashRing(replicas);
  for (let i = 0; i < N; i++) {
    before.addNode(`n${i}`);
    after.addNode(`n${i}`);
  }
  after.addNode(`n${N}`); // one extra node

  const keys = Array.from({ length: 8000 }, (_, i) => `key-${i}`);
  let moved = 0;
  for (const k of keys) if (before.getNode(k) !== after.getNode(k)) moved++;
  const frac = moved / keys.length;
  // ideal ~ 1/(N+1) = 0.2; a plain hash%N would move ~0.75
  assert.ok(frac > 0.1 && frac < 0.32, `moved fraction ${frac} outside the expected band`);
});
