import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { imageIngressFixture, jsonWire, multipartWire, multipartTotalWire, MiB } from './staging-image-ingress-fixture.mjs';

test('hashed-only, zero-budget fixture applies to all real migrations and cleans only its own rows', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    const directory = new URL('../../packages/core/migrations-d1/', import.meta.url);
    for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(name, directory), 'utf8'));
    const make = (character) => imageIngressFixture('c02-ingress-' + character.repeat(8) + '-1111-4111-8111-' + character.repeat(12), 'sha256:' + character.repeat(64), '2026-09-07T12:00:00.000Z');
    const own = make('a'), other = make('b');
    const run = statements => statements.forEach(({ sql, params }) => db.prepare(sql).run(...params));
    run(own.seed); run(other.seed);
    const row = db.prepare('SELECT key,key_hash,limit_micros FROM api_keys WHERE id=?').get(own.ids.key);
    assert.equal(row.key, 'hashref:' + row.key_hash); assert.equal(row.limit_micros, 0);
    assert.equal(db.prepare('SELECT budget_max FROM users WHERE id=?').get(own.ids.user).budget_max, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM providers').get().n, 0);
    const unrelated = db.prepare('SELECT * FROM api_keys WHERE id=?').get(other.ids.key);
    run([own.revoke]); assert.equal(db.prepare('SELECT status FROM api_keys WHERE id=?').get(own.ids.key).status, 'revoked');
    run(own.cleanup); run(own.cleanup);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM workspaces').get().n, 1);
    assert.deepEqual(db.prepare('SELECT * FROM api_keys WHERE id=?').get(other.ids.key), unrelated);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('streamed generators have exact wire sizes and never allocate a full body', () => {
  for (const wire of [jsonWire(50 * MiB), jsonWire(50 * MiB + 1), multipartWire([20 * MiB]), multipartWire([20 * MiB + 1]), multipartTotalWire(50 * MiB), multipartTotalWire(50 * MiB + 1)]) {
    let bytes = 0;
    for (const chunk of wire.chunks()) { bytes += chunk.length; assert.ok(chunk.length <= 64 * 1024); }
    assert.equal(bytes, wire.bytes);
  }
  assert.throws(() => imageIngressFixture('production', 'sha256:' + 'a'.repeat(64), '2026-09-07T12:00:00.000Z'));
  assert.throws(() => imageIngressFixture('c02-ingress-aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'plaintext', '2026-09-07T12:00:00.000Z'));
});
