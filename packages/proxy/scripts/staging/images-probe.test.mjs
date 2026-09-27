import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createSqliteD1 } from '../../src/test-support/sqlite-d1.ts';
import { imageProbeResponse } from './images-probe.ts';
import { imageProbeRow, imageProbePrompt, parseImageProbe } from './images-probe-contract.ts';
import upstream, { UPSTREAM_ORIGIN, SYNTHETIC_PROVIDER_MARKER } from './images-upstream.ts';

function setup(mode, armed = true) {
  const db = createSqliteD1(), probe = { runId: 'c02-success-' + randomUUID(), probeId: randomUUID(), mode };
  const row = imageProbeRow(probe), pending = [], controller = new AbortController();
  if (armed) db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(row.key, row.value, row.description);
  const read = () => JSON.parse(db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(row.key).value);
  const request = new Request('https://example.invalid', { signal: controller.signal });
  const context = { waitUntil(p) { pending.push(p); p.catch(() => undefined); } };
  return { db, probe, row, read, pending, controller, context, options: { probe, request, db: db.binding, context, receipt: 'synthetic-receipt', holdMs: 1000 } };
}
async function until(read, phase) {
  for (let i = 0; i < 100; i++) { if (read().phase === phase) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('Expected probe phase ' + phase);
}

test('probe contract accepts only bounded synthetic identities and fixed modes', () => {
  const probe = { runId: 'c02-success-' + randomUUID(), probeId: randomUUID(), mode: 'body' };
  assert.deepEqual(parseImageProbe(imageProbePrompt(probe)), probe);
  for (const input of [null, 'x'.repeat(10000), imageProbePrompt(probe) + ':150000', imageProbePrompt(probe).replace(':body', ':arbitrary')]) assert.equal(parseImageProbe(input), null);
});
test('unarmed probe fails closed and leaves unrelated system configuration untouched', async () => {
  const s = setup('headers', false);
  try {
    const before = s.db.sqlite.prepare('SELECT * FROM system_config ORDER BY key').all();
    await assert.rejects(imageProbeResponse(s.options), /not armed/);
    assert.deepEqual(s.db.sqlite.prepare('SELECT * FROM system_config ORDER BY key').all(), before);
    assert.equal(s.pending.length, 0);
  } finally { s.db.sqlite.close(); }
});
test('headers held: real SQL start precedes abort and terminal request signal receipt', async () => {
  const s = setup('headers');
  try {
    const response = imageProbeResponse(s.options);
    await until(s.read, 'started'); s.controller.abort();
    assert.equal((await response).status, 499); await Promise.all(s.pending);
    assert.deepEqual(s.read().events.map(e => e.phase), ['started', 'terminal']);
    assert.equal(s.read().events.at(-1).reason, 'request_abort');
    assert.equal(s.read().events.at(-1).signalAborted, true);
    await assert.rejects(imageProbeResponse(s.options), /not armed/);
  } finally { await Promise.allSettled(s.pending); s.db.sqlite.close(); }
});
for (const bySignal of [true, false]) test('body held: distinct ' + (bySignal ? 'request abort' : 'reader cancel') + ' is durable', async () => {
  const s = setup('body');
  try {
    const response = await imageProbeResponse(s.options), reader = response.body.getReader();
    const prefix = await reader.read(); assert.equal(new TextDecoder().decode(prefix.value), '{"data":[');
    await until(s.read, 'body-prefix');
    if (bySignal) { const tail = reader.read(); s.controller.abort(); await assert.rejects(tail, { name: 'AbortError' }); }
    else await reader.cancel();
    await Promise.all(s.pending); reader.releaseLock();
    assert.deepEqual(s.read().events.map(e => e.phase), ['started', 'body-prefix', 'terminal']);
    assert.equal(s.read().events.at(-1).reason, bySignal ? 'request_abort' : 'response_cancel');
    assert.equal(s.read().events.at(-1).signalAborted, bySignal);
  } finally { await Promise.allSettled(s.pending); s.db.sqlite.close(); }
});
for (const mode of ['headers', 'body', 'release']) test('finite ' + mode + ' observer records expiry/release without fabricating cancellation', async () => {
  const s = setup(mode);
  try {
    const response = await imageProbeResponse({ ...s.options, holdMs: 10 });
    assert.equal((await response.json()).data[0].b64_json, 'AQID'); await Promise.all(s.pending);
    const end = s.read().events.at(-1);
    assert.equal(end.reason, mode === 'release' ? 'released' : 'expired'); assert.equal(end.signalAborted, false);
  } finally { await Promise.allSettled(s.pending); s.db.sqlite.close(); }
});
test('upstream probe integration retains preparation and terminal observation without external fetch', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No external network'); });
  const s = setup('headers');
  try {
    const body = JSON.stringify({ model: 'private-model', prompt: imageProbePrompt(s.probe), n: 1 });
    const response = upstream.fetch(new Request(UPSTREAM_ORIGIN + '/cases/small/v1/images/generations', { method: 'POST', body, signal: s.controller.signal,
      headers: { Authorization: 'Bearer ' + SYNTHETIC_PROVIDER_MARKER, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } }), { PROBE_DB: s.db.binding }, s.context);
    await until(s.read, 'started'); s.controller.abort();
    assert.equal((await response).status, 499); await Promise.all(s.pending);
    assert.equal(s.pending.length, 2); assert.equal(s.read().events.at(-1).reason, 'request_abort');
  } finally { await Promise.allSettled(s.pending); s.db.sqlite.close(); }
});
test('reading an already expired body cannot move its durable terminal state backwards', async () => {
  const s = setup('body');
  try {
    const response = await imageProbeResponse({ ...s.options, holdMs: 1 });
    await Promise.all(s.pending);
    assert.equal((await response.json()).data[0].b64_json, 'AQID');
    assert.equal(s.read().phase, 'terminal');
    assert.deepEqual(s.read().events.map(e => e.phase), ['started', 'terminal']);
  } finally { await Promise.allSettled(s.pending); s.db.sqlite.close(); }
});
