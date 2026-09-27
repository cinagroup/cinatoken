-- REVIEW ONLY. Bind the independently signed v348 seller claim to the v344
-- credited-usage projection. No HTTP route or production migration is enabled.
-- Apply as the direct migrator LOGIN in one transaction with:
--   SET LOCAL cinatoken.shared_key_stats_claim_reader_install = 'reviewed-v1';
-- Requires the v344 store and reader, and the v348 claim verifier. The v344
-- full-history audit activates the ready row separately after backfill.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
LOCK TABLE cinatoken_gateway.schema_migrations IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE reader_oid oid;
DECLARE runtime_oid oid;
BEGIN
  SELECT oid INTO reader_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_stats_reader';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting(
      'cinatoken.shared_key_stats_claim_reader_install',true)
        IS DISTINCT FROM 'reviewed-v1'
    OR reader_oid IS NULL OR runtime_oid IS NULL
    OR (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
      AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
      AND NOT rolinherit FROM pg_catalog.pg_roles WHERE oid=reader_oid)
        IS DISTINCT FROM true
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE member=reader_oid OR roleid=reader_oid)
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
          <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR pg_catalog.to_regclass('cinatoken_shared_stats.reader_ready') IS NULL
    OR pg_catalog.to_regclass('cinatoken_shared_stats.summaries') IS NULL
    OR pg_catalog.to_regclass('cinatoken_shared_stats.backfill_cursors') IS NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_stats_claim.verify_seller_stats_claim(text,text,text[],bigint,uuid,bytea)') IS NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_shared_stats.read_shared_key_credited_usage(text,text[])') IS NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_shared_stats.read_shared_key_credited_usage_with_claim(text,text,text[],bigint,uuid,bytea)') IS NOT NULL
    OR pg_catalog.has_schema_privilege(runtime_oid,'cinatoken_shared_stats','USAGE')
    OR pg_catalog.has_table_privilege(reader_oid,
      'cinatoken_shared_stats.summaries','SELECT')
    OR NOT pg_catalog.has_function_privilege(reader_oid,
      'cinatoken_stats_claim.verify_seller_stats_claim(text,text,text[],bigint,uuid,bytea)',
      'EXECUTE')
  THEN
    RAISE EXCEPTION 'Signed credited-usage reader install contract differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_stats_claim_reader_install';
  END IF;
END;
$preflight$;

-- The reader role can call only this endpoint. In particular, it cannot
-- consume a nonce without passing through the gated credited-usage read.
REVOKE EXECUTE ON FUNCTION
  cinatoken_stats_claim.verify_seller_stats_claim(
    text,text,text[],bigint,uuid,bytea)
  FROM cinatoken_gateway_stats_reader;

CREATE FUNCTION cinatoken_shared_stats.read_shared_key_credited_usage_with_claim(
  p_key_id text,p_seller_user_id text,p_key_ids text[],
  p_expires_epoch bigint,p_nonce uuid,p_signature bytea)
RETURNS TABLE(shared_key_id text,seller_user_id text,
  input_tokens numeric,output_tokens numeric,net_micros numeric,
  last_credited_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $read$
BEGIN
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER<>'cinatoken_gateway_stats_reader'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR NOT EXISTS (SELECT 1 FROM cinatoken_shared_stats.reader_ready WHERE id)
    OR (SELECT pg_catalog.count(*) FROM cinatoken_shared_stats.backfill_cursors
      WHERE complete AND source_kind IN ('legacy','economic_attempt'))<>2
    OR (SELECT pg_catalog.count(*) FROM cinatoken_shared_stats.backfill_cursors)<>2
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger
      WHERE tgenabled='O' AND (tgrelid=
        'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
        AND tgname IN ('shared_key_earnings_capture_credited_usage',
          'shared_key_earnings_history_immutable',
          'shared_key_earnings_history_no_truncate',
          'shared_key_earnings_reject_economic_event')
        OR tgrelid=
          'cinatoken_economic_consumer.shared_key_attempt_consumptions'::pg_catalog.regclass
        AND tgname IN ('shared_key_attempt_consumptions_capture_credited_usage',
          'shared_key_attempt_consumptions_no_change',
          'shared_key_attempt_consumptions_no_truncate')))<>7
  THEN
    RAISE EXCEPTION 'Signed credited-usage reader is not active'
      USING ERRCODE='23514',CONSTRAINT='shared_key_stats_claim_reader_not_active';
  END IF;

  -- The v348 verifier checks issuer key, audience, seller, ordered key scope,
  -- signature, expiry and nonce under this same transaction. It enforces the
  -- dedicated direct-login SESSION_USER even inside this SECURITY DEFINER.
  PERFORM cinatoken_stats_claim.verify_seller_stats_claim(
    p_key_id,p_seller_user_id,p_key_ids,p_expires_epoch,p_nonce,p_signature);

  -- Lock each current-owner key against an ownership update until this read
  -- transaction completes. Historical credits for a former owner stay in the
  -- private summary table but are not projected to the new current owner.
  RETURN QUERY SELECT k.id,k.seller_user_id,
    COALESCE(s.input_tokens,0::numeric),
    COALESCE(s.output_tokens,0::numeric),
    COALESCE(s.net_micros,0::numeric),s.last_credited_at
    FROM (SELECT key.id,key.seller_user_id
      FROM cinatoken_gateway.shared_keys AS key
      WHERE key.id=ANY(p_key_ids) AND key.seller_user_id=p_seller_user_id
      FOR SHARE) AS k
    LEFT JOIN cinatoken_shared_stats.summaries AS s
      ON s.shared_key_id=k.id AND s.seller_user_id=k.seller_user_id
    ORDER BY k.id COLLATE "C";
END;
$read$;
REVOKE ALL ON FUNCTION
  cinatoken_shared_stats.read_shared_key_credited_usage_with_claim(
    text,text,text[],bigint,uuid,bytea)
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_shared_earning_consumer;
GRANT USAGE ON SCHEMA cinatoken_shared_stats
  TO cinatoken_gateway_stats_reader;
GRANT EXECUTE ON FUNCTION
  cinatoken_shared_stats.read_shared_key_credited_usage_with_claim(
    text,text,text[],bigint,uuid,bytea)
  TO cinatoken_gateway_stats_reader;

DO $postflight$
DECLARE migrator_oid oid;
DECLARE reader_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO reader_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_stats_reader';
  IF pg_catalog.has_table_privilege(reader_oid,
      'cinatoken_shared_stats.summaries','SELECT')
    OR pg_catalog.has_table_privilege(reader_oid,
      'cinatoken_shared_stats.reader_ready','SELECT')
    OR pg_catalog.has_function_privilege(reader_oid,
      'cinatoken_stats_claim.verify_seller_stats_claim(text,text,text[],bigint,uuid,bytea)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
      'cinatoken_shared_stats.read_shared_key_credited_usage_with_claim(text,text,text[],bigint,uuid,bytea)',
      'EXECUTE')
    OR NOT pg_catalog.has_function_privilege(reader_oid,
      'cinatoken_shared_stats.read_shared_key_credited_usage_with_claim(text,text,text[],bigint,uuid,bytea)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(reader_oid,
      'cinatoken_shared_stats.read_shared_key_credited_usage(text,text[])',
      'EXECUTE')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid=
        'cinatoken_shared_stats.read_shared_key_credited_usage_with_claim(text,text,text[],bigint,uuid,bytea)'::pg_catalog.regprocedure
        AND p.proowner=migrator_oid AND p.prosecdef AND p.provolatile='v'
        AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[])
  THEN
    RAISE EXCEPTION 'Signed credited-usage reader postflight differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_stats_claim_reader_postflight';
  END IF;
END;
$postflight$;
