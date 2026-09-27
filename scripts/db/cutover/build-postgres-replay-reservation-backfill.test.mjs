import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildPostgresReplayReservationBackfill } from './build-postgres-replay-reservation-backfill.mjs';

const script = fileURLToPath(new URL('./build-postgres-replay-reservation-backfill.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('first page differs from resume after a valid empty legacy log ID', () => {
  const first = buildPostgresReplayReservationBackfill({ source: 'legacy_log', limit: 2 });
  const afterEmpty = buildPostgresReplayReservationBackfill({
    source: 'legacy_log', afterRequestId: '', limit: 2 });
  assert.equal(first.afterRequestId, null);
  assert.doesNotMatch(first.batchSql, /WHERE id >/);
  assert.equal(afterEmpty.afterRequestId, '');
  assert.match(afterEmpty.batchSql, /WHERE id > pg_catalog\.convert_from/);
  assert.equal(run('legacy_log', '--start', '2').stdout, first.sql);
  assert.equal(run('legacy_log', '--after', '', '2').stdout, afterEmpty.sql);
});

test('CLI mode and a historical ID with the same text remain unambiguous', () => {
  const afterFlagId = buildPostgresReplayReservationBackfill({
    source: 'legacy_log', afterRequestId: '--start', limit: 1 });
  const result = run('legacy_log', '--after', '--start', '1');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, afterFlagId.sql);
  assert.notEqual(run('legacy_log', '--start', '--start', '1').status, 0);
});
