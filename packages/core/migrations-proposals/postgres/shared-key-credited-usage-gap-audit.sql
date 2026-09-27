-- REVIEW ONLY / READ ONLY. C04.7 per-key audit of the legacy shared_keys
-- counters against both immutable credited-detail sources. Do not put this in
-- the migration runner. Run as the direct migrator in a READ ONLY transaction:
--   BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
--   SET LOCAL cinatoken.shared_key_stats_audit_key_id = 'reviewed-key-id';
--   \i shared-key-credited-usage-gap-audit.sql
--   COMMIT;
-- This exact per-key aggregate may scan a large key's entire history. Use a
-- statement timeout and an off-peak review window. The v342 evidence describes
-- the bounded cursor design needed before a write-side rebuild is activated.
WITH selected_key AS (
  SELECT sk.id, sk.seller_user_id, sk.served_input_tokens,
    sk.served_output_tokens, sk.earned_total, sk.last_used_at
  FROM cinatoken_gateway.shared_keys AS sk
  WHERE sk.id = pg_catalog.current_setting(
    'cinatoken.shared_key_stats_audit_key_id', true)
), legacy AS (
  SELECT e.shared_key_id, pg_catalog.count(*) AS credited_rows,
    pg_catalog.count(*) FILTER (WHERE e.seller_user_id <> sk.seller_user_id)
      AS other_seller_rows,
    coalesce(pg_catalog.sum(e.input_tokens::numeric), 0) AS input_tokens,
    coalesce(pg_catalog.sum(e.output_tokens::numeric), 0) AS output_tokens,
    coalesce(pg_catalog.sum(e.net_amount), 0) AS net_amount,
    pg_catalog.max(e.created_at) AS last_credited_at
  FROM selected_key AS sk
  JOIN cinatoken_gateway.shared_key_earnings AS e ON e.shared_key_id = sk.id
  GROUP BY e.shared_key_id
), economic AS (
  SELECT a.shared_key_id,
    pg_catalog.count(*) FILTER (WHERE a.decision = 'credited') AS credited_rows,
    pg_catalog.count(*) FILTER (WHERE a.decision = 'pending_manual') AS pending_rows,
    pg_catalog.count(*) FILTER (WHERE a.decision = 'credited'
      AND a.seller_user_id <> sk.seller_user_id) AS other_seller_rows,
    coalesce(pg_catalog.sum(a.input_tokens::numeric)
      FILTER (WHERE a.decision = 'credited'), 0) AS input_tokens,
    coalesce(pg_catalog.sum(a.output_tokens::numeric)
      FILTER (WHERE a.decision = 'credited'), 0) AS output_tokens,
    coalesce(pg_catalog.sum(a.net_micros::numeric)
      FILTER (WHERE a.decision = 'credited'), 0) AS net_micros,
    pg_catalog.max(a.processed_at)
      FILTER (WHERE a.decision = 'credited') AS last_credited_at
  FROM selected_key AS sk
  JOIN cinatoken_economic_consumer.shared_key_attempt_consumptions AS a
    ON a.shared_key_id = sk.id
  GROUP BY a.shared_key_id
), overlap AS (
  SELECT pg_catalog.count(DISTINCT a.request_log_id) AS request_logs
  FROM selected_key AS sk
  JOIN cinatoken_economic_consumer.shared_key_attempt_consumptions AS a
    ON a.shared_key_id = sk.id
  JOIN cinatoken_gateway.shared_key_earnings AS e
    ON e.request_log_id = a.request_log_id
)
SELECT sk.id AS shared_key_id, sk.seller_user_id AS current_seller_user_id,
  coalesce(l.credited_rows, 0) AS legacy_credited_rows,
  coalesce(x.credited_rows, 0) AS economic_credited_attempts,
  coalesce(x.pending_rows, 0) AS pending_manual_attempts,
  coalesce(l.other_seller_rows, 0)
    + coalesce(x.other_seller_rows, 0)
      AS credited_rows_for_other_sellers,
  overlap.request_logs AS cross_source_request_log_conflicts,
  sk.served_input_tokens::numeric AS projected_input_tokens,
  coalesce(l.input_tokens, 0)
    + coalesce(x.input_tokens, 0) AS credited_input_tokens,
  sk.served_output_tokens::numeric AS projected_output_tokens,
  coalesce(l.output_tokens, 0)
    + coalesce(x.output_tokens, 0) AS credited_output_tokens,
  sk.earned_total AS projected_earned_total,
  (coalesce(l.net_amount, 0)
    + coalesce(x.net_micros, 0) / 1000000::numeric)::numeric(38,6)
      AS credited_earned_total,
  sk.last_used_at AS projected_last_used_at,
  greatest(l.last_credited_at, x.last_credited_at)
    AS last_credited_at,
  sk.served_input_tokens::numeric IS DISTINCT FROM
    coalesce(l.input_tokens, 0) + coalesce(x.input_tokens, 0)
    OR sk.served_output_tokens::numeric IS DISTINCT FROM
      coalesce(l.output_tokens, 0) + coalesce(x.output_tokens, 0)
    OR sk.earned_total IS DISTINCT FROM
      coalesce(l.net_amount, 0)
        + coalesce(x.net_micros, 0) / 1000000::numeric
    OR sk.last_used_at IS DISTINCT FROM
      greatest(l.last_credited_at, x.last_credited_at)
    AS projection_differs_from_credited_details
FROM selected_key AS sk
LEFT JOIN legacy AS l ON l.shared_key_id = sk.id
LEFT JOIN economic AS x ON x.shared_key_id = sk.id
CROSS JOIN overlap;
