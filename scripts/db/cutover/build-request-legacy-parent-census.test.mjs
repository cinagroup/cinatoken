import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRequestLegacyParentCensus } from './build-request-legacy-parent-census.mjs';

test('legacy parent census is bounded, resumable and read only', () => {
  const first = buildRequestLegacyParentCensus({ cursor: '', limit: 17 });
  const next = buildRequestLegacyParentCensus({ cursor: 'old:a-1', limit: 17 });
  assert.match(first.sql, /REPEATABLE READ READ ONLY/);
  assert.match(first.preflightSql, /transaction_read_only/);
  assert.match(first.pageSql, /LIMIT 17/);
  assert.match(next.pageSql, /old:a-1/);
  assert.match(next.pageSql, /original_request_sha256/);
  assert.match(next.pageSql, /original_total_attempt_budget_recoverable/);
  assert.doesNotMatch(first.pageSql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP)\b/i);
  for (const cursor of ["x' OR true --", 'bad id', 'a'.repeat(201), '\n']) {
    assert.throws(() => buildRequestLegacyParentCensus({ cursor }), /cursor/);
  }
  for (const limit of [0, 501, 1.5, NaN]) {
    assert.throws(() => buildRequestLegacyParentCensus({ limit }), /limit/);
  }
});
