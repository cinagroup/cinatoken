// Operator assertion: a stopped admission window is not a failed in-flight commit.
import assert from 'node:assert/strict';
export function assertMaxSnapshotRecoveryResult(result, expectedCommitted) {
  assert.ok(Number.isSafeInteger(expectedCommitted) && expectedCommitted >= 0 && expectedCommitted <= 5);
  assert.equal(typeof result?.admissionStopped, 'boolean');
  assert.deepEqual(result, {
    scanned: expectedCommitted, claimed: expectedCommitted, committed: expectedCommitted,
    blocked: 0, deferred: 0, lostOwnership: 0, uncertain: 0, skipped: 0, capacityLimited: false,
    admissionStopped: result.admissionStopped,
  });
  // Caller must additionally verify all durable financial projections and repeat stability.
}
