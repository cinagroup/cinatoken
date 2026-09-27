import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createSqliteD1 } from '../../src/test-support/sqlite-d1.ts';
import { createWorkerApp } from '../../src/runtime/workers.ts';
import { drainNodeBackgroundWork } from '../../src/runtime/schedule-background-work.ts';
import { imageSuccessFixture } from '../../../../scripts/deploy/staging-image-success-fixture.mjs';
import { imageProbeRow, imageProbePrompt } from './images-probe-contract.ts';
import upstream from './images-upstream.ts';

for (const mode of ['headers', 'body']) test('full gateway cancels synthetic upstream during ' + mode + ' with real SQL audit', async t => {
  await new Promise(resolve => setImmediate(resolve));
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Native network forbidden'); });
  const db = createSqliteD1(), key = 'synthetic-probe-client', runId = 'c02-success-' + randomUUID();
  const fixture = await imageSuccessFixture(runId, 'sha256:' + createHash('sha256').update(key).digest('hex'), new Date(Date.now() + 3600000).toISOString());
  const probe = { runId, probeId: randomUUID(), mode }, row = imageProbeRow(probe), pending = [];
  const context = { waitUntil(p) { pending.push(p); p.catch(() => undefined); } };
  const env = { DB: db.binding, DATABASE_DRIVER: 'd1', SHARED_KEY_ENCRYPTION_SECRET: 'synthetic-encryption-material-not-for-real-secrets', REQUEST_BODY_LOGGING: 'off', BATCH_API_ENABLED: 'false' };
  let sends = 0;
  const app = createWorkerApp({ imageFetch: async (input, init) => { sends++; return upstream.fetch(new Request(input, init), { PROBE_DB: db.binding }, context); } });
  try {
    for (const s of fixture.seed) db.sqlite.prepare(s.sql).run(...s.params);
    db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(row.key, row.value, row.description);
    const controller = new AbortController();
    const responseTask = app.request('/v1/images/generations', { method: 'POST', signal: controller.signal,
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: fixture.cases['small-generations'].model, prompt: imageProbePrompt(probe) }) }, env);
    const read = () => JSON.parse(db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(row.key).value);
    const desired = mode === 'body' ? 'body-prefix' : 'started';
    for (let i = 0; i < 1000 && read().phase !== desired; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(read().phase, desired); controller.abort();
    const response = await responseTask;
    assert.equal(response.status, 499); await response.body?.cancel();
    await Promise.all(pending); await drainNodeBackgroundWork();
    assert.equal(sends, 1); assert.equal(read().phase, 'terminal');
    assert.ok(['request_abort', 'response_cancel'].includes(read().events.at(-1).reason));
    const logs = db.sqlite.prepare('SELECT status,charged_cost,budget_charged_micros,upstream_attempt_count,output_image_count,request_body,upstream_request_body FROM api_key_request_logs WHERE api_key_id=?').all(fixture.ids.key);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 'error'); assert.equal(logs[0].charged_cost, 0); assert.equal(logs[0].budget_charged_micros, 0);
    assert.equal(logs[0].upstream_attempt_count, 1); assert.equal(logs[0].output_image_count, 0);
    assert.equal(logs[0].request_body, null); assert.equal(logs[0].upstream_request_body, null);
  } finally {
    await Promise.allSettled(pending); await drainNodeBackgroundWork();
    db.sqlite.prepare('DELETE FROM system_config WHERE key=? AND description=?').run(row.key, row.description);
    for (const s of fixture.cleanup) db.sqlite.prepare(s.sql).run(...s.params);
    db.sqlite.close();
  }
});
