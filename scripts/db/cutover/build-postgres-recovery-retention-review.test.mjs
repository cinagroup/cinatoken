import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPostgresRecoveryRetentionReview } from './build-postgres-recovery-retention-review.mjs';

test('retention review requires explicit bounded inputs and emits only read-only inspection', () => {
  for (const input of [undefined, null, '1', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => buildPostgresRecoveryRetentionReview({ cutoffMs: input, limit: 10 }), /cutoffMs/);
  }
  for (const input of [undefined, null, '1', 0, -1, 501, 1.5]) {
    assert.throws(() => buildPostgresRecoveryRetentionReview({ cutoffMs: 1, limit: input }), /limit/);
  }
  const review = buildPostgresRecoveryRetentionReview({ cutoffMs: 1_700_000_000_000, limit: 10 });
  assert.match(review.sql, /BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;/);
  assert.match(review.sql, /SET LOCAL statement_timeout = '15s';/);
  assert.match(review.sql, /transaction_read_only/);
  assert.match(review.sql, /false AS delete_allowed/g);
  assert.match(review.sql, /No approved retention interval or durable request-ID tombstone/);
  assert.match(review.sql, /pre_parent_intent_requires_backfill_review/);
  const executable = review.sql.replaceAll(/--[^\n]*/g, '')
    .replaceAll(/'(?:''|[^'])*'/g, "''");
  assert.doesNotMatch(executable, /\b(?:DELETE|UPDATE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|INSERT)\b/i);
});
