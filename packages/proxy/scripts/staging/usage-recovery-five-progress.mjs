// Operator-only evidence checker for bounded multi-invocation recovery.
import assert from 'node:assert/strict';
import { fiveRecoveryObservations } from './usage-recovery-five-fixture.mjs';

export function assertFiveSnapshotProgress(f, o) {
  fiveRecoveryObservations(f); // Reuse strict fixture identity/cost validation.
  const cases = [...f.cases].sort((a, b) => a.requestId.localeCompare(b.requestId));
  assert.deepEqual(o.jobs.map(j => j.request_id), cases.map(c => c.requestId));
  const byId = new Map(o.jobs.map(j => [j.request_id, j]));
  const done = c => byId.get(c.requestId).state === 'committed';
  for (const j of o.jobs) {
    assert.ok(j.state === 'pending' || j.state === 'committed');
    assert.ok(Number.isSafeInteger(j.attempts) && j.attempts >= (j.state === 'committed' ? 1 : 0) && j.attempts <= 5);
    assert.deepEqual(j, { request_id: j.request_id, state: j.state, revision: 2 * j.attempts, attempts: j.attempts,
      last_error: j.state === 'pending' && j.attempts > 0 ? 'interrupted' : null, lease_token: null, lease_expires_at: null });
  }
  assert.deepEqual(o.account, [{ id: f.userId, status: 'disabled', budget_epoch: 0,
    budget_spent_micros: cases.filter(done).reduce((n, c) => n + Math.round(c.cost * 1e6), 0),
    budget_reserved_micros: cases.filter(c => c.cost > 0 && !done(c)).length * 500000 }]);
  assert.deepEqual(o.key, [{ id: f.keyId, status: 'disabled', user_id: f.userId, workspace_id: f.workspaceId }]);
  assert.deepEqual(o.intents, cases.map(c => ({ request_id: c.requestId, state: 'dispatch_claimed', revision: 1 })));
  assert.deepEqual(o.snapshots, cases.map(c => ({ request_id: c.requestId, payload_sha256: c.payloadSha256,
    recorded_at: c.recordedAt, bytes: 262144 })));
  assert.ok(f.cases.every(c => c.payloadBytes === 262144));
  assert.deepEqual(o.reservations, cases.filter(c => c.cost > 0).map(c => ({ request_id: c.requestId,
    state: done(c) ? 'settled' : 'dispatched', reserved_micros: 500000, settled_micros: done(c) ? Math.round(c.cost * 1e6) : 0 })));
  assert.deepEqual(o.receipts, cases.filter(done).map(c => ({ request_id: c.requestId, payload_sha256: c.payloadSha256,
    recorded_at: c.recordedAt, lease_revision: 2 * byId.get(c.requestId).attempts - 1 })));
  assert.deepEqual(o.logs, cases.filter(done).map(c => ({ id: c.requestId, user_id: f.userId, api_key_id: f.keyId,
    workspace_id: f.workspaceId, model_id: c.modelId, charged_cost: c.cost, budget_charged_micros: Math.round(c.cost * 1e6), created_at: c.recordedAt })));
  assert.deepEqual(o.attempts, cases.filter(done).map(c => ({ request_log_id: c.requestId, attempt_index: 1, outcome: 'available' })));
  assert.deepEqual(o.audit, cases.filter(c => c.cost > 0 && done(c)).map(c => ({ request_log_id: c.requestId, user_id: f.userId, api_key_id: f.keyId, event_type: 'usage_charge' })));
  assert.deepEqual(o.stats, f.cases.filter(done).map(c => ({ model_id: c.modelId, stat_date: c.recordedAt.slice(0, 10),
    request_count: 1, success_count: 1, error_count: 0, output_tokens: 1, total_tokens: 11, latency_total_ms: 10, latency_sample_count: 1 })));
}

export function assertFiveSnapshotInvocationProgress(f, before, after, result) {
  assertFiveSnapshotProgress(f, before); assertFiveSnapshotProgress(f, after);
  assert.deepEqual(after.snapshots, before.snapshots);
  let claimed = 0, committed = 0, deferred = 0;
  for (let i = 0; i < before.jobs.length; i++) {
    const a = before.jobs[i], b = after.jobs[i];
    if (a.state === 'committed') { assert.deepEqual(b, a); continue; }
    const delta = b.attempts - a.attempts;
    assert.ok(delta === 0 || delta === 1, 'At most one claim per job per invocation');
    if (delta === 0) { assert.deepEqual(b, a); continue; }
    claimed++;
    if (b.state === 'committed') committed++;
    else deferred++;
  }
  assert.equal(typeof result?.admissionStopped, 'boolean');
  assert.ok(Number.isSafeInteger(result.scanned) && result.scanned >= claimed && result.scanned <= before.jobs.filter(j => j.state === 'pending').length);
  if (deferred > 0 || claimed < result.scanned) assert.equal(result.admissionStopped, true);
  assert.deepEqual(result, { scanned: result.scanned, claimed, committed, deferred,
    blocked: 0, lostOwnership: 0, uncertain: 0, skipped: 0, capacityLimited: false, admissionStopped: result.admissionStopped });
  return { committed: after.jobs.filter(j => j.state === 'committed').length, pending: after.jobs.filter(j => j.state === 'pending').length };
}
