import assert from 'node:assert/strict';
import test from 'node:test';
import { postgresInitializationCleanup } from '@octafuse/core';
import { postgresInitializationPeer, assertOneClosedInitialization } from '../../../core/src/test-support/postgres-initialization-peer.mjs';
import { createWorkerApp, resolveWorkerStorageFromBindings } from './workers.ts';
import { createRequestCapacityPool } from '../services/request-capacity.ts';

const bindings = peer => ({ DATABASE_DRIVER: 'postgres', HYPERDRIVE: { connectionString: peer.url }, SHARED_KEY_ENCRYPTION_SECRET: 'synthetic-encryption-secret-for-local-test-only' });
test('Workers storage decoration failure closes the unpublished real Node postgres.js socket', { timeout: 5000 }, async t => {
  const peer = await postgresInitializationPeer(t, 'success');
  const env = { ...bindings(peer), get DEEPSEEK_API_KEY() { throw Error('PRIVATE_DECORATION'); } };
  await assert.rejects(resolveWorkerStorageFromBindings(env), error => {
    assert.equal(error.stage, 'worker_decoration'); assert.equal(postgresInitializationCleanup(error), 'confirmed');
    assert.doesNotMatch(String(error), /PRIVATE/); return true;
  });
  await assertOneClosedInitialization(peer);
});
test('Workers invalid encryption configuration creates no PostgreSQL socket', { timeout: 5000 }, async t => {
  const peer = await postgresInitializationPeer(t, 'success');
  await assert.rejects(resolveWorkerStorageFromBindings({ ...bindings(peer), SHARED_KEY_ENCRYPTION_SECRET: '' }));
  assert.equal(peer.observations.connections, 0); assert.equal(peer.observations.queries.length, 0);
});
test('Workers factory public cancellation retains capacity through actual late PG failure and local socket close', { timeout: 5000 }, async t => {
  for (const name of ['log', 'warn', 'error']) t.mock.method(console, name, () => {});
  const peer = await postgresInitializationPeer(t, 'hold-error'), parent = new AbortController(), tasks = [];
  const pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 100 });
  const app = createWorkerApp({ httpCapacity: { pool, reservedBytesPerRequest: 100 } });
  const ctx = { props: {}, passThroughOnException() {}, waitUntil(task) { assert.equal(this, ctx); tasks.push(task); } };
  const pending = app.request('/v1/responses', { method: 'POST', signal: parent.signal }, bindings(peer), ctx);
  await peer.entered; parent.abort();
  const response = await pending; assert.equal(response.status, 499); await assert.rejects(response.text());
  assert.equal(pool.snapshot().requests, 1); assert.equal(peer.observations.connections, 1); assert.equal(peer.observations.closes, 0);
  peer.release(); await Promise.all(tasks); await assertOneClosedInitialization(peer);
  assert.equal(pool.snapshot().requests, 0);
});
