-- REVIEW ONLY. Prototype successor to the v348/v349 positive buyer grant
-- runners. Run only in the same direct-migrator transaction as the v368
-- request-scoped writer and a coordinated replacement of every affected
-- application buyer path. This file alone interrupts existing traffic.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923562);
SELECT pg_catalog.pg_advisory_xact_lock(746923565);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.users,
  cinatoken_gateway.user_budget_reservations,
  cinatoken_gateway.guardrail_budget_reservations,
  cinatoken_gateway.guardrail_budget_windows,
  cinatoken_gateway.complete_text_attempt_grants_v362
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; buyer_oid oid; runtime_oid oid;
DECLARE v348_oid oid; v349_oid oid; writer_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_buyer_settlement';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  v348_oid:=pg_catalog.to_regprocedure(
    'cinatoken_gateway.buyer_split_grant_policy_v348()');
  v349_oid:=pg_catalog.to_regprocedure(
    'cinatoken_gateway.buyer_split_guardrail_grant_policy_v349()');
  writer_oid:=pg_catalog.to_regprocedure(
    'cinatoken_gateway.settle_legacy_buyer_held_v368(text,bigint,bigint,text)');
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting(
      'cinatoken.buyer_counter_grant_policy_v368_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR buyer_oid IS NULL OR runtime_oid IS NULL
    OR v348_oid IS NULL OR v349_oid IS NULL OR writer_oid IS NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.buyer_split_counter_policy_v368()') IS NOT NULL
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
        WHERE nspname='cinatoken_gateway') IS DISTINCT FROM migrator_oid
    OR (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
        AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
        AND NOT rolinherit FROM pg_catalog.pg_roles WHERE oid=buyer_oid)
      IS DISTINCT FROM true
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid IN (buyer_oid,runtime_oid)
        OR member IN (buyer_oid,runtime_oid))
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid=v348_oid AND p.proowner=migrator_oid
        AND p.prosrc=$marker$SELECT 'buyer_split_v348'::text$marker$
        AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[])
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid=v349_oid AND p.proowner=migrator_oid
        AND p.prosrc=$marker$SELECT 'buyer_split_guardrail_v349'::text$marker$
        AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[])
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid=writer_oid AND p.proowner=migrator_oid AND p.prosecdef
        AND p.provolatile='v' AND p.proconfig=
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND pg_catalog.md5(pg_catalog.replace(p.prosrc,
          pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))
          ='abeb0cc33ab91be53a41e42c8f8aeb16')
    OR NOT pg_catalog.has_function_privilege(buyer_oid,writer_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,writer_oid,'EXECUTE')
    OR NOT pg_catalog.has_column_privilege(buyer_oid,
      'cinatoken_gateway.users','budget_spent','UPDATE')
    OR NOT pg_catalog.has_column_privilege(buyer_oid,
      'cinatoken_gateway.users','budget_reserved_micros','UPDATE')
    OR NOT pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.guardrail_budget_windows','UPDATE')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger
      WHERE tgname IN ('complete_text_ordinary_hold_fence_v366',
        'complete_text_guardrail_hold_fence_v366')
        AND tgenabled='O' AND NOT tgisinternal)<>2
  THEN RAISE EXCEPTION 'buyer counter grant policy v368 activation or dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

-- The current buyer has direct counter and hold writes. The v368 wrapper is
-- the only new held-settlement authority after these revokes. All other
-- existing buyer paths need their own replacements before real activation.
REVOKE UPDATE (budget_spent,budget_reserved_micros,updated_at)
  ON TABLE cinatoken_gateway.users
  FROM cinatoken_gateway_buyer_settlement;
REVOKE UPDATE (state,settled_micros,terminal_at,terminal_reason,updated_at)
  ON TABLE cinatoken_gateway.user_budget_reservations
  FROM cinatoken_gateway_buyer_settlement;
REVOKE UPDATE ON TABLE cinatoken_gateway.guardrail_budget_reservations,
  cinatoken_gateway.guardrail_budget_windows
  FROM cinatoken_gateway_buyer_settlement;

-- Both old positive grant runners inspect these exact marker bodies before
-- any GRANT. Superseding both makes an accidental v348 or v349 rerun fail
-- before it can reopen buyer direct counter authority.
CREATE OR REPLACE FUNCTION cinatoken_gateway.buyer_split_grant_policy_v348()
RETURNS text LANGUAGE sql IMMUTABLE
SET search_path TO pg_catalog, pg_temp
AS $marker$SELECT 'buyer_split_superseded_v368'::text$marker$;
CREATE OR REPLACE FUNCTION
  cinatoken_gateway.buyer_split_guardrail_grant_policy_v349()
RETURNS text LANGUAGE sql IMMUTABLE
SET search_path TO pg_catalog, pg_temp
AS $marker$SELECT 'buyer_guardrail_superseded_v368'::text$marker$;
CREATE FUNCTION cinatoken_gateway.buyer_split_counter_policy_v368()
RETURNS text LANGUAGE sql IMMUTABLE
SET search_path TO pg_catalog, pg_temp
AS $marker$SELECT 'buyer_counter_writer_v368'::text$marker$;
REVOKE EXECUTE ON FUNCTION
  cinatoken_gateway.buyer_split_counter_policy_v368()
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_buyer_settlement;

DO $postflight$
DECLARE buyer_oid oid; runtime_oid oid; migrator_oid oid;
BEGIN
  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_buyer_settlement';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  IF pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.users','UPDATE')
    OR pg_catalog.has_any_column_privilege(buyer_oid,
      'cinatoken_gateway.users','UPDATE')
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.user_budget_reservations','UPDATE')
    OR pg_catalog.has_any_column_privilege(buyer_oid,
      'cinatoken_gateway.user_budget_reservations','UPDATE')
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.guardrail_budget_reservations','UPDATE')
    OR pg_catalog.has_any_column_privilege(buyer_oid,
      'cinatoken_gateway.guardrail_budget_reservations','UPDATE')
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.guardrail_budget_windows','UPDATE')
    OR pg_catalog.has_any_column_privilege(buyer_oid,
      'cinatoken_gateway.guardrail_budget_windows','UPDATE')
    OR NOT pg_catalog.has_function_privilege(buyer_oid,
      'cinatoken_gateway.settle_legacy_buyer_held_v368(
        text,bigint,bigint,text)','EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_gateway.settle_legacy_buyer_held_v368(
        text,bigint,bigint,text)','EXECUTE')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid='cinatoken_gateway.buyer_split_counter_policy_v368()'
          ::pg_catalog.regprocedure
        AND p.proowner=migrator_oid
        AND p.prosrc=$marker$SELECT 'buyer_counter_writer_v368'::text$marker$)
    OR pg_catalog.has_function_privilege(buyer_oid,
      'cinatoken_gateway.buyer_split_counter_policy_v368()','EXECUTE')
  THEN RAISE EXCEPTION 'buyer counter grant policy v368 postflight differs'
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
