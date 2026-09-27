// Review-only, opt-in inspection of the PostgreSQL Images recovery graph.
// This file never emits DELETE, UPDATE, TRUNCATE, DDL, or a retention grant.
// An expired parent/intent is the only current request-id replay barrier;
// there is no durable tombstone or approved retention interval yet.
import { fileURLToPath } from 'node:url';

const TABLES = Object.freeze([
  'request_dispatch_requests',
  'request_dispatch_intents',
  'request_usage_settlements',
  'request_usage_settlement_outbox',
  'request_usage_recovery_jobs',
  'request_usage_commit_receipts',
  'api_key_request_logs',
]);

function integer(value, label, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
    || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function buildPostgresRecoveryRetentionReview({ cutoffMs, limit }) {
  integer(cutoffMs, 'cutoffMs', 1, 9007199254740991);
  integer(limit, 'limit', 1, 500);
  const tables = TABLES.map(table => `      ('cinatoken_gateway.${table}')`).join(',\n');
  const preflightSql = `DO $retention_review_preflight$
DECLARE missing text;
BEGIN
  IF pg_catalog.current_setting('transaction_read_only') IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Recovery retention review requires a READ ONLY transaction';
  END IF;
  IF ${cutoffMs}::bigint > pg_catalog.floor(
      extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint THEN
    RAISE EXCEPTION 'Recovery retention review cutoff is in the future';
  END IF;
  SELECT string_agg(required.name, ', ' ORDER BY required.name) INTO missing
  FROM (VALUES
${tables}
  ) AS required(name)
  LEFT JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass(required.name)
  WHERE c.oid IS NULL OR c.relkind <> 'r' OR c.relrowsecurity OR c.relforcerowsecurity;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Recovery retention review table missing, nonordinary or RLS filtered: %', missing;
  END IF;
  IF pg_catalog.to_regprocedure(
      'cinatoken_gateway.prepare_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint,integer)') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index
      WHERE indexrelid = pg_catalog.to_regclass(
        'cinatoken_gateway.request_dispatch_intents_one_claim_per_request')
        AND indisunique AND indisvalid AND indislive) THEN
    RAISE EXCEPTION 'Recovery parent proposal or single-claim index is absent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cinatoken_gateway.schema_migrations
      WHERE version = '0073_recovery_api_key_workspace_lock.sql') THEN
    RAISE EXCEPTION 'Expected PostgreSQL recovery migration corpus is absent';
  END IF;
END;
$retention_review_preflight$;`;

  // Bounded parent sample. Every lateral lookup uses request_id keys; counts are
  // diagnostic only. No result is an authorization to delete after this snapshot.
  const parentSql = `WITH observed AS (
  SELECT pg_catalog.floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint AS at_ms
), sampled AS (
  SELECT p.* FROM cinatoken_gateway.request_dispatch_requests p, observed o
  WHERE p.expires_at_ms <= ${cutoffMs}::bigint AND p.expires_at_ms <= o.at_ms
  ORDER BY p.expires_at_ms, p.request_id
  LIMIT ${limit}
)
SELECT p.request_id, p.expires_at_ms, p.prepared_count, p.claim_count,
  a.attempt_rows, a.prepared_rows, a.claimed_rows, a.unknown_rows,
  a.expired_before_dispatch_rows,
  f.n AS fact_rows, o.n AS outbox_rows, j.n AS job_rows,
  r.n AS receipt_rows, l.n AS legacy_log_rows,
  CASE WHEN p.claim_count = 0 AND p.first_claim_id IS NULL
      AND p.prepared_count = a.attempt_rows AND a.attempt_rows > 0
      AND a.attempt_rows = a.expired_before_dispatch_rows
      AND f.n = 0 AND o.n = 0 AND j.n = 0 AND r.n = 0 AND l.n = 0
    THEN 'pre_dispatch_expired_policy_review' ELSE 'hold' END AS review_bucket,
  pg_catalog.array_remove(ARRAY[
    CASE WHEN p.claim_count <> 0 OR p.first_claim_id IS NOT NULL
      THEN 'parent_claim_consumed' END,
    CASE WHEN a.claimed_rows <> 0 OR a.unknown_rows <> 0
      THEN 'claimed_or_unknown_attempt' END,
    CASE WHEN a.prepared_rows <> 0 THEN 'prepared_attempt' END,
    CASE WHEN a.attempt_rows = 0 OR p.prepared_count <> a.attempt_rows
      OR a.attempt_rows <> a.expired_before_dispatch_rows
      THEN 'attempt_history_incomplete_or_nonterminal' END,
    CASE WHEN f.n <> 0 THEN 'immutable_settlement_fact' END,
    CASE WHEN o.n <> 0 THEN 'immutable_discovery_outbox' END,
    CASE WHEN j.n <> 0 THEN 'recovery_job' END,
    CASE WHEN r.n <> 0 THEN 'immutable_financial_receipt' END,
    CASE WHEN l.n <> 0 THEN 'legacy_financial_log' END
  ], NULL::text) AS observed_blockers,
  false AS delete_allowed,
  'No approved retention interval or durable request-ID tombstone; snapshot cannot authorize DELETE'::text
    AS deletion_boundary
FROM sampled p
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS attempt_rows,
    count(*) FILTER (WHERE state = 'prepared')::integer AS prepared_rows,
    count(*) FILTER (WHERE state = 'dispatch_claimed')::integer AS claimed_rows,
    count(*) FILTER (WHERE state = 'outcome_unknown')::integer AS unknown_rows,
    count(*) FILTER (WHERE state = 'expired_before_dispatch')::integer AS expired_before_dispatch_rows
  FROM cinatoken_gateway.request_dispatch_intents i WHERE i.request_id = p.request_id
) a ON true
LEFT JOIN LATERAL (SELECT count(*)::integer AS n FROM cinatoken_gateway.request_usage_settlements
  WHERE request_id = p.request_id) f ON true
LEFT JOIN LATERAL (SELECT count(*)::integer AS n FROM cinatoken_gateway.request_usage_settlement_outbox
  WHERE request_id = p.request_id) o ON true
LEFT JOIN LATERAL (SELECT count(*)::integer AS n FROM cinatoken_gateway.request_usage_recovery_jobs
  WHERE request_id = p.request_id) j ON true
LEFT JOIN LATERAL (SELECT count(*)::integer AS n FROM cinatoken_gateway.request_usage_commit_receipts
  WHERE request_id = p.request_id) r ON true
LEFT JOIN LATERAL (SELECT count(*)::integer AS n FROM cinatoken_gateway.api_key_request_logs
  WHERE id = p.request_id) l ON true
ORDER BY p.expires_at_ms, p.request_id;`;

  // Formal migration 0069 predates the optional parent proposal. Such rows
  // require explicit backfill review and must not disappear from an audit.
  const orphanSql = `SELECT i.request_id, i.attempt_index, i.state, i.expires_at_ms,
  'pre_parent_intent_requires_backfill_review'::text AS review_bucket,
  false AS delete_allowed,
  'No parent/tombstone; claim history may be the only replay barrier'::text AS deletion_boundary
FROM cinatoken_gateway.request_dispatch_intents i
WHERE i.expires_at_ms <= ${cutoffMs}::bigint
  AND NOT EXISTS (SELECT 1 FROM cinatoken_gateway.request_dispatch_requests p
    WHERE p.request_id = i.request_id)
ORDER BY i.expires_at_ms, i.request_id, i.attempt_index
LIMIT ${limit};`;

  return Object.freeze({ preflightSql, parentSql, orphanSql,
    sql: `-- Review-only snapshot. Supply a deliberately chosen cutoff; it is not a retention policy.\n`
      + `-- Run with ON_ERROR_STOP=1; no result authorizes deletion.\n`
      + `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;\n`
      + `SET LOCAL lock_timeout = '2s';\nSET LOCAL statement_timeout = '15s';\n`
      + `${preflightSql}\n${parentSql}\n${orphanSql}\nCOMMIT;\n` });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--cutoff-ms' || args[2] !== '--limit') {
    throw new Error('Usage: node build-postgres-recovery-retention-review.mjs --cutoff-ms <explicit epoch ms> --limit <1..500>');
  }
  process.stdout.write(buildPostgresRecoveryRetentionReview({
    cutoffMs: Number(args[1]), limit: Number(args[3]),
  }).sql);
}
