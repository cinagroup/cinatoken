import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { withUnpublishedPostgresClient } from '@octafuse/core';
import { createProxyApp } from '../app.ts';
import { createRequestCapacityPool } from '../services/request-capacity.ts';
import { TEXT_REQUEST_DEADLINE_MS } from '../services/request-deadline.ts';

const paths = [
  '/v1/chat/completions', '/api/v1/chat/completions', '/v1/completions', '/api/v1/completions',
  '/v1/responses', '/api/v1/responses', '/v1/messages', '/api/v1/messages',
  '/v1beta/models/synthetic:generateContent', '/v1beta/models/synthetic:streamGenerateContent',
  '/v1/embeddings', '/api/v1/embeddings', '/v1/rerank', '/api/v1/rerank',
  '/v1/images', '/api/v1/images', '/v1/images/generations', '/api/v1/images/generations', '/v1/images/edits', '/api/v1/images/edits',
];
for (const path of paths) for (const stop of ['client', 'deadline']) for (const close of ['resolve', 'reject']) {
  test(`public failed PG initialization ${path}/${stop}/${close}`, { timeout: 5000 }, async t => {
    for (const name of ['log', 'warn', 'error']) t.mock.method(console, name, () => {});
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    const entered = Promise.withResolvers(), ack = Promise.withResolvers(), parent = new AbortController();
    const pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 100 });
    let creates = 0, ends = 0, disposals = 0; const tasks = [];
    const ctx = { props: {}, passThroughOnException() {}, waitUntil(task) { assert.equal(this, ctx); tasks.push(task); } };
    const app = createProxyApp(async () => {
      creates++; return withUnpublishedPostgresClient({ end: async () => { ends++; entered.resolve(); await ack.promise; } }, 'session', () => { throw Error('PRIVATE_DSN'); });
    }, { httpCapacity: { pool, reservedBytesPerRequest: 100 }, disposeUnusedStorage: async () => { disposals++; } });
    t.after(async () => { ack.resolve(); await Promise.allSettled(tasks); });
    const pending = app.request(path, { method: 'POST', signal: parent.signal }, {}, ctx);
    await entered.promise;
    if (stop === 'client') parent.abort(); else t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
    const response = await pending; assert.equal(response.status, stop === 'client' ? 499 : 504);
    if (stop === 'client') await assert.rejects(response.text()); else assert.doesNotMatch(await response.text(), /PRIVATE/);
    await tick(); assert.equal(pool.snapshot().requests, 1); assert.equal(pool.tryAcquire(1), null);
    if (close === 'resolve') ack.resolve(); else ack.reject(Error('PRIVATE_CLEANUP'));
    await Promise.all(tasks);
    assert.equal(pool.snapshot().requests, close === 'resolve' ? 0 : 1);
    assert.equal(creates, 1); assert.equal(ends, 1); assert.equal(disposals, 0, 'no unpublished result escaped to be closed twice');
  });
}
