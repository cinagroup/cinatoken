-- REVIEW ONLY. PG73 plus reviewed buyer split v348/v349, v350, v351 and v353.
-- Install in a single direct-migrator transaction after SET LOCAL
--   cinatoken.guardrail_budget_extension_v355_activation='reviewed-v1'.
-- The budget-admission LOGIN receives EXECUTE only; no raw table write grant.
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
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO admission_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_budget_admission';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_buyer_settlement';
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting('cinatoken.guardrail_budget_extension_v355_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR admission_oid IS NULL OR runtime_oid IS NULL
    OR buyer_oid IS NULL
    OR (SELECT count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n' ORDER BY version COLLATE "C"))
        FROM cinatoken_gateway.schema_migrations)<>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR pg_catalog.to_regprocedure('cinatoken_gateway.reserve_guardrail_budgets_v351(text,text,text,jsonb,bigint,text,timestamptz,timestamptz)') IS NULL
    OR pg_catalog.to_regprocedure('cinatoken_gateway.forfeit_guardrail_budgets_v353(text,text)') IS NULL
    OR pg_catalog.to_regprocedure('cinatoken_gateway.expire_guardrail_budgets_v353(integer)') IS NULL
    OR pg_catalog.to_regprocedure('cinatoken_gateway.extend_guardrail_budgets_dispatched_v355(text,text,text,jsonb,bigint,timestamptz,timestamptz)') IS NOT NULL
    OR (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb
          AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit
        FROM pg_catalog.pg_roles WHERE oid=admission_oid) IS DISTINCT FROM true
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid=admission_oid OR member=admission_oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN ('cinatoken_gateway.guardrail_budget_windows'::pg_catalog.regclass,
                      'cinatoken_gateway.guardrail_budget_reservations'::pg_catalog.regclass)
        AND (c.relowner<>migrator_oid OR c.relkind<>'r'
          OR c.relrowsecurity OR c.relforcerowsecurity))
    OR pg_catalog.has_table_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_windows','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_windows','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_reservations','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_reservations','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.guardrail_budget_windows','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(runtime_oid,
      'cinatoken_gateway.guardrail_budget_windows','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.guardrail_budget_reservations','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(runtime_oid,
      'cinatoken_gateway.guardrail_budget_reservations','INSERT,UPDATE')
  THEN RAISE EXCEPTION 'Guardrail extension v355 activation or dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

-- A route-selective Key hold was already dispatched before private BYOK.
-- Add every currently configured paid-budget intent in one transaction before
-- the first shared/platform fallback. The original Key row, basis, amount and
-- dispatch mark remain intact. Only its lease may be extended on first success.
CREATE FUNCTION cinatoken_gateway.extend_guardrail_budgets_dispatched_v355(
  p_request_id text,p_user_id text,p_api_key_id text,p_intents jsonb,
  p_reserved_micros bigint,p_now timestamptz,p_expires_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $extend$
DECLARE key_row record; workspace_row record; intent record; source_row record;
DECLARE reservation record; route_row record; existing_row record; window_row record;
DECLARE expected_start timestamptz; expected_end timestamptz;
DECLARE expected_count integer; existing_count integer:=0; route_count integer:=0;
DECLARE supplied_configured integer:=0; supplied_workspace integer:=0;
DECLARE supplied_key integer:=0; charged_count integer:=0;
DECLARE seen_assignments text[]:=ARRAY[]::text[]; seen_windows text[]:=ARRAY[]::text[];
DECLARE window_key text; checked_windows jsonb:='{}'::jsonb;
DECLARE active_micros numeric; computed_unreserved_micros numeric;
DECLARE n integer; server_now timestamptz:=pg_catalog.clock_timestamp();
DECLARE extended_expiry timestamptz;
DECLARE earliest_existing_expiry timestamptz;
DECLARE blocked_assignment text;
DECLARE validated_utc_day date;
BEGIN
  n:=CASE WHEN pg_catalog.jsonb_typeof(p_intents)='array'
    THEN pg_catalog.jsonb_array_length(p_intents) ELSE 0 END;
  IF SESSION_USER<>'cinatoken_gateway_budget_admission'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_request_id IS NULL OR pg_catalog.length(p_request_id) NOT BETWEEN 1 AND 128
    OR p_user_id IS NULL OR pg_catalog.length(p_user_id) NOT BETWEEN 1 AND 512
    OR p_api_key_id IS NULL OR pg_catalog.length(p_api_key_id) NOT BETWEEN 1 AND 512
    OR n NOT BETWEEN 1 AND 7 OR p_reserved_micros IS NULL
    OR p_reserved_micros NOT BETWEEN 1 AND 9007199254740991
    OR p_now IS NULL
    OR p_expires_at IS NULL OR p_expires_at<=p_now
    OR p_expires_at>p_now+INTERVAL '15 minutes'
  THEN RAISE EXCEPTION 'invalid Guardrail extension call'
    USING ERRCODE='23514',CONSTRAINT='guardrail_extension_call_v355'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(348,pg_catalog.hashtext(p_request_id));
  -- The request lock can wait behind another owner. All lease checks must use
  -- a clock captured after that wait, never the pre-lock function entry time.
  server_now:=pg_catalog.clock_timestamp();
  IF p_now<server_now-INTERVAL '5 minutes'
    OR p_now>server_now+INTERVAL '30 seconds'
    OR p_expires_at<=server_now
  THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  SELECT * INTO key_row FROM cinatoken_gateway.api_keys k
    WHERE k.id=p_api_key_id AND k.user_id=p_user_id AND k.status='active'
      AND (k.expires_at IS NULL OR k.expires_at>server_now)
      AND k.include_byok_in_limit AND k.limit_micros IS NOT NULL FOR SHARE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;
  SELECT * INTO workspace_row FROM cinatoken_gateway.workspaces w
    WHERE w.id=key_row.workspace_id AND w.status='active' FOR SHARE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;

  -- NOWAIT avoids the buyer writer's row-before-advisory lock inversion. An
  -- unknown or busy outcome keeps all original holds and forbids paid send.
  FOR reservation IN SELECT * FROM cinatoken_gateway.guardrail_budget_reservations
    WHERE request_id=p_request_id
    ORDER BY workspace_id,scope_type,scope_id,period,period_start,id FOR UPDATE NOWAIT
  LOOP
    existing_count:=existing_count+1;
    earliest_existing_expiry:=CASE WHEN earliest_existing_expiry IS NULL
      THEN reservation.expires_at
      ELSE LEAST(earliest_existing_expiry,reservation.expires_at) END;
    IF reservation.expires_at<=server_now
    THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
    IF existing_count>7 OR reservation.state<>'dispatched'
      OR reservation.dispatched_at IS NULL
      OR reservation.settled_micros<>0 OR reservation.terminal_at IS NOT NULL
      OR reservation.terminal_reason IS NOT NULL
      OR reservation.workspace_id<>key_row.workspace_id
    THEN RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;
    IF reservation.settlement_basis='gateway_key_route' THEN
      route_count:=route_count+1;
      route_row:=reservation;
      IF reservation.assignment_id<>'gateway-key-limit:'||p_api_key_id
        OR reservation.guardrail_id<>reservation.assignment_id
        OR reservation.scope_type<>'api_key' OR reservation.scope_id<>p_api_key_id
        OR reservation.guardrail_version<>key_row.limit_epoch+1
        OR reservation.limit_micros<>key_row.limit_micros
        OR reservation.reserved_micros<p_reserved_micros
      THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
    ELSIF reservation.settlement_basis='charged' THEN
      charged_count:=charged_count+1;
      IF reservation.reserved_micros<>p_reserved_micros
      THEN RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;
    ELSE RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;
  END LOOP;
  IF route_count<>1 OR existing_count NOT IN (1,n)
    OR (existing_count=n AND charged_count<>n-1)
    OR (existing_count=1 AND charged_count<>0)
  THEN RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;
  server_now:=pg_catalog.clock_timestamp();
  IF p_now<server_now-INTERVAL '5 minutes'
    OR p_expires_at<=server_now OR route_row.expires_at<=server_now
    OR (key_row.expires_at IS NOT NULL AND key_row.expires_at<=server_now)
  THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  validated_utc_day:=(server_now AT TIME ZONE 'UTC')::date;

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
      OR intent."scopeType" IS NULL
      OR intent."scopeType" NOT IN ('user','api_key','workspace')
      OR intent."scopeId" IS NULL OR intent."periodStart" IS NULL
      OR intent."periodEnd" IS NULL OR intent."limitMicros" IS NULL
      OR intent."limitMicros" NOT BETWEEN 0 AND 9007199254740991
      OR intent.period IS NULL
      OR intent.period NOT IN ('daily','weekly','monthly','lifetime')
      OR intent."assignmentId"=ANY(seen_assignments)
    THEN RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;
    window_key:=pg_catalog.concat_ws(E'\x1f',intent."workspaceId",intent."scopeType",
      intent."scopeId",intent.period,intent."periodStart"::text);
    IF window_key=ANY(seen_windows) THEN
      RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;
    seen_assignments:=pg_catalog.array_append(seen_assignments,intent."assignmentId");
    seen_windows:=pg_catalog.array_append(seen_windows,window_key);

    IF intent."assignmentId"='gateway-key-limit:'||p_api_key_id THEN
      supplied_key:=supplied_key+1;
      IF intent."scopeType"<>'api_key' OR intent."scopeId"<>p_api_key_id
        OR intent."guardrailId"<>intent."assignmentId"
        OR intent."limitMicros"<>key_row.limit_micros
        OR intent."guardrailVersion"<>key_row.limit_epoch+1
        OR intent.period<>COALESCE(key_row.limit_reset,'lifetime')
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
      IF intent.period='lifetime' OR intent."scopeType"='workspace'
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

    SELECT * INTO existing_row FROM cinatoken_gateway.guardrail_budget_reservations r
      WHERE r.request_id=p_request_id AND r.assignment_id=intent."assignmentId";
    IF FOUND THEN
      IF existing_row.workspace_id<>intent."workspaceId"
        OR existing_row.guardrail_id<>intent."guardrailId"
        OR existing_row.guardrail_version<>intent."guardrailVersion"
        OR existing_row.scope_type<>intent."scopeType"
        OR existing_row.scope_id<>intent."scopeId"
        OR existing_row.period<>intent.period
        OR existing_row.period_start<>intent."periodStart"
        OR existing_row.period_end<>intent."periodEnd"
        OR existing_row.limit_micros<>intent."limitMicros"
        OR (existing_row.settlement_basis='gateway_key_route'
          AND existing_row.assignment_id<>route_row.assignment_id)
        OR (existing_row.settlement_basis='charged'
          AND existing_row.reserved_micros<>p_reserved_micros)
      THEN RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;
    ELSIF existing_count=n THEN
      RETURN pg_catalog.jsonb_build_object('status','conflict');
    END IF;
  END LOOP;

  IF supplied_key<>1 THEN RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;
  SELECT count(*) INTO expected_count FROM cinatoken_gateway.workspace_budgets
    WHERE workspace_id=key_row.workspace_id;
  IF supplied_workspace<>expected_count THEN
    RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;
  SELECT COALESCE(sum(CASE WHEN g.is_workspace_default THEN 2 ELSE 1 END),0)::integer
    INTO expected_count FROM cinatoken_gateway.guardrails g
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
  server_now:=pg_catalog.clock_timestamp();
  IF p_now<server_now-INTERVAL '5 minutes'
    OR p_expires_at<=server_now OR route_row.expires_at<=server_now
    OR (key_row.expires_at IS NOT NULL AND key_row.expires_at<=server_now)
    OR (server_now AT TIME ZONE 'UTC')::date<>validated_utc_day
  THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  IF existing_count=n THEN
    -- In the Key-only shape no charged row is inserted. A replay of a
    -- multi-intent extension also cannot promise a longer lease than the
    -- already committed rows. Never let either case authorize paid send
    -- beyond its shortest database-held lease.
    IF earliest_existing_expiry<p_expires_at THEN
      RETURN pg_catalog.jsonb_build_object('status','stale');
    END IF;
    RETURN pg_catalog.jsonb_build_object('status','idempotent',
      'reservationCount',n,'leaseExpiresAt',earliest_existing_expiry);
  END IF;

  -- The only new-write state is exactly one fully dispatched route Key row.
  -- Existing charged rows imply a partial/mixed state and were rejected above.
  extended_expiry:=GREATEST(route_row.expires_at,p_expires_at);
  -- An unavailable capacity check must not leave even a newly seeded empty
  -- window behind. The inner exception block rolls back its own SQL writes.
  BEGIN
  FOR intent IN SELECT * FROM pg_catalog.jsonb_to_recordset(p_intents) AS x(
      "workspaceId" text,"assignmentId" text,"guardrailId" text,
      "guardrailVersion" integer,"scopeType" text,"scopeId" text,
      period text,"periodStart" timestamptz,"periodEnd" timestamptz,
      "limitMicros" bigint)
    WHERE "assignmentId"<>'gateway-key-limit:'||p_api_key_id
    ORDER BY "workspaceId","scopeType","scopeId",period,"periodStart","assignmentId"
  LOOP
    INSERT INTO cinatoken_gateway.guardrail_budget_windows
      (workspace_id,scope_type,scope_id,period,period_start,period_end,
       unreserved_micros,settled_micros,reserved_micros,seeded_at,updated_at)
      VALUES(intent."workspaceId",intent."scopeType",intent."scopeId",intent.period,
        intent."periodStart",intent."periodEnd",0,0,0,server_now,server_now)
      ON CONFLICT (workspace_id,scope_type,scope_id,period,period_start) DO NOTHING;
    SELECT * INTO window_row FROM cinatoken_gateway.guardrail_budget_windows w
      WHERE w.workspace_id=intent."workspaceId" AND w.scope_type=intent."scopeType"
        AND w.scope_id=intent."scopeId" AND w.period=intent.period
        AND w.period_start=intent."periodStart" FOR UPDATE NOWAIT;
    IF NOT FOUND OR window_row.period_end<>intent."periodEnd" THEN
      RAISE EXCEPTION 'Guardrail extension window period differs'
        USING ERRCODE='23514',CONSTRAINT='guardrail_extension_window_v355'; END IF;
    SELECT COALESCE(sum(r.reserved_micros),0)::numeric INTO active_micros
      FROM cinatoken_gateway.guardrail_budget_reservations r
      WHERE r.workspace_id=intent."workspaceId" AND r.scope_type=intent."scopeType"
        AND r.scope_id=intent."scopeId" AND r.period=intent.period
        AND r.period_start=intent."periodStart" AND r.state IN ('reserved','dispatched');
    IF active_micros<>window_row.reserved_micros THEN
      RAISE EXCEPTION 'Guardrail extension window hold differs'
        USING ERRCODE='23514',CONSTRAINT='guardrail_extension_counter_v355'; END IF;
    SELECT COALESCE(sum(COALESCE(l.budget_charged_micros,
        pg_catalog.round(GREATEST(l.charged_cost,0)*1000000)::bigint)),0)::numeric
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
    IF computed_unreserved_micros>9007199254740991
      OR computed_unreserved_micros+window_row.settled_micros
        +window_row.reserved_micros+p_reserved_micros>intent."limitMicros"
    THEN
      blocked_assignment:=intent."assignmentId";
      RAISE EXCEPTION 'Guardrail extension capacity exceeded'
        USING ERRCODE='Z3551';
    END IF;
    window_key:=pg_catalog.concat_ws(E'\x1f',intent."workspaceId",intent."scopeType",
      intent."scopeId",intent.period,intent."periodStart"::text);
    checked_windows:=checked_windows||pg_catalog.jsonb_build_object(
      window_key,computed_unreserved_micros);
  END LOOP;
  server_now:=pg_catalog.clock_timestamp();
  IF p_now<server_now-INTERVAL '5 minutes'
    OR p_expires_at<=server_now OR route_row.expires_at<=server_now
    OR (key_row.expires_at IS NOT NULL AND key_row.expires_at<=server_now)
    OR (server_now AT TIME ZONE 'UTC')::date<>validated_utc_day
  THEN RAISE EXCEPTION 'Guardrail extension became stale before writes'
    USING ERRCODE='Z3552'; END IF;
  FOR intent IN SELECT * FROM pg_catalog.jsonb_to_recordset(p_intents) AS x(
      "workspaceId" text,"assignmentId" text,"guardrailId" text,
      "guardrailVersion" integer,"scopeType" text,"scopeId" text,
      period text,"periodStart" timestamptz,"periodEnd" timestamptz,
      "limitMicros" bigint)
    WHERE "assignmentId"<>'gateway-key-limit:'||p_api_key_id
    ORDER BY "workspaceId","scopeType","scopeId",period,"periodStart","assignmentId"
  LOOP
    window_key:=pg_catalog.concat_ws(E'\x1f',intent."workspaceId",intent."scopeType",
      intent."scopeId",intent.period,intent."periodStart"::text);
    UPDATE cinatoken_gateway.guardrail_budget_windows w SET
      unreserved_micros=(checked_windows->>window_key)::bigint,
      reserved_micros=w.reserved_micros+p_reserved_micros,updated_at=server_now
      WHERE w.workspace_id=intent."workspaceId" AND w.scope_type=intent."scopeType"
        AND w.scope_id=intent."scopeId" AND w.period=intent.period
        AND w.period_start=intent."periodStart";
    INSERT INTO cinatoken_gateway.guardrail_budget_reservations
      (id,workspace_id,request_id,assignment_id,guardrail_id,guardrail_version,
       scope_type,scope_id,period,period_start,period_end,limit_micros,
       reserved_micros,settled_micros,settlement_basis,state,expires_at,
       dispatched_at,created_at,updated_at)
      VALUES(pg_catalog.gen_random_uuid()::text,intent."workspaceId",p_request_id,
        intent."assignmentId",intent."guardrailId",intent."guardrailVersion",
        intent."scopeType",intent."scopeId",intent.period,intent."periodStart",
        intent."periodEnd",intent."limitMicros",p_reserved_micros,0,'charged',
        'dispatched',extended_expiry,server_now,server_now,server_now);
  END LOOP;
  IF n>1 THEN
    UPDATE cinatoken_gateway.guardrail_budget_reservations
      SET expires_at=extended_expiry,updated_at=server_now
      WHERE id=route_row.id AND state='dispatched';
  END IF;
  EXCEPTION WHEN SQLSTATE 'Z3551' THEN
    RETURN pg_catalog.jsonb_build_object('status','blocked',
      'assignmentId',blocked_assignment);
  WHEN SQLSTATE 'Z3552' THEN
    RETURN pg_catalog.jsonb_build_object('status','stale');
  END;
  RETURN pg_catalog.jsonb_build_object('status','reserved',
    'reservationCount',n,'leaseExpiresAt',extended_expiry);
END;
$extend$;

REVOKE ALL ON FUNCTION
  cinatoken_gateway.extend_guardrail_budgets_dispatched_v355(
    text,text,text,jsonb,bigint,timestamptz,timestamptz)
  FROM PUBLIC,cinatoken_gateway_runtime,cinatoken_gateway_buyer_settlement;
GRANT EXECUTE ON FUNCTION
  cinatoken_gateway.extend_guardrail_budgets_dispatched_v355(
    text,text,text,jsonb,bigint,timestamptz,timestamptz)
  TO cinatoken_gateway_budget_admission;

DO $postflight$
DECLARE admission_oid oid; runtime_oid oid; buyer_oid oid;
BEGIN
  SELECT oid INTO admission_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_budget_admission';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_buyer_settlement';
  IF NOT pg_catalog.has_function_privilege(admission_oid,
      'cinatoken_gateway.extend_guardrail_budgets_dispatched_v355(text,text,text,jsonb,bigint,timestamptz,timestamptz)','EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_gateway.extend_guardrail_budgets_dispatched_v355(text,text,text,jsonb,bigint,timestamptz,timestamptz)','EXECUTE')
    OR pg_catalog.has_function_privilege(buyer_oid,
      'cinatoken_gateway.extend_guardrail_budgets_dispatched_v355(text,text,text,jsonb,bigint,timestamptz,timestamptz)','EXECUTE')
    OR pg_catalog.has_table_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_windows','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_windows','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_reservations','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_reservations','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.guardrail_budget_windows','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(runtime_oid,
      'cinatoken_gateway.guardrail_budget_windows','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.guardrail_budget_reservations','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(runtime_oid,
      'cinatoken_gateway.guardrail_budget_reservations','INSERT,UPDATE')
  THEN RAISE EXCEPTION 'Guardrail extension v355 postflight differs'
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
