-- REVIEW ONLY. Exact application ACL successor after the full v367 all-hold
-- renewal proposal has replaced the v366 reservation fence body. This is the
-- same narrow v374 buyer ACL, with a v367 source/role/trigger pin. It remains
-- non-activatable without the other C04 migration and runtime gates.
-- Execute as the direct migrator LOGIN inside one transaction with the
-- explicit local activation setting below. The prior v348/v349 grant runners
-- must remain disabled by the v368 superseding markers. This successor may
-- repair a drifted v374 buyer grant without reopening raw counter authority.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923562);
SELECT pg_catalog.pg_advisory_xact_lock(746923565);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.users,
  cinatoken_gateway.api_keys,
  cinatoken_gateway.user_budget_reservations,
  cinatoken_gateway.guardrail_budget_reservations,
  cinatoken_gateway.guardrail_budget_windows,
  cinatoken_gateway.complete_text_hold_renewals_v367,
  cinatoken_gateway.api_key_request_logs,
  cinatoken_gateway.user_audit_logs,
  cinatoken_gateway.provider_attempt_availability,
  cinatoken_gateway.public_model_daily_stats
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; buyer_oid oid; runtime_oid oid; admission_oid oid;
DECLARE marker_oid oid; old_marker_oid oid; guardrail_marker_oid oid;
DECLARE window_oid oid; old_oid oid; producer_oid oid; fence_oid oid;
DECLARE renewal_oid oid; renewal_table_oid oid; renewer_oid oid;
DECLARE immutable_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_buyer_settlement';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO admission_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_budget_admission';
  marker_oid:=pg_catalog.to_regprocedure(
    'cinatoken_gateway.buyer_split_counter_policy_v368()');
  old_marker_oid:=pg_catalog.to_regprocedure(
    'cinatoken_gateway.buyer_split_grant_policy_v348()');
  guardrail_marker_oid:=pg_catalog.to_regprocedure(
    'cinatoken_gateway.buyer_split_guardrail_grant_policy_v349()');
  window_oid:=pg_catalog.to_regprocedure(
    'cinatoken_gateway.settle_legacy_buyer_windowed_v371(text,text)');
  old_oid:=pg_catalog.to_regprocedure(
    'cinatoken_gateway.settle_legacy_buyer_held_v368(text,bigint,bigint,text)');
  producer_oid:=pg_catalog.to_regprocedure(
    'cinatoken_economic_outbox.write_shared_key_economic_event_v2(text,text,text,bigint,jsonb,text)');
  fence_oid:=pg_catalog.to_regprocedure(
    'cinatoken_gateway.reject_complete_text_enrolled_hold_mutation_v366()');
  renewal_oid:=pg_catalog.to_regprocedure(
    'cinatoken_gateway.renew_complete_text_holds_v367(uuid,uuid,uuid,bigint)');
  immutable_oid:=pg_catalog.to_regprocedure(
    'cinatoken_gateway.reject_complete_text_hold_renewal_mutation_v367()');
  renewal_table_oid:=pg_catalog.to_regclass(
    'cinatoken_gateway.complete_text_hold_renewals_v367');
  SELECT oid INTO renewer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_complete_text_hold_renewer';
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting(
      'cinatoken.legacy_buyer_windowed_app_privileges_v376_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR buyer_oid IS NULL OR runtime_oid IS NULL
    OR admission_oid IS NULL OR marker_oid IS NULL OR old_marker_oid IS NULL
    OR guardrail_marker_oid IS NULL OR window_oid IS NULL OR old_oid IS NULL
    OR producer_oid IS NULL OR fence_oid IS NULL
    OR renewal_oid IS NULL OR renewal_table_oid IS NULL OR renewer_oid IS NULL
    OR immutable_oid IS NULL
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
        WHERE nspname='cinatoken_gateway') IS DISTINCT FROM migrator_oid
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
        WHERE nspname='cinatoken_economic_outbox') IS DISTINCT FROM migrator_oid
    OR (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
        AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
        AND NOT rolinherit FROM pg_catalog.pg_roles WHERE oid=buyer_oid)
      IS DISTINCT FROM true
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid IN (buyer_oid,runtime_oid,admission_oid)
        OR member IN (buyer_oid,runtime_oid,admission_oid))
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid=marker_oid AND p.proowner=migrator_oid
        AND p.prosrc=$marker$SELECT 'buyer_counter_writer_v368'::text$marker$
        AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[])
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid=old_marker_oid AND p.proowner=migrator_oid
        AND p.prosrc=$marker$SELECT 'buyer_split_superseded_v368'::text$marker$)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid=guardrail_marker_oid AND p.proowner=migrator_oid
        AND p.prosrc=$marker$SELECT 'buyer_guardrail_superseded_v368'::text$marker$)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid=window_oid AND p.proowner=migrator_oid AND p.prosecdef
        AND p.provolatile='v' AND p.proconfig=
          ARRAY['search_path=pg_catalog, pg_temp','lock_timeout=2s']::text[]
        AND pg_catalog.md5(pg_catalog.replace(p.prosrc,
          pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))
          ='b29c5550a985893dede144627a4a5c45')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid=old_oid AND p.proowner=migrator_oid AND p.prosecdef
        AND p.provolatile='v' AND p.proconfig=
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND pg_catalog.md5(pg_catalog.replace(p.prosrc,
          pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))
          ='abeb0cc33ab91be53a41e42c8f8aeb16')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid=producer_oid AND p.proowner=migrator_oid AND p.prosecdef
        AND p.provolatile='v' AND p.proconfig=
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND pg_catalog.md5(pg_catalog.replace(p.prosrc,
          pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))
          ='60a5e195951633119537e913169abb5e')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid=fence_oid AND p.proowner=migrator_oid AND p.prosecdef
        AND p.provolatile='v' AND p.proconfig=
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND pg_catalog.md5(pg_catalog.replace(p.prosrc,
          pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))
          ='fbb71177d61d3e668bea3b662a5769f5')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid=renewal_oid AND p.proowner=migrator_oid AND p.prosecdef
        AND p.provolatile='v' AND p.proconfig=
          ARRAY['search_path=pg_catalog, pg_temp','lock_timeout=2s',
            'statement_timeout=15s']::text[]
        AND pg_catalog.md5(pg_catalog.replace(p.prosrc,
          pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))
          ='61cef47071a34d3821b1377e959abf7b')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid=immutable_oid AND p.proowner=migrator_oid AND p.prosecdef
        AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND pg_catalog.md5(pg_catalog.replace(p.prosrc,
          pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))
          ='1df01ab632d99f44ff967a31ee27ec9d')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid=renewal_table_oid AND c.relowner=migrator_oid
        AND c.relkind='r' AND NOT c.relrowsecurity
        AND NOT c.relforcerowsecurity)
    OR (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
        AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
        AND NOT rolinherit FROM pg_catalog.pg_roles WHERE oid=renewer_oid)
      IS DISTINCT FROM true
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid=renewer_oid OR member=renewer_oid)
    OR NOT pg_catalog.has_function_privilege(renewer_oid,renewal_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(buyer_oid,renewal_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,renewal_oid,'EXECUTE')
    OR pg_catalog.has_table_privilege(renewer_oid,renewal_table_oid,
      'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(renewer_oid,renewal_table_oid,
      'SELECT,INSERT,UPDATE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c,
        LATERAL pg_catalog.aclexplode(c.relacl) acl
      WHERE c.oid=renewal_table_oid AND acl.grantee<>migrator_oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a,
        LATERAL pg_catalog.aclexplode(a.attacl) acl
      WHERE a.attrelid=renewal_table_oid AND a.attnum>0
        AND NOT a.attisdropped AND acl.grantee<>migrator_oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
        LATERAL pg_catalog.aclexplode(p.proacl) acl
      WHERE p.oid=renewal_oid
        AND acl.grantee NOT IN (migrator_oid,renewer_oid))
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
      WHERE t.tgname='complete_text_hold_renewals_v367_no_mutation'
        AND t.tgrelid=renewal_table_oid AND t.tgenabled='O'
        AND NOT t.tgisinternal AND t.tgfoid=immutable_oid
        AND t.tgtype=27 AND t.tgqual IS NULL
        AND t.tgattr=''::pg_catalog.int2vector)<>1
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
      WHERE t.tgname IN ('complete_text_ordinary_hold_fence_v366',
          'complete_text_guardrail_hold_fence_v366')
        AND t.tgfoid=fence_oid AND t.tgenabled='O' AND NOT t.tgisinternal
        AND t.tgtype=31 AND t.tgqual IS NULL
        AND t.tgattr=''::pg_catalog.int2vector
        AND (t.tgname='complete_text_ordinary_hold_fence_v366'
          AND t.tgrelid='cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass
          OR t.tgname='complete_text_guardrail_hold_fence_v366'
          AND t.tgrelid='cinatoken_gateway.guardrail_budget_reservations'::pg_catalog.regclass))<>2
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
      WHERE t.tgname='seed_guardrail_window_unreserved_v371'
        AND t.tgrelid='cinatoken_gateway.guardrail_budget_windows'::pg_catalog.regclass
        AND t.tgenabled='O' AND NOT t.tgisinternal
        AND t.tgtype=7 AND t.tgqual IS NULL
        AND t.tgattr=''::pg_catalog.int2vector)<>1
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN (
        'cinatoken_gateway.users'::pg_catalog.regclass,
        'cinatoken_gateway.api_keys'::pg_catalog.regclass,
        'cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass,
        'cinatoken_gateway.guardrail_budget_reservations'::pg_catalog.regclass,
        'cinatoken_gateway.guardrail_budget_windows'::pg_catalog.regclass,
        'cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass,
        'cinatoken_gateway.user_audit_logs'::pg_catalog.regclass,
        'cinatoken_gateway.provider_attempt_availability'::pg_catalog.regclass,
        'cinatoken_gateway.public_model_daily_stats'::pg_catalog.regclass)
        AND (c.relowner<>migrator_oid OR c.relkind<>'r'
          OR c.relrowsecurity OR c.relforcerowsecurity))
    OR pg_catalog.has_schema_privilege(buyer_oid,'cinatoken_gateway','CREATE')
    OR pg_catalog.has_schema_privilege(buyer_oid,'cinatoken_economic_outbox','CREATE')
    OR NOT pg_catalog.has_function_privilege(buyer_oid,window_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,window_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(buyer_oid,old_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,old_oid,'EXECUTE')
    OR NOT pg_catalog.has_function_privilege(buyer_oid,producer_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,producer_oid,'EXECUTE')
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.api_keys','UPDATE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid='cinatoken_gateway.api_keys'::pg_catalog.regclass
        AND a.attnum>0 AND NOT a.attisdropped AND a.attname<>'updated_at'
        AND pg_catalog.has_column_privilege(buyer_oid,a.attrelid,a.attname,'UPDATE'))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN (
        'cinatoken_gateway.users'::pg_catalog.regclass,
        'cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass,
        'cinatoken_gateway.guardrail_budget_reservations'::pg_catalog.regclass,
        'cinatoken_gateway.guardrail_budget_windows'::pg_catalog.regclass)
        AND (pg_catalog.has_table_privilege(buyer_oid,c.oid,
          'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR pg_catalog.has_any_column_privilege(buyer_oid,c.oid,
            'INSERT,UPDATE')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN (
        'cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass,
        'cinatoken_gateway.user_audit_logs'::pg_catalog.regclass,
        'cinatoken_gateway.provider_attempt_availability'::pg_catalog.regclass)
        AND (pg_catalog.has_table_privilege(buyer_oid,c.oid,
          'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR pg_catalog.has_any_column_privilege(buyer_oid,c.oid,'UPDATE')))
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.public_model_daily_stats',
      'DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.user_audit_logs','SELECT')
    OR pg_catalog.has_any_column_privilege(buyer_oid,
      'cinatoken_gateway.user_audit_logs','SELECT')
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.provider_attempt_availability','SELECT')
    OR pg_catalog.has_any_column_privilege(buyer_oid,
      'cinatoken_gateway.provider_attempt_availability','SELECT')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.users','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(runtime_oid,
      'cinatoken_gateway.users','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.user_budget_reservations','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(runtime_oid,
      'cinatoken_gateway.user_budget_reservations','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(admission_oid,
      'cinatoken_gateway.users','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(admission_oid,
      'cinatoken_gateway.users','INSERT,UPDATE')
    OR pg_catalog.has_function_privilege(admission_oid,
      'cinatoken_gateway.reserve_user_budget_v350(text,text,text,bigint,bigint,timestamptz,timestamptz)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(admission_oid,
      'cinatoken_gateway.reserve_guardrail_budgets_v351(text,text,text,jsonb,bigint,text,timestamptz,timestamptz)',
      'EXECUTE')
    OR NOT pg_catalog.has_function_privilege(admission_oid,
      'cinatoken_gateway.admit_complete_flat_text_quote_v361(text,uuid,jsonb)',
      'EXECUTE')
  THEN RAISE EXCEPTION 'windowed buyer app privileges v376 renewal dependency or ACL differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

-- The v348/v349 split leaves ordinary runtime direct Guardrail DML. Remove
-- it in this locked ACL transaction. v361's complete-text admission wrapper
-- remains callable, while legacy Guardrail admission still needs a separate
-- reviewed production route switch. This is not a rollout command.
REVOKE INSERT,UPDATE,DELETE ON TABLE
  cinatoken_gateway.guardrail_budget_reservations,
  cinatoken_gateway.guardrail_budget_windows
  FROM cinatoken_gateway_runtime;

-- These are the only direct DML rights used by the opt-in app transaction.
-- The UPDATE(updated_at) column grant is solely for API-key FOR UPDATE row
-- locking; broad UPDATE would permit identity mutation and is rejected above.
GRANT USAGE ON SCHEMA cinatoken_gateway,
  cinatoken_economic_outbox TO cinatoken_gateway_buyer_settlement;
-- v348 granted broad SELECT to the buyer. Drop it before issuing the exact
-- columns read by the v372 writer and its database-derived audit snapshot.
REVOKE SELECT ON TABLE cinatoken_gateway.users,
  cinatoken_gateway.api_keys,
  cinatoken_gateway.workspaces,
  cinatoken_gateway.user_budget_reservations,
  cinatoken_gateway.guardrail_budget_reservations,
  cinatoken_gateway.guardrail_budget_windows,
  cinatoken_gateway.api_key_request_logs
  FROM cinatoken_gateway_buyer_settlement;
GRANT SELECT (id,email,budget_max,budget_base,budget_spent,
  budget_period,budget_reset_at,budget_epoch,budget_reserved_micros,
  status,metadata,charged_cost_factors,external_system,external_user_id)
  ON TABLE cinatoken_gateway.users
  TO cinatoken_gateway_buyer_settlement;
GRANT SELECT (id,workspace_id) ON TABLE cinatoken_gateway.api_keys
  TO cinatoken_gateway_buyer_settlement;
GRANT SELECT (request_id,user_id,budget_epoch,reserved_micros,
  settled_micros,state)
  ON TABLE cinatoken_gateway.user_budget_reservations
  TO cinatoken_gateway_buyer_settlement;
-- INSERT ... ON CONFLICT (id) DO NOTHING RETURNING id checks SELECT(id).
GRANT SELECT (id) ON TABLE cinatoken_gateway.api_key_request_logs
  TO cinatoken_gateway_buyer_settlement;
GRANT UPDATE (updated_at) ON TABLE cinatoken_gateway.api_keys
  TO cinatoken_gateway_buyer_settlement;
GRANT INSERT ON TABLE cinatoken_gateway.api_key_request_logs,
  cinatoken_gateway.user_audit_logs,
  cinatoken_gateway.provider_attempt_availability
  TO cinatoken_gateway_buyer_settlement;
GRANT SELECT,INSERT,UPDATE ON TABLE
  cinatoken_gateway.public_model_daily_stats
  TO cinatoken_gateway_buyer_settlement;
GRANT EXECUTE ON FUNCTION
  cinatoken_gateway.settle_legacy_buyer_windowed_v371(text,text),
  cinatoken_economic_outbox.write_shared_key_economic_event_v2(
    text,text,text,bigint,jsonb,text)
  TO cinatoken_gateway_buyer_settlement;

DO $postflight$
DECLARE buyer_oid oid; runtime_oid oid;
BEGIN
  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_buyer_settlement';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  IF pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.api_keys','SELECT')
    OR NOT pg_catalog.has_column_privilege(buyer_oid,
      'cinatoken_gateway.api_keys','id','SELECT')
    OR NOT pg_catalog.has_column_privilege(buyer_oid,
      'cinatoken_gateway.api_keys','workspace_id','SELECT')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid='cinatoken_gateway.api_keys'::pg_catalog.regclass
        AND a.attnum>0 AND NOT a.attisdropped
        AND a.attname NOT IN ('id','workspace_id')
        AND pg_catalog.has_column_privilege(buyer_oid,a.attrelid,a.attname,'SELECT'))
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.users','SELECT')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_attribute a
      WHERE a.attrelid='cinatoken_gateway.users'::pg_catalog.regclass
        AND a.attnum>0 AND NOT a.attisdropped
        AND a.attname IN ('id','email','budget_max','budget_base',
          'budget_spent','budget_period','budget_reset_at','budget_epoch',
          'budget_reserved_micros','status','metadata',
          'charged_cost_factors','external_system','external_user_id')
        AND pg_catalog.has_column_privilege(buyer_oid,a.attrelid,a.attname,'SELECT'))<>14
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid='cinatoken_gateway.users'::pg_catalog.regclass
        AND a.attnum>0 AND NOT a.attisdropped
        AND a.attname NOT IN ('id','email','budget_max','budget_base',
          'budget_spent','budget_period','budget_reset_at','budget_epoch',
          'budget_reserved_micros','status','metadata',
          'charged_cost_factors','external_system','external_user_id')
        AND pg_catalog.has_column_privilege(buyer_oid,a.attrelid,a.attname,'SELECT'))
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.user_budget_reservations','SELECT')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_attribute a
      WHERE a.attrelid='cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass
        AND a.attnum>0 AND NOT a.attisdropped
        AND a.attname IN ('request_id','user_id','budget_epoch',
          'reserved_micros','settled_micros','state')
        AND pg_catalog.has_column_privilege(buyer_oid,a.attrelid,a.attname,'SELECT'))<>6
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid='cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass
        AND a.attnum>0 AND NOT a.attisdropped
        AND a.attname NOT IN ('request_id','user_id','budget_epoch',
          'reserved_micros','settled_micros','state')
        AND pg_catalog.has_column_privilege(buyer_oid,a.attrelid,a.attname,'SELECT'))
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.workspaces','SELECT')
    OR pg_catalog.has_any_column_privilege(buyer_oid,
      'cinatoken_gateway.workspaces','SELECT')
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.guardrail_budget_reservations','SELECT')
    OR pg_catalog.has_any_column_privilege(buyer_oid,
      'cinatoken_gateway.guardrail_budget_reservations','SELECT')
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.guardrail_budget_windows','SELECT')
    OR pg_catalog.has_any_column_privilege(buyer_oid,
      'cinatoken_gateway.guardrail_budget_windows','SELECT')
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.api_key_request_logs','SELECT')
    OR NOT pg_catalog.has_column_privilege(buyer_oid,
      'cinatoken_gateway.api_key_request_logs','id','SELECT')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid='cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass
        AND a.attnum>0 AND NOT a.attisdropped AND a.attname<>'id'
        AND pg_catalog.has_column_privilege(buyer_oid,a.attrelid,a.attname,'SELECT'))
    OR NOT pg_catalog.has_column_privilege(buyer_oid,
      'cinatoken_gateway.api_keys','updated_at','UPDATE')
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.api_keys','UPDATE')
    OR NOT pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.api_key_request_logs','INSERT')
    OR NOT pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.user_audit_logs','INSERT')
    OR NOT pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.provider_attempt_availability','INSERT')
    OR NOT pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.public_model_daily_stats','SELECT,INSERT,UPDATE')
    OR NOT pg_catalog.has_function_privilege(buyer_oid,
      'cinatoken_gateway.settle_legacy_buyer_windowed_v371(text,text)','EXECUTE')
    OR NOT pg_catalog.has_function_privilege(buyer_oid,
      'cinatoken_economic_outbox.write_shared_key_economic_event_v2(text,text,text,bigint,jsonb,text)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_gateway.settle_legacy_buyer_windowed_v371(text,text)','EXECUTE')
    OR pg_catalog.has_any_column_privilege(buyer_oid,
      'cinatoken_gateway.users','UPDATE')
    OR pg_catalog.has_any_column_privilege(buyer_oid,
      'cinatoken_gateway.user_budget_reservations','UPDATE')
    OR pg_catalog.has_any_column_privilege(buyer_oid,
      'cinatoken_gateway.guardrail_budget_windows','UPDATE')
    OR pg_catalog.has_function_privilege(
      'cinatoken_gateway_budget_admission',
      'cinatoken_gateway.reserve_user_budget_v350(text,text,text,bigint,bigint,timestamptz,timestamptz)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(
      'cinatoken_gateway_budget_admission',
      'cinatoken_gateway.reserve_guardrail_budgets_v351(text,text,text,jsonb,bigint,text,timestamptz,timestamptz)',
      'EXECUTE')
    OR NOT pg_catalog.has_function_privilege(
      'cinatoken_gateway_budget_admission',
      'cinatoken_gateway.admit_complete_flat_text_quote_v361(text,uuid,jsonb)',
      'EXECUTE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.guardrail_budget_reservations','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(runtime_oid,
      'cinatoken_gateway.guardrail_budget_reservations','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.guardrail_budget_windows','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(runtime_oid,
      'cinatoken_gateway.guardrail_budget_windows','INSERT,UPDATE')
  THEN RAISE EXCEPTION 'windowed buyer app privileges v376 renewal postflight differs'
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
