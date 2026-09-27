import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { d1TransportProbe, d1TransportMatrix, D1_TRANSPORT_SQL } from './staging-d1-transport-fixture.mjs';

test('twelve bounded probes execute only constant SELECTs and return exact byte/codepoint lengths', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const matrix = d1TransportMatrix(); assert.equal(matrix.length, 12);
    assert.equal(new Set(matrix.map(p => p.label)).size, 12);
    for (const p of matrix) {
      const { batch } = JSON.parse(p.body);
      assert.equal(p.wireBytes, Buffer.byteLength(p.body)); assert.ok(p.wireBytes < 2 * 1024 * 1024);
      assert.equal(p.bodySha256, createHash('sha256').update(p.body).digest('hex'));
      assert.equal(batch.length, p.count);
      assert.ok(batch.every(s => s.sql === D1_TRANSPORT_SQL && s.params.length === 1));
      const actual = batch.map(s => JSON.parse(JSON.stringify(db.prepare(s.sql).all(...s.params))));
      assert.deepEqual(actual, p.expected);
    }
    assert.deepEqual(db.prepare('SELECT name FROM sqlite_master').all(), []);
  } finally { db.close(); }
});
test('Unicode escape changes wire representation only, including equal-byte ASCII controls', () => {
  for (const size of [262144, 786432]) {
    const raw = d1TransportProbe('unicode', size), escaped = d1TransportProbe('unicode', size, 1, 'ascii-escaped');
    assert.deepEqual(JSON.parse(escaped.body), JSON.parse(raw.body));
    assert.deepEqual(escaped.expected, raw.expected); assert.ok(escaped.wireBytes > raw.wireBytes);
    assert.match(escaped.body, /^[\x00-\x7f]*$/);
    assert.equal(d1TransportProbe('ascii', size).wireBytes, raw.wireBytes);
  }
});
test('probe builder rejects arbitrary SQL-equivalent selectors, oversized inputs and unbounded counts', () => {
  for (const args of [['other', 16384], ['ascii', 1], ['unicode', 2097152], ['ascii', 16384, 3],
    ['ascii', 262144, 4], ['unicode', 262144, Infinity], ['ascii', 262144, 1, 'ascii-escaped'], ['unicode', 16384, 1, 'other']]) {
    assert.throws(() => d1TransportProbe(...args));
  }
});
