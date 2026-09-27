// Review-only, opt-in, resumable expand backfill. It writes request-ID
// reservations, never source rows. Run each statement in its own transaction,
// save nextRequestId only after COMMIT, then repeat until scanned=0. A null
// cursor means the first page; '' is a valid historical log ID and means resume
// after that key. After all sources, the parent-gate checks for cursor races.
import { fileURLToPath } from 'node:url';

const sources = Object.freeze({
  parent: ['request_dispatch_requests', 'request_id'],
  intent: ['request_dispatch_intents', 'request_id'],
  fact: ['request_usage_settlements', 'request_id'],
  outbox: ['request_usage_settlement_outbox', 'request_id'],
  job: ['request_usage_recovery_jobs', 'request_id'],
  receipt: ['request_usage_commit_receipts', 'request_id'],
  legacy_log: ['api_key_request_logs', 'id'],
});
const uniqueSources = new Set(['parent', 'fact', 'outbox', 'job', 'receipt', 'legacy_log']);

export function buildPostgresReplayReservationBackfill({ source, afterRequestId = null, limit }) {
  if (!Object.hasOwn(sources, source)) throw new TypeError('Unknown replay reservation source');
  if (afterRequestId !== null
    && (typeof afterRequestId !== 'string' || afterRequestId.includes('\0')))
    throw new TypeError('Invalid request-ID cursor');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw new TypeError('Backfill limit must be 1..500');
  const [table, column] = sources[source];
  // Existing log IDs are unconstrained TEXT. No arbitrary length cap may make
  // a valid historical key impossible to resume after it becomes the cursor.
  // Hex framing avoids dependence on standard_conforming_strings and quoting.
  const cursor = afterRequestId === null ? null
    : `pg_catalog.convert_from(pg_catalog.decode('${Buffer.from(afterRequestId, 'utf8').toString('hex')}','hex'),'UTF8')`;
  // Use the source column's own collation for seek, ordering and max. Its PK
  // index has that collation; adding COLLATE "C" can force a full scan and sort
  // on every page even when the database's default collation is also C.
  // Only intents can repeat a request_id (one row per attempt).
  const distinct = uniqueSources.has(source) ? '' : 'DISTINCT ';
  const batchSql = `WITH batch AS MATERIALIZED (
  SELECT ${distinct}${column} AS request_id
  FROM cinatoken_gateway.${table}
  ${cursor === null ? '' : `WHERE ${column} > ${cursor}`}
  ORDER BY request_id
  LIMIT ${limit}
), inserted AS (
  INSERT INTO cinatoken_gateway.request_dispatch_replay_tombstones(request_id,first_source)
    SELECT request_id, '${source}' FROM batch
    ON CONFLICT (request_id) DO NOTHING
    RETURNING request_id
)
SELECT count(*)::integer AS scanned,
  (SELECT count(*)::integer FROM inserted) AS reserved,
  max(batch.request_id) AS next_request_id
FROM batch`;
  return Object.freeze({ source, afterRequestId, limit, batchSql, sql: `BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
DO $preflight$
BEGIN
  IF CURRENT_USER <> 'cinatoken_gateway_migrator'
    OR pg_catalog.to_regclass('cinatoken_gateway.request_dispatch_replay_tombstones') IS NULL
    OR pg_catalog.to_regclass('cinatoken_gateway.${table}') IS NULL THEN
    RAISE EXCEPTION 'Replay reservation backfill owner or source contract differs';
  END IF;
END;
$preflight$;
${batchSql};
COMMIT;
` });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [source, mode, ...rest] = process.argv.slice(2);
  const usage = 'Usage: node build-postgres-replay-reservation-backfill.mjs <source> --start <1..500> | <source> --after <id> <1..500>';
  const firstPage = mode === '--start' && rest.length === 1;
  const resumePage = mode === '--after' && rest.length === 2;
  if (!firstPage && !resumePage) throw new Error(usage);
  const afterRequestId = firstPage ? null : rest[0];
  const count = firstPage ? rest[0] : rest[1];
  process.stdout.write(buildPostgresReplayReservationBackfill({
    source, afterRequestId,
    limit: Number(count),
  }).sql);
}
