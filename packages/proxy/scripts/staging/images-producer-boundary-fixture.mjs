// Local-only public producer harness. No cloud credentials, network, or runtime toggles.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setup } from './images-recovery-test-support.mjs';
import { createWorkerHandler } from '../../src/runtime/worker-handler.ts';
import { drainNodeBackgroundWork } from '../../src/runtime/schedule-background-work.ts';
import { decodeUsageSettlement } from '../../../core/src/storage/recovery/usage-settlement-codec.ts';

export const boundaryProfiles = Object.freeze({ ascii: 'a', unicode: '漢', escaped: '"\\' });
const plain = value => JSON.parse(JSON.stringify(value));
const tables = ['request_dispatch_intents', 'request_usage_settlements', 'request_usage_recovery_jobs',
  'request_usage_commit_receipts', 'api_key_request_logs', 'provider_attempt_availability',
  'user_audit_logs', 'public_model_daily_stats'];

export async function producerFixture(t, { hooks = {}, verifiedBy = 'V', providerName } = {}) {
  // Reuse the frozen schema/seed support, but own our request composition so edits
  // can carry the same bounded control fields as generations. The old app is unused.
  t.mock.method(globalThis, 'fetch', async () => { throw Error('External network forbidden'); });
  for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, () => {});
  const f = await setup(undefined, { hooks, cost: 0.1, composition: 'worker' });
  let cleanup = () => f.close();
  t.after(() => cleanup()); // Register before any fallible fixture customization.
  const key = 'synthetic-boundary-' + randomUUID();
  const hash = 'sha256:' + createHash('sha256').update(key).digest('hex');
  f.db.sqlite.prepare('UPDATE api_keys SET key=?,key_hash=? WHERE id=?').run('hashref:' + hash, hash, f.fixture.ids.key);
  for (const endpoint of f.fixture.ids.endpoints) f.db.sqlite.prepare('UPDATE model_endpoints SET verified_by=? WHERE id=?').run(verifiedBy, endpoint);
  if (providerName !== undefined) {
    const provider = f.fixture.cases['small-generations'].provider;
    assert.equal(provider, f.fixture.cases['small-edits'].provider);
    assert.equal(f.db.sqlite.prepare('UPDATE providers SET name=? WHERE id=?').run(providerName, provider).changes, 1);
  }
  const env = { DB: f.db.binding, DATABASE_DRIVER: 'd1', SHARED_KEY_ENCRYPTION_SECRET: 'synthetic-material-not-for-real-secrets',
    REQUEST_BODY_LOGGING: 'off', BATCH_API_ENABLED: 'false' };
  const tasks = [];
  let sends = 0, closed = false;
  const context = { waitUntil(p) { assert.equal(this, context); tasks.push(p); p.catch(() => undefined); } };
  const app = createWorkerHandler({ imageUsageRecovery: { settlementLeaseSeconds: 5 }, imageFetch: async (input, init) => {
    sends++;
    assert.equal(f.row("SELECT COUNT(*) AS n FROM request_dispatch_intents WHERE state='dispatch_claimed'").n, sends);
    const request = new Request(input, init);
    let bytes = 0;
    for await (const chunk of request.body) { bytes += chunk.byteLength; assert.ok(bytes <= 8192); }
    assert.equal(Number(request.headers.get('Content-Length')), bytes);
    return Response.json({ data: [{ b64_json: 'AQID' }], usage: { input_tokens: 9, output_tokens: 1, total_tokens: 10,
      secret_extension: 'private-boundary-usage-marker' } }, { headers: { 'X-Request-ID': 'c02-producer-boundary' } });
  } });
  async function drain() {
    for (let i = 0; i < tasks.length; i++) await tasks[i];
    await drainNodeBackgroundWork();
  }
  async function close() { if (closed) return; try { await drain(); } finally { await f.close(); closed = true; } }
  cleanup = close;
  return {
    db: f.db, fixture: f.fixture, row: f.row, advance: f.advance, recover: f.recover, drain, close,
    get sends() { return sends; },
    counts() { return Object.fromEntries(tables.map(table => [table, f.row('SELECT COUNT(*) AS n FROM ' + table).n])); },
    account() { return plain(f.row('SELECT budget_spent_micros,budget_reserved_micros FROM users WHERE id=?', f.fixture.ids.user)); },
    async snapshot() {
      const stored = f.row('SELECT payload_json,payload_sha256 FROM request_usage_settlements');
      assert.ok(stored);
      return { ...plain(stored), value: await decodeUsageSettlement(stored.payload_json, stored.payload_sha256) };
    },
    async request(operation, quality) {
      assert.ok(['generations', 'edits'].includes(operation));
      assert.ok(quality === undefined || /^[a]{1,8}$/.test(quality));
      const model = f.fixture.cases['small-' + operation].model;
      let body, type;
      if (operation === 'edits') {
        const boundary = 'cinatoken-producer-boundary';
        const fields = { model, prompt: 'private-boundary-prompt', ...(quality ? { quality } : {}) };
        const chunks = Object.entries(fields).map(([name, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="test.png"\r\nContent-Type: image/png\r\n\r\n`),
          Buffer.alloc(16, 1), Buffer.from(`\r\n--${boundary}--\r\n`));
        body = Buffer.concat(chunks); type = 'multipart/form-data; boundary=' + boundary;
      } else { body = JSON.stringify({ model, prompt: 'private-boundary-prompt', ...(quality ? { quality } : {}) }); type = 'application/json'; }
      const response = await app.fetch(new Request('https://example.invalid/v1/images/' + operation, {
        method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': type }, body,
      }), env, context);
      const value = await response.json(); await drain();
      return { status: response.status, body: value };
    },
  };
}

export function exactAuditPlan(baselineAudit, profile) {
  assert.ok(Object.hasOwn(boundaryProfiles, profile));
  const remaining = 65536 - Buffer.byteLength(baselineAudit);
  assert.ok(remaining > 0);
  // The baseline has quality="a". quality is retained once, verified_by four times.
  const quality = 'a'.repeat(1 + remaining % 4);
  const perCopy = Math.floor(remaining / 4);
  const unit = boundaryProfiles[profile], cost = Buffer.byteLength(JSON.stringify(unit)) - 2;
  const verifiedBy = 'V' + unit.repeat(Math.floor(perCopy / cost)) + 'a'.repeat(perCopy % cost);
  const expected = JSON.parse(baselineAudit);
  let copies = 0;
  function replace(value) {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'verified_by') { assert.equal(child, 'V'); value[key] = verifiedBy; copies++; }
      else if (child && typeof child === 'object') replace(child);
    }
  }
  replace(expected); assert.equal(copies, 4); expected.quality = quality;
  assert.equal(Buffer.byteLength(JSON.stringify(expected)), 65536);
  return { verifiedBy, quality };
}

export function assertSettled(f, snapshot) {
  for (const [table, n] of Object.entries(f.counts())) assert.equal(n, 1, table);
  assert.deepEqual(f.account(), { budget_spent_micros: 100000, budget_reserved_micros: 0 });
  assert.equal(f.row('SELECT state FROM request_usage_recovery_jobs').state, 'committed');
  assert.equal(f.row('SELECT charged_cost FROM api_key_request_logs').charged_cost, 0.1);
  assert.equal(f.row('SELECT pricing_audit FROM api_key_request_logs').pricing_audit, snapshot.value.params.requestLog.pricingAudit);
  assert.equal(f.row('SELECT COALESCE(SUM(request_count),0) AS n FROM public_model_daily_stats').n, 1);
  assert.equal(f.sends, 1);
  assert.ok(Buffer.byteLength(snapshot.payload_json) <= 262144);
  assert.equal(snapshot.payload_json.includes('private-boundary-'), false);
}

export function assertUnconfirmed(f, response) {
  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'gateway.image_settlement_unconfirmed');
  assert.equal(response.body.error.metadata.retry_safe, false);
  assert.equal(response.body.error.metadata.outcome_unknown, true);
  for (const [table, n] of Object.entries(f.counts())) assert.equal(n, table === 'request_dispatch_intents' ? 1 : 0, table);
  assert.deepEqual(f.account(), { budget_spent_micros: 0, budget_reserved_micros: 100000 });
  assert.equal(f.row('SELECT state FROM user_budget_reservations').state, 'dispatched');
  assert.equal(f.sends, 1);
}
