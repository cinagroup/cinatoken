// Operator-only transport bound; not a database transaction or a public API limit.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { paidRecoveryObservations } from './usage-recovery-paid-fixture.mjs';
export const MAX_RECOVERY_SEED_WIRE_BYTES = 512 * 1024;
export function recoverySeedBatches(fixture) {
  paidRecoveryObservations(fixture); // Validate exact synthetic tenant and request ownership.
  assert.equal(fixture.seed.length, 18);
  const source = JSON.parse(JSON.stringify(fixture.seed)), batches = [];
  const wire = statements => JSON.stringify({ batch: statements });
  let current = [];
  function flush() {
    if (!current.length) return;
    const body = wire(current);
    batches.push({ statements: current, wireBytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') });
    current = [];
  }
  for (const statement of source) {
    assert.ok(/^\s*(INSERT|UPDATE)\b/.test(statement.sql));
    assert.ok(Buffer.byteLength(statement.sql) < 100000 && Array.isArray(statement.params) && statement.params.length <= 100);
    assert.ok(Buffer.byteLength(wire([statement])) <= MAX_RECOVERY_SEED_WIRE_BYTES, 'One captured statement exceeds the operator transport bound');
    if (Buffer.byteLength(wire([...current, statement])) > MAX_RECOVERY_SEED_WIRE_BYTES) flush();
    current.push(statement);
  }
  flush(); assert.ok(batches.length >= 1 && batches.length <= 18);
  assert.deepEqual(batches.flatMap(b => b.statements), fixture.seed);
  return batches;
}
