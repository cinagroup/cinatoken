-- REVIEW ONLY. Install after v362 in one migrator transaction with
-- complete_text_send_start_activation=reviewed-v1. Provision the separate
-- direct NOINHERIT LOGIN cinatoken_gateway_complete_text_send_holder first.
-- The holder first claims immutable epoch-1 custody in its own committed
-- transaction. A fresh SQL send-start result is not permission to send: the
-- holder must observe both transactions' COMMIT and close acknowledgements,
-- recheck the server deadline, and never treat replay as a new send right.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923562);
SELECT pg_catalog.pg_advisory_xact_lock(746923565);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.complete_text_quotes_v360,
  cinatoken_gateway.complete_text_admissions_v361,
  cinatoken_gateway.complete_text_attempt_grants_v362
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; holder_oid oid; grant_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO holder_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_complete_text_send_holder';
  SELECT oid INTO grant_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_complete_text_attempt_granter';
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting('cinatoken.complete_text_send_start_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR holder_oid IS NULL OR grant_oid IS NULL
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
      WHERE nspname='cinatoken_gateway') IS DISTINCT FROM migrator_oid
    OR (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
       AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
       AND NOT rolinherit FROM pg_catalog.pg_roles WHERE oid=holder_oid)
         IS DISTINCT FROM true
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid=holder_oid OR member=holder_oid)
    OR pg_catalog.has_schema_privilege(holder_oid,'cinatoken_gateway','CREATE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
      WHERE n.nspname LIKE 'cinatoken_economic_%'
        AND pg_catalog.has_schema_privilege(holder_oid,n.oid,'USAGE'))
    OR pg_catalog.to_regclass(
      'cinatoken_gateway.complete_text_send_starts_v365') IS NOT NULL
    OR pg_catalog.to_regclass(
      'cinatoken_gateway.complete_text_send_custody_v365') IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.record_complete_text_send_start_v365(uuid,uuid,bigint,text)')
      IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.claim_complete_text_send_custody_v365(uuid,uuid)')
      IS NOT NULL
    OR pg_catalog.to_regclass(
      'cinatoken_gateway.complete_text_attempt_grants_v362') IS NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.grant_complete_flat_text_attempt_v362(uuid,jsonb)')
      IS NULL
    OR NOT pg_catalog.has_function_privilege(grant_oid,
      'cinatoken_gateway.grant_complete_flat_text_attempt_v362(uuid,jsonb)',
      'EXECUTE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN (
        'cinatoken_gateway.complete_text_quotes_v360'::pg_catalog.regclass,
        'cinatoken_gateway.complete_text_admissions_v361'::pg_catalog.regclass,
        'cinatoken_gateway.complete_text_attempt_grants_v362'::pg_catalog.regclass)
        AND (c.relowner<>migrator_oid OR c.relkind<>'r'
          OR c.relrowsecurity OR c.relforcerowsecurity))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('cinatoken_gateway','cinatoken_economic_outbox',
        'cinatoken_economic_quotes','cinatoken_economic_consumer')
        AND c.relkind IN ('r','p')
        AND (pg_catalog.has_table_privilege(holder_oid,c.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR pg_catalog.has_any_column_privilege(holder_oid,c.oid,
            'SELECT,INSERT,UPDATE')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='cinatoken_gateway'
        AND pg_catalog.has_function_privilege(holder_oid,p.oid,'EXECUTE'))
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger
      WHERE tgname='complete_text_attempt_grants_v362_no_mutation'
        AND tgrelid='cinatoken_gateway.complete_text_attempt_grants_v362'::pg_catalog.regclass
        AND tgenabled='O' AND NOT tgisinternal)<>1
  THEN RAISE EXCEPTION 'complete text send start v365 activation or dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

CREATE TABLE cinatoken_gateway.complete_text_send_custody_v365 (
  grant_id uuid PRIMARY KEY REFERENCES
    cinatoken_gateway.complete_text_attempt_grants_v362(grant_id),
  request_id text NOT NULL UNIQUE,
  holder_run_id uuid NOT NULL UNIQUE,
  lease_epoch bigint NOT NULL CHECK (lease_epoch=1),
  mode text NOT NULL CHECK (mode='active'),
  claimed_at timestamptz NOT NULL,
  lease_until timestamptz NOT NULL CHECK (lease_until>claimed_at)
);
CREATE TABLE cinatoken_gateway.complete_text_send_starts_v365 (
  send_start_id uuid PRIMARY KEY,
  grant_id uuid NOT NULL UNIQUE REFERENCES
    cinatoken_gateway.complete_text_send_custody_v365(grant_id),
  request_id text NOT NULL,
  holder_run_id uuid NOT NULL,
  lease_epoch bigint NOT NULL CHECK (lease_epoch=1),
  outbound_body_sha256 text NOT NULL
    CHECK (outbound_body_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL,
  send_expires_at timestamptz NOT NULL CHECK (send_expires_at>recorded_at),
  UNIQUE (request_id,holder_run_id)
);
CREATE INDEX complete_text_send_starts_v365_request
  ON cinatoken_gateway.complete_text_send_starts_v365(request_id,recorded_at);

CREATE FUNCTION cinatoken_gateway.reject_complete_text_send_start_mutation_v365()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $immutable$
BEGIN
  RAISE EXCEPTION 'complete text send start v365 is insert-only'
    USING ERRCODE='P0001';
END;
$immutable$;
CREATE TRIGGER complete_text_send_custody_v365_no_mutation
  BEFORE UPDATE OR DELETE ON cinatoken_gateway.complete_text_send_custody_v365
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_gateway.reject_complete_text_send_start_mutation_v365();
CREATE TRIGGER complete_text_send_starts_v365_no_mutation
  BEFORE UPDATE OR DELETE ON cinatoken_gateway.complete_text_send_starts_v365
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_gateway.reject_complete_text_send_start_mutation_v365();

-- Private common check for both committed custody and send-start. This checks
-- the exact admitted physical holds, not merely their count and deadline.
CREATE FUNCTION cinatoken_gateway.check_complete_text_send_holds_v365(
  p_request_id text,p_quote_id uuid,p_recovery_expires_at timestamptz)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $holds$
DECLARE q record; admission record; cap record; key_row record;
DECLARE user_row record; workspace_row record; ordinary record;
DECLARE intent record; held record; window_row record; server_now timestamptz;
DECLARE active_micros numeric; intent_count integer:=0;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_complete_text_send_holder'
  THEN RAISE EXCEPTION 'invalid complete text hold verifier caller'
    USING ERRCODE='23514'; END IF;
  SELECT * INTO q FROM cinatoken_gateway.complete_text_quotes_v360
    WHERE request_id=p_request_id AND quote_id=p_quote_id;
  SELECT * INTO admission FROM cinatoken_gateway.complete_text_admissions_v361
    WHERE request_id=p_request_id AND quote_id=p_quote_id;
  SELECT * INTO cap FROM cinatoken_gateway.authenticated_request_capabilities_v356
    WHERE request_id=p_request_id FOR SHARE;
  server_now:=pg_catalog.clock_timestamp();
  IF q.quote_id IS NULL OR admission.quote_id IS NULL
    OR admission.reserved_micros IS DISTINCT FROM q.three_attempt_ceiling_micros
    OR admission.guardrail_count IS DISTINCT FROM
      pg_catalog.jsonb_array_length(admission.guardrail_intents)
  THEN RETURN 'invalid_admission'; END IF;
  SELECT * INTO key_row FROM cinatoken_gateway.api_keys
    WHERE id=q.api_key_id FOR SHARE;
  SELECT * INTO user_row FROM cinatoken_gateway.users
    WHERE id=q.user_id FOR SHARE;
  SELECT * INTO workspace_row FROM cinatoken_gateway.workspaces
    WHERE id=q.workspace_id FOR SHARE;
  IF cap.request_id IS NULL OR cap.state IS DISTINCT FROM 'claimed'
    OR cap.invalidated_at IS NOT NULL
    OR cap.body_sha256 IS DISTINCT FROM q.original_body_sha256
    OR cap.api_key_id IS DISTINCT FROM q.api_key_id
    OR cap.user_id IS DISTINCT FROM q.user_id
    OR cap.workspace_id IS DISTINCT FROM q.workspace_id
    OR cap.budget_epoch IS DISTINCT FROM q.budget_epoch
    OR cap.key_limit_epoch IS DISTINCT FROM q.key_limit_epoch
    OR key_row.id IS NULL OR key_row.status IS DISTINCT FROM 'active'
    OR key_row.key_hash IS DISTINCT FROM cap.key_hash
    OR key_row.key IS DISTINCT FROM 'hashref:'||cap.key_hash
    OR key_row.user_id IS DISTINCT FROM q.user_id
    OR key_row.workspace_id IS DISTINCT FROM q.workspace_id
    OR key_row.limit_epoch IS DISTINCT FROM q.key_limit_epoch
    OR (key_row.expires_at IS NOT NULL AND key_row.expires_at<=server_now)
    OR workspace_row.id IS NULL OR workspace_row.status IS DISTINCT FROM 'active'
    OR workspace_row.scope_type IS DISTINCT FROM 'personal'
    OR workspace_row.personal_owner_user_id IS DISTINCT FROM q.user_id
  THEN RETURN 'stale_identity'; END IF;
  IF user_row.id IS NULL OR user_row.status IS DISTINCT FROM 'active'
    OR user_row.budget_epoch IS DISTINCT FROM q.budget_epoch
    OR user_row.charged_cost_factors IS NOT NULL
  THEN RETURN 'stale_account'; END IF;
  -- v362 locks the account before reservation tables. Keep that order here.
  LOCK TABLE cinatoken_gateway.user_budget_reservations,
    cinatoken_gateway.guardrail_budget_reservations IN SHARE MODE;
  FOR intent IN SELECT * FROM pg_catalog.jsonb_to_recordset(
      admission.guardrail_intents) AS x(
      "workspaceId" text,"assignmentId" text,"guardrailId" text,
      "guardrailVersion" integer,"scopeType" text,"scopeId" text,
      period text,"periodStart" timestamptz,"periodEnd" timestamptz,
      "limitMicros" bigint)
    ORDER BY "workspaceId","scopeType","scopeId",period,"periodStart",
      "assignmentId"
  LOOP
    intent_count:=intent_count+1;
    SELECT * INTO held FROM cinatoken_gateway.guardrail_budget_reservations
      WHERE request_id=p_request_id
        AND assignment_id=intent."assignmentId" FOR SHARE;
    IF held.id IS NULL
      OR intent."workspaceId" IS DISTINCT FROM q.workspace_id
      OR held.workspace_id IS DISTINCT FROM intent."workspaceId"
      OR held.guardrail_id IS DISTINCT FROM intent."guardrailId"
      OR held.guardrail_version IS DISTINCT FROM intent."guardrailVersion"
      OR held.scope_type IS DISTINCT FROM intent."scopeType"
      OR held.scope_id IS DISTINCT FROM intent."scopeId"
      OR held.period IS DISTINCT FROM intent.period
      OR held.period_start IS DISTINCT FROM intent."periodStart"
      OR held.period_end IS DISTINCT FROM intent."periodEnd"
      OR held.limit_micros IS DISTINCT FROM intent."limitMicros"
      OR held.reserved_micros IS DISTINCT FROM admission.reserved_micros
      OR held.settled_micros<>0 OR held.settlement_basis IS DISTINCT FROM 'charged'
      OR held.state IS DISTINCT FROM 'dispatched'
      OR held.dispatched_at IS NULL OR held.terminal_at IS NOT NULL
      OR held.terminal_reason IS NOT NULL
      OR held.expires_at<p_recovery_expires_at OR held.expires_at<=server_now
      OR server_now<intent."periodStart" OR server_now>=intent."periodEnd"
    THEN RETURN 'missing_hold'; END IF;
    SELECT * INTO window_row FROM cinatoken_gateway.guardrail_budget_windows
      WHERE workspace_id=held.workspace_id AND scope_type=held.scope_type
        AND scope_id=held.scope_id AND period=held.period
        AND period_start=held.period_start FOR SHARE;
    SELECT coalesce(pg_catalog.sum(reserved_micros),0) INTO active_micros
      FROM cinatoken_gateway.guardrail_budget_reservations
      WHERE workspace_id=held.workspace_id AND scope_type=held.scope_type
        AND scope_id=held.scope_id AND period=held.period
        AND period_start=held.period_start
        AND state IN ('reserved','dispatched');
    IF window_row.workspace_id IS NULL
      OR window_row.period_end IS DISTINCT FROM held.period_end
      OR window_row.reserved_micros IS DISTINCT FROM active_micros
    THEN RETURN 'hold_counter_differs'; END IF;
  END LOOP;
  IF intent_count<>admission.guardrail_count
    OR (SELECT pg_catalog.count(*) FROM
      cinatoken_gateway.guardrail_budget_reservations
      WHERE request_id=p_request_id)<>intent_count
  THEN RETURN 'missing_hold'; END IF;
  IF admission.ordinary_status='reserved' THEN
    SELECT * INTO ordinary FROM cinatoken_gateway.user_budget_reservations
      WHERE request_id=p_request_id FOR SHARE;
    IF ordinary.request_id IS NULL
      OR ordinary.user_id IS DISTINCT FROM q.user_id
      OR ordinary.api_key_id IS DISTINCT FROM q.api_key_id
      OR ordinary.budget_epoch IS DISTINCT FROM q.budget_epoch
      OR ordinary.reserved_micros IS DISTINCT FROM admission.reserved_micros
      OR ordinary.settled_micros<>0
      OR ordinary.state IS DISTINCT FROM 'dispatched'
      OR ordinary.dispatched_at IS NULL OR ordinary.terminal_at IS NOT NULL
      OR ordinary.terminal_reason IS NOT NULL
      OR ordinary.expires_at<p_recovery_expires_at
      OR ordinary.expires_at<=server_now
      OR user_row.budget_max IS NULL
      OR ordinary.limit_micros IS DISTINCT FROM LEAST(pg_catalog.round(
        GREATEST(user_row.budget_max,0::numeric)*1000000::numeric),
        9007199254740991::numeric)::bigint
    THEN RETURN 'missing_hold'; END IF;
    SELECT coalesce(pg_catalog.sum(reserved_micros),0) INTO active_micros
      FROM cinatoken_gateway.user_budget_reservations
      WHERE user_id=q.user_id AND budget_epoch=q.budget_epoch
        AND state IN ('reserved','dispatched');
    IF user_row.budget_reserved_micros IS DISTINCT FROM active_micros
    THEN RETURN 'hold_counter_differs'; END IF;
  ELSIF admission.ordinary_status='unlimited' THEN
    IF user_row.budget_max IS NOT NULL OR EXISTS (SELECT 1 FROM
        cinatoken_gateway.user_budget_reservations WHERE request_id=p_request_id)
    THEN RETURN 'missing_hold'; END IF;
  ELSE RETURN 'invalid_admission'; END IF;
  RETURN 'ok';
END;
$holds$;

CREATE FUNCTION cinatoken_gateway.claim_complete_text_send_custody_v365(
  p_grant_id uuid,p_holder_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
SET lock_timeout TO '2s'
SET statement_timeout TO '15s' AS $claim$
DECLARE grant_row record; prior record; q record; admission record;
DECLARE server_now timestamptz; ordinary record; v_guardrail_count integer;
DECLARE hold_status text;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_complete_text_send_holder'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_grant_id IS NULL OR p_holder_run_id IS NULL
  THEN RAISE EXCEPTION 'invalid complete text custody claim call'
    USING ERRCODE='23514',CONSTRAINT='complete_text_custody_claim_v365'; END IF;
  SELECT * INTO grant_row FROM cinatoken_gateway.complete_text_attempt_grants_v362
    WHERE grant_id=p_grant_id FOR SHARE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status','missing_grant'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(348,
    pg_catalog.hashtext(grant_row.request_id));
  SELECT * INTO prior FROM cinatoken_gateway.complete_text_send_custody_v365
    WHERE grant_id=p_grant_id FOR SHARE;
  IF FOUND THEN
    IF prior.holder_run_id IS DISTINCT FROM p_holder_run_id
    THEN RETURN pg_catalog.jsonb_build_object('status','holder_run_conflict'); END IF;
    RETURN pg_catalog.jsonb_build_object('status','already_claimed_unknown');
  END IF;
  IF EXISTS (SELECT 1 FROM cinatoken_gateway.complete_text_send_custody_v365
      WHERE request_id=grant_row.request_id)
  THEN RETURN pg_catalog.jsonb_build_object('status','holder_run_conflict'); END IF;
  SELECT * INTO q FROM cinatoken_gateway.complete_text_quotes_v360
    WHERE quote_id=grant_row.quote_id AND request_id=grant_row.request_id FOR SHARE;
  SELECT * INTO admission FROM cinatoken_gateway.complete_text_admissions_v361
    WHERE quote_id=grant_row.quote_id AND request_id=grant_row.request_id FOR SHARE;
  server_now:=pg_catalog.clock_timestamp();
  IF q.quote_id IS NULL OR admission.quote_id IS NULL
    OR grant_row.obligation_state IS DISTINCT FROM 'unknown'
    OR grant_row.send_expires_at<=server_now+INTERVAL '1 second'
    OR grant_row.hold_recovery_expires_at<=server_now
    OR q.expires_at<=server_now OR admission.expires_at<=server_now
    OR admission.final_body_sha256 IS DISTINCT FROM grant_row.final_body_sha256
    OR admission.ordinary_status NOT IN ('reserved','unlimited')
  THEN RETURN pg_catalog.jsonb_build_object('status','expired_or_stale'); END IF;
  server_now:=pg_catalog.clock_timestamp();
  IF grant_row.send_expires_at<=server_now+INTERVAL '1 second'
    OR q.expires_at<=server_now OR admission.expires_at<=server_now
  THEN RETURN pg_catalog.jsonb_build_object('status','expired_or_stale'); END IF;
  hold_status:=cinatoken_gateway.check_complete_text_send_holds_v365(
    grant_row.request_id,grant_row.quote_id,grant_row.hold_recovery_expires_at);
  IF hold_status<>'ok'
  THEN RETURN pg_catalog.jsonb_build_object('status',hold_status); END IF;
  server_now:=pg_catalog.clock_timestamp();
  IF grant_row.send_expires_at<=server_now+INTERVAL '1 second'
    OR q.expires_at<=server_now OR admission.expires_at<=server_now
  THEN RETURN pg_catalog.jsonb_build_object('status','expired_or_stale'); END IF;
  INSERT INTO cinatoken_gateway.complete_text_send_custody_v365
    (grant_id,request_id,holder_run_id,lease_epoch,mode,claimed_at,lease_until)
    VALUES(p_grant_id,grant_row.request_id,p_holder_run_id,1,'active',
      server_now,grant_row.hold_recovery_expires_at);
  RETURN pg_catalog.jsonb_build_object(
    'status','custody_claim_recorded','grantId',p_grant_id,
    'holderRunId',p_holder_run_id,'leaseEpoch',1,
    'leaseUntil',grant_row.hold_recovery_expires_at);
END;
$claim$;

CREATE FUNCTION cinatoken_gateway.record_complete_text_send_start_v365(
  p_grant_id uuid,p_holder_run_id uuid,p_expected_epoch bigint,
  p_upload_sha256 text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
SET lock_timeout TO '2s'
SET statement_timeout TO '15s' AS $start$
DECLARE grant_row record; custody record; prior record; q record;
DECLARE admission record; ordinary record; server_now timestamptz;
DECLARE v_start_id uuid; v_guardrail_count integer; v_expires_at timestamptz;
DECLARE hold_status text;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_complete_text_send_holder'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_grant_id IS NULL OR p_holder_run_id IS NULL
    OR p_expected_epoch IS NULL OR p_expected_epoch<1
    OR p_upload_sha256 IS NULL
    OR p_upload_sha256 !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'invalid complete text send start call'
    USING ERRCODE='23514',CONSTRAINT='complete_text_send_start_call_v365'; END IF;
  SELECT * INTO grant_row FROM cinatoken_gateway.complete_text_attempt_grants_v362
    WHERE grant_id=p_grant_id FOR SHARE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status','missing_grant'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(348,
    pg_catalog.hashtext(grant_row.request_id));
  SELECT * INTO custody FROM cinatoken_gateway.complete_text_send_custody_v365
    WHERE grant_id=p_grant_id FOR SHARE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status','custody_required'); END IF;
  IF custody.request_id IS DISTINCT FROM grant_row.request_id
    OR custody.holder_run_id IS DISTINCT FROM p_holder_run_id
    OR custody.lease_epoch IS DISTINCT FROM p_expected_epoch
    OR custody.mode IS DISTINCT FROM 'active'
  THEN RETURN pg_catalog.jsonb_build_object('status','holder_run_conflict'); END IF;
  SELECT * INTO prior FROM cinatoken_gateway.complete_text_send_starts_v365
    WHERE grant_id=p_grant_id FOR SHARE;
  IF FOUND THEN
    -- Even an identical replay after lost ACK carries no new send right.
    RETURN pg_catalog.jsonb_build_object('status','already_possible_send',
      'sendStartId',prior.send_start_id);
  END IF;
  IF grant_row.obligation_state IS DISTINCT FROM 'unknown'
    OR grant_row.outbound_body_sha256 IS DISTINCT FROM p_upload_sha256
  THEN RETURN pg_catalog.jsonb_build_object('status','grant_upload_differs'); END IF;

  -- This conservative source and hold lock set prevents a concurrent update
  -- from being certified unchanged by a committed marker. It is review-only.
  LOCK TABLE cinatoken_gateway.model_routes,
    cinatoken_gateway.route_pools,cinatoken_gateway.providers,
    cinatoken_gateway.model_endpoints,
    cinatoken_gateway.model_endpoint_routes,
    cinatoken_gateway.route_source_generations_v359,
    cinatoken_gateway.api_keys IN SHARE MODE;
  SELECT * INTO q FROM cinatoken_gateway.complete_text_quotes_v360
    WHERE quote_id=grant_row.quote_id AND request_id=grant_row.request_id FOR SHARE;
  SELECT * INTO admission FROM cinatoken_gateway.complete_text_admissions_v361
    WHERE quote_id=grant_row.quote_id AND request_id=grant_row.request_id FOR SHARE;
  server_now:=pg_catalog.clock_timestamp();
  v_expires_at:=LEAST(grant_row.send_expires_at,custody.lease_until);
  IF q.quote_id IS NULL OR admission.quote_id IS NULL
    OR v_expires_at<=server_now+INTERVAL '1 second'
    OR q.expires_at<=server_now OR admission.expires_at<=server_now
    OR admission.final_body_sha256 IS DISTINCT FROM grant_row.final_body_sha256
    OR admission.ordinary_status NOT IN ('reserved','unlimited')
    OR NOT EXISTS (SELECT 1 FROM cinatoken_gateway.api_keys k
      WHERE k.id=q.api_key_id AND k.status='active'
        AND (k.expires_at IS NULL OR k.expires_at>server_now))
  THEN RETURN pg_catalog.jsonb_build_object('status','expired_or_stale'); END IF;
  IF NOT EXISTS (SELECT 1 FROM cinatoken_gateway.model_routes r
    JOIN cinatoken_gateway.route_pools rp
      ON rp.id=r.route_pool_id AND rp.model_id=r.model_id
        AND rp.route_group=r.route_group
    JOIN cinatoken_gateway.providers po ON po.id=r.provider_id
    JOIN cinatoken_gateway.model_endpoint_routes er
      ON er.route_target_id=r.id
    JOIN cinatoken_gateway.model_endpoints e
      ON e.id=er.endpoint_id AND e.model_id=r.model_id
        AND e.provider_id=r.provider_id
    JOIN cinatoken_gateway.route_source_generations_v359 f
      ON f.route_target_id=r.id
    WHERE r.id=grant_row.route_target_id AND r.model_id=grant_row.model_id
      AND r.provider_id=grant_row.provider_id
      AND r.status='active' AND r.route_group='default'
      AND r.upstream_protocol='openai' AND r.upstream_operation='chat'
      AND r.adapter='passthrough' AND r.price_override IS NULL
      AND r.custom_params IS NULL AND r.routing_metadata IS NULL
      AND rp.status='active' AND po.status='active'
      AND po.shared_channel_type IS NULL AND po.api_key LIKE 'enc:v2:%'
      AND pg_catalog.encode(pg_catalog.sha256(
        pg_catalog.convert_to(po.api_key,'UTF8')),'hex')
          =grant_row.provider_ciphertext_sha256
      AND e.id=grant_row.endpoint_id AND e.status='verified'
      AND e.expires_at>server_now
      AND f.generation=grant_row.manifest_source_generation
      AND f.verified_generation=f.generation
      AND f.attested_source_sha256=grant_row.manifest_attested_source_sha256
      AND f.verified_subject_fingerprint=er.subject_fingerprint)
  THEN RETURN pg_catalog.jsonb_build_object('status','stale_source'); END IF;
  hold_status:=cinatoken_gateway.check_complete_text_send_holds_v365(
    grant_row.request_id,grant_row.quote_id,grant_row.hold_recovery_expires_at);
  IF hold_status<>'ok'
  THEN RETURN pg_catalog.jsonb_build_object('status',hold_status); END IF;
  server_now:=pg_catalog.clock_timestamp();
  IF v_expires_at<=server_now+INTERVAL '1 second'
    OR q.expires_at<=server_now OR admission.expires_at<=server_now
  THEN RETURN pg_catalog.jsonb_build_object('status','expired_or_stale'); END IF;
  v_start_id:=pg_catalog.gen_random_uuid();
  INSERT INTO cinatoken_gateway.complete_text_send_starts_v365
    (send_start_id,grant_id,request_id,holder_run_id,lease_epoch,
      outbound_body_sha256,recorded_at,send_expires_at)
    VALUES(v_start_id,p_grant_id,grant_row.request_id,p_holder_run_id,
      p_expected_epoch,p_upload_sha256,server_now,v_expires_at);
  RETURN pg_catalog.jsonb_build_object(
    'status','start_recorded','sendStartId',v_start_id,'grantId',p_grant_id,
    'holderRunId',p_holder_run_id,'leaseEpoch',p_expected_epoch,
    'uploadSha256',p_upload_sha256,'expiresAt',v_expires_at);
END;
$start$;

REVOKE ALL ON cinatoken_gateway.complete_text_send_custody_v365,
  cinatoken_gateway.complete_text_send_starts_v365
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_budget_admission,
    cinatoken_gateway_complete_text_attempt_granter,
    cinatoken_gateway_complete_text_send_holder;
REVOKE ALL ON FUNCTION
  cinatoken_gateway.claim_complete_text_send_custody_v365(uuid,uuid),
  cinatoken_gateway.record_complete_text_send_start_v365(uuid,uuid,bigint,text),
  cinatoken_gateway.check_complete_text_send_holds_v365(text,uuid,timestamptz),
  cinatoken_gateway.reject_complete_text_send_start_mutation_v365()
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_budget_admission,
    cinatoken_gateway_complete_text_attempt_granter,
    cinatoken_gateway_complete_text_send_holder;
GRANT USAGE ON SCHEMA cinatoken_gateway
  TO cinatoken_gateway_complete_text_send_holder;
GRANT EXECUTE ON FUNCTION
  cinatoken_gateway.claim_complete_text_send_custody_v365(uuid,uuid),
  cinatoken_gateway.record_complete_text_send_start_v365(uuid,uuid,bigint,text)
  TO cinatoken_gateway_complete_text_send_holder;

DO $postflight$
BEGIN
  IF NOT pg_catalog.has_function_privilege(
      'cinatoken_gateway_complete_text_send_holder',
      'cinatoken_gateway.record_complete_text_send_start_v365(uuid,uuid,bigint,text)',
      'EXECUTE')
    OR NOT pg_catalog.has_function_privilege(
      'cinatoken_gateway_complete_text_send_holder',
      'cinatoken_gateway.claim_complete_text_send_custody_v365(uuid,uuid)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(
      'cinatoken_gateway_runtime',
      'cinatoken_gateway.record_complete_text_send_start_v365(uuid,uuid,bigint,text)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(
      'cinatoken_gateway_budget_admission',
      'cinatoken_gateway.record_complete_text_send_start_v365(uuid,uuid,bigint,text)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(
      'cinatoken_gateway_complete_text_attempt_granter',
      'cinatoken_gateway.record_complete_text_send_start_v365(uuid,uuid,bigint,text)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(
      'cinatoken_gateway_runtime',
      'cinatoken_gateway.claim_complete_text_send_custody_v365(uuid,uuid)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(
      'cinatoken_gateway_budget_admission',
      'cinatoken_gateway.claim_complete_text_send_custody_v365(uuid,uuid)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(
      'cinatoken_gateway_complete_text_attempt_granter',
      'cinatoken_gateway.claim_complete_text_send_custody_v365(uuid,uuid)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(
      'cinatoken_gateway_complete_text_send_holder',
      'cinatoken_gateway.grant_complete_flat_text_attempt_v362(uuid,jsonb)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(
      'cinatoken_gateway_complete_text_send_holder',
      'cinatoken_gateway.check_complete_text_send_holds_v365(text,uuid,timestamptz)',
      'EXECUTE')
    OR pg_catalog.has_table_privilege(
      'cinatoken_gateway_complete_text_send_holder',
      'cinatoken_gateway.complete_text_send_starts_v365',
      'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege(
      'cinatoken_gateway_complete_text_send_holder',
      'cinatoken_gateway.complete_text_send_custody_v365',
      'SELECT,INSERT,UPDATE,DELETE')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger
      WHERE tgname='complete_text_send_starts_v365_no_mutation'
        AND tgrelid='cinatoken_gateway.complete_text_send_starts_v365'::pg_catalog.regclass
        AND tgenabled='O' AND NOT tgisinternal)<>1
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger
      WHERE tgname='complete_text_send_custody_v365_no_mutation'
        AND tgrelid='cinatoken_gateway.complete_text_send_custody_v365'::pg_catalog.regclass
        AND tgenabled='O' AND NOT tgisinternal)<>1
  THEN RAISE EXCEPTION 'complete text send start v365 postflight differs'
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
