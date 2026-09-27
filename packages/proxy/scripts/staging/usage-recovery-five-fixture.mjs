// Operator-side synthetic fixture only. No network, credentials, deployment, or inference.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sample } from '../../../core/src/storage/recovery/usage-settlement-test-support.mjs';
import { encodeUsageSettlement } from '../../../core/src/storage/recovery/usage-settlement-codec.ts';
import { recoveryFixtureDatabase } from './usage-recovery-paid-fixture.mjs';
import { exactSizeSettlement, MAX_SNAPSHOT_PROFILES } from './usage-recovery-max-snapshot-fixture.mjs';

export const FIVE_FIXTURE_COSTS = Object.freeze([0, 0.1, 0.2, 0.3, 0.4]);
export const FIVE_FIXTURE_TABLES = Object.freeze([
  'users', 'workspaces', 'api_keys', 'request_dispatch_intents', 'user_budget_reservations',
  'request_usage_settlements', 'request_usage_recovery_jobs', 'request_usage_commit_receipts',
  'api_key_request_logs', 'provider_attempt_availability', 'user_audit_logs', 'public_model_daily_stats',
]);

const statement = (sql, ...params) => ({ sql, params });
export function validateFiveRecoveryFixture(f) {
  assert.equal(f.version, 1); assert.equal(f.syntheticFundsOnly, true);
  assert.ok(MAX_SNAPSHOT_PROFILES.includes(f.snapshotProfile));
  assert.equal(f.expectedSpentMicros, 1000000); assert.equal(f.expectedReservedMicros, 2000000);
  assert.match(f.id, /^staging-recovery-[a-f0-9-]{36}$/);
  assert.equal(f.userId, f.id + '-user');
  assert.equal(f.keyId, f.id + '-key');
  assert.equal(f.workspaceId, f.id + '-workspace');
  assert.equal(f.cases.length, 5);
  assert.equal(new Set(f.cases.map(c => c.requestId)).size, 5);
  f.cases.forEach((c, n) => {
    assert.match(c.requestId, /^gen-[a-f0-9-]{36}$/);
    assert.equal(c.modelId, f.id + '-model-' + n);
    assert.equal(c.cost, FIVE_FIXTURE_COSTS[n]);
    assert.equal(c.payloadBytes, 262144); assert.match(c.payloadSha256, /^[a-f0-9]{64}$/);
  });
}
function inRequests(f, column) {
  return [`${column} IN (?,?,?,?,?)`, f.cases.map(c => c.requestId)];
}

/** Capture the real repositories' INSERT/UPDATE statements, not terminal row dumps:
 * reservation INSERT triggers require reserved state and maintain account counters.
 * Jobs are enqueued by the real snapshot trigger, never inserted by the fixture.
 */
export async function buildFiveRecoveryFixture(profile) {
  assert.ok(MAX_SNAPSHOT_PROFILES.includes(profile));
  const db = recoveryFixtureDatabase(), id = 'staging-recovery-' + randomUUID();
  const f = { version: 1, id, userId: id + '-user', keyId: id + '-key', workspaceId: id + '-workspace',
    syntheticFundsOnly: true, snapshotProfile: profile, cases: [], seed: [], expectedSpentMicros: 1000000, expectedReservedMicros: 2000000 };
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
    for (const [n, cost] of FIVE_FIXTURE_COSTS.entries()) {
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
      const exact = await exactSizeSettlement(v, profile);
      const ref = await db.repo.persist(exact), encoded = await encodeUsageSettlement(exact);
      assert.equal(ref.payloadSha256, encoded.sha256);
      assert.equal(Buffer.byteLength(encoded.json), 262144);
      f.cases.push({ requestId: i.requestId, modelId: log.modelId, cost, recordedAt: v.recordedAtIso,
        payloadSha256: ref.payloadSha256, payloadBytes: Buffer.byteLength(encoded.json) });
    }
    // Admission requires an active key; finish all seed chunks with these exact disables before any recovery RPC.
    await db.binding.prepare("UPDATE api_keys SET status='disabled' WHERE id=? AND user_id=?").bind(f.keyId, f.userId).run();
    await db.binding.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(f.userId).run();
    validateFiveRecoveryFixture(f);
    assert.equal(f.seed.length, 28);
    assert.ok(Buffer.byteLength(JSON.stringify(f)) < 4 * 1024 * 1024);
    return f;
  } finally { db.sqlite.close(); }
}

/** Scoped scalar projections usable unchanged with SQLite or the staging D1 query API. */
export function fiveRecoveryObservations(f) {
  validateFiveRecoveryFixture(f);
  const [ids, params] = inRequests(f, 'request_id');
  return {
    account: statement('SELECT id,status,budget_spent_micros,budget_reserved_micros,budget_epoch FROM users WHERE id=?', f.userId),
    key: statement('SELECT id,status,user_id,workspace_id FROM api_keys WHERE id=?', f.keyId),
    intents: statement(`SELECT request_id,state,revision FROM request_dispatch_intents WHERE ${ids} ORDER BY request_id`, ...params),
    snapshots: statement(`SELECT request_id,payload_sha256,recorded_at,length(CAST(payload_json AS BLOB)) AS bytes FROM request_usage_settlements WHERE ${ids} ORDER BY request_id`, ...params),
    jobs: statement(`SELECT request_id,state,revision,attempts,last_error,lease_token,lease_expires_at FROM request_usage_recovery_jobs WHERE ${ids} ORDER BY request_id`, ...params),
    reservations: statement(`SELECT request_id,state,reserved_micros,settled_micros FROM user_budget_reservations WHERE ${ids} ORDER BY request_id`, ...params),
    receipts: statement(`SELECT request_id,payload_sha256,recorded_at,lease_revision FROM request_usage_commit_receipts WHERE ${ids} ORDER BY request_id`, ...params),
    logs: statement('SELECT id,user_id,api_key_id,workspace_id,model_id,charged_cost,budget_charged_micros,created_at FROM api_key_request_logs WHERE id IN (?,?,?,?,?) ORDER BY id', ...params),
    attempts: statement('SELECT request_log_id,attempt_index,outcome FROM provider_attempt_availability WHERE request_log_id IN (?,?,?,?,?) ORDER BY request_log_id', ...params),
    audit: statement('SELECT request_log_id,user_id,api_key_id,event_type FROM user_audit_logs WHERE request_log_id IN (?,?,?,?,?) ORDER BY request_log_id', ...params),
    stats: statement('SELECT model_id,stat_date,request_count,success_count,error_count,output_tokens,total_tokens,latency_total_ms,latency_sample_count FROM public_model_daily_stats WHERE model_id IN (?,?,?,?,?) ORDER BY model_id', ...f.cases.map(c => c.modelId)),
  };
}

/** Only after ingress is closed, jobs are not leased, and fixture ownership is rechecked.
 * No schema removal, broad user cleanup, or deleting shared model aggregates.
 */
export function fiveRecoveryCleanup(f) {
  validateFiveRecoveryFixture(f);
  const [ids, params] = inRequests(f, 'request_id');
  return [
    statement('DELETE FROM provider_attempt_availability WHERE request_log_id IN (?,?,?,?,?)', ...params),
    statement('DELETE FROM user_audit_logs WHERE user_id=? AND request_log_id IN (?,?,?,?,?)', f.userId, ...params),
    statement('DELETE FROM api_key_request_logs WHERE user_id=? AND id IN (?,?,?,?,?)', f.userId, ...params),
    statement('DELETE FROM public_model_daily_stats WHERE model_id IN (?,?,?,?,?)', ...f.cases.map(c => c.modelId)),
    ...['request_usage_commit_receipts','request_usage_recovery_jobs','request_usage_settlements','request_dispatch_intents','user_budget_reservations']
      .map(table => statement(`DELETE FROM ${table} WHERE ${ids}`, ...params)),
    statement('DELETE FROM api_keys WHERE id=? AND user_id=?', f.keyId, f.userId),
    statement('DELETE FROM workspaces WHERE id=? AND personal_owner_user_id=?', f.workspaceId, f.userId),
    statement('DELETE FROM users WHERE id=? AND email=?', f.userId, f.id + '@example.invalid'),
  ];
}
