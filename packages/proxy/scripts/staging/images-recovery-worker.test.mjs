import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setup } from './images-recovery-test-support.mjs';
import { privateImageTransport } from './images-gateway-handler.ts';
import { imageStorageFaultHeader, imageStorageFaultRow, IMAGE_STORAGE_FAULT_HEADER } from './images-storage-fault-contract.ts';
import { UPSTREAM_ORIGIN } from './images-upstream.ts';

function settled(f, cost) {
  assert.equal(f.row('SELECT COUNT(*) AS n FROM request_usage_settlements').n, 1);
  assert.equal(f.row('SELECT state FROM request_usage_recovery_jobs').state, 'committed');
  assert.equal(f.row('SELECT COUNT(*) AS n FROM request_usage_commit_receipts').n, 1);
  assert.equal(f.row('SELECT COUNT(*) AS n FROM api_key_request_logs').n, 1);
  assert.equal(f.row('SELECT charged_cost FROM api_key_request_logs').charged_cost, cost);
  assert.deepEqual({ ...f.row('SELECT budget_spent_micros,budget_reserved_micros FROM users WHERE id=?', f.fixture.ids.user) },
    { budget_spent_micros: cost * 1000000, budget_reserved_micros: 0 });
  assert.equal(f.row('SELECT COUNT(*) AS n FROM user_audit_logs WHERE event_type=?', 'usage_charge').n, cost ? 1 : 0);
  assert.equal(f.row('SELECT COALESCE(SUM(request_count),0) AS n FROM public_model_daily_stats').n, 1);
  assert.equal(f.sends, 1);
}

for (const composition of ['worker', 'staging']) for (const operation of ['generations', 'edits']) for (const cost of [0, 0.1]) {
  test(`${composition} complete handler persists and settles ${operation} at synthetic USD ${cost}`, async t => {
    const f = await setup(t, { composition, cost });
    const pending = f.request(operation);
    assert.equal(f.holds, 1, 'entry hold must precede any async dispatch');
    assert.equal(f.sends, 0);
    const response = await pending;
    assert.equal(response.status, 200, JSON.stringify(f.messages));
    assert.equal((await response.json()).data[0].b64_json, 'AQID');
    await f.drain();
    assert.ok(f.holds >= 2, 'accounting owns an independent host hold');
    settled(f, cost);
    const payload = f.row('SELECT payload_json FROM request_usage_settlements').payload_json;
    assert.equal(JSON.parse(payload).params.requestLog.requestOperation, 'images.' + operation);
    assert.equal(payload.includes('private-prompt-marker'), false);
    assert.equal((await f.recover()).claimed, 0);
    settled(f, cost);
  });
}

for (const mode of ['before-fail', 'after-fail']) for (const operation of ['generations', 'edits']) {
  test(`staging header ${mode} connects ${operation} producer to independent recovery without re-inference`, async t => {
    const f = await setup(t, { composition: 'staging', cost: 0.1 });
    const probe = { runId: f.fixture.ids.user.slice(0, -5), probeId: randomUUID(), mode };
    const row = imageStorageFaultRow(probe);
    f.db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(row.key, row.value, row.description);
    const response = await f.request(operation, {}, undefined, { [IMAGE_STORAGE_FAULT_HEADER]: imageStorageFaultHeader(probe) });
    assert.equal(response.status, 200, JSON.stringify(f.messages));
    await response.body.cancel();
    await f.drain();
    const committed = mode === 'after-fail';
    assert.equal(JSON.parse(f.row('SELECT value FROM system_config WHERE key=?', row.key).value).phase,
      committed ? 'committed-ack-lost' : 'failed-before-commit');
    assert.equal(f.row('SELECT state FROM request_usage_recovery_jobs').state, committed ? 'committed' : 'pending');
    assert.equal(f.row('SELECT COUNT(*) AS n FROM api_key_request_logs').n, committed ? 1 : 0);
    assert.equal(f.row('SELECT COUNT(*) AS n FROM request_usage_settlements').n, 1);
    if (!committed) {
      assert.equal(f.row('SELECT COUNT(*) AS n FROM request_usage_commit_receipts').n, 0);
      assert.equal(f.row('SELECT budget_spent_micros FROM users WHERE id=?', f.fixture.ids.user).budget_spent_micros, 0);
      assert.ok(f.row('SELECT budget_reserved_micros FROM users WHERE id=?', f.fixture.ids.user).budget_reserved_micros > 0);
      assert.equal((await f.recover()).claimed, 0, 'database backoff blocks immediate replay');
    }
    // Consumer uses the unwrapped binding, durable snapshot and database time,
    // with no producer request, transport or current pricing dependency.
    f.db.sqlite.prepare("UPDATE model_endpoints SET image_capabilities='{}'").run();
    f.advance(31);
    assert.equal((await f.recover()).committed, committed ? 0 : 1);
    settled(f, 0.1);
    assert.equal((await f.recover()).claimed, 0);
    settled(f, 0.1);
  });
}

for (const composition of ['worker', 'staging']) {
  test(`${composition} default ignores request and binding recovery toggles with only formal schema`, async t => {
    const f = await setup(t, { composition, schema: 0, enabled: false, cost: 0.1,
      envPatch: { IMAGE_USAGE_RECOVERY_ENABLED: 'true', imageUsageRecovery: { settlementLeaseSeconds: 1 } },
      hooks: { beforeStatement(sql) { assert.equal(/request_(?:usage_(?:settlements|recovery_jobs|commit_receipts)|dispatch_intents)/.test(sql), false); } },
    });
    const response = await f.request('generations', { imageUsageRecovery: { settlementLeaseSeconds: 1 } }, undefined,
      { 'x-image-usage-recovery': 'true' });
    assert.equal(response.status, 200);
    await response.body.cancel(); await f.drain();
    assert.equal(f.sends, 1);
    assert.equal(f.row('SELECT charged_cost FROM api_key_request_logs').charged_cost, 0.1);
  });

  test(`${composition} snapshots server options before caller mutation`, async t => {
    const recoveryOptions = { settlementLeaseSeconds: 30 };
    const f = await setup(t, { composition, recoveryOptions });
    recoveryOptions.settlementLeaseSeconds = 0;
    const response = await f.request();
    assert.equal(response.status, 200); await response.body.cancel(); await f.drain(); settled(f, 0);
  });

  for (const schema of [0, 1, 2]) test(`${composition} partial schema ${schema}/3 rejects before upstream`, async t => {
    const f = await setup(t, { composition, schema });
    const response = await f.request();
    assert.notEqual(response.status, 200); await response.body.cancel(); await f.drain();
    assert.equal(f.sends, 0);
    assert.equal(f.row('SELECT COUNT(*) AS n FROM api_key_request_logs').n, 0);
  });
}

test('staging recovery preserves maintenance, invalid-secret and authentication gates', async t => {
  for (const [envPatch, headers, status] of [
    [{ CINATOKEN_MAINTENANCE_MODE: 'true' }, {}, 503],
    [{ SHARED_KEY_ENCRYPTION_SECRET: '' }, {}, 500],
    [{}, { Authorization: 'Bearer invalid-client' }, 401],
  ]) {
    await t.test(JSON.stringify(Object.keys(envPatch).concat(Object.keys(headers))), async s => {
      const f = await setup(s, { composition: 'staging', envPatch });
      const response = await f.request('generations', {}, undefined, headers);
      assert.equal(response.status, status); await response.body.cancel(); await f.drain();
      assert.equal(f.sends, 0);
      assert.equal(f.row('SELECT COUNT(*) AS n FROM request_dispatch_intents').n, 0);
    });
  }
});

test('invalid staging fault header cannot reach storage, upstream or recovery', async t => {
  const f = await setup(t, { composition: 'staging' });
  const response = await f.request('generations', {}, undefined, { [IMAGE_STORAGE_FAULT_HEADER]: 'arbitrary' });
  assert.equal(response.status, 400); await response.body.cancel();
  assert.equal(f.holds, 0); assert.equal(f.sends, 0);
  assert.equal(f.row('SELECT COUNT(*) AS n FROM request_dispatch_intents').n, 0);
});

for (const mode of ['before-abort', 'after-abort']) test(`staging ${mode} refuses a runtime without native abort before admission`, async t => {
  const f = await setup(t, { composition: 'staging', cost: 0.1 });
  const probe = { runId: f.fixture.ids.runId, probeId: randomUUID(), mode };
  const row = imageStorageFaultRow(probe);
  f.db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(row.key, row.value, row.description);
  const response = await f.request('generations', {}, undefined, { [IMAGE_STORAGE_FAULT_HEADER]: imageStorageFaultHeader(probe) });
  assert.equal(response.status, 400); await response.body.cancel();
  assert.equal(f.holds, 0); assert.equal(f.sends, 0);
  for (const table of ['request_dispatch_intents', 'request_usage_settlements', 'request_usage_recovery_jobs', 'api_key_request_logs']) {
    assert.equal(f.row(`SELECT COUNT(*) AS n FROM ${table}`).n, 0);
  }
  assert.equal(f.row('SELECT value FROM system_config WHERE key=?', row.key).value, row.value);
});

test('private transport preserves input/stream identity and refuses destination or redirect expansion', async () => {
  const url = UPSTREAM_ORIGIN + '/cases/small/v1/images/generations';
  const stream = new ReadableStream({ start(c) { c.close(); } });
  const init = { method: 'POST', redirect: 'manual', body: stream };
  let calls = 0;
  const transport = privateImageTransport((input, options) => {
    calls++; assert.equal(input, url); assert.equal(options, init); assert.equal(options.body, stream);
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  assert.equal((await transport(url, init)).status, 204);
  for (const [input, options] of [
    ['https://example.invalid/cases/small/v1/images/generations', init], [url + '?secret=value', init],
    [url + '#fragment', init], [url.replace('https://', 'https://user:pass@'), init],
    [UPSTREAM_ORIGIN + '/admin', init], [url, { ...init, redirect: 'follow' }], [url, { ...init, method: 'GET' }], [url, undefined],
  ]) assert.throws(() => transport(input, options), /refused an unexpected destination/);
  assert.equal(calls, 1);
});
