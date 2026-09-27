// Operator-only oracle for exactly two independent five-job fixtures. No I/O.
import assert from 'node:assert/strict';
import { validateFiveRecoveryFixture } from './usage-recovery-five-fixture.mjs';
import { assertFiveSnapshotProgress } from './usage-recovery-five-progress.mjs';

// Intentionally global, not filtered to fixture IDs: an unexpected eleventh job
// must fail closed. This is bounded scalar evidence, never a payload read.
export const BACKLOG_RECOVERY_SCOPE_QUERY = `SELECT request_id,user_id,api_key_id,workspace_id,payload_sha256,
  state,revision,attempts,available_at,unixepoch('now') AS now_seconds
  FROM request_usage_recovery_jobs ORDER BY available_at,request_id LIMIT 11`;

function validate(fixtures, observations) {
  assert.ok(Array.isArray(fixtures) && fixtures.length === 2, 'Exactly two five-job fixtures required');
  assert.ok(Array.isArray(observations) && observations.length === 2, 'Exactly two tenant observations required');
  fixtures.forEach(validateFiveRecoveryFixture);
  for (const key of ['id', 'userId', 'keyId', 'workspaceId'])
    assert.equal(new Set(fixtures.map(f => f[key])).size, 2, 'Fixtures must be independent: ' + key);
  for (const key of ['requestId', 'modelId'])
    assert.equal(new Set(fixtures.flatMap(f => f.cases.map(c => c[key]))).size, 10, 'Overlapping fixture ' + key);
  fixtures.forEach((f, i) => assertFiveSnapshotProgress(f, observations[i]));
}

/** All eleven existing scalar/accounting projections are checked per tenant;
 * aggregate money alone cannot establish ownership or exactly-once effects. */
export function assertBacklogSnapshotProgress(fixtures, observations) {
  validate(fixtures, observations);
  const jobs = observations.flatMap(o => o.jobs);
  return { committed: jobs.filter(j => j.state === 'committed').length, pending: jobs.filter(j => j.state === 'pending').length };
}

const binaryCompare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function dueOrder(fixtures, before, rows) {
  assert.ok(Array.isArray(rows) && rows.length === 10, 'Global scope must contain exactly the ten fixture jobs');
  assert.equal(new Set(rows.map(r => r.request_id)).size, 10, 'Duplicate global job');
  const cases = new Map(fixtures.flatMap(f => f.cases.map(c => [c.requestId, { f, c }])));
  const jobs = new Map(before.flatMap(o => o.jobs).map(j => [j.request_id, j]));
  const now = rows[0].now_seconds;
  assert.ok(Number.isSafeInteger(now) && now >= 0, 'Database observation time required');
  for (const r of rows) {
    const owner = cases.get(r.request_id);
    assert.ok(owner, 'Global scope contains a foreign job');
    const { f, c } = owner, job = jobs.get(r.request_id);
    if (job.state === 'committed') assert.equal(r.available_at, null);
    else assert.ok(Number.isSafeInteger(r.available_at) && r.available_at >= 0, 'Pending job requires original due time');
    assert.deepEqual(r, { request_id: c.requestId, user_id: f.userId, api_key_id: f.keyId,
      workspace_id: f.workspaceId, payload_sha256: c.payloadSha256, state: job.state,
      revision: job.revision, attempts: job.attempts, available_at: r.available_at, now_seconds: now });
  }
  // SQLite ASC puts NULL first. All validated request IDs are ASCII, so binary
  // comparison avoids a locale-sensitive approximation of SQLite ordering.
  const ordered = [...rows].sort((a, b) => (a.available_at === b.available_at ? 0
    : a.available_at === null ? -1 : b.available_at === null ? 1 : a.available_at - b.available_at)
    || binaryCompare(a.request_id, b.request_id));
  assert.deepEqual(rows, ordered, 'Global observation must retain database due ordering');
  return rows.filter(r => r.state === 'pending' && r.available_at <= now).map(r => r.request_id);
}

/** One existing staging host invocation: maxItems=5, concurrency=1, known
 * pending/committed outcomes only. Optional globalRows must be the unmodified
 * BACKLOG_RECOVERY_SCOPE_QUERY result immediately before the run, with no other
 * writer or due-time boundary crossing between observation and the actual scan.
 * It proves that observed scope/order only, not tenant fairness or fleet locking.
 * Without globalRows, counters/effects are checked but selection is unproven. */
export function assertBacklogSnapshotInvocationProgress(fixtures, before, after, result, globalRows) {
  assertBacklogSnapshotProgress(fixtures, before);
  const progress = assertBacklogSnapshotProgress(fixtures, after);
  let claimed = 0, committed = 0, deferred = 0;
  const changed = [], interrupted = [];
  for (let tenant = 0; tenant < 2; tenant++) {
    assert.deepEqual(after[tenant].snapshots, before[tenant].snapshots);
    for (let i = 0; i < before[tenant].jobs.length; i++) {
      const a = before[tenant].jobs[i], b = after[tenant].jobs[i];
      if (a.state === 'committed') { assert.deepEqual(b, a, 'Committed job cannot be recaptured'); continue; }
      const delta = b.attempts - a.attempts;
      assert.ok(delta === 0 || delta === 1, 'At most one claim per job per invocation');
      if (delta === 0) { assert.deepEqual(b, a); continue; }
      claimed++; changed.push(b.request_id);
      if (b.state === 'committed') committed++;
      else { deferred++; interrupted.push(b.request_id); }
    }
  }
  assert.equal(typeof result?.admissionStopped, 'boolean');
  assert.ok(Number.isSafeInteger(result.scanned) && result.scanned >= claimed && result.scanned <= 5
    && result.scanned <= before.flatMap(o => o.jobs).filter(j => j.state === 'pending').length, 'Staging scan bound is five');
  assert.ok(deferred <= 1, 'A sequential interrupted consumer stops after one deferral');
  if (deferred > 0 || claimed < result.scanned) assert.equal(result.admissionStopped, true);
  assert.deepEqual(result, { scanned: result.scanned, claimed, committed, deferred,
    blocked: 0, lostOwnership: 0, uncertain: 0, skipped: 0, capacityLimited: false, admissionStopped: result.admissionStopped });
  if (globalRows !== undefined) {
    const due = dueOrder(fixtures, before, globalRows);
    // A budget stop may happen before scanning. Otherwise the bounded scan reads
    // every member of this first page, even when later admission stops early.
    if (result.scanned === 0 && result.admissionStopped) assert.equal(claimed, 0);
    else assert.equal(result.scanned, Math.min(5, due.length), 'Result must match the observed due first page');
    assert.deepEqual(changed.sort(binaryCompare), due.slice(0, claimed).sort(binaryCompare), 'Claims must be the sequential due prefix');
    if (deferred) assert.equal(interrupted[0], due[claimed - 1], 'Interrupted claim ends this invocation');
  }
  return progress;
}
