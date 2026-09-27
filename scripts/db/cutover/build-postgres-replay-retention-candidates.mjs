// Read-only, bounded keyset classification. This is NOT an archival or purge
// authorization. The request-ID reservation is durable but no approved
// retention interval or source-history contract exists, so delete_allowed is
// false for every row, including apparently clean pre-dispatch expirations.
import { fileURLToPath } from 'node:url';

export function buildPostgresReplayRetentionCandidates({ cutoffMs, limit,
  afterExpiresAtMs = 0, afterRequestId = '' }) {
  for (const [name, value, min, max] of [
    ['cutoffMs', cutoffMs, 1, 9007199254740991],
    ['limit', limit, 1, 500],
    ['afterExpiresAtMs', afterExpiresAtMs, 0, 9007199254740991],
  ]) {
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new TypeError(`${name} must be a safe integer in ${min}..${max}`);
  }
  if (typeof afterRequestId !== 'string' || afterRequestId.length > 200
    || afterRequestId.includes('\0')) throw new TypeError('Invalid request-ID cursor');
  const cursor = `'${afterRequestId.replaceAll("'", "''")}'`;
  const preflightSql = `DO $preflight$
BEGIN
  IF pg_catalog.current_setting('transaction_read_only') IS DISTINCT FROM 'on'
    OR pg_catalog.to_regclass('cinatoken_gateway.request_dispatch_replay_tombstones') IS NULL
    OR pg_catalog.to_regclass('cinatoken_gateway.request_dispatch_requests') IS NULL
    OR ${cutoffMs}::bigint > pg_catalog.floor(extract(epoch FROM pg_catalog.clock_timestamp())*1000)::bigint THEN
    RAISE EXCEPTION 'Replay retention review requires read-only installed schema and past cutoff';
  END IF;
END;
$preflight$`;
  const querySql = `WITH page AS MATERIALIZED (
  SELECT p.request_id,p.expires_at_ms,p.prepared_count,p.claim_count,p.first_claim_id
  FROM cinatoken_gateway.request_dispatch_requests p
  WHERE p.expires_at_ms <= ${cutoffMs}::bigint
    AND (p.expires_at_ms,p.request_id COLLATE "C") >
      (${afterExpiresAtMs}::bigint,${cursor} COLLATE "C")
  ORDER BY p.expires_at_ms,p.request_id COLLATE "C" LIMIT ${limit}
)
SELECT p.request_id,p.expires_at_ms,p.prepared_count,p.claim_count,
  (r.request_id IS NOT NULL) AS reservation_present,
  a.attempt_rows,a.expired_rows,a.claimed_or_unknown_rows,
  f.n AS fact_rows,o.n AS outbox_rows,j.n AS job_rows,
  c.n AS receipt_rows,l.n AS legacy_log_rows,
  CASE WHEN r.request_id IS NULL THEN 'missing_replay_reservation'
    WHEN p.claim_count <> 0 OR p.first_claim_id IS NOT NULL
      OR a.claimed_or_unknown_rows <> 0 THEN 'claimed_history_hold'
    WHEN f.n <> 0 OR o.n <> 0 OR j.n <> 0 OR c.n <> 0 OR l.n <> 0
      THEN 'financial_history_hold'
    WHEN a.attempt_rows <> p.prepared_count OR a.attempt_rows = 0
      OR a.expired_rows <> a.attempt_rows THEN 'incomplete_history_hold'
    ELSE 'pre_dispatch_expired_policy_review' END AS review_bucket,
  false AS delete_allowed,
  'No approved retention interval, archive integrity proof or source-history deletion contract'::text
    AS deletion_boundary
FROM page p
LEFT JOIN cinatoken_gateway.request_dispatch_replay_tombstones r
  ON r.request_id=p.request_id
LEFT JOIN LATERAL (SELECT count(*)::integer AS attempt_rows,
  count(*) FILTER (WHERE state='expired_before_dispatch')::integer AS expired_rows,
  count(*) FILTER (WHERE state IN ('dispatch_claimed','outcome_unknown'))::integer AS claimed_or_unknown_rows
  FROM cinatoken_gateway.request_dispatch_intents WHERE request_id=p.request_id) a ON true
LEFT JOIN LATERAL (SELECT count(*)::integer AS n FROM cinatoken_gateway.request_usage_settlements
  WHERE request_id=p.request_id) f ON true
LEFT JOIN LATERAL (SELECT count(*)::integer AS n FROM cinatoken_gateway.request_usage_settlement_outbox
  WHERE request_id=p.request_id) o ON true
LEFT JOIN LATERAL (SELECT count(*)::integer AS n FROM cinatoken_gateway.request_usage_recovery_jobs
  WHERE request_id=p.request_id) j ON true
LEFT JOIN LATERAL (SELECT count(*)::integer AS n FROM cinatoken_gateway.request_usage_commit_receipts
  WHERE request_id=p.request_id) c ON true
LEFT JOIN LATERAL (SELECT count(*)::integer AS n FROM cinatoken_gateway.api_key_request_logs
  WHERE id=p.request_id) l ON true
ORDER BY p.expires_at_ms,p.request_id COLLATE "C"`;
  return Object.freeze({ preflightSql, querySql,
    sql: `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
${preflightSql};
${querySql};
COMMIT;
` });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cutoff, limit, afterExpiry, afterId = ''] = process.argv.slice(2);
  if (process.argv.length < 4 || process.argv.length > 6)
    throw new Error('Usage: node build-postgres-replay-retention-candidates.mjs <cutoff-ms> <1..500> [after-expiry-ms] [after-id]');
  process.stdout.write(buildPostgresReplayRetentionCandidates({
    cutoffMs: Number(cutoff), limit: Number(limit),
    afterExpiresAtMs: Number(afterExpiry ?? 0), afterRequestId: afterId,
  }).sql);
}
