-- REVIEW ONLY. Install after shared-key-credited-usage-store.sql, then finish
-- both bounded backfill cursors before explicitly activating the read gate.
-- Run as the direct migrator LOGIN in one transaction with:
--   SET LOCAL cinatoken.shared_key_credited_usage_reader_install = 'reviewed-v1';
-- No application flag or production migration is enabled by this proposal.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF CURRENT_USER <> 'cinatoken_gateway_migrator'
    OR SESSION_USER <> CURRENT_USER
    OR pg_catalog.current_setting('cinatoken.shared_key_credited_usage_reader_install',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations) <> 73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
         ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
       <> 'ca1ea96a1b4bcd0675642f30dcf48042'
    OR pg_catalog.to_regclass('cinatoken_shared_stats.contributions') IS NULL
    OR pg_catalog.to_regclass('cinatoken_shared_stats.summaries') IS NULL
    OR pg_catalog.to_regclass('cinatoken_shared_stats.backfill_cursors') IS NULL
    OR pg_catalog.to_regclass('cinatoken_shared_stats.reader_ready') IS NOT NULL
    OR pg_catalog.to_regprocedure('cinatoken_shared_stats.read_shared_key_credited_usage(text,text[])') IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid='cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
        AND tgname='shared_key_earnings_capture_credited_usage' AND tgenabled='O'
        AND tgfoid='cinatoken_shared_stats.capture_legacy_credit()'::pg_catalog.regprocedure)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid='cinatoken_economic_consumer.shared_key_attempt_consumptions'::pg_catalog.regclass
        AND tgname='shared_key_attempt_consumptions_capture_credited_usage' AND tgenabled='O'
        AND tgfoid='cinatoken_shared_stats.capture_economic_credit()'::pg_catalog.regprocedure)
    OR pg_catalog.has_schema_privilege('cinatoken_gateway_runtime',
      'cinatoken_shared_stats','USAGE')
    OR pg_catalog.pg_has_role('cinatoken_gateway_runtime',
      'cinatoken_gateway_migrator','MEMBER')
  THEN
    RAISE EXCEPTION 'Credited-usage reader installation contract differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_stats_reader_install';
  END IF;
END;
$preflight$;

CREATE TABLE cinatoken_shared_stats.reader_ready (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  activated_at timestamptz NOT NULL,
  legacy_rows numeric(38,0) NOT NULL,
  economic_rows numeric(38,0) NOT NULL
);
REVOKE ALL ON cinatoken_shared_stats.reader_ready FROM PUBLIC,
  cinatoken_gateway_runtime,cinatoken_gateway_shared_earning_consumer;

-- This full-history audit is a controlled migration step, never an HTTP read.
-- Call in a REPEATABLE READ transaction after both cursor pages complete:
--   SET LOCAL cinatoken.shared_key_stats_reader_activate = 'reviewed-v1';
--   SELECT cinatoken_shared_stats.activate_credited_usage_reader();
-- The source triggers atomically capture any writer committing after the audit
-- snapshot, including random IDs below the backfill cursors.
CREATE FUNCTION cinatoken_shared_stats.activate_credited_usage_reader()
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $activate$
DECLARE n_legacy numeric;
DECLARE n_economic numeric;
BEGIN
  IF CURRENT_USER <> 'cinatoken_gateway_migrator'
    OR SESSION_USER <> CURRENT_USER
    OR pg_catalog.current_setting('transaction_isolation') <> 'repeatable read'
    OR pg_catalog.current_setting('cinatoken.shared_key_stats_reader_activate',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR (SELECT pg_catalog.count(*) FROM cinatoken_shared_stats.backfill_cursors
        WHERE complete AND source_kind IN ('legacy','economic_attempt')) <> 2
    OR (SELECT pg_catalog.count(*) FROM cinatoken_shared_stats.backfill_cursors) <> 2
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger
      WHERE tgenabled='O' AND (tgrelid='cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
        AND tgname IN ('shared_key_earnings_capture_credited_usage',
          'shared_key_earnings_history_immutable',
          'shared_key_earnings_history_no_truncate',
          'shared_key_earnings_reject_economic_event')
        OR tgrelid='cinatoken_economic_consumer.shared_key_attempt_consumptions'::pg_catalog.regclass
        AND tgname IN ('shared_key_attempt_consumptions_capture_credited_usage',
          'shared_key_attempt_consumptions_no_change',
          'shared_key_attempt_consumptions_no_truncate'))) <> 7
    OR EXISTS (SELECT 1 FROM (
      SELECT id,request_log_id,shared_key_id,seller_user_id,input_tokens,
        output_tokens,net_amount,created_at
      FROM cinatoken_gateway.shared_key_earnings) AS src
      FULL JOIN (SELECT * FROM cinatoken_shared_stats.contributions
        WHERE source_kind='legacy') AS c ON c.source_id=src.id
      WHERE src.id IS NULL OR c.source_id IS NULL
        OR c.request_log_id IS DISTINCT FROM src.request_log_id
        OR c.event_id IS NOT NULL
        OR c.shared_key_id IS DISTINCT FROM src.shared_key_id
        OR c.seller_user_id IS DISTINCT FROM src.seller_user_id
        OR c.input_tokens IS DISTINCT FROM src.input_tokens::numeric
        OR c.output_tokens IS DISTINCT FROM src.output_tokens::numeric
        OR c.net_micros IS DISTINCT FROM src.net_amount*1000000::numeric
        OR c.credited_at IS DISTINCT FROM src.created_at)
    OR EXISTS (SELECT 1 FROM (
      SELECT attempt_id,request_log_id,event_id,shared_key_id,seller_user_id,
        input_tokens,output_tokens,net_micros,processed_at
      FROM cinatoken_economic_consumer.shared_key_attempt_consumptions
      WHERE decision='credited') AS src
      FULL JOIN (SELECT * FROM cinatoken_shared_stats.contributions
        WHERE source_kind='economic_attempt') AS c
        ON c.source_id=src.attempt_id::text
      WHERE src.attempt_id IS NULL OR c.source_id IS NULL
        OR c.request_log_id IS DISTINCT FROM src.request_log_id
        OR c.event_id IS DISTINCT FROM src.event_id
        OR c.shared_key_id IS DISTINCT FROM src.shared_key_id
        OR c.seller_user_id IS DISTINCT FROM src.seller_user_id
        OR c.input_tokens IS DISTINCT FROM src.input_tokens::numeric
        OR c.output_tokens IS DISTINCT FROM src.output_tokens::numeric
        OR c.net_micros IS DISTINCT FROM src.net_micros::numeric
        OR c.credited_at IS DISTINCT FROM src.processed_at)
    OR EXISTS (SELECT 1 FROM cinatoken_shared_stats.contributions c
      LEFT JOIN cinatoken_shared_stats.request_sources r
        ON r.request_log_id=c.request_log_id
      WHERE r.source_kind IS DISTINCT FROM c.source_kind)
    OR EXISTS (SELECT 1 FROM cinatoken_shared_stats.request_sources r
      LEFT JOIN cinatoken_shared_stats.contributions c
        ON c.request_log_id=r.request_log_id
      WHERE c.source_id IS NULL)
    OR EXISTS (SELECT 1 FROM (
      SELECT shared_key_id,seller_user_id,count(*)::numeric AS credited_rows,
        sum(input_tokens) AS input_tokens,sum(output_tokens) AS output_tokens,
        sum(net_micros) AS net_micros,max(credited_at) AS last_credited_at
      FROM cinatoken_shared_stats.contributions
      GROUP BY shared_key_id,seller_user_id) AS expected
      FULL JOIN cinatoken_shared_stats.summaries AS actual
        ON actual.shared_key_id=expected.shared_key_id
        AND actual.seller_user_id=expected.seller_user_id
      WHERE expected.shared_key_id IS NULL OR actual.shared_key_id IS NULL
        OR actual.credited_rows IS DISTINCT FROM expected.credited_rows
        OR actual.input_tokens IS DISTINCT FROM expected.input_tokens
        OR actual.output_tokens IS DISTINCT FROM expected.output_tokens
        OR actual.net_micros IS DISTINCT FROM expected.net_micros
        OR actual.last_credited_at IS DISTINCT FROM expected.last_credited_at)
  THEN
    RAISE EXCEPTION 'Credited-usage reader source, backfill, or summary differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_stats_reader_not_ready';
  END IF;
  SELECT pg_catalog.count(*) INTO n_legacy FROM cinatoken_gateway.shared_key_earnings;
  SELECT pg_catalog.count(*) INTO n_economic
    FROM cinatoken_economic_consumer.shared_key_attempt_consumptions
    WHERE decision='credited';
  INSERT INTO cinatoken_shared_stats.reader_ready
    (id,activated_at,legacy_rows,economic_rows)
    VALUES (true,pg_catalog.clock_timestamp(),n_legacy,n_economic)
    ON CONFLICT (id) DO NOTHING;
END;
$activate$;
REVOKE ALL ON FUNCTION cinatoken_shared_stats.activate_credited_usage_reader()
  FROM PUBLIC,cinatoken_gateway_runtime,cinatoken_gateway_shared_earning_consumer;

-- This review-only function accepts an explicit seller scope and returns that
-- current owner's own credited rows only. The shared runtime LOGIN could forge
-- any seller argument, so EXECUTE stays migrator-only pending a separate
-- per-request authorization design. The default-off API adapter fails closed.
CREATE FUNCTION cinatoken_shared_stats.read_shared_key_credited_usage(
  p_seller_user_id text,p_key_ids text[])
RETURNS TABLE(shared_key_id text,seller_user_id text,
  input_tokens numeric,output_tokens numeric,net_micros numeric,
  last_credited_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $read$
BEGIN
  IF SESSION_USER <> 'cinatoken_gateway_migrator'
    OR p_seller_user_id IS NULL OR p_seller_user_id=''
    OR p_key_ids IS NULL OR pg_catalog.cardinality(p_key_ids) NOT BETWEEN 1 AND 200
    OR pg_catalog.array_position(p_key_ids,NULL) IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM cinatoken_shared_stats.reader_ready WHERE id)
    OR (SELECT pg_catalog.count(*) FROM cinatoken_shared_stats.backfill_cursors
       WHERE complete AND source_kind IN ('legacy','economic_attempt')) <> 2
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger
      WHERE tgenabled='O' AND (tgrelid='cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
        AND tgname IN ('shared_key_earnings_capture_credited_usage',
          'shared_key_earnings_history_immutable',
          'shared_key_earnings_history_no_truncate',
          'shared_key_earnings_reject_economic_event')
        OR tgrelid='cinatoken_economic_consumer.shared_key_attempt_consumptions'::pg_catalog.regclass
        AND tgname IN ('shared_key_attempt_consumptions_capture_credited_usage',
          'shared_key_attempt_consumptions_no_change',
          'shared_key_attempt_consumptions_no_truncate'))) <> 7
  THEN
    RAISE EXCEPTION 'Credited-usage reader not active or input invalid'
      USING ERRCODE='23514',CONSTRAINT='shared_key_stats_reader_not_active';
  END IF;
  RETURN QUERY SELECT k.id,k.seller_user_id,
    COALESCE(s.input_tokens,0::numeric),COALESCE(s.output_tokens,0::numeric),
    COALESCE(s.net_micros,0::numeric),s.last_credited_at
    FROM cinatoken_gateway.shared_keys AS k
    LEFT JOIN cinatoken_shared_stats.summaries AS s
      ON s.shared_key_id=k.id AND s.seller_user_id=k.seller_user_id
    WHERE k.id=ANY(p_key_ids) AND k.seller_user_id=p_seller_user_id;
END;
$read$;
REVOKE ALL ON FUNCTION cinatoken_shared_stats.read_shared_key_credited_usage(text,text[])
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_shared_earning_consumer;

DO $postflight$
BEGIN
  IF pg_catalog.has_schema_privilege('cinatoken_gateway_runtime',
      'cinatoken_shared_stats','USAGE')
    OR pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
      'cinatoken_shared_stats.summaries','SELECT')
    OR pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
      'cinatoken_shared_stats.read_shared_key_credited_usage(text,text[])','EXECUTE')
    OR pg_catalog.has_function_privilege('cinatoken_gateway_shared_earning_consumer',
      'cinatoken_shared_stats.read_shared_key_credited_usage(text,text[])','EXECUTE')
    OR (SELECT proowner FROM pg_catalog.pg_proc WHERE oid=
      'cinatoken_shared_stats.read_shared_key_credited_usage(text,text[])'::pg_catalog.regprocedure)
      <> 'cinatoken_gateway_migrator'::pg_catalog.regrole
  THEN
    RAISE EXCEPTION 'Credited-usage reader privilege contract differs';
  END IF;
END;
$postflight$;
