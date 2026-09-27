-- REVIEW ONLY. Install after v371 when the PG73 runtime grant is present.
-- The v371 wrapper itself checks SESSION_USER, but its public-facing ACL must
-- also exclude the ordinary runtime that received an earlier schema-wide
-- function grant. This proposal is not a formal migration or cutover.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
LOCK TABLE cinatoken_gateway.schema_migrations IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; buyer_oid oid; runtime_oid oid; wrapper_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_buyer_settlement';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  wrapper_oid:=pg_catalog.to_regprocedure(
    'cinatoken_gateway.settle_legacy_buyer_windowed_v371(text,text)');
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting(
      'cinatoken.legacy_buyer_window_acl_v372_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR buyer_oid IS NULL OR runtime_oid IS NULL
    OR wrapper_oid IS NULL
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
        WHERE nspname='cinatoken_gateway') IS DISTINCT FROM migrator_oid
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid=wrapper_oid AND p.proowner=migrator_oid AND p.prosecdef
        AND p.provolatile='v' AND p.proconfig=
          ARRAY['search_path=pg_catalog, pg_temp','lock_timeout=2s']::text[]
        AND pg_catalog.md5(pg_catalog.replace(p.prosrc,
          pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))
          ='b29c5550a985893dede144627a4a5c45')
    OR NOT pg_catalog.has_function_privilege(buyer_oid,wrapper_oid,'EXECUTE')
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.guardrail_budget_windows','UPDATE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid IN (buyer_oid,runtime_oid)
        OR member IN (buyer_oid,runtime_oid))
  THEN RAISE EXCEPTION 'legacy buyer window ACL v372 dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

REVOKE EXECUTE ON FUNCTION
  cinatoken_gateway.settle_legacy_buyer_windowed_v371(text,text)
  FROM PUBLIC,cinatoken_gateway_runtime;

DO $postflight$
BEGIN
  IF NOT pg_catalog.has_function_privilege(
      'cinatoken_gateway_buyer_settlement',
      'cinatoken_gateway.settle_legacy_buyer_windowed_v371(text,text)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(
      'cinatoken_gateway_runtime',
      'cinatoken_gateway.settle_legacy_buyer_windowed_v371(text,text)',
      'EXECUTE')
    OR pg_catalog.has_table_privilege(
      'cinatoken_gateway_buyer_settlement',
      'cinatoken_gateway.guardrail_budget_windows','UPDATE')
  THEN RAISE EXCEPTION 'legacy buyer window ACL v372 postflight differs'
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
