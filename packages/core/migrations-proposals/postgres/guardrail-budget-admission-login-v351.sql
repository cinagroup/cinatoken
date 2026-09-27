-- REVIEW ONLY. PG73 + buyer split v349 + ordinary admission v350 prerequisite.
-- Direct budget-admission LOGIN gets only EXECUTE, never table write grants.
-- Install in one direct-migrator transaction with
--   SET LOCAL cinatoken.guardrail_budget_admission_v351_activation='reviewed-v1'.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.guardrail_budget_windows,
  cinatoken_gateway.guardrail_budget_reservations
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; admission_oid oid; runtime_oid oid; buyer_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO admission_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_budget_admission';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_buyer_settlement';
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting('cinatoken.guardrail_budget_admission_v351_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR admission_oid IS NULL OR runtime_oid IS NULL OR buyer_oid IS NULL
    OR (SELECT count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n' ORDER BY version COLLATE "C"))
        FROM cinatoken_gateway.schema_migrations)<>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR pg_catalog.to_regprocedure('cinatoken_gateway.buyer_split_guardrail_grant_policy_v349()') IS NULL
    OR pg_catalog.to_regprocedure('cinatoken_gateway.reserve_user_budget_v350(text,text,text,bigint,bigint,timestamptz,timestamptz)') IS NULL
    OR pg_catalog.to_regprocedure('cinatoken_economic_outbox.verified_guardrail_pre_send_denial(text,text,text)') IS NULL
    OR pg_catalog.to_regprocedure('cinatoken_gateway.reserve_guardrail_budgets_v351(text,text,text,jsonb,bigint,text,timestamptz,timestamptz)') IS NOT NULL
    OR pg_catalog.to_regprocedure('cinatoken_gateway.mark_guardrail_budgets_dispatched_v351(text,timestamptz,timestamptz)') IS NOT NULL
    OR pg_catalog.to_regprocedure('cinatoken_gateway.release_guardrail_budgets_v351(text,timestamptz,text)') IS NOT NULL
    OR (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb
          AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit
        FROM pg_catalog.pg_roles WHERE oid=admission_oid) IS DISTINCT FROM true
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid=admission_oid OR member=admission_oid)
    OR (SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname='cinatoken_gateway')
      IS DISTINCT FROM migrator_oid
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN ('cinatoken_gateway.guardrail_budget_windows'::pg_catalog.regclass,
                      'cinatoken_gateway.guardrail_budget_reservations'::pg_catalog.regclass)
        AND (c.relowner<>migrator_oid OR c.relkind<>'r' OR c.relrowsecurity OR c.relforcerowsecurity))
    OR pg_catalog.has_table_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_windows','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_windows','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_reservations','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_reservations','INSERT,UPDATE')
    OR NOT pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.guardrail_budget_windows','UPDATE')
  THEN RAISE EXCEPTION 'Guardrail admission v351 activation or dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

-- The legacy runtime grant still carries raw Guardrail DML after v349. Remove
-- it in this same transaction before exposing the function-only admission API.
REVOKE INSERT,UPDATE,DELETE ON TABLE
  cinatoken_gateway.guardrail_budget_windows,
  cinatoken_gateway.guardrail_budget_reservations
  FROM cinatoken_gateway_runtime;

CREATE FUNCTION cinatoken_gateway.reserve_guardrail_budgets_v351(
  p_request_id text,p_user_id text,p_api_key_id text,p_intents jsonb,
  p_reserved_micros bigint,p_settlement_basis text,
  p_now timestamptz,p_expires_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $reserve$
DECLARE key_row record; workspace_row record; intent record; source_row record;
DECLARE window_row record; existing_row record;
DECLARE expected_start timestamptz; expected_end timestamptz;
DECLARE expected_count integer; supplied_configured integer:=0;
DECLARE supplied_workspace integer:=0; supplied_key integer:=0;
DECLARE seen_assignments text[]:=ARRAY[]::text[]; seen_windows text[]:=ARRAY[]::text[];
DECLARE window_key text; active_micros bigint; computed_unreserved_micros bigint;
DECLARE checked_windows jsonb:='{}'::jsonb;
DECLARE basis text; n integer;
DECLARE server_now timestamptz:=pg_catalog.clock_timestamp();
BEGIN
  n:=CASE WHEN pg_catalog.jsonb_typeof(p_intents)='array'
    THEN pg_catalog.jsonb_array_length(p_intents) ELSE 0 END;
  basis:=COALESCE(p_settlement_basis,'charged');
  IF SESSION_USER<>'cinatoken_gateway_budget_admission'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_request_id IS NULL OR pg_catalog.length(p_request_id) NOT BETWEEN 1 AND 128
    OR p_user_id IS NULL OR pg_catalog.length(p_user_id) NOT BETWEEN 1 AND 512
    OR p_api_key_id IS NULL OR pg_catalog.length(p_api_key_id) NOT BETWEEN 1 AND 512
    OR n NOT BETWEEN 1 AND 7 OR p_reserved_micros IS NULL
    OR p_reserved_micros NOT BETWEEN 1 AND 9007199254740991
    OR basis NOT IN ('charged','gateway_key_route')
    OR (basis='gateway_key_route' AND n<>1)
    OR p_now IS NULL OR p_now<server_now-INTERVAL '5 minutes'
    OR p_now>server_now+INTERVAL '30 seconds'
    OR p_expires_at IS NULL OR p_expires_at<=p_now OR p_expires_at<=server_now
    OR p_expires_at>p_now+INTERVAL '2 minutes'
  THEN RAISE EXCEPTION 'invalid Guardrail admission call'
    USING ERRCODE='23514',CONSTRAINT='guardrail_admission_call_v351'; END IF;
  -- Same request lock used by the private v348 denial receipt/late-insert guard.
  PERFORM pg_catalog.pg_advisory_xact_lock(348,pg_catalog.hashtext(p_request_id));
  SELECT * INTO key_row FROM cinatoken_gateway.api_keys k
    WHERE k.id=p_api_key_id AND k.user_id=p_user_id AND k.status='active'
      AND (k.expires_at IS NULL OR k.expires_at>server_now) FOR SHARE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;
  SELECT * INTO workspace_row FROM cinatoken_gateway.workspaces w
    WHERE w.id=key_row.workspace_id AND w.status='active' FOR SHARE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;

  FOR intent IN SELECT * FROM pg_catalog.jsonb_to_recordset(p_intents) AS x(
      "workspaceId" text,"assignmentId" text,"guardrailId" text,
      "guardrailVersion" integer,"scopeType" text,"scopeId" text,
      period text,"periodStart" timestamptz,"periodEnd" timestamptz,
      "limitMicros" bigint)
    ORDER BY "workspaceId","scopeType","scopeId",period,"periodStart","assignmentId"
  LOOP
    IF intent."workspaceId" IS DISTINCT FROM key_row.workspace_id
      OR intent."assignmentId" IS NULL OR pg_catalog.length(intent."assignmentId") NOT BETWEEN 1 AND 512
      OR intent."guardrailId" IS NULL OR pg_catalog.length(intent."guardrailId") NOT BETWEEN 1 AND 512
      OR intent."guardrailVersion" IS NULL OR intent."guardrailVersion"<1
      OR intent."scopeType" NOT IN ('user','api_key','workspace')
      OR intent."scopeId" IS NULL OR intent."periodStart" IS NULL
      OR intent."periodEnd" IS NULL OR intent."limitMicros" IS NULL
      OR intent."limitMicros" NOT BETWEEN 0 AND 9007199254740991
      OR intent.period NOT IN ('daily','weekly','monthly','lifetime')
      OR intent."assignmentId"=ANY(seen_assignments)
    THEN RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;
    window_key:=pg_catalog.concat_ws(E'\x1f',intent."workspaceId",intent."scopeType",
      intent."scopeId",intent.period,intent."periodStart"::text);
    IF window_key=ANY(seen_windows) THEN
      RETURN pg_catalog.jsonb_build_object('status','conflict');
    END IF;
    seen_assignments:=pg_catalog.array_append(seen_assignments,intent."assignmentId");
    seen_windows:=pg_catalog.array_append(seen_windows,window_key);

    IF intent."assignmentId"='gateway-key-limit:'||p_api_key_id THEN
      supplied_key:=supplied_key+1;
      IF intent."scopeType"<>'api_key' OR intent."scopeId"<>p_api_key_id
        OR intent."guardrailId"<>intent."assignmentId"
        OR key_row.limit_micros IS NULL
        OR intent."limitMicros"<>key_row.limit_micros
        OR intent."guardrailVersion"<>key_row.limit_epoch+1
        OR intent.period<>COALESCE(key_row.limit_reset,'lifetime')
        OR (basis='gateway_key_route' AND NOT key_row.include_byok_in_limit)
      THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
      expected_start:=key_row.created_at;
    ELSIF pg_catalog.left(intent."assignmentId",17)='workspace-budget:' THEN
      supplied_workspace:=supplied_workspace+1;
      SELECT * INTO source_row FROM cinatoken_gateway.workspace_budgets b
        WHERE b.id=pg_catalog.substr(intent."assignmentId",18) FOR SHARE;
      IF NOT FOUND OR intent."scopeType"<>'workspace'
        OR intent."scopeId"<>key_row.workspace_id
        OR intent."guardrailId"<>intent."assignmentId"
        OR source_row.workspace_id<>key_row.workspace_id
        OR source_row.limit_micros<>intent."limitMicros"
        OR source_row.config_epoch+1<>intent."guardrailVersion"
        OR source_row.reset_interval<>intent.period
      THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
      expected_start:=workspace_row.created_at;
    ELSE
      supplied_configured:=supplied_configured+1;
      IF basis='gateway_key_route' OR intent.period='lifetime'
        OR intent."scopeType"='workspace'
        OR (intent."scopeType"='user' AND intent."scopeId"<>p_user_id)
        OR (intent."scopeType"='api_key' AND intent."scopeId"<>p_api_key_id)
      THEN RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;
      SELECT g.id,g.designated_version,g.is_workspace_default,
        g.is_account_default,v.config_json::jsonb AS config
        INTO source_row FROM cinatoken_gateway.guardrails g
        JOIN cinatoken_gateway.guardrail_versions v
          ON v.guardrail_id=g.id AND v.version=g.designated_version
        WHERE g.id=intent."guardrailId" AND g.workspace_id=key_row.workspace_id
          AND g.status='active' FOR SHARE OF g,v;
      IF NOT FOUND OR source_row.is_account_default
        OR source_row.designated_version<>intent."guardrailVersion"
        OR source_row.config->'budget' IS NULL
        OR source_row.config->'budget'='null'::jsonb
        OR source_row.config->'budget'->>'period'<>intent.period
        OR pg_catalog.round((source_row.config->'budget'->>'limit')::numeric*1000000)::bigint
          <>intent."limitMicros"
      THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
      IF source_row.is_workspace_default THEN
        IF (intent."scopeType"='user' AND intent."assignmentId"
              IS DISTINCT FROM 'workspace-default:'||source_row.id||':user')
          OR (intent."scopeType"='api_key' AND intent."assignmentId"
              IS DISTINCT FROM 'workspace-default:'||source_row.id||':api-key')
        THEN RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;
      ELSIF NOT EXISTS (SELECT 1 FROM cinatoken_gateway.guardrail_assignments a
          WHERE a.id=intent."assignmentId" AND a.guardrail_id=source_row.id
            AND a.workspace_id=key_row.workspace_id
            AND a.scope_type=intent."scopeType" AND a.scope_id=intent."scopeId")
      THEN RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;
      expected_start:=NULL;
    END IF;
    IF intent.period='lifetime' THEN
      expected_end:='9999-12-31T23:59:59.999Z'::timestamptz;
    ELSE
      expected_start:=CASE intent.period
        WHEN 'daily' THEN pg_catalog.date_trunc('day',server_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        WHEN 'weekly' THEN pg_catalog.date_trunc('week',server_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        ELSE pg_catalog.date_trunc('month',server_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' END;
      expected_end:=CASE intent.period
        WHEN 'daily' THEN expected_start+INTERVAL '1 day'
        WHEN 'weekly' THEN expected_start+INTERVAL '7 days'
        ELSE expected_start+INTERVAL '1 month' END;
    END IF;
    IF intent."periodStart" IS DISTINCT FROM expected_start
      OR intent."periodEnd" IS DISTINCT FROM expected_end
      OR NOT (p_now>=intent."periodStart" AND p_now<intent."periodEnd")
    THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  END LOOP;
  IF basis='gateway_key_route' THEN
    IF supplied_key<>1 THEN RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;
  ELSE
    SELECT count(*) INTO expected_count FROM cinatoken_gateway.workspace_budgets
      WHERE workspace_id=key_row.workspace_id;
    IF supplied_workspace<>expected_count
      OR (key_row.limit_micros IS NULL AND supplied_key<>0)
      OR (key_row.limit_micros IS NOT NULL AND supplied_key<>1)
    THEN RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;
    SELECT COALESCE(sum(CASE WHEN g.is_workspace_default THEN 2 ELSE 1 END),0)::integer
      INTO expected_count
      FROM cinatoken_gateway.guardrails g
      JOIN cinatoken_gateway.guardrail_versions v
        ON v.guardrail_id=g.id AND v.version=g.designated_version
      LEFT JOIN cinatoken_gateway.guardrail_assignments a
        ON NOT g.is_workspace_default AND a.guardrail_id=g.id
        AND a.workspace_id=key_row.workspace_id
        AND ((a.scope_type='user' AND a.scope_id=p_user_id)
          OR (a.scope_type='api_key' AND a.scope_id=p_api_key_id))
      WHERE g.workspace_id=key_row.workspace_id AND g.status='active'
        AND NOT g.is_account_default AND (g.is_workspace_default OR a.id IS NOT NULL)
        AND v.config_json::jsonb->'budget' IS NOT NULL
        AND v.config_json::jsonb->'budget'<>'null'::jsonb;
    IF supplied_configured<>expected_count THEN
      RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;
  END IF;

  SELECT count(*) INTO expected_count FROM cinatoken_gateway.guardrail_budget_reservations
    WHERE request_id=p_request_id;
  IF expected_count>0 THEN
    IF expected_count<>n THEN RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;
    FOR intent IN SELECT * FROM pg_catalog.jsonb_to_recordset(p_intents) AS x(
      "workspaceId" text,"assignmentId" text,"guardrailId" text,
      "guardrailVersion" integer,"scopeType" text,"scopeId" text,
      period text,"periodStart" timestamptz,"periodEnd" timestamptz,
      "limitMicros" bigint)
    LOOP
      SELECT * INTO existing_row FROM cinatoken_gateway.guardrail_budget_reservations r
        WHERE r.request_id=p_request_id AND r.assignment_id=intent."assignmentId" FOR UPDATE;
      IF NOT FOUND OR existing_row.state NOT IN ('reserved','dispatched')
        OR existing_row.workspace_id<>intent."workspaceId"
        OR existing_row.guardrail_id<>intent."guardrailId"
        OR existing_row.guardrail_version<>intent."guardrailVersion"
        OR existing_row.scope_type<>intent."scopeType" OR existing_row.scope_id<>intent."scopeId"
        OR existing_row.period<>intent.period
        OR existing_row.period_start<>intent."periodStart"
        OR existing_row.period_end<>intent."periodEnd"
        OR existing_row.limit_micros<>intent."limitMicros"
        OR existing_row.reserved_micros<>p_reserved_micros
        OR existing_row.settlement_basis<>basis
      THEN RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;
    END LOOP;
    RETURN pg_catalog.jsonb_build_object('status','idempotent','reservationCount',n);
  END IF;

  FOR intent IN SELECT * FROM pg_catalog.jsonb_to_recordset(p_intents) AS x(
      "workspaceId" text,"assignmentId" text,"guardrailId" text,
      "guardrailVersion" integer,"scopeType" text,"scopeId" text,
      period text,"periodStart" timestamptz,"periodEnd" timestamptz,
      "limitMicros" bigint)
    ORDER BY "workspaceId","scopeType","scopeId",period,"periodStart","assignmentId"
  LOOP
    INSERT INTO cinatoken_gateway.guardrail_budget_windows
      (workspace_id,scope_type,scope_id,period,period_start,period_end,
       unreserved_micros,settled_micros,reserved_micros,seeded_at,updated_at)
      VALUES(intent."workspaceId",intent."scopeType",intent."scopeId",intent.period,
        intent."periodStart",intent."periodEnd",0,0,0,p_now,p_now)
      ON CONFLICT (workspace_id,scope_type,scope_id,period,period_start) DO NOTHING;
    SELECT * INTO window_row FROM cinatoken_gateway.guardrail_budget_windows w
      WHERE w.workspace_id=intent."workspaceId" AND w.scope_type=intent."scopeType"
        AND w.scope_id=intent."scopeId" AND w.period=intent.period
        AND w.period_start=intent."periodStart" FOR UPDATE;
    IF NOT FOUND OR window_row.period_end<>intent."periodEnd" THEN
      RAISE EXCEPTION 'Guardrail window period differs'
        USING ERRCODE='23514',CONSTRAINT='guardrail_admission_window_v351'; END IF;
    SELECT COALESCE(sum(r.reserved_micros),0)::bigint INTO active_micros
      FROM cinatoken_gateway.guardrail_budget_reservations r
      WHERE r.workspace_id=intent."workspaceId" AND r.scope_type=intent."scopeType"
        AND r.scope_id=intent."scopeId" AND r.period=intent.period
        AND r.period_start=intent."periodStart" AND r.state IN ('reserved','dispatched');
    IF active_micros<>window_row.reserved_micros THEN
      RAISE EXCEPTION 'Guardrail window hold lacks matching reservations'
        USING ERRCODE='23514',CONSTRAINT='guardrail_admission_counter_v351'; END IF;
    SELECT COALESCE(sum(COALESCE(l.budget_charged_micros,
        pg_catalog.round(GREATEST(l.charged_cost,0)*1000000)::bigint)),0)::bigint
      INTO computed_unreserved_micros FROM cinatoken_gateway.api_key_request_logs l
      WHERE l.workspace_id=intent."workspaceId"
        AND (intent."scopeType"='workspace'
          OR (intent."scopeType"='user' AND l.user_id=intent."scopeId")
          OR (intent."scopeType"='api_key' AND l.api_key_id=intent."scopeId"))
        AND COALESCE(l.budget_accounted_at,l.created_at)>=intent."periodStart"
        AND COALESCE(l.budget_accounted_at,l.created_at)<intent."periodEnd"
        AND NOT EXISTS (SELECT 1 FROM cinatoken_gateway.guardrail_budget_reservations r
          WHERE r.request_id=l.id AND r.workspace_id=intent."workspaceId"
            AND r.scope_type=intent."scopeType" AND r.scope_id=intent."scopeId"
            AND r.period=intent.period AND r.period_start=intent."periodStart"
            AND r.state IN ('reserved','dispatched','settled','expired'));
    IF computed_unreserved_micros+window_row.settled_micros+window_row.reserved_micros
      +p_reserved_micros>intent."limitMicros" THEN
      RETURN pg_catalog.jsonb_build_object('status','blocked',
        'assignmentId',intent."assignmentId");
    END IF;
    window_key:=pg_catalog.concat_ws(E'\x1f',intent."workspaceId",intent."scopeType",
      intent."scopeId",intent.period,intent."periodStart"::text);
    checked_windows:=checked_windows||pg_catalog.jsonb_build_object(
      window_key,computed_unreserved_micros);
  END LOOP;
  -- Every capacity check has completed while all window row locks remain held.
  FOR intent IN SELECT * FROM pg_catalog.jsonb_to_recordset(p_intents) AS x(
      "workspaceId" text,"assignmentId" text,"guardrailId" text,
      "guardrailVersion" integer,"scopeType" text,"scopeId" text,
      period text,"periodStart" timestamptz,"periodEnd" timestamptz,
      "limitMicros" bigint)
    ORDER BY "workspaceId","scopeType","scopeId",period,"periodStart","assignmentId"
  LOOP
    window_key:=pg_catalog.concat_ws(E'\x1f',intent."workspaceId",intent."scopeType",
      intent."scopeId",intent.period,intent."periodStart"::text);
    UPDATE cinatoken_gateway.guardrail_budget_windows w SET
      unreserved_micros=(checked_windows->>window_key)::bigint,
      reserved_micros=w.reserved_micros+p_reserved_micros,
      updated_at=p_now
      WHERE w.workspace_id=intent."workspaceId" AND w.scope_type=intent."scopeType"
        AND w.scope_id=intent."scopeId" AND w.period=intent.period
        AND w.period_start=intent."periodStart";
  END LOOP;
  FOR intent IN SELECT * FROM pg_catalog.jsonb_to_recordset(p_intents) AS x(
      "workspaceId" text,"assignmentId" text,"guardrailId" text,
      "guardrailVersion" integer,"scopeType" text,"scopeId" text,
      period text,"periodStart" timestamptz,"periodEnd" timestamptz,
      "limitMicros" bigint)
  LOOP
    INSERT INTO cinatoken_gateway.guardrail_budget_reservations
      (id,workspace_id,request_id,assignment_id,guardrail_id,guardrail_version,
       scope_type,scope_id,period,period_start,period_end,limit_micros,
       reserved_micros,settled_micros,settlement_basis,state,expires_at,created_at,updated_at)
      VALUES(pg_catalog.gen_random_uuid()::text,intent."workspaceId",p_request_id,
        intent."assignmentId",intent."guardrailId",intent."guardrailVersion",
        intent."scopeType",intent."scopeId",intent.period,intent."periodStart",
        intent."periodEnd",intent."limitMicros",p_reserved_micros,0,basis,
        'reserved',p_expires_at,p_now,p_now);
  END LOOP;
  RETURN pg_catalog.jsonb_build_object('status','reserved','reservationCount',n);
END;
$reserve$;

CREATE FUNCTION cinatoken_gateway.mark_guardrail_budgets_dispatched_v351(
  p_request_id text,p_now timestamptz,p_expires_at timestamptz)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $mark$
DECLARE reservation record; window_row record; active_micros bigint; n integer:=0;
DECLARE server_now timestamptz:=pg_catalog.clock_timestamp();
DECLARE earliest_expires_at timestamptz;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_budget_admission'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_request_id IS NULL OR pg_catalog.length(p_request_id) NOT BETWEEN 1 AND 128
    OR p_now IS NULL OR p_now<server_now-INTERVAL '5 minutes'
    OR p_now>server_now+INTERVAL '30 seconds'
    OR p_expires_at IS NULL OR p_expires_at<=p_now OR p_expires_at<=server_now
    OR p_expires_at>p_now+INTERVAL '15 minutes'
  THEN RAISE EXCEPTION 'invalid Guardrail dispatch call'
    USING ERRCODE='23514',CONSTRAINT='guardrail_admission_call_v351'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(348,pg_catalog.hashtext(p_request_id));
  FOR reservation IN SELECT * FROM cinatoken_gateway.guardrail_budget_reservations
    WHERE request_id=p_request_id
    ORDER BY workspace_id,scope_type,scope_id,period,period_start,id FOR UPDATE
  LOOP
    n:=n+1;
    IF reservation.state NOT IN ('reserved','dispatched') THEN RETURN false; END IF;
    -- A replay must not claim a longer lease than the already dispatched hold.
    IF reservation.state='dispatched' AND reservation.expires_at<p_expires_at
    THEN RETURN false; END IF;
    earliest_expires_at:=LEAST(earliest_expires_at,reservation.expires_at);
    SELECT * INTO window_row FROM cinatoken_gateway.guardrail_budget_windows
      WHERE workspace_id=reservation.workspace_id AND scope_type=reservation.scope_type
        AND scope_id=reservation.scope_id AND period=reservation.period
        AND period_start=reservation.period_start FOR UPDATE;
    SELECT COALESCE(sum(reserved_micros),0)::bigint INTO active_micros
      FROM cinatoken_gateway.guardrail_budget_reservations
      WHERE workspace_id=reservation.workspace_id AND scope_type=reservation.scope_type
        AND scope_id=reservation.scope_id AND period=reservation.period
        AND period_start=reservation.period_start AND state IN ('reserved','dispatched');
    IF window_row.workspace_id IS NULL OR active_micros<>window_row.reserved_micros THEN
      RAISE EXCEPTION 'Guardrail dispatch window hold differs'
        USING ERRCODE='23514',CONSTRAINT='guardrail_admission_counter_v351'; END IF;
  END LOOP;
  IF n=0 THEN RETURN false; END IF;
  -- The advisory, reservation, and window locks above can all wait. Check
  -- physical database time only after the complete set is locked so a lease
  -- that expired during any wait cannot authorize a dispatch transition.
  server_now:=pg_catalog.clock_timestamp();
  IF p_now<server_now-INTERVAL '5 minutes'
    OR p_expires_at<=server_now OR earliest_expires_at<=server_now
  THEN RETURN false; END IF;
  UPDATE cinatoken_gateway.guardrail_budget_reservations
    SET state='dispatched',dispatched_at=p_now,expires_at=p_expires_at,updated_at=p_now
    WHERE request_id=p_request_id AND state='reserved';
  RETURN true;
END;
$mark$;

CREATE FUNCTION cinatoken_gateway.release_guardrail_budgets_v351(
  p_request_id text,p_now timestamptz,p_reason text)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $release$
DECLARE reservation record; window_row record; active_micros bigint; n integer:=0;
DECLARE server_now timestamptz:=pg_catalog.clock_timestamp();
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_budget_admission'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_request_id IS NULL OR pg_catalog.length(p_request_id) NOT BETWEEN 1 AND 128
    OR p_reason IS NULL OR pg_catalog.length(p_reason) NOT BETWEEN 1 AND 128
    OR p_reason='guardrail_budget_admission_rejected'
    OR p_now IS NULL OR p_now<server_now-INTERVAL '5 minutes'
    OR p_now>server_now+INTERVAL '30 seconds'
  THEN RAISE EXCEPTION 'invalid Guardrail release call'
    USING ERRCODE='23514',CONSTRAINT='guardrail_admission_call_v351'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(348,pg_catalog.hashtext(p_request_id));
  FOR reservation IN SELECT * FROM cinatoken_gateway.guardrail_budget_reservations
    WHERE request_id=p_request_id
    ORDER BY workspace_id,scope_type,scope_id,period,period_start,id FOR UPDATE
  LOOP
    IF reservation.state='released' THEN CONTINUE; END IF;
    IF reservation.state<>'reserved' OR reservation.dispatched_at IS NOT NULL
    THEN RETURN 0; END IF;
    SELECT * INTO window_row FROM cinatoken_gateway.guardrail_budget_windows
      WHERE workspace_id=reservation.workspace_id AND scope_type=reservation.scope_type
        AND scope_id=reservation.scope_id AND period=reservation.period
        AND period_start=reservation.period_start FOR UPDATE;
    SELECT COALESCE(sum(reserved_micros),0)::bigint INTO active_micros
      FROM cinatoken_gateway.guardrail_budget_reservations
      WHERE workspace_id=reservation.workspace_id AND scope_type=reservation.scope_type
        AND scope_id=reservation.scope_id AND period=reservation.period
        AND period_start=reservation.period_start AND state IN ('reserved','dispatched');
    IF window_row.workspace_id IS NULL OR active_micros<>window_row.reserved_micros
      OR window_row.reserved_micros<reservation.reserved_micros THEN
      RAISE EXCEPTION 'Guardrail release window hold differs'
        USING ERRCODE='23514',CONSTRAINT='guardrail_admission_counter_v351'; END IF;
    UPDATE cinatoken_gateway.guardrail_budget_windows SET
      reserved_micros=reserved_micros-reservation.reserved_micros,updated_at=p_now
      WHERE workspace_id=reservation.workspace_id AND scope_type=reservation.scope_type
        AND scope_id=reservation.scope_id AND period=reservation.period
        AND period_start=reservation.period_start;
    n:=n+1;
  END LOOP;
  UPDATE cinatoken_gateway.guardrail_budget_reservations SET
    state='released',settled_micros=0,terminal_at=p_now,
    terminal_reason=p_reason,updated_at=p_now
    WHERE request_id=p_request_id AND state='reserved';
  RETURN n;
END;
$release$;

REVOKE ALL ON FUNCTION
  cinatoken_gateway.reserve_guardrail_budgets_v351(text,text,text,jsonb,bigint,text,timestamptz,timestamptz),
  cinatoken_gateway.mark_guardrail_budgets_dispatched_v351(text,timestamptz,timestamptz),
  cinatoken_gateway.release_guardrail_budgets_v351(text,timestamptz,text)
  FROM PUBLIC,cinatoken_gateway_runtime,cinatoken_gateway_buyer_settlement;
GRANT EXECUTE ON FUNCTION
  cinatoken_gateway.reserve_guardrail_budgets_v351(text,text,text,jsonb,bigint,text,timestamptz,timestamptz),
  cinatoken_gateway.mark_guardrail_budgets_dispatched_v351(text,timestamptz,timestamptz),
  cinatoken_gateway.release_guardrail_budgets_v351(text,timestamptz,text)
  TO cinatoken_gateway_budget_admission;

DO $postflight$
DECLARE admission_oid oid; runtime_oid oid; buyer_oid oid;
BEGIN
  SELECT oid INTO admission_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_budget_admission';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_buyer_settlement';
  IF NOT pg_catalog.has_function_privilege(admission_oid,
      'cinatoken_gateway.reserve_guardrail_budgets_v351(text,text,text,jsonb,bigint,text,timestamptz,timestamptz)','EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_gateway.reserve_guardrail_budgets_v351(text,text,text,jsonb,bigint,text,timestamptz,timestamptz)','EXECUTE')
    OR pg_catalog.has_function_privilege(buyer_oid,
      'cinatoken_gateway.reserve_guardrail_budgets_v351(text,text,text,jsonb,bigint,text,timestamptz,timestamptz)','EXECUTE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.guardrail_budget_windows','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(runtime_oid,
      'cinatoken_gateway.guardrail_budget_windows','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.guardrail_budget_reservations','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(runtime_oid,
      'cinatoken_gateway.guardrail_budget_reservations','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_windows','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_windows','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_reservations','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_reservations','INSERT,UPDATE')
  THEN RAISE EXCEPTION 'Guardrail admission v351 postflight differs'
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
