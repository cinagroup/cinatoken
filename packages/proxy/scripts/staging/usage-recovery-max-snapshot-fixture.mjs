// Operator-only exact-byte fixtures. Never imported by a Worker or public route.
import assert from 'node:assert/strict';
import { encodeUsageSettlement, decodeUsageSettlement, MAX_SETTLEMENT_BYTES } from '../../../core/src/storage/recovery/usage-settlement-codec.ts';
import { buildPaidRecoveryFixture, recoveryFixtureDatabase } from './usage-recovery-paid-fixture.mjs';

export const MAX_SNAPSHOT_PROFILES = Object.freeze(['ascii', 'unicode', 'dense', 'escaped']);
const bytes = value => Buffer.byteLength(JSON.stringify(value));

function auditText(limit, profile) {
  if (profile === 'dense') {
    const count = Math.max(0, Math.floor((limit - 1) / 3));
    const text = count ? '[' + Array(count).fill('{}').join(',') + ']' : '[]';
    return text + ' '.repeat(limit - Buffer.byteLength(text));
  }
  const character = profile === 'unicode' ? '漢' : profile === 'escaped' ? '"' : 'x';
  const unit = Buffer.byteLength(JSON.stringify(character)) - 2;
  const text = JSON.stringify(character.repeat(Math.floor((limit - 2) / unit)));
  return text + ' '.repeat(limit - Buffer.byteLength(text));
}

/** Keep the real financial/identity fields. Only synthetic audit content grows.
 * Sizing never catches arbitrary codec errors or pads an already hashed payload.
 * max+1 is available solely for rejection tests, not for fixture persistence.
 */
export async function exactSizeSettlement(input, profile, targetBytes = MAX_SETTLEMENT_BYTES) {
  assert.ok(MAX_SNAPSHOT_PROFILES.includes(profile), 'Unknown maximum snapshot profile');
  assert.ok(Number.isSafeInteger(targetBytes) && targetBytes >= MAX_SETTLEMENT_BYTES - 1 && targetBytes <= MAX_SETTLEMENT_BYTES + 1);
  const original = await encodeUsageSettlement(input);
  const value = await decodeUsageSettlement(original.json, original.sha256);
  const log = value.params.requestLog, audit = value.params.audit;
  audit.reasonText = '';
  const fields = [[log, 'rawUsage', 65536], [log, 'pricingAudit', 65536],
    [log, 'routeTrace', 32768], [log, 'timingMetadata', 32768],
    [audit, 'beforeUserSnapshot', 32768], [audit, 'afterUserSnapshot', 32768]];
  assert.ok(bytes(value) < targetBytes, 'Base fixture must be below the target');
  for (const [object, key, limit] of fields) {
    object[key] = auditText(limit, profile);
    if (bytes(value) <= targetBytes) continue;
    let low = 2, high = limit;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      object[key] = auditText(middle, profile);
      if (bytes(value) <= targetBytes) low = middle + 1;
      else high = middle - 1;
    }
    assert.ok(high >= 2, 'Field envelope must fit');
    object[key] = auditText(high, profile);
    break;
  }
  const remaining = targetBytes - bytes(value);
  assert.ok(remaining >= 0 && remaining <= 32, 'Audit fields must reach the boundary');
  audit.reasonText = 'x'.repeat(remaining);
  assert.equal(bytes(value), targetBytes);
  return value;
}

/** Re-execute the existing synthetic tenant's repository transitions locally.
 * Replace each small persist operation with a real persist of an exact-size DTO.
 * Capture INSERT/UPDATE statements, not fabricated terminal job/receipt rows.
 */
export async function buildMaxSnapshotRecoveryFixture(profile) {
  assert.ok(MAX_SNAPSHOT_PROFILES.includes(profile), 'Unknown maximum snapshot profile');
  const original = await buildPaidRecoveryFixture(), db = recoveryFixtureDatabase();
  const fixture = { ...original, snapshotProfile: profile, seed: [], cases: [] };
  db.hooks.beforeStatement = (sql, params) => {
    if (/^\s*(INSERT|UPDATE)\b/.test(sql)) fixture.seed.push({ sql, params: [...params] });
  };
  db.hooks.afterBatch = () => { throw new Error('Maximum snapshot seed unexpectedly used a batch'); };
  try {
    for (const statement of original.seed) {
      if (/^\s*INSERT INTO request_usage_settlements\b/.test(statement.sql)) {
        assert.equal(statement.params.length, 12);
        const small = await decodeUsageSettlement(statement.params[9], statement.params[10]);
        const value = await exactSizeSettlement(small, profile);
        const reference = await db.repo.persist(value);
        const encoded = await encodeUsageSettlement(value);
        assert.equal(reference.payloadSha256, encoded.sha256);
        assert.equal(Buffer.byteLength(encoded.json), MAX_SETTLEMENT_BYTES);
        const prior = original.cases.find(c => c.requestId === reference.requestId);
        assert.ok(prior);
        fixture.cases.push({ ...prior, payloadSha256: encoded.sha256, payloadBytes: MAX_SETTLEMENT_BYTES });
      } else {
        await db.binding.prepare(statement.sql).bind(...statement.params).run();
      }
    }
    assert.equal(fixture.seed.length, original.seed.length);
    assert.deepEqual(fixture.cases.map(c => c.requestId), original.cases.map(c => c.requestId));
    assert.ok(Buffer.byteLength(JSON.stringify(fixture)) <= 4 * 1024 * 1024);
    return fixture;
  } finally { db.sqlite.close(); }
}
