-- REVIEW ONLY. A complete local no-fetch buyer terminal, not production cutover.
-- Requires PG73, v370 no-fetch, v367 renewal, and v368/v371/v372/v380 buyer ACLs.
-- The independently authenticated provider bill/actual/late adjustment paths
-- remain outside this zero-buyer-debit branch. Supplier cost is NOT asserted.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923588);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.complete_text_attempt_grants_v362,
  cinatoken_gateway.complete_text_no_fetch_resolutions_v370,
  cinatoken_gateway.complete_text_send_starts_v365,
  cinatoken_gateway.complete_text_hold_renewals_v367,
  cinatoken_gateway.users,cinatoken_gateway.user_budget_reservations,
  cinatoken_gateway.guardrail_budget_reservations,
  cinatoken_gateway.guardrail_budget_windows,
  cinatoken_gateway.api_key_request_logs IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE closer_oid oid; owner_oid oid;
BEGIN
  SELECT oid INTO closer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_complete_text_platform_closer';
  SELECT oid INTO owner_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  IF SESSION_USER<>'cinatoken_gateway_migrator' OR CURRENT_USER<>SESSION_USER
    OR pg_catalog.current_setting('cinatoken.complete_text_no_fetch_close_v388_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR closer_oid IS NULL OR owner_oid IS NULL
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n' ORDER BY version COLLATE "C"))
      FROM cinatoken_gateway.schema_migrations)<>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR (SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname='cinatoken_gateway')<>owner_oid
    OR (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb
      AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit
      FROM pg_catalog.pg_roles WHERE oid=closer_oid) IS DISTINCT FROM true
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid=closer_oid OR member=closer_oid)
    OR pg_catalog.has_schema_privilege(closer_oid,'cinatoken_gateway','CREATE')
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('cinatoken_gateway','cinatoken_economic_outbox','cinatoken_economic_quotes','cinatoken_economic_consumer')
        AND c.relkind IN ('r','p','v','m','f')
        AND (pg_catalog.has_table_privilege(closer_oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR pg_catalog.has_any_column_privilege(closer_oid,c.oid,'SELECT,INSERT,UPDATE')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='cinatoken_gateway' AND pg_catalog.has_function_privilege(closer_oid,p.oid,'EXECUTE'))
    OR pg_catalog.has_any_column_privilege('cinatoken_gateway_buyer_settlement','cinatoken_gateway.users','UPDATE')
    OR pg_catalog.has_any_column_privilege('cinatoken_gateway_buyer_settlement','cinatoken_gateway.user_budget_reservations','UPDATE')
    OR pg_catalog.has_any_column_privilege('cinatoken_gateway_buyer_settlement','cinatoken_gateway.guardrail_budget_windows','UPDATE')
    OR pg_catalog.has_any_column_privilege('cinatoken_gateway_buyer_settlement','cinatoken_gateway.guardrail_budget_reservations','UPDATE')
    OR pg_catalog.to_regprocedure('cinatoken_gateway.buyer_split_counter_policy_v368()') IS NULL
    OR pg_catalog.to_regprocedure('cinatoken_gateway.settle_legacy_buyer_windowed_v371(text,text)') IS NULL
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname IN (
      'cinatoken_gateway_buyer_settlement','cinatoken_gateway_runtime') AND
      (NOT rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r
      ON r.oid=m.member OR r.oid=m.roleid WHERE r.rolname IN (
        'cinatoken_gateway_buyer_settlement','cinatoken_gateway_runtime'))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_class c
      WHERE r.rolname IN ('cinatoken_gateway_buyer_settlement','cinatoken_gateway_runtime')
        AND c.oid IN ('cinatoken_gateway.users'::pg_catalog.regclass,
          'cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass,
          'cinatoken_gateway.guardrail_budget_reservations'::pg_catalog.regclass,
          'cinatoken_gateway.guardrail_budget_windows'::pg_catalog.regclass)
        AND (pg_catalog.has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR pg_catalog.has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE')))
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE
      oid='cinatoken_gateway.buyer_split_grant_policy_v348()'::pg_catalog.regprocedure
      AND proowner=owner_oid AND prosrc=$marker$SELECT 'buyer_split_superseded_v368'::text$marker$)
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE
      oid='cinatoken_gateway.buyer_split_guardrail_grant_policy_v349()'::pg_catalog.regprocedure
      AND proowner=owner_oid AND prosrc=$marker$SELECT 'buyer_guardrail_superseded_v368'::text$marker$)
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal AND t.tgqual IS NULL
      AND t.tgattr::text='' AND (t.tgrelid,t.tgname,t.tgfoid,t.tgenabled,t.tgtype) IN (
        ('cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass,'legacy_buyer_admitted_log_fence_v380',
          'cinatoken_gateway.reject_legacy_buyer_admitted_log_v380()'::pg_catalog.regprocedure,'O',7),
        ('cinatoken_gateway.complete_text_admissions_v361'::pg_catalog.regclass,'complete_text_preexisting_log_fence_v380',
          'cinatoken_gateway.reject_complete_text_preexisting_log_v380()'::pg_catalog.regprocedure,'O',7),
        ('cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass,'legacy_buyer_admitted_hold_fence_v380',
          'cinatoken_gateway.reject_legacy_buyer_admitted_hold_v380()'::pg_catalog.regprocedure,'O',19)))<>3
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE
      oid='cinatoken_gateway.reject_complete_text_enrolled_hold_mutation_v366()'::pg_catalog.regprocedure
      AND proowner=owner_oid AND prosecdef AND
      pg_catalog.md5(pg_catalog.replace(prosrc,E'\r\n',E'\n'))='fbb71177d61d3e668bea3b662a5769f5')
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE
      oid='cinatoken_gateway.reject_complete_text_fenced_send_v370()'::pg_catalog.regprocedure
      AND proowner=owner_oid AND prosecdef AND
      pg_catalog.md5(pg_catalog.replace(prosrc,E'\r\n',E'\n'))='b6a66a0e0c0bda5cdd7a10db04c87188')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal AND t.tgqual IS NULL
      AND t.tgattr::text='' AND (t.tgrelid,t.tgname,t.tgfoid,t.tgenabled,t.tgtype) IN (
        ('cinatoken_gateway.complete_text_send_custody_v365'::pg_catalog.regclass,'complete_text_send_custody_v370_no_fetch_fence',
          'cinatoken_gateway.reject_complete_text_fenced_send_v370()'::pg_catalog.regprocedure,'O',7),
        ('cinatoken_gateway.complete_text_send_starts_v365'::pg_catalog.regclass,'complete_text_send_starts_v370_no_fetch_fence',
          'cinatoken_gateway.reject_complete_text_fenced_send_v370()'::pg_catalog.regprocedure,'O',7),
        ('cinatoken_gateway.complete_text_no_fetch_resolutions_v370'::pg_catalog.regclass,'complete_text_no_fetch_resolutions_v370_no_mutation',
          'cinatoken_gateway.reject_complete_text_no_fetch_mutation_v370()'::pg_catalog.regprocedure,'O',27),
        ('cinatoken_gateway.complete_text_no_fetch_resolutions_v370'::pg_catalog.regclass,'complete_text_no_fetch_resolutions_v370_no_truncate',
          'cinatoken_gateway.reject_complete_text_no_fetch_mutation_v370()'::pg_catalog.regprocedure,'O',34),
        ('cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass,'complete_text_ordinary_hold_fence_v366',
          'cinatoken_gateway.reject_complete_text_enrolled_hold_mutation_v366()'::pg_catalog.regprocedure,'O',31),
        ('cinatoken_gateway.guardrail_budget_reservations'::pg_catalog.regclass,'complete_text_guardrail_hold_fence_v366',
          'cinatoken_gateway.reject_complete_text_enrolled_hold_mutation_v366()'::pg_catalog.regprocedure,'O',31)))<>6
    OR pg_catalog.to_regclass('cinatoken_gateway.complete_text_platform_terminals_v388') IS NOT NULL
  THEN RAISE EXCEPTION 'complete text no-fetch closer v388 activation or dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

CREATE TABLE cinatoken_gateway.complete_text_platform_terminals_v388 (
  terminal_id uuid PRIMARY KEY,
  request_id text NOT NULL UNIQUE,
  grant_id uuid NOT NULL UNIQUE REFERENCES cinatoken_gateway.complete_text_attempt_grants_v362(grant_id),
  resolution_id uuid NOT NULL UNIQUE REFERENCES cinatoken_gateway.complete_text_no_fetch_resolutions_v370(resolution_id),
  quote_id uuid NOT NULL,
  decision_nonce uuid NOT NULL UNIQUE,
  decision_sha256 text NOT NULL CHECK(decision_sha256 ~ '^[0-9a-f]{64}$'),
  event_id uuid NOT NULL UNIQUE,
  decision jsonb NOT NULL,
  buyer_charged_micros bigint NOT NULL CHECK(buyer_charged_micros=0),
  supplier_cost_status text NOT NULL CHECK(supplier_cost_status='not_asserted'),
  supplier_cost_micros bigint CHECK(supplier_cost_micros IS NULL),
  ordinary_before jsonb,
  guardrails_before jsonb NOT NULL,
  account_before jsonb NOT NULL,
  windows_before jsonb NOT NULL,
  expected_log jsonb NOT NULL,
  closed_at timestamptz NOT NULL,
  writer_xid xid8 NOT NULL
);
CREATE TABLE cinatoken_gateway.complete_text_platform_outbox_v388 (
  event_id uuid PRIMARY KEY,
  terminal_id uuid NOT NULL UNIQUE REFERENCES cinatoken_gateway.complete_text_platform_terminals_v388(terminal_id),
  request_id text NOT NULL UNIQUE,
  event_type text NOT NULL CHECK(event_type='platform_text_no_fetch_closed'),
  event_version integer NOT NULL CHECK(event_version=1),
  payload jsonb NOT NULL,
  payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  writer_xid xid8 NOT NULL
);

CREATE FUNCTION cinatoken_gateway.protect_platform_close_rows_v388()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,pg_temp AS $protect$
BEGIN
  IF TG_OP<>'INSERT' OR SESSION_USER<>'cinatoken_gateway_complete_text_platform_closer'
    OR NEW.writer_xid IS DISTINCT FROM pg_catalog.pg_current_xact_id()
  THEN RAISE EXCEPTION 'platform no-fetch terminal and event are protected append-only rows'
    USING ERRCODE='23514',CONSTRAINT='platform_close_immutable_v388'; END IF;
  RETURN NEW;
END;
$protect$;
CREATE TRIGGER platform_terminal_rows_v388 BEFORE INSERT OR UPDATE OR DELETE
  ON cinatoken_gateway.complete_text_platform_terminals_v388 FOR EACH ROW
  EXECUTE FUNCTION cinatoken_gateway.protect_platform_close_rows_v388();
CREATE TRIGGER platform_event_rows_v388 BEFORE INSERT OR UPDATE OR DELETE
  ON cinatoken_gateway.complete_text_platform_outbox_v388 FOR EACH ROW
  EXECUTE FUNCTION cinatoken_gateway.protect_platform_close_rows_v388();
CREATE TRIGGER platform_terminal_truncate_v388 BEFORE TRUNCATE
  ON cinatoken_gateway.complete_text_platform_terminals_v388 FOR EACH STATEMENT
  EXECUTE FUNCTION cinatoken_gateway.protect_platform_close_rows_v388();
CREATE TRIGGER platform_event_truncate_v388 BEFORE TRUNCATE
  ON cinatoken_gateway.complete_text_platform_outbox_v388 FOR EACH STATEMENT
  EXECUTE FUNCTION cinatoken_gateway.protect_platform_close_rows_v388();

-- v370 already permanently fences custody/start. This additional table fence
-- prevents a future caller from attaching another grant/renewal to a terminal.
CREATE FUNCTION cinatoken_gateway.reject_platform_terminal_egress_v388()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,pg_temp AS $egress$
DECLARE request_key text;
BEGIN
  IF TG_TABLE_NAME='complete_text_attempt_grants_v362' THEN request_key:=NEW.request_id;
  ELSE
    SELECT request_id INTO request_key FROM cinatoken_gateway.complete_text_attempt_grants_v362
      WHERE grant_id=NEW.grant_id;
    IF request_key IS DISTINCT FROM NEW.request_id THEN RAISE EXCEPTION 'platform grant identity differs'
      USING ERRCODE='23514',CONSTRAINT='platform_terminal_egress_v388'; END IF;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(348,pg_catalog.hashtext(request_key));
  IF TG_TABLE_NAME='complete_text_result_facts_v366' THEN
    IF NEW.source_kind='provider_bill' THEN RETURN NEW; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_platform_terminals_v388 WHERE request_id=request_key)
  THEN RAISE EXCEPTION 'platform terminal cannot acquire egress authority'
    USING ERRCODE='23514',CONSTRAINT='platform_terminal_egress_v388'; END IF;
  RETURN NEW;
END;
$egress$;
CREATE TRIGGER platform_terminal_grant_v388 BEFORE INSERT
  ON cinatoken_gateway.complete_text_attempt_grants_v362 FOR EACH ROW
  EXECUTE FUNCTION cinatoken_gateway.reject_platform_terminal_egress_v388();
CREATE TRIGGER platform_terminal_renewal_v388 BEFORE INSERT
  ON cinatoken_gateway.complete_text_hold_renewals_v367 FOR EACH ROW
  EXECUTE FUNCTION cinatoken_gateway.reject_platform_terminal_egress_v388();
CREATE TRIGGER platform_terminal_holder_fact_v388 BEFORE INSERT
  ON cinatoken_gateway.complete_text_result_facts_v366 FOR EACH ROW
  EXECUTE FUNCTION cinatoken_gateway.reject_platform_terminal_egress_v388();

-- Preserve v367's renewal exception and add only the exact current-terminal
-- zero transition. No caller GUC, raw receipt or supplied amount is authority.
CREATE OR REPLACE FUNCTION cinatoken_gateway.reject_complete_text_enrolled_hold_mutation_v366()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO pg_catalog,pg_temp AS $fence$
DECLARE old_request text; new_request text; terminal record; before_row jsonb;
BEGIN
  old_request:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.request_id END;
  new_request:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE NEW.request_id END;
  IF NOT EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_attempt_grants_v362
    WHERE request_id=old_request OR request_id=new_request) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' AND SESSION_USER='cinatoken_gateway_complete_text_hold_renewer'
    AND OLD.request_id IS NOT DISTINCT FROM NEW.request_id
    AND (pg_catalog.to_jsonb(NEW)-'expires_at') IS NOT DISTINCT FROM (pg_catalog.to_jsonb(OLD)-'expires_at')
    AND NEW.expires_at>OLD.expires_at
    AND NOT EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_platform_terminals_v388 WHERE request_id=OLD.request_id)
    AND EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_hold_renewals_v367 r
      WHERE r.request_id=OLD.request_id AND r.prior_lease_until=OLD.expires_at
        AND r.lease_until=NEW.expires_at AND r.writer_xid=pg_catalog.pg_current_xact_id()
        AND EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_attempt_grants_v362 g
          WHERE g.grant_id=r.grant_id AND g.request_id=OLD.request_id))
  THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND SESSION_USER='cinatoken_gateway_complete_text_platform_closer' THEN
    SELECT * INTO terminal FROM cinatoken_gateway.complete_text_platform_terminals_v388
      WHERE request_id=OLD.request_id AND writer_xid=pg_catalog.pg_current_xact_id();
    IF terminal.terminal_id IS NOT NULL THEN
      IF TG_TABLE_NAME='user_budget_reservations' THEN before_row:=terminal.ordinary_before;
      ELSE SELECT value INTO before_row FROM pg_catalog.jsonb_array_elements(terminal.guardrails_before)
        WHERE value->>'id'=OLD.id; END IF;
      IF before_row IS NOT DISTINCT FROM pg_catalog.to_jsonb(OLD)
        AND pg_catalog.to_jsonb(NEW) IS NOT DISTINCT FROM (before_row || pg_catalog.jsonb_build_object(
          'state','settled','settled_micros',0,'terminal_at',terminal.closed_at,
          'terminal_reason','platform_verified_no_fetch_v388','updated_at',terminal.closed_at))
      THEN RETURN NEW; END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'grant-linked complete text hold requires exact atomic closer or renewal'
    USING ERRCODE='23514',CONSTRAINT='complete_text_enrolled_hold_v366';
END;
$fence$;

CREATE FUNCTION cinatoken_gateway.protect_platform_buyer_log_v388()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,pg_temp AS $log$
DECLARE terminal record; request_key text;
BEGIN
  IF TG_OP='TRUNCATE' THEN
    IF EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_platform_terminals_v388)
    THEN RAISE EXCEPTION 'platform buyer logs cannot be truncated'
      USING ERRCODE='23514',CONSTRAINT='platform_buyer_log_v388'; END IF;
    RETURN NULL;
  END IF;
  request_key:=CASE WHEN TG_OP='INSERT' THEN NEW.id ELSE OLD.id END;
  SELECT * INTO terminal FROM cinatoken_gateway.complete_text_platform_terminals_v388
    WHERE request_id=request_key OR (TG_OP='UPDATE' AND request_id=NEW.id);
  IF terminal.terminal_id IS NULL THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
  END IF;
  IF TG_OP<>'INSERT' OR SESSION_USER<>'cinatoken_gateway_complete_text_platform_closer'
    OR terminal.writer_xid<>pg_catalog.pg_current_xact_id()
    OR NOT (pg_catalog.to_jsonb(NEW) @> terminal.expected_log)
  THEN RAISE EXCEPTION 'platform buyer log is immutable and bound to terminal'
    USING ERRCODE='23514',CONSTRAINT='platform_buyer_log_v388'; END IF;
  RETURN NEW;
END;
$log$;
CREATE TRIGGER platform_buyer_log_rows_v388 BEFORE INSERT OR UPDATE OR DELETE
  ON cinatoken_gateway.api_key_request_logs FOR EACH ROW
  EXECUTE FUNCTION cinatoken_gateway.protect_platform_buyer_log_v388();
CREATE TRIGGER platform_buyer_log_truncate_v388 BEFORE TRUNCATE
  ON cinatoken_gateway.api_key_request_logs FOR EACH STATEMENT
  EXECUTE FUNCTION cinatoken_gateway.protect_platform_buyer_log_v388();

CREATE FUNCTION cinatoken_gateway.verify_platform_close_v388()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,pg_temp AS $verify$
DECLARE terminal record; current_json jsonb; expected jsonb; item jsonb; active numeric;
BEGIN
  SELECT * INTO terminal FROM cinatoken_gateway.complete_text_platform_terminals_v388
    WHERE terminal_id=NEW.terminal_id;
  IF terminal.terminal_id IS NULL OR terminal.writer_xid<>pg_catalog.pg_current_xact_id()
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.complete_text_attempt_grants_v362 WHERE request_id=terminal.request_id)<>1
    OR EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_send_starts_v365 WHERE request_id=terminal.request_id)
    OR NOT EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_no_fetch_resolutions_v370
      WHERE resolution_id=terminal.resolution_id AND grant_id=terminal.grant_id AND request_id=terminal.request_id)
    OR NOT EXISTS(SELECT 1 FROM cinatoken_gateway.api_key_request_logs l
      WHERE l.id=terminal.request_id AND pg_catalog.to_jsonb(l) @> terminal.expected_log)
    OR NOT EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_platform_outbox_v388 e
      WHERE e.event_id=terminal.event_id AND e.terminal_id=terminal.terminal_id AND e.request_id=terminal.request_id
        AND e.event_type='platform_text_no_fetch_closed' AND e.event_version=1
        AND e.payload=terminal.decision AND e.payload_sha256=terminal.decision_sha256
        AND e.created_at=terminal.closed_at AND e.writer_xid=terminal.writer_xid)
  THEN RAISE EXCEPTION 'platform no-fetch terminal/log/event set incomplete'
    USING ERRCODE='23514',CONSTRAINT='platform_close_complete_v388'; END IF;
  SELECT pg_catalog.to_jsonb(r) INTO current_json FROM cinatoken_gateway.user_budget_reservations r
    WHERE request_id=terminal.request_id;
  IF terminal.ordinary_before IS NULL THEN
    IF current_json IS NOT NULL THEN RAISE EXCEPTION 'unexpected ordinary hold'
      USING ERRCODE='23514',CONSTRAINT='platform_close_complete_v388'; END IF;
  ELSE
    expected:=terminal.ordinary_before || pg_catalog.jsonb_build_object('state','settled','settled_micros',0,
      'terminal_at',terminal.closed_at,'terminal_reason','platform_verified_no_fetch_v388','updated_at',terminal.closed_at);
    IF current_json IS DISTINCT FROM expected THEN RAISE EXCEPTION 'platform ordinary close differs'
      USING ERRCODE='23514',CONSTRAINT='platform_close_complete_v388'; END IF;
  END IF;
  IF (SELECT pg_catalog.count(*) FROM cinatoken_gateway.guardrail_budget_reservations
      WHERE request_id=terminal.request_id)<>pg_catalog.jsonb_array_length(terminal.guardrails_before)
  THEN RAISE EXCEPTION 'platform Guardrail close count differs'
    USING ERRCODE='23514',CONSTRAINT='platform_close_complete_v388'; END IF;
  FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(terminal.guardrails_before) LOOP
    SELECT pg_catalog.to_jsonb(r) INTO current_json FROM cinatoken_gateway.guardrail_budget_reservations r
      WHERE id=item->>'id';
    expected:=item || pg_catalog.jsonb_build_object('state','settled','settled_micros',0,
      'terminal_at',terminal.closed_at,'terminal_reason','platform_verified_no_fetch_v388','updated_at',terminal.closed_at);
    IF current_json IS DISTINCT FROM expected THEN RAISE EXCEPTION 'platform Guardrail close differs'
      USING ERRCODE='23514',CONSTRAINT='platform_close_complete_v388'; END IF;
  END LOOP;
  SELECT pg_catalog.jsonb_build_object('id',id,'budget_epoch',budget_epoch,'budget_spent',budget_spent,
    'budget_reserved_micros',budget_reserved_micros) INTO current_json FROM cinatoken_gateway.users
    WHERE id=terminal.account_before->>'id';
  expected:=terminal.account_before || pg_catalog.jsonb_build_object('budget_reserved_micros',
    (terminal.account_before->>'budget_reserved_micros')::bigint
      -COALESCE((terminal.ordinary_before->>'reserved_micros')::bigint,0));
  IF current_json IS DISTINCT FROM expected THEN RAISE EXCEPTION 'platform account delta differs'
    USING ERRCODE='23514',CONSTRAINT='platform_close_complete_v388'; END IF;
  FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(terminal.windows_before) LOOP
    SELECT pg_catalog.to_jsonb(w)-'updated_at' INTO current_json FROM cinatoken_gateway.guardrail_budget_windows w
      WHERE workspace_id=item->>'workspace_id' AND scope_type=item->>'scope_type' AND scope_id=item->>'scope_id'
        AND period=item->>'period' AND period_start=(item->>'period_start')::timestamptz;
    SELECT COALESCE(pg_catalog.sum((value->>'reserved_micros')::numeric),0) INTO active
      FROM pg_catalog.jsonb_array_elements(terminal.guardrails_before) WHERE value->>'workspace_id'=item->>'workspace_id'
        AND value->>'scope_type'=item->>'scope_type' AND value->>'scope_id'=item->>'scope_id'
        AND value->>'period'=item->>'period' AND value->>'period_start'=item->>'period_start';
    expected:=(item-'updated_at') || pg_catalog.jsonb_build_object('reserved_micros',(item->>'reserved_micros')::numeric-active);
    IF current_json IS DISTINCT FROM expected THEN RAISE EXCEPTION 'platform window delta differs'
      USING ERRCODE='23514',CONSTRAINT='platform_close_complete_v388'; END IF;
  END LOOP;
  RETURN NULL;
END;
$verify$;
CREATE CONSTRAINT TRIGGER platform_terminal_complete_v388 AFTER INSERT
  ON cinatoken_gateway.complete_text_platform_terminals_v388 DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.verify_platform_close_v388();
CREATE CONSTRAINT TRIGGER platform_event_complete_v388 AFTER INSERT
  ON cinatoken_gateway.complete_text_platform_outbox_v388 DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.verify_platform_close_v388();

CREATE FUNCTION cinatoken_gateway.close_complete_text_no_fetch_v388(
  p_grant_id uuid,p_resolution_id uuid,p_decision_nonce uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO pg_catalog,pg_temp
SET lock_timeout TO '2s' SET statement_timeout TO '15s' AS $close$
DECLARE request_key text; grant_row record; resolution record; quote_row record; admission record;
DECLARE account record; ordinary record; held record; window_row record; intent record; terminal record;
DECLARE guardrails jsonb:='[]'; windows jsonb:='[]'; ordinary_json jsonb; account_json jsonb;
DECLARE decision jsonb; expected_log jsonb; facts jsonb; decision_sha text;
DECLARE at_time timestamptz; terminal_uuid uuid; event_uuid uuid; active numeric; held_count integer:=0;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_complete_text_platform_closer'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_grant_id IS NULL OR p_resolution_id IS NULL OR p_decision_nonce IS NULL
  THEN RAISE EXCEPTION 'invalid platform no-fetch closer call'
    USING ERRCODE='23514',CONSTRAINT='platform_close_call_v388'; END IF;
  SELECT request_id INTO request_key FROM cinatoken_gateway.complete_text_attempt_grants_v362 WHERE grant_id=p_grant_id;
  IF request_key IS NULL THEN RETURN pg_catalog.jsonb_build_object('status','missing_grant'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(348,pg_catalog.hashtext(request_key));
  SELECT * INTO terminal FROM cinatoken_gateway.complete_text_platform_terminals_v388 WHERE request_id=request_key;
  IF terminal.terminal_id IS NOT NULL THEN
    IF terminal.grant_id<>p_grant_id OR terminal.resolution_id<>p_resolution_id OR terminal.decision_nonce<>p_decision_nonce
    THEN RETURN pg_catalog.jsonb_build_object('status','decision_conflict'); END IF;
    RETURN pg_catalog.jsonb_build_object('status','already_closed_no_fetch','requestId',request_key,
      'grantId',p_grant_id,'resolutionId',p_resolution_id,'terminalId',terminal.terminal_id,'eventId',terminal.event_id,
      'decisionNonce',terminal.decision_nonce,'decisionSha256',terminal.decision_sha256,'buyerChargedMicros',0,
      'supplierCostStatus','not_asserted','closedAt',terminal.closed_at);
  END IF;
  IF EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_platform_terminals_v388 WHERE decision_nonce=p_decision_nonce)
  THEN RETURN pg_catalog.jsonb_build_object('status','decision_conflict'); END IF;
  SELECT * INTO grant_row FROM cinatoken_gateway.complete_text_attempt_grants_v362 WHERE grant_id=p_grant_id FOR SHARE;
  SELECT * INTO resolution FROM cinatoken_gateway.complete_text_no_fetch_resolutions_v370
    WHERE resolution_id=p_resolution_id AND grant_id=p_grant_id FOR SHARE;
  IF resolution.resolution_id IS NULL THEN RETURN pg_catalog.jsonb_build_object('status','missing_no_fetch_resolution'); END IF;
  IF EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_send_starts_v365
    WHERE grant_id=p_grant_id OR request_id=request_key)
  THEN RETURN pg_catalog.jsonb_build_object('status','possible_send_unknown'); END IF;
  IF EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_result_facts_v366
    WHERE (grant_id=p_grant_id OR request_id=request_key) AND kind<>'no_fetch_attestation')
  THEN RETURN pg_catalog.jsonb_build_object('status','fact_contradiction_unknown'); END IF;
  SELECT * INTO quote_row FROM cinatoken_gateway.complete_text_quotes_v360
    WHERE request_id=request_key AND quote_id=grant_row.quote_id FOR SHARE;
  SELECT * INTO admission FROM cinatoken_gateway.complete_text_admissions_v361
    WHERE request_id=request_key AND quote_id=grant_row.quote_id FOR SHARE;
  IF grant_row.request_id IS DISTINCT FROM request_key OR grant_row.attempt_number<>1
    OR grant_row.obligation_state<>'unknown' OR grant_row.send_expires_at>=pg_catalog.clock_timestamp()
    OR resolution.result<>'verified_no_fetch' OR resolution.request_id<>request_key
    OR resolution.quote_id<>grant_row.quote_id OR resolution.attempt_nonce<>grant_row.attempt_nonce
    OR resolution.grant_claim_sha256<>grant_row.claim_sha256 OR resolution.outbound_body_sha256<>grant_row.outbound_body_sha256
    OR resolution.send_expires_at<>grant_row.send_expires_at
    OR quote_row.quote_id IS NULL OR admission.quote_id IS NULL
    OR admission.reserved_micros<>quote_row.three_attempt_ceiling_micros
    OR admission.final_body_sha256<>quote_row.final_body_sha256 OR grant_row.final_body_sha256<>quote_row.final_body_sha256
    OR admission.guardrail_count<>pg_catalog.jsonb_array_length(admission.guardrail_intents)
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.complete_text_attempt_grants_v362 WHERE request_id=request_key)<>1
    OR EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_hold_renewals_v367 WHERE request_id=request_key)
    OR EXISTS(SELECT 1 FROM cinatoken_gateway.api_key_request_logs WHERE id=request_key)
  THEN RETURN pg_catalog.jsonb_build_object('status','identity_differs'); END IF;
  SELECT * INTO account FROM cinatoken_gateway.users WHERE id=quote_row.user_id FOR UPDATE;
  IF account.id IS NULL OR account.budget_epoch IS DISTINCT FROM quote_row.budget_epoch
  THEN RETURN pg_catalog.jsonb_build_object('status','account_epoch_differs'); END IF;
  -- Acquire future UPDATE table locks BEFORE any window rows, including the
  -- v371 shared-window table lock. Account is locked before reservation tables.
  LOCK TABLE cinatoken_gateway.user_budget_reservations,cinatoken_gateway.guardrail_budget_reservations,
    cinatoken_gateway.guardrail_budget_windows IN ROW EXCLUSIVE MODE;
  SELECT * INTO ordinary FROM cinatoken_gateway.user_budget_reservations WHERE request_id=request_key FOR UPDATE;
  IF admission.ordinary_status='reserved' THEN
    IF ordinary.request_id IS NULL OR ordinary.user_id<>quote_row.user_id OR ordinary.api_key_id<>quote_row.api_key_id
      OR ordinary.budget_epoch<>quote_row.budget_epoch OR ordinary.reserved_micros<>admission.reserved_micros
      OR ordinary.state<>'dispatched' OR ordinary.settled_micros<>0 OR ordinary.dispatched_at IS NULL
      OR ordinary.terminal_at IS NOT NULL OR ordinary.terminal_reason IS NOT NULL
      OR ordinary.expires_at<>grant_row.hold_recovery_expires_at
    THEN RETURN pg_catalog.jsonb_build_object('status','holds_differ'); END IF;
    ordinary_json:=pg_catalog.to_jsonb(ordinary);
  ELSIF admission.ordinary_status<>'unlimited' OR ordinary.request_id IS NOT NULL
  THEN RETURN pg_catalog.jsonb_build_object('status','holds_differ'); END IF;
  SELECT COALESCE(pg_catalog.sum(reserved_micros),0) INTO active FROM cinatoken_gateway.user_budget_reservations
    WHERE user_id=quote_row.user_id AND budget_epoch=quote_row.budget_epoch AND state IN ('reserved','dispatched');
  IF active<>account.budget_reserved_micros THEN RETURN pg_catalog.jsonb_build_object('status','holds_differ'); END IF;
  account_json:=pg_catalog.jsonb_build_object('id',account.id,'budget_epoch',account.budget_epoch,
    'budget_spent',account.budget_spent,'budget_reserved_micros',account.budget_reserved_micros);
  FOR intent IN SELECT * FROM pg_catalog.jsonb_to_recordset(admission.guardrail_intents) AS x(
    "workspaceId" text,"assignmentId" text,"guardrailId" text,"guardrailVersion" integer,"scopeType" text,"scopeId" text,
    period text,"periodStart" timestamptz,"periodEnd" timestamptz,"limitMicros" bigint)
    ORDER BY "workspaceId","scopeType","scopeId",period,"periodStart","assignmentId"
  LOOP
    SELECT * INTO held FROM cinatoken_gateway.guardrail_budget_reservations
      WHERE request_id=request_key AND assignment_id=intent."assignmentId" FOR UPDATE;
    IF held.id IS NULL OR held.workspace_id IS DISTINCT FROM intent."workspaceId"
      OR held.workspace_id<>quote_row.workspace_id OR held.guardrail_id IS DISTINCT FROM intent."guardrailId"
      OR held.guardrail_version IS DISTINCT FROM intent."guardrailVersion" OR held.scope_type IS DISTINCT FROM intent."scopeType"
      OR held.scope_id IS DISTINCT FROM intent."scopeId" OR held.period IS DISTINCT FROM intent.period
      OR held.period_start IS DISTINCT FROM intent."periodStart" OR held.period_end IS DISTINCT FROM intent."periodEnd"
      OR held.limit_micros IS DISTINCT FROM intent."limitMicros" OR held.reserved_micros<>admission.reserved_micros
      OR held.settlement_basis<>'charged' OR held.state<>'dispatched' OR held.settled_micros<>0 OR held.dispatched_at IS NULL
      OR held.terminal_at IS NOT NULL OR held.terminal_reason IS NOT NULL OR held.expires_at<>grant_row.hold_recovery_expires_at
    THEN RETURN pg_catalog.jsonb_build_object('status','holds_differ'); END IF;
    guardrails:=guardrails || pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(held)); held_count:=held_count+1;
    SELECT * INTO window_row FROM cinatoken_gateway.guardrail_budget_windows WHERE workspace_id=held.workspace_id
      AND scope_type=held.scope_type AND scope_id=held.scope_id AND period=held.period AND period_start=held.period_start FOR UPDATE;
    SELECT COALESCE(pg_catalog.sum(reserved_micros),0) INTO active FROM cinatoken_gateway.guardrail_budget_reservations
      WHERE workspace_id=held.workspace_id AND scope_type=held.scope_type AND scope_id=held.scope_id
        AND period=held.period AND period_start=held.period_start AND state IN ('reserved','dispatched');
    IF window_row.workspace_id IS NULL OR window_row.period_end<>held.period_end OR window_row.reserved_micros<>active
    THEN RETURN pg_catalog.jsonb_build_object('status','holds_differ'); END IF;
    IF NOT windows @> pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(window_row)) THEN
      windows:=windows || pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(window_row)); END IF;
  END LOOP;
  IF held_count<>admission.guardrail_count OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.guardrail_budget_reservations
    WHERE request_id=request_key)<>held_count THEN RETURN pg_catalog.jsonb_build_object('status','holds_differ'); END IF;
  at_time:=pg_catalog.clock_timestamp(); terminal_uuid:=pg_catalog.gen_random_uuid(); event_uuid:=pg_catalog.gen_random_uuid();
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('factId',fact_id,'evidenceSha256',evidence_sha256)
    ORDER BY fact_id),'[]'::jsonb) INTO facts FROM cinatoken_gateway.complete_text_result_facts_v366 WHERE grant_id=p_grant_id;
  decision:=pg_catalog.jsonb_build_object('eventType','platform_text_no_fetch_closed','eventVersion',1,
    'terminalId',terminal_uuid,'eventId',event_uuid,'requestId',request_key,'quoteId',grant_row.quote_id,
    'grantId',p_grant_id,'resolutionId',p_resolution_id,'decisionNonce',p_decision_nonce,
    'result','verified_no_fetch','buyerChargedMicros',0,'buyerBillableUnits',0,'supplierCostStatus','not_asserted',
    'supplierCostMicros',NULL,'grant',pg_catalog.to_jsonb(grant_row),'noFetchResolution',pg_catalog.to_jsonb(resolution),
    'quote',pg_catalog.to_jsonb(quote_row),'selectedFacts',facts,'closedAt',at_time);
  decision_sha:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(decision::text,'UTF8')),'hex');
  expected_log:=pg_catalog.jsonb_build_object('id',request_key,'user_id',quote_row.user_id,'api_key_id',quote_row.api_key_id,
    'workspace_id',quote_row.workspace_id,'model_id',grant_row.model_id,'provider_id',grant_row.provider_id,
    'input_tokens',0,'output_tokens',0,'reasoning_tokens',0,'cache_read_tokens',0,'cache_write_tokens',0,'total_tokens',0,
    'standard_cost',0,'metered_cost',0,'charged_cost',0,'budget_charged_micros',0,'is_byok',false,
    'status','error','error_message','verified_no_fetch','created_at',at_time,'budget_accounted_at',at_time,
    'pricing_audit',pg_catalog.jsonb_build_object('v',1,'basis','verified_no_fetch','terminalId',terminal_uuid,
      'decisionSha256',decision_sha,'supplierCostStatus','not_asserted')::text);
  INSERT INTO cinatoken_gateway.complete_text_platform_terminals_v388 VALUES(terminal_uuid,request_key,p_grant_id,
    p_resolution_id,grant_row.quote_id,p_decision_nonce,decision_sha,event_uuid,decision,0,'not_asserted',NULL,
    ordinary_json,guardrails,account_json,windows,expected_log,at_time,pg_catalog.pg_current_xact_id());
  IF ordinary_json IS NOT NULL THEN
    UPDATE cinatoken_gateway.users SET budget_reserved_micros=budget_reserved_micros-admission.reserved_micros,
      updated_at=at_time WHERE id=quote_row.user_id AND budget_epoch=quote_row.budget_epoch;
    UPDATE cinatoken_gateway.user_budget_reservations SET state='settled',settled_micros=0,terminal_at=at_time,
      terminal_reason='platform_verified_no_fetch_v388',updated_at=at_time WHERE request_id=request_key;
  END IF;
  FOR held IN SELECT * FROM cinatoken_gateway.guardrail_budget_reservations WHERE request_id=request_key
    ORDER BY workspace_id,scope_type,scope_id,period,period_start,assignment_id LOOP
    UPDATE cinatoken_gateway.guardrail_budget_reservations SET state='settled',settled_micros=0,terminal_at=at_time,
      terminal_reason='platform_verified_no_fetch_v388',updated_at=at_time WHERE id=held.id;
    UPDATE cinatoken_gateway.guardrail_budget_windows SET reserved_micros=reserved_micros-held.reserved_micros,
      updated_at=at_time WHERE workspace_id=held.workspace_id AND scope_type=held.scope_type AND scope_id=held.scope_id
        AND period=held.period AND period_start=held.period_start;
  END LOOP;
  INSERT INTO cinatoken_gateway.api_key_request_logs(id,user_id,api_key_id,workspace_id,model_id,provider_id,
    input_tokens,output_tokens,standard_cost,metered_cost,charged_cost,budget_charged_micros,is_byok,status,error_message,
    created_at,budget_accounted_at,pricing_audit)
    VALUES(request_key,quote_row.user_id,quote_row.api_key_id,quote_row.workspace_id,grant_row.model_id,grant_row.provider_id,
      0,0,0,0,0,0,false,'error','verified_no_fetch',at_time,at_time,expected_log->>'pricing_audit');
  INSERT INTO cinatoken_gateway.complete_text_platform_outbox_v388 VALUES(event_uuid,terminal_uuid,request_key,
    'platform_text_no_fetch_closed',1,decision,decision_sha,at_time,pg_catalog.pg_current_xact_id());
  RETURN pg_catalog.jsonb_build_object('status','closed_no_fetch','requestId',request_key,'grantId',p_grant_id,
    'resolutionId',p_resolution_id,'terminalId',terminal_uuid,'eventId',event_uuid,'decisionNonce',p_decision_nonce,
    'decisionSha256',decision_sha,'buyerChargedMicros',0,'supplierCostStatus','not_asserted','closedAt',at_time);
END;
$close$;

REVOKE ALL ON cinatoken_gateway.complete_text_platform_terminals_v388,
  cinatoken_gateway.complete_text_platform_outbox_v388 FROM PUBLIC,cinatoken_gateway_runtime,
  cinatoken_gateway_buyer_settlement,cinatoken_gateway_complete_text_platform_closer;
REVOKE ALL ON FUNCTION cinatoken_gateway.protect_platform_close_rows_v388(),
  cinatoken_gateway.reject_platform_terminal_egress_v388(),cinatoken_gateway.protect_platform_buyer_log_v388(),
  cinatoken_gateway.verify_platform_close_v388(),cinatoken_gateway.close_complete_text_no_fetch_v388(uuid,uuid,uuid)
  FROM PUBLIC,cinatoken_gateway_runtime,cinatoken_gateway_buyer_settlement,cinatoken_gateway_complete_text_platform_closer;
GRANT USAGE ON SCHEMA cinatoken_gateway TO cinatoken_gateway_complete_text_platform_closer;
GRANT EXECUTE ON FUNCTION cinatoken_gateway.close_complete_text_no_fetch_v388(uuid,uuid,uuid)
  TO cinatoken_gateway_complete_text_platform_closer;
