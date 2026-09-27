// Review-only census of formal 0069 dispatch intents created before the optional
// request parent. A cursor is diagnostic, not a cutover watermark: a final
// locked census is required because live writers can insert below the cursor.
import { fileURLToPath } from 'node:url';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function buildRequestLegacyParentCensus({ cursor = '', limit = 100 } = {}) {
  if (typeof cursor !== 'string' || (cursor !== '' && !ID.test(cursor))) {
    throw new TypeError('cursor must be an empty string or a valid request ID');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new TypeError('limit must be an integer between 1 and 500');
  }
  const preflightSql = `DO $legacy_parent_census$
BEGIN
  IF pg_catalog.current_setting('transaction_read_only') IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Legacy parent census requires a READ ONLY transaction';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cinatoken_gateway.schema_migrations
      WHERE version = '0073_recovery_api_key_workspace_lock.sql')
    OR pg_catalog.to_regclass('cinatoken_gateway.request_dispatch_intents') IS NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid = 'cinatoken_gateway.request_dispatch_intents'::pg_catalog.regclass
        AND attname = 'request_sha256' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Expected pre-parent formal 0069-0073 intent schema is absent';
  END IF;
END;
$legacy_parent_census$;`;
  const pageSql = `WITH ids AS (
  SELECT DISTINCT i.request_id COLLATE "C" AS request_id
  FROM cinatoken_gateway.request_dispatch_intents i
  WHERE i.request_id COLLATE "C" > '${cursor}' COLLATE "C"
  ORDER BY request_id LIMIT ${limit}
)
SELECT ids.request_id,
  a.attempt_rows, a.min_attempt_index, a.max_attempt_index,
  a.scope_variants, a.claimed_rows, a.unknown_rows,
  a.prepared_rows, a.expired_rows, a.min_created_at_ms,
  a.min_expires_at_ms, a.max_expires_at_ms,
  f.fact_rows, o.outbox_rows, j.job_rows, r.receipt_rows, l.log_rows,
  NULL::text AS original_request_sha256,
  false AS original_request_digest_recoverable,
  false AS original_total_attempt_budget_recoverable,
  false AS original_request_deadline_recoverable,
  true AS require_permanent_replay_reservation,
  pg_catalog.array_to_string(pg_catalog.array_remove(ARRAY[
    CASE WHEN a.max_attempt_index > 3 OR a.attempt_rows > 3
      THEN 'exceeds_v1_parent_attempt_ceiling' END,
    CASE WHEN a.scope_variants <> 1 THEN 'inconsistent_legacy_scope' END,
    CASE WHEN a.claimed_rows + a.unknown_rows > 0 THEN 'claim_consumed_or_unknown' END,
    CASE WHEN a.prepared_rows > 0 THEN 'prepared_attempt_still_present' END,
    CASE WHEN f.fact_rows + o.outbox_rows + j.job_rows + r.receipt_rows > 0
      THEN 'financial_evidence_present' END,
    CASE WHEN l.log_rows > 0 THEN 'legacy_log_id_collision' END
  ], NULL::text), '|') AS observed_barriers
FROM ids
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS attempt_rows,
    min(attempt_index) AS min_attempt_index,
    max(attempt_index) AS max_attempt_index,
    count(DISTINCT (user_id,api_key_id,workspace_id,operation))::integer AS scope_variants,
    count(*) FILTER (WHERE state='dispatch_claimed')::integer AS claimed_rows,
    count(*) FILTER (WHERE state='outcome_unknown')::integer AS unknown_rows,
    count(*) FILTER (WHERE state='prepared')::integer AS prepared_rows,
    count(*) FILTER (WHERE state='expired_before_dispatch')::integer AS expired_rows,
    min(created_at_ms) AS min_created_at_ms,
    min(expires_at_ms) AS min_expires_at_ms,
    max(expires_at_ms) AS max_expires_at_ms
  FROM cinatoken_gateway.request_dispatch_intents i
  WHERE i.request_id=ids.request_id
) a ON true
LEFT JOIN LATERAL (SELECT count(*)::integer AS fact_rows
  FROM cinatoken_gateway.request_usage_settlements WHERE request_id=ids.request_id) f ON true
LEFT JOIN LATERAL (SELECT count(*)::integer AS outbox_rows
  FROM cinatoken_gateway.request_usage_settlement_outbox WHERE request_id=ids.request_id) o ON true
LEFT JOIN LATERAL (SELECT count(*)::integer AS job_rows
  FROM cinatoken_gateway.request_usage_recovery_jobs WHERE request_id=ids.request_id) j ON true
LEFT JOIN LATERAL (SELECT count(*)::integer AS receipt_rows
  FROM cinatoken_gateway.request_usage_commit_receipts WHERE request_id=ids.request_id) r ON true
LEFT JOIN LATERAL (SELECT count(*)::integer AS log_rows
  FROM cinatoken_gateway.api_key_request_logs WHERE id=ids.request_id) l ON true
ORDER BY ids.request_id COLLATE "C";`;
  return Object.freeze({ preflightSql, pageSql,
    sql: `-- Review only. Page cursors can miss concurrent inserts; recensus under a write-blocking lock before any activation.\n`
      + `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;\n`
      + `SET LOCAL lock_timeout = '2s';\nSET LOCAL statement_timeout = '15s';\n`
      + `${preflightSql}\n${pageSql}\nCOMMIT;\n` });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--cursor' || args[2] !== '--limit') {
    throw new Error('Usage: node build-request-legacy-parent-census.mjs --cursor <request-id-or-empty> --limit <1..500>');
  }
  process.stdout.write(buildRequestLegacyParentCensus({ cursor: args[1], limit: Number(args[3]) }).sql);
}
