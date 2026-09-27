import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import type { D1Database } from '@cloudflare/workers-types';
import { createD1StorageContext, type StorageContext } from '@octafuse/core';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { pgCoreSchema } from '../../../core/src/storage/drizzle/schema.pg';
import { createProxyApp } from '../app';
import { createRequestCapacityPool } from '../services/request-capacity';
import { TEXT_REQUEST_DEADLINE_MS } from '../services/request-deadline';
import { disposeUnusedWorkerStorage } from './workers';
import { drainNodeResourceWork } from './schedule-resource-completion';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function storage() {
  const unexpected = (): never => { throw Error('Unexpected database access'); };
  const db: D1Database = { prepare: unexpected, batch: unexpected, exec: unexpected, withSession: unexpected, dump: unexpected };
  return createD1StorageContext(db);
}
const paths = [
  '/v1/chat/completions', '/api/v1/chat/completions', '/v1/completions', '/api/v1/completions',
  '/v1/responses', '/api/v1/responses', '/v1/messages', '/api/v1/messages',
  '/v1beta/models/synthetic:generateContent', '/v1beta/models/synthetic:streamGenerateContent',
  '/v1/embeddings', '/api/v1/embeddings', '/v1/rerank', '/api/v1/rerank',
  '/v1/images', '/api/v1/images', '/v1/images/generations', '/api/v1/images/generations', '/v1/images/edits', '/api/v1/images/edits',
];

for (const path of paths) for (const stop of ['client', 'deadline']) for (const ack of ['resolve', 'reject']) {
  test(`storage preparation public ${path}/${stop}/${ack}`, { timeout: 5000 }, async t => {
    for (const name of ['log', 'warn', 'error'] as const) t.mock.method(console, name, () => {});
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    const entered = deferred<void>(), late = deferred<StorageContext>(), cleanup = deferred<void>();
    const parent = new AbortController(), pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 100 });
    const resolved = storage(); let initializations = 0, disposals = 0, auth = 0;
    t.mock.method(resolved.repositories.apiKeys, 'getApiKeyWithUserByKey', async () => { auth++; return null; });
    const app = createProxyApp(async () => { initializations++; entered.resolve(); return late.promise; }, {
      httpCapacity: { pool, reservedBytesPerRequest: 100 },
      disposeUnusedStorage: async value => { assert.equal(value, resolved); disposals++; await cleanup.promise; },
    });
    const tasks: Promise<unknown>[] = [];
    const ctx = { props: {}, passThroughOnException() {}, waitUntil(task: Promise<unknown>) { assert.equal(this, ctx); tasks.push(task); } };
    t.after(async () => { late.resolve(resolved); cleanup.resolve(); await Promise.allSettled(tasks); });
    const pending = app.request(path, { method: 'POST', signal: parent.signal, headers: { Authorization: 'Bearer synthetic' } }, {}, ctx);
    await entered.promise;
    if (stop === 'client') parent.abort('PRIVATE_CANCEL'); else t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
    const response = await pending;
    assert.equal(response.status, stop === 'client' ? 499 : 504);
    if (stop === 'client') await assert.rejects(response.text(), /delivery stopped/);
    else assert.doesNotMatch(await response.text(), /PRIVATE/);
    assert.equal(initializations, 1); assert.equal(disposals, 0); assert.equal(auth, 0); assert.equal(pool.snapshot().requests, 1);
    late.resolve(resolved); await tick();
    assert.equal(disposals, 1); assert.equal(auth, 0); assert.equal(pool.tryAcquire(1), null);
    if (ack === 'resolve') cleanup.resolve(); else cleanup.reject(Error('PRIVATE_CLEANUP'));
    await Promise.all(tasks);
    assert.equal(pool.snapshot().requests, ack === 'resolve' ? 0 : 1); assert.equal(initializations, 1); assert.equal(auth, 0);
  });
}

for (const mode of ['accepted', 'handoff-abort', 'late-reject', 'shared', 'legacy']) test(`storage ownership ${mode}`, { timeout: 5000 }, async t => {
  for (const name of ['log', 'warn', 'error'] as const) t.mock.method(console, name, () => {});
  const entered = deferred<void>(), late = deferred<StorageContext>(), resolved = storage();
  const parent = new AbortController(), pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 100 });
  let disposals = 0, auth = 0, settled = false;
  t.mock.method(resolved.repositories.apiKeys, 'getApiKeyWithUserByKey', async () => { auth++; return null; });
  const app = createProxyApp(async () => { entered.resolve(); return late.promise; }, {
    httpCapacity: { pool, reservedBytesPerRequest: 100 },
    ...(mode === 'legacy' ? {} : { disposeUnusedStorage: async () => { if (mode !== 'shared') disposals++; } }),
  });
  const pending = Promise.resolve(app.request('/v1/responses', { method: 'POST', signal: parent.signal, headers: { Authorization: 'Bearer synthetic' } }, {})).then(r => { settled = true; return r; });
  await entered.promise;
  if (mode === 'handoff-abort') { late.resolve(resolved); queueMicrotask(() => parent.abort()); }
  else if (mode !== 'accepted') parent.abort();
  if (mode === 'legacy') { await tick(); assert.equal(settled, false); late.resolve(resolved); }
  if (mode === 'accepted') late.resolve(resolved);
  const response = await pending;
  assert.equal(response.status, mode === 'accepted' ? 401 : 499);
  if (mode === 'accepted') await response.text(); else await assert.rejects(response.text(), /delivery stopped/);
  if (mode === 'late-reject') late.reject(Error('PRIVATE_INITIALIZATION'));
  else if (mode === 'shared') { assert.equal(pool.snapshot().requests, 1); late.resolve(resolved); }
  await drainNodeResourceWork();
  assert.equal(disposals, mode === 'handoff-abort' ? 1 : 0); assert.equal(auth, mode === 'accepted' ? 1 : 0);
  assert.equal(pool.snapshot().requests, mode === 'late-reject' ? 1 : 0);
});

test('unused Workers D1 storage requires no client close', async () => { await disposeUnusedWorkerStorage(storage()); });
for (const outcome of ['resolve', 'reject']) test(`unused Workers Postgres close observes ${outcome}`, async t => {
  const raw = postgres('postgres://synthetic:synthetic@127.0.0.1:1/synthetic');
  const end = raw.end; t.after(() => end({ timeout: 0 }));
  const ack = deferred<void>(); let calls = 0;
  t.mock.method(raw, 'end', (options?: { timeout?: number }) => { calls++; assert.deepEqual(options, { timeout: 1 }); return ack.promise; });
  const value: StorageContext = { client: { driver: 'postgres', raw, drizzle: drizzle(raw, { schema: pgCoreSchema }) }, repositories: storage().repositories };
  let finished = false; const pending = disposeUnusedWorkerStorage(value).then(() => { finished = true; });
  void pending.catch(() => {}); await tick(); assert.equal(finished, false); assert.equal(calls, 1);
  if (outcome === 'resolve') { ack.resolve(); await pending; assert.equal(finished, true); }
  else { ack.reject(Error('synthetic close failure')); await assert.rejects(pending); }
});
