// Operator-side synthetic fixture only. No network, credentials, deployment, or inference.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setup, sample } from '../../../core/src/storage/recovery/usage-settlement-test-support.mjs';
import { encodeUsageSettlement } from '../../../core/src/storage/recovery/usage-settlement-codec.ts';
import { assertUsageRecoverySchemaD1 } from '../../../core/src/storage/recovery/usage-recovery-schema-d1.ts';

// query must return the original successful D1 result, not just its rows.
export function assertPaidRecoverySchema(query) {
  return assertUsageRecoverySchemaD1({ prepare(sql) { return { bind(...params) { return { all: () => query(sql, params) }; } }; } });
}

export const PAID_FIXTURE_COSTS = Object.freeze([0, 0.1, 0.2]);
export const PAID_FIXTURE_TABLES = Object.freeze([
  'users', 'workspaces', 'api_keys', 'request_dispatch_intents', 'user_budget_reservations',
  'request_usage_settlements', 'request_usage_recovery_jobs', 'request_usage_commit_receipts',
  'api_key_request_logs', 'provider_attempt_availability', 'user_audit_logs', 'public_model_daily_stats',
]);
export function recoveryFixtureDatabase(t) {
  const db = setup(t);
  db.sqlite.exec(readFileSync(new URL('../../../core/migrations-proposals/d1/request-usage-recovery-jobs.sql', import.meta.url), 'utf8'));
  return db;
}
const statement = (sql, ...params) => ({ sql, params });
function validate(f) {
  assert.match(f.id, /^staging-recovery-[a-f0-9-]{36}$/);
  assert.equal(f.userId, f.id + '-user');
  assert.equal(f.keyId, f.id + '-key');
  assert.equal(f.workspaceId, f.id + '-workspace');
  assert.equal(f.cases.length, 3);
  assert.equal(new Set(f.cases.map(c => c.requestId)).size, 3);
  f.cases.forEach((c, n) => {
    assert.match(c.requestId, /^gen-[a-f0-9-]{36}$/);
    assert.equal(c.modelId, f.id + '-model-' + n);
    assert.equal(c.cost, PAID_FIXTURE_COSTS[n]);
  });
}
function inRequests(f, column) {
  return [`${column} IN (?,?,?)`, f.cases.map(c => c.requestId)];
}

/** Capture the real repositories' INSERT/UPDATE statements, not terminal row dumps:
 * reservation INSERT triggers require reserved state and maintain account counters.
 * Jobs are enqueued by the real snapshot trigger, never inserted by the fixture.
 */
export async function buildPaidRecoveryFixture() {
  const db = recoveryFixtureDatabase(), id = 'staging-recovery-' + randomUUID();
  const f = { version: 1, id, userId: id + '-user', keyId: id + '-key', workspaceId: id + '-workspace',
    syntheticFundsOnly: true, cases: [], seed: [], expectedSpentMicros: 300000, expectedReservedMicros: 1000000 };
  db.hooks.beforeStatement = (sql, params) => {
    if (/^\s*(INSERT|UPDATE)\b/.test(sql)) f.seed.push({ sql, params: [...params] });
  };
  db.hooks.afterBatch = () => { throw new Error('Fixture seed unexpectedly used a batch; review capture boundaries'); };
  try {
    await db.binding.prepare('INSERT INTO users(id,email,budget_max,budget_base) VALUES(?,?,10,10)')
      .bind(f.userId, id + '@example.invalid').run();
    await db.binding.prepare("INSERT INTO workspaces(id,scope_type,personal_owner_user_id,name,slug) VALUES(?,'personal',?,?,?)")
      .bind(f.workspaceId, f.userId, id, id).run();
    await db.binding.prepare('INSERT INTO api_keys(id,key,user_id,workspace_id,name) VALUES(?,?,?,?,?)')
      .bind(f.keyId, 'not-a-credential-' + id, f.userId, f.workspaceId, id).run();
    for (const [n, cost] of PAID_FIXTURE_COSTS.entries()) {
      const v = sample(cost), i = v.intent, p = v.params, log = p.requestLog;
      Object.assign(i, { userId: f.userId, apiKeyId: f.keyId, workspaceId: f.workspaceId });
      p.userId = f.userId; p.audit.apiKeyId = f.keyId;
      Object.assign(log, { userId: f.userId, apiKeyId: f.keyId, workspaceId: f.workspaceId, modelId: id + '-model-' + n,
        providerId: id + '-provider', routeTargetId: id + '-target' });
      Object.assign(log.providerAttempts[0], { providerId: log.providerId, routeTargetId: log.routeTargetId });
      const prepared = await db.intents.prepare(i, 100, 1000);
      assert.equal(prepared.state, 'prepared');
      assert.equal(await db.intents.claim(i, 0, v.dispatchClaimId, 200), 'granted');
      if (cost > 0) {
        const reserved = await db.budgets.reserve({ requestId: i.requestId, userId: f.userId, apiKeyId: f.keyId,
          expectedBudgetEpoch: 0, reservedMicros: 500000, nowIso: v.recordedAtIso, expiresAtIso: '2026-09-07T00:05:00.000Z' });
        assert.equal(reserved.status, 'reserved');
        assert.equal(await db.budgets.markDispatched(i.requestId, v.recordedAtIso, '2026-09-07T00:10:00.000Z'), true);
      }
      const ref = await db.repo.persist(v), encoded = await encodeUsageSettlement(v);
      assert.equal(ref.payloadSha256, encoded.sha256);
      assert.ok(Buffer.byteLength(encoded.json) < 8192);
      f.cases.push({ requestId: i.requestId, modelId: log.modelId, cost, recordedAt: v.recordedAtIso,
        payloadSha256: ref.payloadSha256, payloadBytes: Buffer.byteLength(encoded.json) });
    }
    // Initial admission needs an active key; the atomic seed ends disabled before any exposure.
    await db.binding.prepare("UPDATE api_keys SET status='disabled' WHERE id=? AND user_id=?").bind(f.keyId, f.userId).run();
    await db.binding.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(f.userId).run();
    validate(f);
    assert.equal(f.seed.length, 18);
    assert.ok(Buffer.byteLength(JSON.stringify(f)) < 32768);
    return f;
  } finally { db.sqlite.close(); }
}

/** Scoped scalar projections usable unchanged with SQLite or the staging D1 query API. */
export function paidRecoveryObservations(f) {
  validate(f);
  const [ids, params] = inRequests(f, 'request_id');
  return {
    account: statement('SELECT id,status,budget_spent_micros,budget_reserved_micros,budget_epoch FROM users WHERE id=?', f.userId),
    key: statement('SELECT id,status,user_id,workspace_id FROM api_keys WHERE id=?', f.keyId),
    intents: statement(`SELECT request_id,state,revision FROM request_dispatch_intents WHERE ${ids} ORDER BY request_id`, ...params),
    snapshots: statement(`SELECT request_id,payload_sha256,recorded_at,length(CAST(payload_json AS BLOB)) AS bytes FROM request_usage_settlements WHERE ${ids} ORDER BY request_id`, ...params),
    jobs: statement(`SELECT request_id,state,revision,attempts,last_error,lease_token,lease_expires_at FROM request_usage_recovery_jobs WHERE ${ids} ORDER BY request_id`, ...params),
    reservations: statement(`SELECT request_id,state,reserved_micros,settled_micros FROM user_budget_reservations WHERE ${ids} ORDER BY request_id`, ...params),
    receipts: statement(`SELECT request_id,payload_sha256,recorded_at,lease_revision FROM request_usage_commit_receipts WHERE ${ids} ORDER BY request_id`, ...params),
    logs: statement('SELECT id,user_id,api_key_id,workspace_id,model_id,charged_cost,budget_charged_micros,created_at FROM api_key_request_logs WHERE id IN (?,?,?) ORDER BY id', ...params),
    attempts: statement('SELECT request_log_id,attempt_index,outcome FROM provider_attempt_availability WHERE request_log_id IN (?,?,?) ORDER BY request_log_id', ...params),
    audit: statement('SELECT request_log_id,user_id,api_key_id,event_type FROM user_audit_logs WHERE request_log_id IN (?,?,?) ORDER BY request_log_id', ...params),
    stats: statement('SELECT model_id,stat_date,request_count,success_count,error_count,output_tokens,total_tokens,latency_total_ms,latency_sample_count FROM public_model_daily_stats WHERE model_id IN (?,?,?) ORDER BY model_id', ...f.cases.map(c => c.modelId)),
  };
}

export function assertPaidRecoveryObservation(f, o, phase) {
  validate(f); assert.ok(['pending', 'committed', 'audit_fault', 'recovered_audit_fault'].includes(phase));
  const fault = c => c.requestId === f.cases[1].requestId;
  const done = c => phase !== 'pending' && !(phase === 'audit_fault' && fault(c));
  const retried = c => phase === 'recovered_audit_fault' && fault(c);
  const sorted = [...f.cases].sort((a,b) => a.requestId.localeCompare(b.requestId));
  assert.deepEqual(o.account, [{ id: f.userId, status: 'disabled', budget_spent_micros: phase === 'pending' ? 0 : phase === 'audit_fault' ? 200000 : 300000,
    budget_reserved_micros: phase === 'pending' ? 1000000 : phase === 'audit_fault' ? 500000 : 0, budget_epoch: 0 }]);
  assert.deepEqual(o.key, [{ id: f.keyId, status: 'disabled', user_id: f.userId, workspace_id: f.workspaceId }]);
  assert.deepEqual(o.intents, sorted.map(c => ({ request_id: c.requestId, state: 'dispatch_claimed', revision: 1 })));
  assert.deepEqual(o.snapshots, sorted.map(c => ({ request_id: c.requestId, payload_sha256: c.payloadSha256, recorded_at: c.recordedAt, bytes: c.payloadBytes })));
  assert.deepEqual(o.jobs, sorted.map(c => ({ request_id: c.requestId, state: done(c) ? 'committed' : 'pending', revision: phase === 'pending' ? 0 : retried(c) ? 4 : 2,
    attempts: phase === 'pending' ? 0 : retried(c) ? 2 : 1, last_error: phase === 'audit_fault' && fault(c) ? 'execution_error' : null, lease_token: null, lease_expires_at: null })));
  assert.deepEqual(o.reservations, sorted.filter(c => c.cost > 0).map(c => ({ request_id: c.requestId,
    state: done(c) ? 'settled' : 'dispatched', reserved_micros: 500000, settled_micros: done(c) ? Math.round(c.cost * 1e6) : 0 })));
  assert.deepEqual(o.receipts, sorted.filter(done).map(c => ({ request_id: c.requestId, payload_sha256: c.payloadSha256, recorded_at: c.recordedAt, lease_revision: retried(c) ? 3 : 1 })));
  assert.deepEqual(o.logs, sorted.filter(done).map(c => ({ id: c.requestId, user_id: f.userId, api_key_id: f.keyId, workspace_id: f.workspaceId,
    model_id: c.modelId, charged_cost: c.cost, budget_charged_micros: Math.round(c.cost * 1e6), created_at: c.recordedAt })));
  assert.deepEqual(o.attempts, sorted.filter(done).map(c => ({ request_log_id: c.requestId, attempt_index: 1, outcome: 'available' })));
  assert.deepEqual(o.audit, sorted.filter(c => c.cost > 0 && done(c)).map(c => ({ request_log_id: c.requestId, user_id: f.userId, api_key_id: f.keyId, event_type: 'usage_charge' })));
  assert.deepEqual(o.stats, f.cases.filter(done).map(c => ({ model_id: c.modelId, stat_date: c.recordedAt.slice(0,10), request_count: 1,
    success_count: 1, error_count: 0, output_tokens: 1, total_tokens: 11, latency_total_ms: 10, latency_sample_count: 1 })));
}

/** Only after ingress is closed, jobs are not leased, and fixture ownership is rechecked.
 * No schema removal, broad user cleanup, or deleting shared model aggregates.
 */
export function paidRecoveryCleanup(f) {
  validate(f);
  const [ids, params] = inRequests(f, 'request_id');
  return [
    statement('DELETE FROM provider_attempt_availability WHERE request_log_id IN (?,?,?)', ...params),
    statement('DELETE FROM user_audit_logs WHERE user_id=? AND request_log_id IN (?,?,?)', f.userId, ...params),
    statement('DELETE FROM api_key_request_logs WHERE user_id=? AND id IN (?,?,?)', f.userId, ...params),
    statement('DELETE FROM public_model_daily_stats WHERE model_id IN (?,?,?)', ...f.cases.map(c => c.modelId)),
    ...['request_usage_commit_receipts','request_usage_recovery_jobs','request_usage_settlements','request_dispatch_intents','user_budget_reservations']
      .map(table => statement(`DELETE FROM ${table} WHERE ${ids}`, ...params)),
    statement('DELETE FROM api_keys WHERE id=? AND user_id=?', f.keyId, f.userId),
    statement('DELETE FROM workspaces WHERE id=? AND personal_owner_user_id=?', f.workspaceId, f.userId),
    statement('DELETE FROM users WHERE id=? AND email=?', f.userId, f.id + '@example.invalid'),
  ];
}
