-- REVIEW ONLY. This is the durable switch for the post-v346/v347 grant path.
-- The old grant runner's fail-closed marker check MUST be deployed first.
-- Run this in the SAME migrator transaction and advisory-lock window as
-- buyer-critical-writer-privilege-split-v346.sql and
-- shared-key-economic-producer-buyer-login-v347.sql, after both files.
-- Never commit the financial revokes before this marker exists.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.users,
  cinatoken_gateway.user_earnings,
  cinatoken_gateway.withdrawals,
  cinatoken_gateway.user_budget_reservations,
  cinatoken_gateway.shared_key_earnings,
  cinatoken_gateway.portal_ledger_entries
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
DECLARE buyer_oid oid;
DECLARE v1_oid oid;
DECLARE v2_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_buyer_settlement';
  v1_oid := pg_catalog.to_regprocedure(
    'cinatoken_economic_outbox.write_shared_key_economic_event(text,text,text,jsonb,text)');
  v2_oid := pg_catalog.to_regprocedure(
    'cinatoken_economic_outbox.write_shared_key_economic_event_v2(text,text,text,bigint,jsonb,text)');
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting('cinatoken.buyer_split_grant_marker_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.buyer_split_grant_policy_v348()') IS NOT NULL
    OR migrator_oid IS NULL OR runtime_oid IS NULL OR buyer_oid IS NULL
    OR v1_oid IS NULL OR v2_oid IS NULL
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
        WHERE nspname='cinatoken_gateway') IS DISTINCT FROM migrator_oid
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
        WHERE nspname='cinatoken_economic_outbox') IS DISTINCT FROM migrator_oid
    OR (SELECT count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C"))
        FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
        AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
        AND NOT rolinherit FROM pg_catalog.pg_roles WHERE oid=buyer_oid)
        IS DISTINCT FROM true
    OR pg_catalog.pg_has_role(runtime_oid,buyer_oid,'MEMBER')
    OR pg_catalog.pg_has_role(buyer_oid,runtime_oid,'MEMBER')
    OR pg_catalog.pg_has_role(buyer_oid,migrator_oid,'MEMBER')
    OR pg_catalog.pg_has_role(runtime_oid,migrator_oid,'MEMBER')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.users','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(runtime_oid,
      'cinatoken_gateway.users','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.user_earnings','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(runtime_oid,
      'cinatoken_gateway.user_earnings','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.withdrawals','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(runtime_oid,
      'cinatoken_gateway.withdrawals','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.user_budget_reservations','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(runtime_oid,
      'cinatoken_gateway.user_budget_reservations','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.shared_key_earnings','INSERT')
    OR pg_catalog.has_any_column_privilege(runtime_oid,
      'cinatoken_gateway.shared_key_earnings','INSERT')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.portal_ledger_entries','INSERT')
    OR pg_catalog.has_any_column_privilege(runtime_oid,
      'cinatoken_gateway.portal_ledger_entries','INSERT')
    OR NOT pg_catalog.has_column_privilege(buyer_oid,
      'cinatoken_gateway.users','budget_spent','UPDATE')
    OR pg_catalog.has_column_privilege(buyer_oid,
      'cinatoken_gateway.users','budget_max','UPDATE')
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.user_earnings','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.shared_key_earnings','INSERT')
    OR pg_catalog.has_any_column_privilege(buyer_oid,
      'cinatoken_gateway.user_earnings','INSERT,UPDATE')
    OR pg_catalog.has_any_column_privilege(buyer_oid,
      'cinatoken_gateway.shared_key_earnings','INSERT')
    OR pg_catalog.has_function_privilege(runtime_oid,v1_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,v2_oid,'EXECUTE')
    OR NOT pg_catalog.has_function_privilege(buyer_oid,v2_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(buyer_oid,v1_oid,'EXECUTE')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE p.oid=v2_oid AND p.proowner=migrator_oid
        AND l.lanname='plpgsql' AND p.prosecdef AND p.provolatile='v'
        AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND pg_catalog.md5(pg_catalog.replace(p.prosrc,
          pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))
          ='132180ac28c093adc3fb07c38a769cab')
  THEN
    RAISE EXCEPTION 'Buyer split grant marker activation or dependency differs'
      USING ERRCODE='P0001';
  END IF;
END;
$preflight$;

CREATE FUNCTION cinatoken_gateway.buyer_split_grant_policy_v348()
RETURNS text LANGUAGE sql IMMUTABLE
SET search_path TO pg_catalog, pg_temp
AS $marker$SELECT 'buyer_split_v348'::text$marker$;
REVOKE EXECUTE ON FUNCTION cinatoken_gateway.buyer_split_grant_policy_v348()
  FROM PUBLIC, cinatoken_gateway_runtime;

DO $postflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
DECLARE marker_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  marker_oid := pg_catalog.to_regprocedure(
    'cinatoken_gateway.buyer_split_grant_policy_v348()');
  IF marker_oid IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE p.oid=marker_oid AND p.proowner=migrator_oid
        AND l.lanname='sql' AND NOT p.prosecdef AND p.provolatile='i'
        AND p.prosrc=$marker$SELECT 'buyer_split_v348'::text$marker$
        AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[])
    OR pg_catalog.has_function_privilege(runtime_oid,marker_oid,'EXECUTE')
  THEN
    RAISE EXCEPTION 'Buyer split grant marker postflight differs'
      USING ERRCODE='P0001';
  END IF;
END;
$postflight$;
