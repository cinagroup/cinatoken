-- REVIEW ONLY. Guardrail-successor split-grant reconciler. Run as the direct
-- migrator LOGIN after atomic Guardrail v348 + v349 marker activation.
-- The old v348 marker remains installed and blocks the broad grant runner.
-- This deliberately grants no new ordinary-runtime table writes. Future
-- management, admission, payout, and recovery authorities require their own
-- explicit migration contracts before a production role switch.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.users,
  cinatoken_gateway.api_keys,
  cinatoken_gateway.user_earnings,
  cinatoken_gateway.withdrawals,
  cinatoken_gateway.user_budget_reservations,
  cinatoken_gateway.shared_key_earnings,
  cinatoken_gateway.portal_ledger_entries,
  cinatoken_economic_outbox.shared_key_economic_events,
  cinatoken_economic_outbox.shared_key_economic_event_attempts,
  cinatoken_economic_outbox.shared_key_economic_producer_tx_markers,
  cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts,
  cinatoken_economic_outbox.shared_key_buyer_reservation_admissions
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
DECLARE buyer_oid oid;
DECLARE marker_oid oid;
DECLARE successor_marker_oid oid;
DECLARE v1_oid oid;
DECLARE v2_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_buyer_settlement';
  marker_oid := pg_catalog.to_regprocedure(
    'cinatoken_gateway.buyer_split_grant_policy_v348()');
  successor_marker_oid := pg_catalog.to_regprocedure(
    'cinatoken_gateway.buyer_split_guardrail_grant_policy_v349()');
  v1_oid := pg_catalog.to_regprocedure(
    'cinatoken_economic_outbox.write_shared_key_economic_event(text,text,text,jsonb,text)');
  v2_oid := pg_catalog.to_regprocedure(
    'cinatoken_economic_outbox.write_shared_key_economic_event_v2(text,text,text,bigint,jsonb,text)');
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR migrator_oid IS NULL OR runtime_oid IS NULL OR buyer_oid IS NULL
    OR marker_oid IS NULL OR successor_marker_oid IS NULL
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
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid IN (runtime_oid,buyer_oid)
        OR member IN (runtime_oid,buyer_oid))
    OR pg_catalog.has_schema_privilege(runtime_oid,
      'cinatoken_economic_outbox','CREATE')
    OR pg_catalog.has_schema_privilege(buyer_oid,
      'cinatoken_economic_outbox','CREATE')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE p.oid=marker_oid AND p.proowner=migrator_oid
        AND l.lanname='sql' AND NOT p.prosecdef AND p.provolatile='i'
        AND p.prosrc=$marker$SELECT 'buyer_split_v348'::text$marker$
        AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[])
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE p.oid=successor_marker_oid AND p.proowner=migrator_oid
        AND l.lanname='sql' AND NOT p.prosecdef AND p.provolatile='i'
        AND p.prosrc=$marker$SELECT 'buyer_split_guardrail_v349'::text$marker$
        AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[])
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE p.oid=v2_oid AND p.proowner=migrator_oid
        AND l.lanname='plpgsql' AND p.prosecdef AND p.provolatile='v'
        AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND pg_catalog.md5(pg_catalog.replace(p.prosrc,
          pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))
          ='60a5e195951633119537e913169abb5e')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN (
        'cinatoken_gateway.users'::pg_catalog.regclass,
        'cinatoken_gateway.api_keys'::pg_catalog.regclass,
        'cinatoken_gateway.user_earnings'::pg_catalog.regclass,
        'cinatoken_gateway.withdrawals'::pg_catalog.regclass,
        'cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass,
        'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass,
        'cinatoken_gateway.portal_ledger_entries'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_economic_event_attempts'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_economic_producer_tx_markers'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_buyer_reservation_admissions'::pg_catalog.regclass)
      AND (c.relowner<>migrator_oid OR c.relkind<>'r'
        OR c.relrowsecurity OR c.relforcerowsecurity))
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
      'cinatoken_gateway.shared_key_earnings','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(runtime_oid,
      'cinatoken_gateway.shared_key_earnings','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.portal_ledger_entries','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(runtime_oid,
      'cinatoken_gateway.portal_ledger_entries','INSERT,UPDATE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN (
        'cinatoken_gateway.users'::pg_catalog.regclass,
        'cinatoken_gateway.user_earnings'::pg_catalog.regclass,
        'cinatoken_gateway.withdrawals'::pg_catalog.regclass,
        'cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass,
        'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass,
        'cinatoken_gateway.portal_ledger_entries'::pg_catalog.regclass)
        AND pg_catalog.has_table_privilege(runtime_oid,c.oid,
          'TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.users','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(buyer_oid,
      'cinatoken_gateway.users','INSERT')
    OR pg_catalog.has_column_privilege(buyer_oid,
      'cinatoken_gateway.users','budget_max','UPDATE')
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.api_keys','UPDATE')
    OR pg_catalog.has_column_privilege(buyer_oid,
      'cinatoken_gateway.api_keys','workspace_id','UPDATE')
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.user_earnings','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(buyer_oid,
      'cinatoken_gateway.user_earnings','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.withdrawals','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(buyer_oid,
      'cinatoken_gateway.withdrawals','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.user_budget_reservations','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(buyer_oid,
      'cinatoken_gateway.user_budget_reservations','INSERT')
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.shared_key_earnings','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(buyer_oid,
      'cinatoken_gateway.shared_key_earnings','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.portal_ledger_entries','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(buyer_oid,
      'cinatoken_gateway.portal_ledger_entries','INSERT,UPDATE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid='cinatoken_gateway.users'::pg_catalog.regclass
        AND a.attnum>0 AND NOT a.attisdropped
        AND a.attname NOT IN ('budget_spent','budget_reserved_micros','updated_at')
        AND pg_catalog.has_column_privilege(buyer_oid,a.attrelid,a.attname,'UPDATE'))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid='cinatoken_gateway.api_keys'::pg_catalog.regclass
        AND a.attnum>0 AND NOT a.attisdropped
        AND a.attname<>'updated_at'
        AND pg_catalog.has_column_privilege(buyer_oid,a.attrelid,a.attname,'UPDATE'))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid='cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass
        AND a.attnum>0 AND NOT a.attisdropped
        AND a.attname NOT IN (
          'state','settled_micros','terminal_at','terminal_reason','updated_at')
        AND pg_catalog.has_column_privilege(buyer_oid,a.attrelid,a.attname,'UPDATE'))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN (
        'cinatoken_gateway.users'::pg_catalog.regclass,
        'cinatoken_gateway.api_keys'::pg_catalog.regclass,
        'cinatoken_gateway.user_earnings'::pg_catalog.regclass,
        'cinatoken_gateway.withdrawals'::pg_catalog.regclass,
        'cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass,
        'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass,
        'cinatoken_gateway.portal_ledger_entries'::pg_catalog.regclass)
        AND pg_catalog.has_table_privilege(buyer_oid,c.oid,
          'TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))
    OR pg_catalog.has_function_privilege(runtime_oid,marker_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,successor_marker_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(buyer_oid,successor_marker_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,v1_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,v2_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(buyer_oid,v1_oid,'EXECUTE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
      LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,
        pg_catalog.acldefault('f',p.proowner))) acl
      WHERE p.oid IN (v1_oid,v2_oid)
        AND (acl.grantee NOT IN (migrator_oid,buyer_oid)
          OR (acl.grantee=buyer_oid AND
            (p.oid<>v2_oid OR acl.privilege_type<>'EXECUTE'
              OR acl.is_grantable))))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c,
      LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,
        pg_catalog.acldefault('r',c.relowner))) acl
      WHERE c.oid IN (
        'cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_economic_event_attempts'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_economic_producer_tx_markers'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_buyer_reservation_admissions'::pg_catalog.regclass)
        AND acl.grantee<>migrator_oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN (
        'cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_economic_event_attempts'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_economic_producer_tx_markers'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_buyer_reservation_admissions'::pg_catalog.regclass)
      AND (pg_catalog.has_table_privilege(runtime_oid,c.oid,
          'SELECT,INSERT,UPDATE,DELETE')
        OR pg_catalog.has_table_privilege(buyer_oid,c.oid,
          'SELECT,INSERT,UPDATE,DELETE')))
  THEN
    RAISE EXCEPTION 'Buyer split grant drift or dependency differs'
      USING ERRCODE='P0001';
  END IF;
END;
$preflight$;

-- The successor grant cannot accept a replaced Guardrail proof function,
-- detached trigger, or reopened private receipt ACL. This runs before GRANT.
DO $guardrail_preflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
DECLARE buyer_oid oid;
DECLARE receipt_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_buyer_settlement';
  receipt_oid := pg_catalog.to_regclass(
    'cinatoken_economic_outbox.shared_key_guardrail_pre_send_denials');
  IF receipt_oid IS NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid=receipt_oid AND (c.relowner<>migrator_oid
        OR c.relkind<>'r' OR c.relrowsecurity OR c.relforcerowsecurity))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c,
      LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,
        pg_catalog.acldefault('r',c.relowner))) acl
      WHERE c.oid=receipt_oid AND acl.grantee<>migrator_oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a,
      LATERAL pg_catalog.aclexplode(a.attacl) acl
      WHERE a.attrelid=receipt_oid AND a.attnum>0 AND NOT a.attisdropped
        AND acl.grantee<>migrator_oid)
    OR pg_catalog.has_table_privilege(runtime_oid,receipt_oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    OR pg_catalog.has_table_privilege(buyer_oid,receipt_oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    OR pg_catalog.has_any_column_privilege(runtime_oid,receipt_oid,
      'SELECT,INSERT,UPDATE,REFERENCES')
    OR pg_catalog.has_any_column_privilege(buyer_oid,receipt_oid,
      'SELECT,INSERT,UPDATE,REFERENCES')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE p.oid IN (
        pg_catalog.to_regprocedure(
          'cinatoken_economic_outbox.verify_buyer_debit_v2()'),
        pg_catalog.to_regprocedure(
          'cinatoken_economic_outbox.verify_buyer_budget_tx_receipt()'),
        pg_catalog.to_regprocedure(
          'cinatoken_economic_outbox.capture_guardrail_pre_send_denial()'),
        pg_catalog.to_regprocedure(
          'cinatoken_economic_outbox.verified_guardrail_pre_send_denial(text,text,text)'),
        pg_catalog.to_regprocedure(
          'cinatoken_economic_outbox.guard_guardrail_pre_send_denial()'),
        pg_catalog.to_regprocedure(
          'cinatoken_economic_outbox.reject_guardrail_pre_send_denial_change()'),
        pg_catalog.to_regprocedure(
          'cinatoken_economic_outbox.guard_guardrail_reservation_after_denial()'))
        AND p.proowner=migrator_oid AND p.prosecdef
        AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND (l.lanname,p.provolatile)=(CASE p.proname
          WHEN 'verified_guardrail_pre_send_denial' THEN 'sql'
          ELSE 'plpgsql' END,CASE p.proname
          WHEN 'verified_guardrail_pre_send_denial' THEN 's'::"char"
          ELSE 'v'::"char" END)
        AND pg_catalog.md5(pg_catalog.replace(p.prosrc,
          pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))=
          CASE p.proname
            WHEN 'verify_buyer_debit_v2' THEN '4fad800586f0f75bf00f254c79fd392d'
            WHEN 'verify_buyer_budget_tx_receipt' THEN '84ae6d785faee4b5ea334f5d3ba29a7e'
            WHEN 'capture_guardrail_pre_send_denial' THEN 'b23a930d9eaf1dfb1ca57b2044bcf382'
            WHEN 'verified_guardrail_pre_send_denial' THEN 'acc8f35d13f223998bf1ec44d0a758c3'
            WHEN 'guard_guardrail_pre_send_denial' THEN '7961a70c156c8b124ab4c89dcc4662ef'
            WHEN 'reject_guardrail_pre_send_denial_change' THEN '207afededa37852c5bc1240a49a58c7e'
            WHEN 'guard_guardrail_reservation_after_denial' THEN '8defeb190527985f2928c856cfa11f29'
            ELSE '' END)<>7
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
      LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,
        pg_catalog.acldefault('f',p.proowner))) acl
      WHERE p.oid IN (
        pg_catalog.to_regprocedure(
          'cinatoken_economic_outbox.capture_guardrail_pre_send_denial()'),
        pg_catalog.to_regprocedure(
          'cinatoken_economic_outbox.verified_guardrail_pre_send_denial(text,text,text)'),
        pg_catalog.to_regprocedure(
          'cinatoken_economic_outbox.guard_guardrail_pre_send_denial()'),
        pg_catalog.to_regprocedure(
          'cinatoken_economic_outbox.reject_guardrail_pre_send_denial_change()'),
        pg_catalog.to_regprocedure(
          'cinatoken_economic_outbox.guard_guardrail_reservation_after_denial()'))
        AND acl.grantee<>migrator_oid)
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
      WHERE NOT t.tgisinternal AND t.tgenabled='O' AND (
        (t.tgname='user_budget_reservations_capture_guardrail_pre_send_denial'
          AND t.tgrelid='cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass
          AND t.tgfoid=pg_catalog.to_regprocedure(
            'cinatoken_economic_outbox.capture_guardrail_pre_send_denial()')
          AND t.tgtype=17)
        OR (t.tgname='user_budget_reservations_guard_guardrail_pre_send_denial'
          AND t.tgrelid='cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass
          AND t.tgfoid=pg_catalog.to_regprocedure(
            'cinatoken_economic_outbox.guard_guardrail_pre_send_denial()')
          AND t.tgtype=27)
        OR (t.tgname='shared_key_guardrail_pre_send_denials_no_change'
          AND t.tgrelid=receipt_oid
          AND t.tgfoid=pg_catalog.to_regprocedure(
            'cinatoken_economic_outbox.reject_guardrail_pre_send_denial_change()')
          AND t.tgtype=27)
        OR (t.tgname='guardrail_budget_reservations_guard_pre_send_denial'
          AND t.tgrelid='cinatoken_gateway.guardrail_budget_reservations'::pg_catalog.regclass
          AND t.tgfoid=pg_catalog.to_regprocedure(
            'cinatoken_economic_outbox.guard_guardrail_reservation_after_denial()')
          AND t.tgtype=23)))<>4
  THEN RAISE EXCEPTION 'Buyer Guardrail split grant drift or dependency differs'
    USING ERRCODE='P0001';
  END IF;
END;
$guardrail_preflight$;

-- Reassert only the dedicated buyer writer's reviewed positive rights. This
-- can repair a missing positive grant; unexpected excess rights fail above.
GRANT USAGE ON SCHEMA cinatoken_gateway
  TO cinatoken_gateway_buyer_settlement;
GRANT SELECT ON TABLE
  cinatoken_gateway.users,
  cinatoken_gateway.api_keys,
  cinatoken_gateway.workspaces,
  cinatoken_gateway.user_budget_reservations,
  cinatoken_gateway.api_key_request_logs,
  cinatoken_gateway.guardrail_budget_reservations,
  cinatoken_gateway.guardrail_budget_windows
TO cinatoken_gateway_buyer_settlement;
GRANT UPDATE (updated_at) ON TABLE cinatoken_gateway.api_keys
  TO cinatoken_gateway_buyer_settlement;
GRANT UPDATE (budget_spent,budget_reserved_micros,updated_at)
  ON TABLE cinatoken_gateway.users
  TO cinatoken_gateway_buyer_settlement;
GRANT UPDATE (state,settled_micros,terminal_at,terminal_reason,updated_at)
  ON TABLE cinatoken_gateway.user_budget_reservations
  TO cinatoken_gateway_buyer_settlement;
GRANT INSERT ON TABLE
  cinatoken_gateway.api_key_request_logs,
  cinatoken_gateway.user_audit_logs,
  cinatoken_gateway.provider_attempt_availability
TO cinatoken_gateway_buyer_settlement;
GRANT SELECT, INSERT, UPDATE ON TABLE
  cinatoken_gateway.public_model_daily_stats
TO cinatoken_gateway_buyer_settlement;
GRANT SELECT, UPDATE ON TABLE
  cinatoken_gateway.guardrail_budget_reservations,
  cinatoken_gateway.guardrail_budget_windows
TO cinatoken_gateway_buyer_settlement;
GRANT USAGE ON SCHEMA cinatoken_economic_outbox
  TO cinatoken_gateway_buyer_settlement;
GRANT EXECUTE ON FUNCTION
  cinatoken_economic_outbox.write_shared_key_economic_event_v2(
    text,text,text,bigint,jsonb,text)
  TO cinatoken_gateway_buyer_settlement;

DO $postflight$
DECLARE runtime_oid oid;
DECLARE buyer_oid oid;
DECLARE marker_oid oid;
DECLARE successor_marker_oid oid;
DECLARE v1_oid oid;
DECLARE v2_oid oid;
BEGIN
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_buyer_settlement';
  marker_oid := pg_catalog.to_regprocedure(
    'cinatoken_gateway.buyer_split_grant_policy_v348()');
  successor_marker_oid := pg_catalog.to_regprocedure(
    'cinatoken_gateway.buyer_split_guardrail_grant_policy_v349()');
  v1_oid := pg_catalog.to_regprocedure(
    'cinatoken_economic_outbox.write_shared_key_economic_event(text,text,text,jsonb,text)');
  v2_oid := pg_catalog.to_regprocedure(
    'cinatoken_economic_outbox.write_shared_key_economic_event_v2(text,text,text,bigint,jsonb,text)');
  IF pg_catalog.has_column_privilege(runtime_oid,
      'cinatoken_gateway.users','budget_spent','UPDATE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.user_earnings','UPDATE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.shared_key_earnings','INSERT')
    OR pg_catalog.has_function_privilege(runtime_oid,v1_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,v2_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,marker_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,successor_marker_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(buyer_oid,successor_marker_oid,'EXECUTE')
    OR NOT pg_catalog.has_schema_privilege(buyer_oid,
      'cinatoken_gateway','USAGE')
    OR NOT pg_catalog.has_column_privilege(buyer_oid,
      'cinatoken_gateway.users','budget_spent','UPDATE')
    OR NOT pg_catalog.has_column_privilege(buyer_oid,
      'cinatoken_gateway.users','budget_reserved_micros','UPDATE')
    OR NOT pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.api_key_request_logs','INSERT')
    OR NOT pg_catalog.has_schema_privilege(buyer_oid,
      'cinatoken_economic_outbox','USAGE')
    OR NOT pg_catalog.has_function_privilege(buyer_oid,v2_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(buyer_oid,v1_oid,'EXECUTE')
  THEN
    RAISE EXCEPTION 'Buyer split grant postflight differs'
      USING ERRCODE='P0001';
  END IF;
END;
$postflight$;
