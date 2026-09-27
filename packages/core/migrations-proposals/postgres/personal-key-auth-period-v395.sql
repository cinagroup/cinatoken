-- REVIEW ONLY. PG73 + v356/v362/v388; direct migrator activation is required.
-- No caller chooses an account, amount, epoch, clock or audit payload.
-- Period rollover waits for all unresolved personal obligations to close.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog,pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923595);
LOCK TABLE cinatoken_gateway.schema_migrations,cinatoken_gateway.api_keys,
  cinatoken_gateway.users,cinatoken_gateway.workspaces,cinatoken_gateway.user_audit_logs,
  cinatoken_gateway.user_budget_reservations,cinatoken_gateway.guardrail_budget_reservations,
  cinatoken_gateway.guardrail_budget_windows,
  cinatoken_gateway.complete_text_quotes_v360,cinatoken_gateway.complete_text_attempt_grants_v362,
  cinatoken_gateway.complete_text_platform_terminals_v388,
  cinatoken_gateway.complete_text_platform_outbox_v388,
  cinatoken_gateway.api_key_request_logs,cinatoken_gateway.complete_text_hold_renewals_v367,
  cinatoken_gateway.complete_text_result_facts_v366 IN SHARE ROW EXCLUSIVE MODE;
DO $preflight$
DECLARE migrator oid; auth_oid oid; runtime_oid oid; invalidator oid;
DECLARE dependency_tables text[]:=ARRAY['api_keys','users','workspaces','user_audit_logs',
  'user_budget_reservations','guardrail_budget_reservations','guardrail_budget_windows','complete_text_quotes_v360',
  'complete_text_attempt_grants_v362','complete_text_platform_terminals_v388','complete_text_platform_outbox_v388',
  'api_key_request_logs','complete_text_hold_renewals_v367','complete_text_result_facts_v366'];
DECLARE trigger_contract text; function_contract text;
BEGIN
  SELECT oid INTO migrator FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO auth_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_personal_key_auth';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_runtime';
  invalidator:=pg_catalog.to_regprocedure('cinatoken_gateway.invalidate_request_capabilities_v356()');
  IF SESSION_USER<>'cinatoken_gateway_migrator' OR CURRENT_USER<>SESSION_USER
    OR pg_catalog.current_setting('cinatoken.personal_key_auth_period_v395_activation',true) IS DISTINCT FROM 'reviewed-v1'
    OR migrator IS NULL OR auth_oid IS NULL OR runtime_oid IS NULL OR invalidator IS NULL
    OR (SELECT count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT md5(string_agg(version,E'\n' ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      IS DISTINCT FROM 'ca1ea96a1b4bcd0675642f30dcf48042'
    OR (SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname='cinatoken_gateway') IS DISTINCT FROM migrator
    OR pg_catalog.to_regnamespace('cinatoken_personal_auth') IS NOT NULL
    OR pg_catalog.to_regprocedure('cinatoken_gateway.authenticate_personal_gateway_key_v395(text)') IS NOT NULL
  THEN RAISE EXCEPTION 'personal auth v395 activation or dependency differs' USING ERRCODE='P0001'; END IF;
  IF (SELECT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreaterole
        AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls FROM pg_catalog.pg_roles WHERE oid=auth_oid) IS DISTINCT FROM true
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=auth_oid OR roleid=auth_oid)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE nspname LIKE 'cinatoken_%'
      AND (has_schema_privilege(auth_oid,n.oid,'CREATE') OR has_schema_privilege(auth_oid,n.oid,'USAGE')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname LIKE 'cinatoken_%' AND CASE WHEN c.relkind IN ('r','p','v','m','f')
        THEN has_table_privilege(auth_oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR has_any_column_privilege(auth_oid,c.oid,'SELECT,INSERT,UPDATE') ELSE false END)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname LIKE 'cinatoken_%' AND CASE WHEN c.relkind='S'
        THEN has_sequence_privilege(auth_oid,c.oid,'SELECT,USAGE,UPDATE') ELSE false END)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE (n.nspname LIKE 'cinatoken_%' OR p.proowner=migrator) AND has_function_privilege(auth_oid,p.oid,'EXECUTE'))
    OR has_table_privilege(runtime_oid,'cinatoken_gateway.users','UPDATE')
    OR has_any_column_privilege(runtime_oid,'cinatoken_gateway.users','UPDATE')
    OR has_database_privilege(auth_oid,current_database(),'CREATE')
    OR has_schema_privilege(auth_oid,'public','CREATE')
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid IN (
      'cinatoken_gateway.api_keys'::regclass,'cinatoken_gateway.users'::regclass,
      'cinatoken_gateway.workspaces'::regclass,'cinatoken_gateway.user_audit_logs'::regclass,
      'cinatoken_gateway.user_budget_reservations'::regclass,'cinatoken_gateway.guardrail_budget_reservations'::regclass,
      'cinatoken_gateway.guardrail_budget_windows'::regclass,'cinatoken_gateway.complete_text_quotes_v360'::regclass,
      'cinatoken_gateway.complete_text_attempt_grants_v362'::regclass,
      'cinatoken_gateway.complete_text_platform_terminals_v388'::regclass,
      'cinatoken_gateway.complete_text_platform_outbox_v388'::regclass,'cinatoken_gateway.api_key_request_logs'::regclass)
      AND (c.relowner<>migrator OR c.relkind<>'r' OR c.relrowsecurity OR c.relforcerowsecurity))
  THEN RAISE EXCEPTION 'personal auth v395 dedicated role or buyer split differs' USING ERRCODE='P0001'; END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d,LATERAL pg_catalog.aclexplode(d.defaclacl) a
    WHERE d.defaclrole=migrator AND a.grantee<>migrator
      AND (d.defaclnamespace=0 OR d.defaclnamespace='cinatoken_gateway'::regnamespace)
      AND NOT(d.defaclobjtype='f' AND a.privilege_type='EXECUTE' AND NOT a.is_grantable AND a.grantee IN (0,runtime_oid))
      AND NOT(d.defaclnamespace='cinatoken_gateway'::regnamespace AND a.grantee=runtime_oid AND NOT a.is_grantable
        AND ((d.defaclobjtype='r' AND a.privilege_type='SELECT')
          OR (d.defaclobjtype='S' AND a.privilege_type IN ('SELECT','USAGE','UPDATE')))))
  THEN RAISE EXCEPTION 'personal auth v395 default ACL differs' USING ERRCODE='P0001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=invalidator AND p.proowner=migrator
      AND p.prosecdef AND p.provolatile='v' AND p.prokind='f' AND NOT p.proretset
      AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp','lock_timeout=2s']::text[]
      AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
      AND md5(replace(p.prosrc,E'\r\n',E'\n'))='331cc2f19e2673f9190d382d85735a40')
    OR (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal AND t.tgfoid=invalidator
      AND t.tgenabled='O' AND t.tgtype=25 AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgattr::text=''
      AND (t.tgrelid,t.tgname) IN (
        ('cinatoken_gateway.api_keys'::regclass,'invalidate_request_capabilities_key_v356'),
        ('cinatoken_gateway.users'::regclass,'invalidate_request_capabilities_user_v356'),
        ('cinatoken_gateway.workspaces'::regclass,'invalidate_request_capabilities_workspace_v356')))<>3
  THEN RAISE EXCEPTION 'personal auth v395 capability invalidation differs' USING ERRCODE='P0001'; END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN (VALUES
      ('cinatoken_gateway.grant_complete_flat_text_attempt_v362(uuid,jsonb)'::regprocedure,
        '0339e4f95fff26784032d2d73ec09a7a',ARRAY['search_path=pg_catalog, pg_temp','lock_timeout=2s','statement_timeout=15s']::text[]),
      ('cinatoken_gateway.protect_platform_close_rows_v388()'::regprocedure,
        '8b40041321fe92f1390049e1749649db',ARRAY['search_path=pg_catalog, pg_temp']::text[]),
      ('cinatoken_gateway.reject_platform_terminal_egress_v388()'::regprocedure,
        '20dba83baa81941565ce39a20302f524',ARRAY['search_path=pg_catalog, pg_temp']::text[]),
      ('cinatoken_gateway.verify_platform_close_v388()'::regprocedure,
        '091a633e98ade83604dad78dd13a6c31',ARRAY['search_path=pg_catalog, pg_temp']::text[])
    ) AS expected(fn,body_md5,config) ON p.oid=expected.fn
    WHERE p.proowner=migrator AND p.prosecdef AND p.provolatile='v' AND p.prokind='f' AND NOT p.proretset
      AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
      AND md5(replace(p.prosrc,E'\r\n',E'\n'))=expected.body_md5 AND p.proconfig=expected.config)<>4
    OR (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled='O'
      AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgattr::text='' AND NOT t.tgdeferrable
      AND (t.tgrelid,t.tgname,t.tgfoid,t.tgtype) IN (
        ('cinatoken_gateway.complete_text_platform_terminals_v388'::regclass,'platform_terminal_rows_v388',
          'cinatoken_gateway.protect_platform_close_rows_v388()'::regprocedure,31),
        ('cinatoken_gateway.complete_text_platform_outbox_v388'::regclass,'platform_event_rows_v388',
          'cinatoken_gateway.protect_platform_close_rows_v388()'::regprocedure,31),
        ('cinatoken_gateway.complete_text_platform_terminals_v388'::regclass,'platform_terminal_truncate_v388',
          'cinatoken_gateway.protect_platform_close_rows_v388()'::regprocedure,34),
        ('cinatoken_gateway.complete_text_platform_outbox_v388'::regclass,'platform_event_truncate_v388',
          'cinatoken_gateway.protect_platform_close_rows_v388()'::regprocedure,34),
        ('cinatoken_gateway.complete_text_attempt_grants_v362'::regclass,'platform_terminal_grant_v388',
          'cinatoken_gateway.reject_platform_terminal_egress_v388()'::regprocedure,7),
        ('cinatoken_gateway.complete_text_hold_renewals_v367'::regclass,'platform_terminal_renewal_v388',
          'cinatoken_gateway.reject_platform_terminal_egress_v388()'::regprocedure,7),
        ('cinatoken_gateway.complete_text_result_facts_v366'::regclass,'platform_terminal_holder_fact_v388',
          'cinatoken_gateway.reject_platform_terminal_egress_v388()'::regprocedure,7)))<>7
    OR (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled='O'
      AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgattr::text='' AND t.tgdeferrable AND t.tginitdeferred
      AND t.tgtype=5 AND t.tgfoid='cinatoken_gateway.verify_platform_close_v388()'::regprocedure
      AND (t.tgrelid,t.tgname) IN (
        ('cinatoken_gateway.complete_text_platform_terminals_v388'::regclass,'platform_terminal_complete_v388'),
        ('cinatoken_gateway.complete_text_platform_outbox_v388'::regclass,'platform_event_complete_v388')))<>2
  THEN RAISE EXCEPTION 'personal auth v395 grant or terminal authority differs' USING ERRCODE='P0001'; END IF;
  -- Exact v388 branch contract, including every user trigger on the fourteen
  -- dependency tables and every referenced trigger function. Native report
  -- retains all 37 definitions / 28 function traits and EXECUTE ACL entries.
  -- An added trigger or inherited PUBLIC/extra EXECUTE grant is not permitted.
  SELECT md5(string_agg(c.relname||'|'||t.tgname||'|'||pg_get_triggerdef(t.oid,true)||'|'||t.tgenabled::text,
    E'\n' ORDER BY c.relname COLLATE "C",t.tgname COLLATE "C")) INTO trigger_contract
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE NOT t.tgisinternal AND n.nspname='cinatoken_gateway' AND c.relname=ANY(dependency_tables);
  SELECT md5(string_agg(p.oid::regprocedure::text||'|'||pg_get_userbyid(p.proowner)||'|'||p.prosecdef::text||'|'
    ||p.provolatile::text||'|'||p.prokind::text||'|'||p.proretset::text||'|'||l.lanname||'|'
    ||COALESCE(p.proconfig::text,'NULL')||'|'||md5(replace(p.prosrc,E'\r\n',E'\n'))||'|'
    ||(SELECT string_agg((CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END)||':'
      ||pg_get_userbyid(a.grantor)||':'||a.privilege_type||':'||a.is_grantable::text,','
      ORDER BY (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END) COLLATE "C",
        a.privilege_type COLLATE "C") FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a),
      E'\n' ORDER BY p.oid::regprocedure::text COLLATE "C")) INTO function_contract
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    WHERE p.oid IN (SELECT t.tgfoid FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal
        AND n.nspname='cinatoken_gateway' AND c.relname=ANY(dependency_tables))
      OR p.oid IN ('cinatoken_gateway.grant_complete_flat_text_attempt_v362(uuid,jsonb)'::regprocedure,
        'cinatoken_gateway.close_complete_text_no_fetch_v388(uuid,uuid,uuid)'::regprocedure);
  IF trigger_contract IS DISTINCT FROM '059b16fedc395a3579bae93da967a662'
    OR function_contract IS DISTINCT FROM '9aaafe214c422d1ca5705cb753479304'
  THEN RAISE EXCEPTION 'personal auth v395 exact trigger or function ACL catalog differs' USING ERRCODE='P0001'; END IF;
END;
$preflight$;

CREATE SCHEMA cinatoken_personal_auth AUTHORIZATION cinatoken_gateway_migrator;
REVOKE ALL ON SCHEMA cinatoken_personal_auth FROM PUBLIC;

-- Same UTC anchored, iterative month-clamp semantics as advanceByOnePeriod.
-- Private pure function permits independent boundary tests with no clock injection
-- into the authorized auth/reset entry point.
CREATE FUNCTION cinatoken_personal_auth.next_period_v395(p_anchor timestamptz,p_period text,p_now timestamptz)
RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $period$
DECLARE next_at timestamp; next_month timestamp; iterations integer:=0;
BEGIN
  IF p_anchor IS NULL OR p_now IS NULL OR NOT isfinite(p_anchor) OR NOT isfinite(p_now)
    OR p_period NOT IN ('daily','weekly','monthly') OR p_period IS NULL
    OR extract(year FROM p_anchor AT TIME ZONE 'UTC') NOT BETWEEN 1 AND 9998
    OR extract(year FROM p_now AT TIME ZONE 'UTC') NOT BETWEEN 1 AND 9998
  THEN RAISE EXCEPTION 'invalid personal budget period' USING ERRCODE='23514'; END IF;
  next_at:=p_anchor AT TIME ZONE 'UTC';
  WHILE next_at<=p_now AT TIME ZONE 'UTC' LOOP
    iterations:=iterations+1;
    IF iterations>120000 THEN RAISE EXCEPTION 'personal budget period range exceeded' USING ERRCODE='23514'; END IF;
    IF p_period='daily' THEN
      next_at:=next_at+(floor(extract(epoch FROM ((p_now AT TIME ZONE 'UTC')-next_at))/86400)+1)*INTERVAL '1 day';
    ELSIF p_period='weekly' THEN
      next_at:=next_at+(floor(extract(epoch FROM ((p_now AT TIME ZONE 'UTC')-next_at))/604800)+1)*INTERVAL '7 days';
    ELSE
      next_month:=date_trunc('month',next_at)+INTERVAL '1 month';
      next_at:=next_month+(LEAST(extract(day FROM next_at),extract(day FROM next_month+INTERVAL '1 month'-INTERVAL '1 day'))-1)*INTERVAL '1 day'
        +(next_at-date_trunc('day',next_at));
    END IF;
  END LOOP;
  RETURN next_at AT TIME ZONE 'UTC';
END;
$period$;

-- Called only by the bearer-bound wrapper after key -> user -> workspace locks.
-- No ledger or window is modified. Unknown/dispatched obligations are preserved.
CREATE FUNCTION cinatoken_personal_auth.reset_due_period_v395(p_user_id text,p_key_id text,p_workspace_id text)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $reset$
DECLARE u cinatoken_gateway.users%ROWTYPE; next_at timestamptz; server_now timestamptz;
DECLARE before_snapshot jsonb; after_snapshot jsonb; fields text[];
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_personal_key_auth' OR current_setting('transaction_isolation')<>'read committed'
  THEN RAISE EXCEPTION 'invalid personal period caller' USING ERRCODE='23514'; END IF;
  SELECT * INTO u FROM cinatoken_gateway.users WHERE id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'personal period user missing' USING ERRCODE='23514'; END IF;
  server_now:=clock_timestamp();
  IF u.budget_period='none' OR u.budget_reset_at IS NULL OR u.budget_reset_at>server_now THEN RETURN 'unchanged'; END IF;
  -- Predicate locks exclude admission, renewal and direct legacy writes while
  -- proving there is no remaining obligation. This conservative review path
  -- may wait up to the caller's 2s lock bound; no financial write is raced.
  LOCK TABLE cinatoken_gateway.user_budget_reservations,cinatoken_gateway.guardrail_budget_reservations,
    cinatoken_gateway.guardrail_budget_windows,
    cinatoken_gateway.complete_text_attempt_grants_v362,
    cinatoken_gateway.complete_text_platform_terminals_v388,
    cinatoken_gateway.complete_text_platform_outbox_v388,
    cinatoken_gateway.api_key_request_logs IN SHARE ROW EXCLUSIVE MODE;
  IF u.budget_reserved_micros<>0
    OR EXISTS(SELECT 1 FROM cinatoken_gateway.user_budget_reservations WHERE user_id=u.id AND state IN ('reserved','dispatched'))
    OR EXISTS(SELECT 1 FROM cinatoken_gateway.guardrail_budget_reservations r WHERE r.state IN ('reserved','dispatched')
      AND (r.workspace_id=p_workspace_id OR (r.scope_type='user' AND r.scope_id=u.id)
        OR EXISTS(SELECT 1 FROM cinatoken_gateway.user_budget_reservations o WHERE o.user_id=u.id AND o.request_id=r.request_id)))
    OR EXISTS(SELECT 1 FROM cinatoken_gateway.guardrail_budget_windows w WHERE w.reserved_micros<>0
      AND (w.workspace_id=p_workspace_id OR (w.scope_type='user' AND w.scope_id=u.id)))
    -- A zero/unlimited reservation is still an obligation once a grant exists.
    -- Only a complete, immutable v388 terminal/log/event set discharges it.
    OR EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_attempt_grants_v362 g
      JOIN cinatoken_gateway.complete_text_quotes_v360 q ON q.quote_id=g.quote_id AND q.request_id=g.request_id
      WHERE q.user_id=u.id AND NOT EXISTS(
        SELECT 1 FROM cinatoken_gateway.complete_text_platform_terminals_v388 t
        JOIN cinatoken_gateway.complete_text_platform_outbox_v388 e
          ON e.event_id=t.event_id AND e.terminal_id=t.terminal_id AND e.request_id=t.request_id
        JOIN cinatoken_gateway.api_key_request_logs l ON l.id=t.request_id
        WHERE t.grant_id=g.grant_id AND t.request_id=g.request_id AND t.quote_id=g.quote_id
          AND t.buyer_charged_micros=0 AND t.supplier_cost_status='not_asserted' AND t.supplier_cost_micros IS NULL
          AND e.event_type='platform_text_no_fetch_closed' AND e.event_version=1
          AND e.payload=t.decision AND e.payload_sha256=t.decision_sha256
          AND e.created_at=t.closed_at AND e.writer_xid=t.writer_xid
          -- JSON timestamp strings depend on the writer session TimeZone.
          -- Compare timestamps by value across the closer/auth sessions.
          AND (to_jsonb(l)-'created_at'-'budget_accounted_at')
            @> (t.expected_log-'created_at'-'budget_accounted_at')
          AND l.created_at=(t.expected_log->>'created_at')::timestamptz
          AND l.budget_accounted_at=(t.expected_log->>'budget_accounted_at')::timestamptz))
  THEN RETURN 'period_reset_pending'; END IF;
  IF u.budget_epoch>=9007199254740991 THEN RAISE EXCEPTION 'personal budget epoch exhausted' USING ERRCODE='23514'; END IF;
  next_at:=cinatoken_personal_auth.next_period_v395(u.budget_reset_at,u.budget_period,clock_timestamp());
  before_snapshot:=jsonb_build_object('id',u.id,'email',u.email,'budget_max',u.budget_max,'budget_base',u.budget_base,
    'budget_spent',u.budget_spent,'budget_period',u.budget_period,'budget_reset_at',u.budget_reset_at,
    'budget_epoch',u.budget_epoch,'budget_reserved_micros',u.budget_reserved_micros,'status',u.status,
    'metadata',u.metadata,'charged_cost_factors',u.charged_cost_factors,'external_system',u.external_system,'external_user_id',u.external_user_id);
  after_snapshot:=before_snapshot||jsonb_build_object('budget_max',u.budget_base,'budget_spent',0,
    'budget_reset_at',next_at,'budget_epoch',u.budget_epoch+1);
  fields:=ARRAY[]::text[];
  IF u.budget_max IS DISTINCT FROM u.budget_base THEN fields:=array_append(fields,'budget_max'); END IF;
  IF u.budget_spent<>0 THEN fields:=array_append(fields,'budget_spent'); END IF;
  fields:=fields||ARRAY['budget_reset_at','budget_epoch'];
  UPDATE cinatoken_gateway.users SET budget_max=u.budget_base,budget_spent=0,
    budget_reset_at=next_at,budget_epoch=u.budget_epoch+1,updated_at=clock_timestamp()
    WHERE id=u.id AND budget_epoch=u.budget_epoch AND budget_reserved_micros=0;
  IF NOT FOUND THEN RAISE EXCEPTION 'personal period state changed' USING ERRCODE='23514'; END IF;
  INSERT INTO cinatoken_gateway.user_audit_logs(id,user_id,api_key_id,event_type,actor_type,
    before_user_snapshot,after_user_snapshot,changed_fields,change_payload,correlation_id,source,reason_code,reason_text,created_at)
    VALUES(gen_random_uuid()::text,u.id,p_key_id,'period_reset','system',before_snapshot::text,after_snapshot::text,to_jsonb(fields)::text,
      jsonb_build_object('beforeBudgetBase',u.budget_base,'afterBudgetBase',u.budget_base,'beforeBudgetPeriod',u.budget_period,
        'afterBudgetPeriod',u.budget_period,'beforeBudgetResetAt',u.budget_reset_at,'afterBudgetResetAt',next_at)::text,
      gen_random_uuid()::text,'gateway_auth_v395','api_key_auth_lazy_reset','Period reset (auth)',clock_timestamp());
  RETURN 'reset';
END;
$reset$;

CREATE FUNCTION cinatoken_gateway.authenticate_personal_gateway_key_v395(p_bearer text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp SET lock_timeout TO '2s' SET statement_timeout TO '15s' SET TimeZone TO 'UTC' AS $auth$
DECLARE k cinatoken_gateway.api_keys%ROWTYPE; u cinatoken_gateway.users%ROWTYPE; w cinatoken_gateway.workspaces%ROWTYPE;
DECLARE lookup_hash text; reset_status text; server_now timestamptz; modern boolean;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_personal_key_auth' OR current_setting('transaction_isolation')<>'read committed'
    OR p_bearer IS NULL OR octet_length(p_bearer) NOT BETWEEN 16 AND 512
  THEN RAISE EXCEPTION 'invalid personal auth call' USING ERRCODE='23514'; END IF;
  IF left(p_bearer,3)<>'sk-' OR left(p_bearer,13)='sk-cina-mgmt-' OR p_bearer !~ '^[!-~]+$'
  THEN RETURN jsonb_build_object('status','unauthorized'); END IF;
  lookup_hash:='sha256:'||encode(sha256(convert_to(p_bearer,'UTF8')),'hex');
  SELECT * INTO k FROM cinatoken_gateway.api_keys
    WHERE key_hash=lookup_hash AND key='hashref:'||lookup_hash FOR UPDATE;
  modern:=FOUND;
  IF NOT modern THEN SELECT * INTO k FROM cinatoken_gateway.api_keys WHERE key=p_bearer FOR UPDATE; END IF;
  IF k.id IS NULL OR k.status<>'active' THEN RETURN jsonb_build_object('status','unauthorized'); END IF;
  SELECT * INTO u FROM cinatoken_gateway.users WHERE id=k.user_id FOR UPDATE;
  IF NOT FOUND OR u.status<>'active' THEN RETURN jsonb_build_object('status','unauthorized'); END IF;
  SELECT * INTO w FROM cinatoken_gateway.workspaces WHERE id=k.workspace_id FOR SHARE;
  server_now:=clock_timestamp();
  IF NOT FOUND OR w.status<>'active' OR w.scope_type<>'personal' OR w.personal_owner_user_id IS DISTINCT FROM u.id
    OR w.organization_id IS NOT NULL OR (k.expires_at IS NOT NULL AND k.expires_at<=server_now)
  THEN RETURN jsonb_build_object('status','unauthorized'); END IF;
  IF u.budget_period NOT IN ('none','daily','weekly','monthly')
    OR u.budget_spent<0 OR u.budget_base<0 OR u.budget_max<0
    OR u.budget_spent*1000000>9007199254740991 OR u.budget_base*1000000>9007199254740991 OR u.budget_max*1000000>9007199254740991
    OR octet_length(COALESCE(u.metadata,''))>65536 OR octet_length(COALESCE(k.metadata,''))>65536
    OR octet_length(COALESCE(u.charged_cost_factors,''))>16384 OR octet_length(u.email)>512
  THEN RAISE EXCEPTION 'personal auth source outside bounded contract' USING ERRCODE='23514'; END IF;
  reset_status:=cinatoken_personal_auth.reset_due_period_v395(u.id,k.id,w.id);
  IF reset_status='period_reset_pending' THEN RETURN jsonb_build_object('status','period_reset_pending'); END IF;
  -- The key expiry can pass while the period helper waits for a ledger lock.
  IF k.expires_at IS NOT NULL AND k.expires_at<=clock_timestamp()
  THEN RAISE EXCEPTION 'personal auth expired during owned operation' USING ERRCODE='23514'; END IF;
  IF NOT modern THEN
    UPDATE cinatoken_gateway.api_keys SET key='hashref:'||lookup_hash,key_hash=lookup_hash,
      key_preview=left(p_bearer,8)||'…'||right(p_bearer,4)
      WHERE id=k.id AND key=p_bearer;
    IF NOT FOUND THEN RAISE EXCEPTION 'personal legacy key changed' USING ERRCODE='23514'; END IF;
  END IF;
  SELECT * INTO u FROM cinatoken_gateway.users WHERE id=u.id;
  RETURN jsonb_build_object('status','authenticated','keyId',k.id,'keyLimitEpoch',k.limit_epoch,
    'userId',u.id,'workspaceId',w.id,'userEmail',u.email,'budgetMax',u.budget_max,'budgetSpent',u.budget_spent,
    'budgetEpoch',u.budget_epoch,'budgetPeriod',u.budget_period,
    'budgetResetAt',CASE WHEN u.budget_reset_at IS NULL THEN NULL ELSE to_char(u.budget_reset_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'includeByokInLimit',k.include_byok_in_limit,'userMetadata',u.metadata,'keyMetadata',k.metadata,'chargedCostFactors',u.charged_cost_factors);
END;
$auth$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cinatoken_personal_auth FROM PUBLIC,cinatoken_gateway_runtime,cinatoken_gateway_personal_key_auth;
REVOKE ALL ON FUNCTION cinatoken_gateway.authenticate_personal_gateway_key_v395(text) FROM PUBLIC,cinatoken_gateway_runtime,cinatoken_gateway_personal_key_auth;
GRANT USAGE ON SCHEMA cinatoken_gateway TO cinatoken_gateway_personal_key_auth;
GRANT EXECUTE ON FUNCTION cinatoken_gateway.authenticate_personal_gateway_key_v395(text) TO cinatoken_gateway_personal_key_auth;
