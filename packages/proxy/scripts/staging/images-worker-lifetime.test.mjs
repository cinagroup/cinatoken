import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createSqliteD1 } from '../../src/test-support/sqlite-d1.ts';
import { createWorkerHandler } from '../../src/runtime/worker-handler.ts';
import { imageSuccessFixture } from '../../../../scripts/deploy/staging-image-success-fixture.mjs';
import { imageProbeRow, imageProbePrompt } from './images-probe-contract.ts';
import upstream from './images-upstream.ts';

for (const mode of ['headers', 'body']) test('Worker registers request work before dispatch and retains canceled ' + mode + ' accounting', async t => {
  await new Promise(resolve => setImmediate(resolve));
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Native network forbidden'); });
  const db = createSqliteD1(), key = 'synthetic-worker-lifetime', runId = 'c02-success-' + randomUUID();
  const fixture = await imageSuccessFixture(runId, 'sha256:' + createHash('sha256').update(key).digest('hex'), new Date(Date.now() + 3600000).toISOString());
  const probe = { runId, probeId: randomUUID(), mode }, row = imageProbeRow(probe);
  const gatewayTasks = [], upstreamTasks = [];
  const gatewayContext = { waitUntil(p) { assert.equal(this, gatewayContext); gatewayTasks.push(p); p.catch(() => undefined); } };
  const upstreamContext = { waitUntil(p) { upstreamTasks.push(p); p.catch(() => undefined); } };
  const env = { DB: db.binding, DATABASE_DRIVER: 'd1', SHARED_KEY_ENCRYPTION_SECRET: 'synthetic-encryption-material-not-for-real-secrets', REQUEST_BODY_LOGGING: 'off', BATCH_API_ENABLED: 'false' };
  let sends = 0, responseTask;
  const controller = new AbortController();
  const handler = createWorkerHandler({ imageFetch: async (input, init) => { sends++; return upstream.fetch(new Request(input, init), { PROBE_DB: db.binding }, upstreamContext); } });
  try {
    for (const s of fixture.seed) db.sqlite.prepare(s.sql).run(...s.params);
    db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(row.key, row.value, row.description);
    responseTask = handler.fetch(new Request('https://example.invalid/v1/images/generations', { method: 'POST', signal: controller.signal,
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: fixture.cases['small-generations'].model, prompt: imageProbePrompt(probe) }) }), env, gatewayContext);
    assert.equal(gatewayTasks.length, 1, 'host hold must be registered synchronously, before awaiting app dispatch');
    let heldSettled = false; gatewayTasks[0].then(() => { heldSettled = true; });
    const read = () => JSON.parse(db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(row.key).value);
    const desired = mode === 'body' ? 'body-prefix' : 'started', limit = performance.now() + 5000;
    while (read().phase !== desired && performance.now() < limit) await new Promise(resolve => setImmediate(resolve));
    assert.equal(read().phase, desired); assert.equal(heldSettled, false);
    controller.abort();
    const response = await responseTask; assert.equal(response.status, 499); await response.body?.cancel();
    for (let i = 0; i < gatewayTasks.length; i++) await gatewayTasks[i];
    for (const task of upstreamTasks) await task;
    assert.equal(heldSettled, true); assert.equal(sends, 1);
    const logs = db.sqlite.prepare('SELECT status,charged_cost,budget_charged_micros,upstream_attempt_count,output_image_count FROM api_key_request_logs WHERE api_key_id=?').all(fixture.ids.key);
    assert.deepEqual(logs.map(l => ({ ...l })), [{ status: 'error', charged_cost: 0, budget_charged_micros: 0, upstream_attempt_count: 1, output_image_count: 0 }]);
    const attempts = db.sqlite.prepare('SELECT outcome,reason,http_status FROM provider_attempt_availability WHERE request_log_id IN (SELECT id FROM api_key_request_logs WHERE api_key_id=?)').all(fixture.ids.key);
    assert.deepEqual(attempts.map(a => ({ ...a })), [{ outcome: 'excluded', reason: 'client_cancelled', http_status: mode === 'headers' ? null : 200 }]);
    assert.ok(gatewayTasks.length >= 2, 'route accounting has its own independent host hold');
  } finally {
    controller.abort(); await responseTask?.catch(() => undefined);
    for (let i = 0; i < gatewayTasks.length; i++) await gatewayTasks[i].catch(() => undefined);
    await Promise.allSettled(upstreamTasks);
    db.sqlite.prepare('DELETE FROM system_config WHERE key=? AND description=?').run(row.key, row.description);
    for (const s of fixture.cleanup) db.sqlite.prepare(s.sql).run(...s.params);
    db.sqlite.close();
  }
});
