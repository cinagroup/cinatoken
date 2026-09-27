-- REVIEW ONLY / NON-ACTIVATABLE. Requires v361/v362/v365/v366 and a separately
-- provisioned direct NOINHERIT LOGIN cinatoken_gateway_complete_text_hold_renewer.
-- Install only in a reviewed migrator transaction with SET LOCAL
-- cinatoken.complete_text_all_hold_renewal_v367_activation='reviewed-v1'.
-- Production also needs a request-scoped buyer counter-authority cutover, an
-- atomic all-hold result closer, and a holder with COMMIT/close ACK discipline.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923562);
SELECT pg_catalog.pg_advisory_xact_lock(746923565);
SELECT pg_catalog.pg_advisory_xact_lock(746923567);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.complete_text_attempt_grants_v362,
  cinatoken_gateway.complete_text_send_custody_v365,
  cinatoken_gateway.complete_text_send_starts_v365,
  cinatoken_gateway.users,
  cinatoken_gateway.user_budget_reservations,
  cinatoken_gateway.guardrail_budget_reservations,
  cinatoken_gateway.guardrail_budget_windows
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; renewer_oid oid; fence_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO renewer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_complete_text_hold_renewer';
  fence_oid:=pg_catalog.to_regprocedure(
    'cinatoken_gateway.reject_complete_text_enrolled_hold_mutation_v366()');
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting(
      'cinatoken.complete_text_all_hold_renewal_v367_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR renewer_oid IS NULL OR fence_oid IS NULL
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
      WHERE nspname='cinatoken_gateway') IS DISTINCT FROM migrator_oid
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid=renewer_oid OR member=renewer_oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE oid=renewer_oid
      AND (NOT rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb
        OR rolreplication OR rolbypassrls OR rolinherit))
    OR pg_catalog.has_schema_privilege(renewer_oid,
      'cinatoken_gateway','CREATE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='cinatoken_gateway'
        AND c.relkind IN ('r','p','v','m','f')
        AND (pg_catalog.has_table_privilege(renewer_oid,c.oid,
          'SELECT,INSERT,UPDATE,DELETE')
          OR pg_catalog.has_any_column_privilege(renewer_oid,c.oid,
            'SELECT,INSERT,UPDATE')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid IN (
      'cinatoken_gateway.complete_text_attempt_grants_v362'::pg_catalog.regclass,
      'cinatoken_gateway.complete_text_send_custody_v365'::pg_catalog.regclass,
      'cinatoken_gateway.complete_text_send_starts_v365'::pg_catalog.regclass,
      'cinatoken_gateway.users'::pg_catalog.regclass,
      'cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass,
      'cinatoken_gateway.guardrail_budget_reservations'::pg_catalog.regclass,
      'cinatoken_gateway.guardrail_budget_windows'::pg_catalog.regclass)
      AND (c.relowner<>migrator_oid OR c.relkind<>'r'
        OR c.relrowsecurity OR c.relforcerowsecurity))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal
      AND t.tgname IN ('complete_text_ordinary_hold_fence_v366',
        'complete_text_guardrail_hold_fence_v366')
      GROUP BY t.tgname HAVING pg_catalog.count(*)<>1)
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
      WHERE NOT t.tgisinternal AND t.tgenabled='O' AND t.tgfoid=fence_oid
        AND t.tgname IN ('complete_text_ordinary_hold_fence_v366',
          'complete_text_guardrail_hold_fence_v366'))<>2
    OR pg_catalog.has_table_privilege(renewer_oid,
      'cinatoken_gateway.users','SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(renewer_oid,
      'cinatoken_gateway.users','SELECT,INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(renewer_oid,
      'cinatoken_gateway.user_budget_reservations','SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(renewer_oid,
      'cinatoken_gateway.user_budget_reservations','SELECT,INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(renewer_oid,
      'cinatoken_gateway.guardrail_budget_reservations','SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(renewer_oid,
      'cinatoken_gateway.guardrail_budget_reservations','SELECT,INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(renewer_oid,
      'cinatoken_gateway.guardrail_budget_windows','SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(renewer_oid,
      'cinatoken_gateway.guardrail_budget_windows','SELECT,INSERT,UPDATE')
    OR pg_catalog.has_function_privilege(renewer_oid,
      'cinatoken_gateway.grant_complete_flat_text_attempt_v362(uuid,jsonb)','EXECUTE')
    OR pg_catalog.has_function_privilege(renewer_oid,
      'cinatoken_gateway.record_complete_text_send_start_v365(uuid,uuid,bigint,text)','EXECUTE')
    OR pg_catalog.has_function_privilege(renewer_oid,
      'cinatoken_gateway.forfeit_guardrail_budgets_v353(text,text)','EXECUTE')
    OR pg_catalog.has_function_privilege(renewer_oid,
      'cinatoken_gateway.forfeit_user_budget_dispatched_v354(text,timestamptz,text)','EXECUTE')
    OR (pg_catalog.to_regprocedure(
      'cinatoken_gateway.append_complete_text_provider_bill_v366(uuid,uuid,jsonb,text)')
      IS NOT NULL AND pg_catalog.has_function_privilege(renewer_oid,
      'cinatoken_gateway.append_complete_text_provider_bill_v366(uuid,uuid,jsonb,text)',
      'EXECUTE'))
  THEN RAISE EXCEPTION 'complete text all-hold renewal v367 activation or role differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

-- Immutable custody and original send-start remain at epoch 1. Each row below
-- is the sole committed successor from its prior epoch; the transaction ID is
-- used only by the reservation fence while this transaction is still open.
CREATE TABLE cinatoken_gateway.complete_text_hold_renewals_v367 (
  grant_id uuid NOT NULL REFERENCES
    cinatoken_gateway.complete_text_attempt_grants_v362(grant_id),
  lease_epoch bigint NOT NULL CHECK (lease_epoch BETWEEN 2 AND 9007199254740991),
  request_id text NOT NULL,
  holder_run_id uuid NOT NULL,
  send_start_id uuid NOT NULL REFERENCES
    cinatoken_gateway.complete_text_send_starts_v365(send_start_id),
  prior_lease_until timestamptz NOT NULL,
  lease_until timestamptz NOT NULL CHECK (lease_until>prior_lease_until),
  recorded_at timestamptz NOT NULL,
  writer_xid xid8 NOT NULL,
  PRIMARY KEY (grant_id,lease_epoch),
  UNIQUE (grant_id,prior_lease_until),
  CHECK (lease_until<=recorded_at+INTERVAL '15 minutes')
);
CREATE INDEX complete_text_hold_renewals_v367_request
  ON cinatoken_gateway.complete_text_hold_renewals_v367(request_id,lease_epoch);

CREATE FUNCTION cinatoken_gateway.reject_complete_text_hold_renewal_mutation_v367()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $immutable$
BEGIN
  RAISE EXCEPTION 'complete text hold renewal v367 is append-only'
    USING ERRCODE='23514',CONSTRAINT='complete_text_hold_renewal_append_v367';
END;
$immutable$;
CREATE TRIGGER complete_text_hold_renewals_v367_no_mutation
  BEFORE UPDATE OR DELETE ON cinatoken_gateway.complete_text_hold_renewals_v367
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_gateway.reject_complete_text_hold_renewal_mutation_v367();

-- Replace the v366 freeze in this SAME activation transaction. Its one
-- exception requires the isolated renewer session, an exact expires_at-only
-- update and an append row made by that very transaction. A caller-set GUC is
-- never authorization. Future closers must replace this fence atomically too.
CREATE OR REPLACE FUNCTION
  cinatoken_gateway.reject_complete_text_enrolled_hold_mutation_v366()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $fence$
DECLARE old_request text; new_request text; has_grant boolean;
BEGIN
  old_request:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.request_id END;
  new_request:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE NEW.request_id END;
  SELECT EXISTS (SELECT 1 FROM cinatoken_gateway.complete_text_attempt_grants_v362
    WHERE request_id=old_request OR request_id=new_request) INTO has_grant;
  IF NOT has_grant THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE'
    AND SESSION_USER='cinatoken_gateway_complete_text_hold_renewer'
    AND OLD.request_id IS NOT DISTINCT FROM NEW.request_id
    AND (pg_catalog.to_jsonb(NEW)-'expires_at')
      IS NOT DISTINCT FROM (pg_catalog.to_jsonb(OLD)-'expires_at')
    AND NEW.expires_at>OLD.expires_at
    AND EXISTS (
      SELECT 1 FROM cinatoken_gateway.complete_text_hold_renewals_v367 renewal
      WHERE renewal.request_id=OLD.request_id
        AND renewal.prior_lease_until=OLD.expires_at
        AND renewal.lease_until=NEW.expires_at
        AND renewal.writer_xid=pg_catalog.pg_current_xact_id()
        AND EXISTS (SELECT 1 FROM
          cinatoken_gateway.complete_text_attempt_grants_v362 grant_row
          WHERE grant_row.grant_id=renewal.grant_id
            AND grant_row.request_id=OLD.request_id))
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'grant-linked complete text hold requires atomic closer or renewal'
    USING ERRCODE='23514',CONSTRAINT='complete_text_enrolled_hold_v366';
END;
$fence$;

CREATE FUNCTION cinatoken_gateway.renew_complete_text_holds_v367(
  p_grant_id uuid,p_holder_run_id uuid,p_send_start_id uuid,
  p_expected_epoch bigint)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
SET lock_timeout TO '2s'
SET statement_timeout TO '15s' AS $renew$
DECLARE request_key text; grant_row record; custody record; send_start record;
DECLARE quote_row record; admission record; account record; ordinary record;
DECLARE held record; window_row record; intent record; prior record;
DECLARE latest_epoch bigint; prior_deadline timestamptz;
DECLARE new_deadline timestamptz; server_now timestamptz;
DECLARE guardrail_count integer:=0; affected integer; active_micros bigint;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_complete_text_hold_renewer'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_grant_id IS NULL OR p_holder_run_id IS NULL
    OR p_send_start_id IS NULL OR p_expected_epoch IS NULL
    OR p_expected_epoch NOT BETWEEN 1 AND 9007199254740990
  THEN RAISE EXCEPTION 'invalid complete text renewal call'
    USING ERRCODE='23514',CONSTRAINT='complete_text_renewal_call_v367'; END IF;
  -- The grant is immutable. Read the request key before its advisory lock and
  -- then re-read every binding under that lock.
  SELECT request_id INTO request_key FROM
    cinatoken_gateway.complete_text_attempt_grants_v362
    WHERE grant_id=p_grant_id;
  IF request_key IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status','missing_grant'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(348,pg_catalog.hashtext(request_key));
  SELECT * INTO grant_row FROM cinatoken_gateway.complete_text_attempt_grants_v362
    WHERE grant_id=p_grant_id AND request_id=request_key FOR SHARE;
  SELECT * INTO custody FROM cinatoken_gateway.complete_text_send_custody_v365
    WHERE grant_id=p_grant_id FOR SHARE;
  SELECT * INTO send_start FROM cinatoken_gateway.complete_text_send_starts_v365
    WHERE grant_id=p_grant_id FOR SHARE;
  IF grant_row.grant_id IS NULL OR custody.grant_id IS NULL
    OR send_start.grant_id IS NULL
    OR grant_row.obligation_state IS DISTINCT FROM 'unknown'
    OR custody.request_id IS DISTINCT FROM request_key
    OR custody.holder_run_id IS DISTINCT FROM p_holder_run_id
    OR custody.lease_epoch IS DISTINCT FROM 1
    OR custody.mode IS DISTINCT FROM 'active'
    OR send_start.request_id IS DISTINCT FROM request_key
    OR send_start.holder_run_id IS DISTINCT FROM p_holder_run_id
    OR send_start.send_start_id IS DISTINCT FROM p_send_start_id
    OR send_start.lease_epoch IS DISTINCT FROM 1
    OR send_start.outbound_body_sha256
      IS DISTINCT FROM grant_row.outbound_body_sha256
  THEN RETURN pg_catalog.jsonb_build_object('status','holder_binding_differs'); END IF;
  SELECT * INTO prior FROM cinatoken_gateway.complete_text_hold_renewals_v367
    WHERE grant_id=p_grant_id AND lease_epoch=p_expected_epoch+1 FOR SHARE;
  IF FOUND THEN
    IF prior.request_id IS DISTINCT FROM request_key
      OR prior.holder_run_id IS DISTINCT FROM p_holder_run_id
      OR prior.send_start_id IS DISTINCT FROM p_send_start_id
    THEN RETURN pg_catalog.jsonb_build_object('status','holder_binding_differs'); END IF;
    -- A replay after uncertain COMMIT does not grant another stream interval.
    RETURN pg_catalog.jsonb_build_object('status','already_recorded');
  END IF;
  SELECT COALESCE(pg_catalog.max(lease_epoch),1) INTO latest_epoch
    FROM cinatoken_gateway.complete_text_hold_renewals_v367
    WHERE grant_id=p_grant_id;
  IF latest_epoch<>p_expected_epoch
  THEN RETURN pg_catalog.jsonb_build_object('status','stale_epoch'); END IF;
  IF latest_epoch=1 THEN
    prior_deadline:=grant_row.hold_recovery_expires_at;
    IF custody.lease_until IS DISTINCT FROM prior_deadline
    THEN RETURN pg_catalog.jsonb_build_object('status','holder_binding_differs'); END IF;
  ELSE
    SELECT lease_until INTO prior_deadline FROM
      cinatoken_gateway.complete_text_hold_renewals_v367
      WHERE grant_id=p_grant_id AND lease_epoch=latest_epoch;
  END IF;
  SELECT * INTO quote_row FROM cinatoken_gateway.complete_text_quotes_v360
    WHERE request_id=request_key AND quote_id=grant_row.quote_id FOR SHARE;
  SELECT * INTO admission FROM cinatoken_gateway.complete_text_admissions_v361
    WHERE request_id=request_key AND quote_id=grant_row.quote_id FOR SHARE;
  IF quote_row.quote_id IS NULL OR admission.quote_id IS NULL
    OR admission.final_body_sha256 IS DISTINCT FROM grant_row.final_body_sha256
    OR admission.reserved_micros
      IS DISTINCT FROM quote_row.three_attempt_ceiling_micros
    OR admission.guardrail_count IS DISTINCT FROM
      pg_catalog.jsonb_array_length(admission.guardrail_intents)
    OR admission.ordinary_status NOT IN ('reserved','unlimited')
    OR (SELECT pg_catalog.count(*) FROM
      cinatoken_gateway.complete_text_attempt_grants_v362
      WHERE request_id=request_key)<>1
  THEN RETURN pg_catalog.jsonb_build_object('status','admission_differs'); END IF;

  -- Account -> reservation TABLE ROW EXCLUSIVE -> exact reservation rows ->
  -- Guardrail window rows. This order avoids the v365 table/window cycle.
  SELECT * INTO account FROM cinatoken_gateway.users
    WHERE id=quote_row.user_id FOR UPDATE;
  IF account.id IS NULL OR account.status IS DISTINCT FROM 'active'
    OR account.budget_epoch IS DISTINCT FROM quote_row.budget_epoch
    OR account.charged_cost_factors IS NOT NULL
  THEN RETURN pg_catalog.jsonb_build_object('status','account_differs'); END IF;
  LOCK TABLE cinatoken_gateway.user_budget_reservations,
    cinatoken_gateway.guardrail_budget_reservations IN ROW EXCLUSIVE MODE;
  SELECT * INTO ordinary FROM cinatoken_gateway.user_budget_reservations
    WHERE request_id=request_key FOR UPDATE;
  IF admission.ordinary_status='reserved' THEN
    IF ordinary.request_id IS NULL
      OR ordinary.user_id IS DISTINCT FROM quote_row.user_id
      OR ordinary.api_key_id IS DISTINCT FROM quote_row.api_key_id
      OR ordinary.budget_epoch IS DISTINCT FROM quote_row.budget_epoch
      OR ordinary.reserved_micros IS DISTINCT FROM admission.reserved_micros
      OR ordinary.settled_micros<>0 OR ordinary.state IS DISTINCT FROM 'dispatched'
      OR ordinary.dispatched_at IS NULL OR ordinary.terminal_at IS NOT NULL
      OR ordinary.terminal_reason IS NOT NULL
      OR ordinary.expires_at IS DISTINCT FROM prior_deadline
      OR account.budget_max IS NULL
    THEN RETURN pg_catalog.jsonb_build_object('status','ordinary_hold_differs'); END IF;
    SELECT COALESCE(pg_catalog.sum(reserved_micros),0)::bigint
      INTO active_micros FROM cinatoken_gateway.user_budget_reservations
      WHERE user_id=quote_row.user_id AND budget_epoch=quote_row.budget_epoch
        AND state IN ('reserved','dispatched');
    IF active_micros IS DISTINCT FROM account.budget_reserved_micros
    THEN RETURN pg_catalog.jsonb_build_object('status','ordinary_counter_differs'); END IF;
  ELSE
    IF ordinary.request_id IS NOT NULL OR account.budget_max IS NOT NULL
    THEN RETURN pg_catalog.jsonb_build_object('status','unlimited_source_differs'); END IF;
  END IF;
  FOR intent IN SELECT * FROM pg_catalog.jsonb_to_recordset(
      admission.guardrail_intents) AS x(
      "workspaceId" text,"assignmentId" text,"guardrailId" text,
      "guardrailVersion" integer,"scopeType" text,"scopeId" text,
      period text,"periodStart" timestamptz,"periodEnd" timestamptz,
      "limitMicros" bigint)
    ORDER BY "workspaceId","scopeType","scopeId",period,"periodStart",
      "assignmentId"
  LOOP
    guardrail_count:=guardrail_count+1;
    SELECT * INTO held FROM cinatoken_gateway.guardrail_budget_reservations
      WHERE request_id=request_key AND assignment_id=intent."assignmentId"
      FOR UPDATE;
    IF held.id IS NULL
      OR intent."workspaceId" IS DISTINCT FROM quote_row.workspace_id
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
      OR held.settled_micros<>0
      OR held.settlement_basis IS DISTINCT FROM 'charged'
      OR held.state IS DISTINCT FROM 'dispatched'
      OR held.dispatched_at IS NULL OR held.terminal_at IS NOT NULL
      OR held.terminal_reason IS NOT NULL
      OR held.expires_at IS DISTINCT FROM prior_deadline
    THEN RETURN pg_catalog.jsonb_build_object('status','guardrail_hold_differs'); END IF;
    SELECT * INTO window_row FROM cinatoken_gateway.guardrail_budget_windows
      WHERE workspace_id=held.workspace_id AND scope_type=held.scope_type
        AND scope_id=held.scope_id AND period=held.period
        AND period_start=held.period_start FOR UPDATE;
    SELECT COALESCE(pg_catalog.sum(reserved_micros),0)::bigint
      INTO active_micros FROM cinatoken_gateway.guardrail_budget_reservations
      WHERE workspace_id=held.workspace_id AND scope_type=held.scope_type
        AND scope_id=held.scope_id AND period=held.period
        AND period_start=held.period_start
        AND state IN ('reserved','dispatched');
    IF window_row.workspace_id IS NULL
      OR window_row.period_end IS DISTINCT FROM held.period_end
      OR window_row.reserved_micros IS DISTINCT FROM active_micros
    THEN RETURN pg_catalog.jsonb_build_object('status','guardrail_counter_differs'); END IF;
  END LOOP;
  IF guardrail_count<>admission.guardrail_count
    OR (SELECT pg_catalog.count(*) FROM
      cinatoken_gateway.guardrail_budget_reservations
      WHERE request_id=request_key)<>guardrail_count
  THEN RETURN pg_catalog.jsonb_build_object('status','guardrail_count_differs'); END IF;

  -- Re-read the clock AFTER every blocking lock. The old deadline must still
  -- be live; no caller-provided timestamp can revive it.
  server_now:=pg_catalog.clock_timestamp();
  new_deadline:=server_now+INTERVAL '15 minutes';
  IF prior_deadline<=server_now
  THEN RETURN pg_catalog.jsonb_build_object('status','lease_expired'); END IF;
  IF new_deadline<=prior_deadline
  THEN RETURN pg_catalog.jsonb_build_object('status','no_extension'); END IF;
  INSERT INTO cinatoken_gateway.complete_text_hold_renewals_v367
    (grant_id,lease_epoch,request_id,holder_run_id,send_start_id,
      prior_lease_until,lease_until,recorded_at,writer_xid)
    VALUES(p_grant_id,p_expected_epoch+1,request_key,p_holder_run_id,
      p_send_start_id,prior_deadline,new_deadline,server_now,
      pg_catalog.pg_current_xact_id());
  IF admission.ordinary_status='reserved' THEN
    UPDATE cinatoken_gateway.user_budget_reservations
      SET expires_at=new_deadline
      WHERE request_id=request_key AND state='dispatched'
        AND expires_at=prior_deadline;
    GET DIAGNOSTICS affected=ROW_COUNT;
    IF affected<>1 THEN RAISE EXCEPTION 'ordinary renewal raced'
      USING ERRCODE='23514',CONSTRAINT='complete_text_all_hold_renewal_v367'; END IF;
  END IF;
  UPDATE cinatoken_gateway.guardrail_budget_reservations
    SET expires_at=new_deadline
    WHERE request_id=request_key AND state='dispatched'
      AND expires_at=prior_deadline;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>guardrail_count THEN RAISE EXCEPTION 'Guardrail renewal raced'
    USING ERRCODE='23514',CONSTRAINT='complete_text_all_hold_renewal_v367'; END IF;
  RETURN pg_catalog.jsonb_build_object('status','renewal_recorded',
    'grantId',p_grant_id,'holderRunId',p_holder_run_id,
    'sendStartId',p_send_start_id,'leaseEpoch',p_expected_epoch+1,
    'leaseUntil',new_deadline);
END;
$renew$;

REVOKE ALL ON cinatoken_gateway.complete_text_hold_renewals_v367
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_budget_admission,
    cinatoken_gateway_budget_recovery,
    cinatoken_gateway_buyer_settlement,
    cinatoken_gateway_complete_text_attempt_granter,
    cinatoken_gateway_complete_text_send_holder,
    cinatoken_gateway_complete_text_hold_renewer;
REVOKE ALL ON FUNCTION
  cinatoken_gateway.renew_complete_text_holds_v367(uuid,uuid,uuid,bigint),
  cinatoken_gateway.reject_complete_text_hold_renewal_mutation_v367()
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_budget_admission,
    cinatoken_gateway_budget_recovery,
    cinatoken_gateway_buyer_settlement,
    cinatoken_gateway_complete_text_attempt_granter,
    cinatoken_gateway_complete_text_send_holder,
    cinatoken_gateway_complete_text_hold_renewer;
GRANT USAGE ON SCHEMA cinatoken_gateway
  TO cinatoken_gateway_complete_text_hold_renewer;
GRANT EXECUTE ON FUNCTION
  cinatoken_gateway.renew_complete_text_holds_v367(uuid,uuid,uuid,bigint)
  TO cinatoken_gateway_complete_text_hold_renewer;

DO $postflight$
BEGIN
  IF NOT pg_catalog.has_function_privilege(
      'cinatoken_gateway_complete_text_hold_renewer',
      'cinatoken_gateway.renew_complete_text_holds_v367(uuid,uuid,uuid,bigint)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
      'cinatoken_gateway.renew_complete_text_holds_v367(uuid,uuid,uuid,bigint)',
      'EXECUTE')
    OR pg_catalog.has_table_privilege(
      'cinatoken_gateway_complete_text_hold_renewer',
      'cinatoken_gateway.complete_text_hold_renewals_v367',
      'SELECT,INSERT,UPDATE,DELETE')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
      WHERE NOT t.tgisinternal AND t.tgenabled='O'
        AND t.tgname IN ('complete_text_ordinary_hold_fence_v366',
          'complete_text_guardrail_hold_fence_v366')
        AND t.tgfoid='cinatoken_gateway.reject_complete_text_enrolled_hold_mutation_v366()'::pg_catalog.regprocedure)<>2
  THEN RAISE EXCEPTION 'complete text all-hold renewal v367 postflight differs'
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
