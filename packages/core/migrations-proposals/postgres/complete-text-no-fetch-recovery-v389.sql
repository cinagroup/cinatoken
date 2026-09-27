-- REVIEW ONLY / DEFAULT OFF. Durable recovery for v370 -> v388 only.
-- Worker job ownership is not grant/send/financial authority. Existing
-- resolver/closer LOGINs remain isolated and no supplier cost is inferred.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog,pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923589);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.complete_text_attempt_grants_v362,
  cinatoken_gateway.complete_text_no_fetch_resolutions_v370,
  cinatoken_gateway.complete_text_platform_terminals_v388,
  cinatoken_gateway.complete_text_platform_outbox_v388 IN SHARE ROW EXCLUSIVE MODE;
DO $preflight$
DECLARE owner_oid oid; actor record;
BEGIN
  SELECT oid INTO owner_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_migrator';
  IF SESSION_USER<>'cinatoken_gateway_migrator' OR CURRENT_USER<>SESSION_USER
    OR pg_catalog.current_setting('cinatoken.complete_text_no_fetch_recovery_v389_activation',true) IS DISTINCT FROM 'reviewed-v1'
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n' ORDER BY version COLLATE "C"))
      FROM cinatoken_gateway.schema_migrations)<>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR pg_catalog.to_regnamespace('cinatoken_text_no_fetch_recovery') IS NOT NULL
    OR pg_catalog.to_regprocedure('cinatoken_gateway.close_complete_text_no_fetch_v388(uuid,uuid,uuid)') IS NULL
    OR pg_catalog.to_regprocedure('cinatoken_gateway.resolve_complete_text_no_fetch_v370(uuid,uuid)') IS NULL
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_roles WHERE rolname IN (
      'cinatoken_gateway_complete_text_recovery_worker','cinatoken_gateway_complete_text_recovery_observer',
      'cinatoken_gateway_complete_text_recovery_operator'))<>3
  THEN RAISE EXCEPTION 'no-fetch recovery v389 activation or dependency differs' USING ERRCODE='P0001'; END IF;
  -- New private objects must not inherit a global/gateway grant to a third
  -- role. Revoking PUBLIC alone would leave such default-ACL grants intact.
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
    WHERE d.defaclrole=owner_oid AND (d.defaclnamespace=0 AND d.defaclobjtype IN ('r','f','n')
      OR d.defaclnamespace=(SELECT oid FROM pg_catalog.pg_namespace WHERE nspname='cinatoken_gateway')
        AND d.defaclobjtype='f') AND a.grantee<>owner_oid
      -- PUBLIC function EXECUTE and the reviewed gateway-runtime function
      -- default are explicitly revoked below. Gateway table defaults do not
      -- apply to the new private-schema tables; no gateway table is created.
      AND NOT(d.defaclobjtype='f' AND a.privilege_type='EXECUTE' AND NOT a.is_grantable AND
        (a.grantee=0 OR d.defaclnamespace<>0 AND a.grantee=
          (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_runtime'))))
  THEN RAISE EXCEPTION 'no-fetch recovery v389 inherited default ACL differs' USING ERRCODE='P0001'; END IF;
  FOR actor IN SELECT * FROM pg_catalog.pg_roles WHERE rolname IN (
      'cinatoken_gateway_complete_text_recovery_worker','cinatoken_gateway_complete_text_recovery_observer',
      'cinatoken_gateway_complete_text_recovery_operator') LOOP
    IF NOT actor.rolcanlogin OR actor.rolsuper OR actor.rolcreaterole OR actor.rolcreatedb
      OR actor.rolreplication OR actor.rolbypassrls OR actor.rolinherit
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=actor.oid OR roleid=actor.oid)
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname LIKE 'cinatoken%'
        AND pg_catalog.has_schema_privilege(actor.oid,n.oid,'CREATE'))
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname LIKE 'cinatoken%' AND c.relkind IN ('r','p','v','m','f')
          AND (pg_catalog.has_table_privilege(actor.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            OR pg_catalog.has_any_column_privilege(actor.oid,c.oid,'SELECT,INSERT,UPDATE')))
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname LIKE 'cinatoken%' AND pg_catalog.has_function_privilege(actor.oid,p.oid,'EXECUTE'))
    THEN RAISE EXCEPTION 'no-fetch recovery v389 role authority differs' USING ERRCODE='P0001'; END IF;
  END LOOP;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p JOIN (VALUES
    ('cinatoken_gateway.protect_platform_close_rows_v388()'::pg_catalog.regprocedure,'8b40041321fe92f1390049e1749649db'),
    ('cinatoken_gateway.reject_platform_terminal_egress_v388()'::pg_catalog.regprocedure,'20dba83baa81941565ce39a20302f524'),
    ('cinatoken_gateway.reject_complete_text_enrolled_hold_mutation_v366()'::pg_catalog.regprocedure,'6e5666a4e25b0645537c0742cd44b52e'),
    ('cinatoken_gateway.protect_platform_buyer_log_v388()'::pg_catalog.regprocedure,'31354b2dbdcff900ab7c4fc3f1037fe0'),
    ('cinatoken_gateway.verify_platform_close_v388()'::pg_catalog.regprocedure,'091a633e98ade83604dad78dd13a6c31'),
    ('cinatoken_gateway.close_complete_text_no_fetch_v388(uuid,uuid,uuid)'::pg_catalog.regprocedure,'ef057ebf246bab052674ee1e472822e2'))
    AS expected(function_oid,source_md5) ON p.oid=expected.function_oid
    WHERE p.proowner=owner_oid AND p.prosecdef
      AND pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\r\n',E'\n'))=expected.source_md5)<>6
  THEN RAISE EXCEPTION 'no-fetch recovery v389 terminal function body differs' USING ERRCODE='P0001'; END IF;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled='O'
    AND t.tgqual IS NULL AND t.tgattr::text='' AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
    AND (t.tgrelid,t.tgname,t.tgfoid,t.tgtype,t.tgdeferrable,t.tginitdeferred) IN (
      ('cinatoken_gateway.complete_text_platform_terminals_v388'::pg_catalog.regclass,'platform_terminal_rows_v388',
        'cinatoken_gateway.protect_platform_close_rows_v388()'::pg_catalog.regprocedure,31,false,false),
      ('cinatoken_gateway.complete_text_platform_outbox_v388'::pg_catalog.regclass,'platform_event_rows_v388',
        'cinatoken_gateway.protect_platform_close_rows_v388()'::pg_catalog.regprocedure,31,false,false),
      ('cinatoken_gateway.complete_text_platform_terminals_v388'::pg_catalog.regclass,'platform_terminal_complete_v388',
        'cinatoken_gateway.verify_platform_close_v388()'::pg_catalog.regprocedure,5,true,true),
      ('cinatoken_gateway.complete_text_platform_outbox_v388'::pg_catalog.regclass,'platform_event_complete_v388',
        'cinatoken_gateway.verify_platform_close_v388()'::pg_catalog.regprocedure,5,true,true),
      ('cinatoken_gateway.complete_text_platform_terminals_v388'::pg_catalog.regclass,'platform_terminal_truncate_v388',
        'cinatoken_gateway.protect_platform_close_rows_v388()'::pg_catalog.regprocedure,34,false,false),
      ('cinatoken_gateway.complete_text_platform_outbox_v388'::pg_catalog.regclass,'platform_event_truncate_v388',
        'cinatoken_gateway.protect_platform_close_rows_v388()'::pg_catalog.regprocedure,34,false,false),
      ('cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass,'platform_buyer_log_rows_v388',
        'cinatoken_gateway.protect_platform_buyer_log_v388()'::pg_catalog.regprocedure,31,false,false),
      ('cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass,'platform_buyer_log_truncate_v388',
        'cinatoken_gateway.protect_platform_buyer_log_v388()'::pg_catalog.regprocedure,34,false,false),
      ('cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass,'complete_text_ordinary_hold_fence_v366',
        'cinatoken_gateway.reject_complete_text_enrolled_hold_mutation_v366()'::pg_catalog.regprocedure,31,false,false),
      ('cinatoken_gateway.guardrail_budget_reservations'::pg_catalog.regclass,'complete_text_guardrail_hold_fence_v366',
        'cinatoken_gateway.reject_complete_text_enrolled_hold_mutation_v366()'::pg_catalog.regprocedure,31,false,false),
      ('cinatoken_gateway.complete_text_attempt_grants_v362'::pg_catalog.regclass,'platform_terminal_grant_v388',
        'cinatoken_gateway.reject_platform_terminal_egress_v388()'::pg_catalog.regprocedure,7,false,false),
      ('cinatoken_gateway.complete_text_hold_renewals_v367'::pg_catalog.regclass,'platform_terminal_renewal_v388',
        'cinatoken_gateway.reject_platform_terminal_egress_v388()'::pg_catalog.regprocedure,7,false,false),
      ('cinatoken_gateway.complete_text_result_facts_v366'::pg_catalog.regclass,'platform_terminal_holder_fact_v388',
        'cinatoken_gateway.reject_platform_terminal_egress_v388()'::pg_catalog.regprocedure,7,false,false)))<>13
  THEN RAISE EXCEPTION 'no-fetch recovery v389 terminal guards differ' USING ERRCODE='P0001'; END IF;
END;
$preflight$;

CREATE SCHEMA cinatoken_text_no_fetch_recovery AUTHORIZATION cinatoken_gateway_migrator;
REVOKE ALL ON SCHEMA cinatoken_text_no_fetch_recovery FROM PUBLIC;
CREATE TABLE cinatoken_text_no_fetch_recovery.jobs_v389 (
  job_id uuid PRIMARY KEY,
  grant_id uuid NOT NULL UNIQUE REFERENCES cinatoken_gateway.complete_text_attempt_grants_v362(grant_id),
  request_id text NOT NULL UNIQUE,
  resolution_nonce uuid NOT NULL UNIQUE,
  decision_nonce uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  state text NOT NULL CHECK(state IN ('pending','leased','completed','quarantined')),
  available_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 7),
  recovery_count integer NOT NULL DEFAULT 0 CHECK(recovery_count BETWEEN 0 AND 3),
  lease_generation integer NOT NULL DEFAULT 0 CHECK(lease_generation>=0),
  lease_token uuid,
  lease_until timestamptz,
  terminal_id uuid REFERENCES cinatoken_gateway.complete_text_platform_terminals_v388(terminal_id),
  event_id uuid REFERENCES cinatoken_gateway.complete_text_platform_outbox_v388(event_id),
  completion_token uuid,
  completed_at timestamptz,
  quarantine_reason text CHECK(quarantine_reason IN ('possible_send','state_conflict','attempts_exhausted')),
  last_error_code text CHECK(last_error_code IN ('possible_send','state_conflict','resolver_rejected','closer_rejected','not_confirmed')),
  updated_at timestamptz NOT NULL,
  CHECK((state='leased')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK((state='completed')=(terminal_id IS NOT NULL AND event_id IS NOT NULL AND completion_token IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK((state='quarantined')=(quarantine_reason IS NOT NULL))
);
CREATE INDEX no_fetch_recovery_due_v389 ON cinatoken_text_no_fetch_recovery.jobs_v389(available_at,job_id)
  WHERE state IN ('pending','leased');
CREATE INDEX complete_text_grant_recovery_scan_v389 ON cinatoken_gateway.complete_text_attempt_grants_v362(send_expires_at,grant_id);
CREATE TABLE cinatoken_text_no_fetch_recovery.manual_recoveries_v389 (
  job_id uuid NOT NULL REFERENCES cinatoken_text_no_fetch_recovery.jobs_v389(job_id),
  recovery_number integer NOT NULL CHECK(recovery_number BETWEEN 1 AND 3),
  reason text NOT NULL CHECK(pg_catalog.length(reason) BETWEEN 8 AND 256),
  prior_quarantine_reason text NOT NULL,
  recovered_by text NOT NULL CHECK(recovered_by='cinatoken_gateway_complete_text_recovery_operator'),
  recovered_at timestamptz NOT NULL,
  PRIMARY KEY(job_id,recovery_number)
);
CREATE FUNCTION cinatoken_text_no_fetch_recovery.protect_jobs_v389()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,pg_temp AS $guard$
BEGIN
  IF TG_OP='TRUNCATE' OR TG_OP='DELETE' THEN RAISE EXCEPTION 'no-fetch recovery history cannot be erased'
    USING ERRCODE='23514',CONSTRAINT='no_fetch_recovery_immutable_v389'; END IF;
  IF TG_TABLE_NAME='manual_recoveries_v389' THEN
    IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'no-fetch recovery audit is immutable'
      USING ERRCODE='23514',CONSTRAINT='no_fetch_recovery_immutable_v389'; END IF;
  ELSIF TG_OP='UPDATE' THEN
    IF ROW(NEW.job_id,NEW.grant_id,NEW.request_id,NEW.resolution_nonce,NEW.decision_nonce,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.job_id,OLD.grant_id,OLD.request_id,OLD.resolution_nonce,OLD.decision_nonce,OLD.created_at)
      OR OLD.state='completed'
    THEN RAISE EXCEPTION 'no-fetch recovery identity and completed result are immutable'
      USING ERRCODE='23514',CONSTRAINT='no_fetch_recovery_immutable_v389'; END IF;
  END IF;
  RETURN NEW;
END;
$guard$;
CREATE TRIGGER no_fetch_recovery_jobs_guard_v389 BEFORE UPDATE OR DELETE
  ON cinatoken_text_no_fetch_recovery.jobs_v389 FOR EACH ROW EXECUTE FUNCTION cinatoken_text_no_fetch_recovery.protect_jobs_v389();
CREATE TRIGGER no_fetch_recovery_jobs_truncate_v389 BEFORE TRUNCATE
  ON cinatoken_text_no_fetch_recovery.jobs_v389 FOR EACH STATEMENT EXECUTE FUNCTION cinatoken_text_no_fetch_recovery.protect_jobs_v389();
CREATE TRIGGER no_fetch_recovery_audit_guard_v389 BEFORE UPDATE OR DELETE
  ON cinatoken_text_no_fetch_recovery.manual_recoveries_v389 FOR EACH ROW EXECUTE FUNCTION cinatoken_text_no_fetch_recovery.protect_jobs_v389();
CREATE TRIGGER no_fetch_recovery_audit_truncate_v389 BEFORE TRUNCATE
  ON cinatoken_text_no_fetch_recovery.manual_recoveries_v389 FOR EACH STATEMENT EXECUTE FUNCTION cinatoken_text_no_fetch_recovery.protect_jobs_v389();

CREATE FUNCTION cinatoken_text_no_fetch_recovery.enqueue_grant_v389()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,pg_temp AS $enqueue$
BEGIN
  INSERT INTO cinatoken_text_no_fetch_recovery.jobs_v389(job_id,grant_id,request_id,resolution_nonce,decision_nonce,
    created_at,state,available_at,updated_at)
    VALUES(pg_catalog.gen_random_uuid(),NEW.grant_id,NEW.request_id,pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid(),
      pg_catalog.clock_timestamp(),'pending',NEW.send_expires_at+INTERVAL '1 millisecond',pg_catalog.clock_timestamp());
  RETURN NEW;
END;
$enqueue$;
CREATE TRIGGER complete_text_grant_enqueue_recovery_v389 AFTER INSERT
  ON cinatoken_gateway.complete_text_attempt_grants_v362 FOR EACH ROW
  EXECUTE FUNCTION cinatoken_text_no_fetch_recovery.enqueue_grant_v389();

CREATE FUNCTION cinatoken_gateway.scan_complete_text_no_fetch_recovery_v389(p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,pg_temp SET lock_timeout TO '2s' SET statement_timeout TO '15s' AS $scan$
DECLARE affected integer;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_complete_text_recovery_worker' OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
  THEN RAISE EXCEPTION 'invalid no-fetch recovery scan' USING ERRCODE='23514'; END IF;
  INSERT INTO cinatoken_text_no_fetch_recovery.jobs_v389(job_id,grant_id,request_id,resolution_nonce,decision_nonce,
    created_at,state,available_at,updated_at)
    SELECT pg_catalog.gen_random_uuid(),g.grant_id,g.request_id,
      COALESCE(r.resolution_nonce,pg_catalog.gen_random_uuid()),COALESCE(t.decision_nonce,pg_catalog.gen_random_uuid()),
      pg_catalog.clock_timestamp(),'pending',g.send_expires_at+INTERVAL '1 millisecond',pg_catalog.clock_timestamp()
    FROM cinatoken_gateway.complete_text_attempt_grants_v362 g
    LEFT JOIN cinatoken_gateway.complete_text_no_fetch_resolutions_v370 r ON r.grant_id=g.grant_id
    LEFT JOIN cinatoken_gateway.complete_text_platform_terminals_v388 t ON t.grant_id=g.grant_id
    WHERE NOT EXISTS(SELECT 1 FROM cinatoken_text_no_fetch_recovery.jobs_v389 j WHERE j.grant_id=g.grant_id)
    ORDER BY g.send_expires_at,g.grant_id LIMIT p_limit ON CONFLICT(grant_id) DO NOTHING;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN pg_catalog.jsonb_build_object('status','scanned','enqueued',affected);
END;
$scan$;

CREATE FUNCTION cinatoken_gateway.claim_complete_text_no_fetch_recovery_v389(p_lease_seconds integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,pg_temp SET lock_timeout TO '2s' SET statement_timeout TO '15s' AS $claim$
DECLARE job record; at_time timestamptz;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_complete_text_recovery_worker' OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 300
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
  THEN RAISE EXCEPTION 'invalid no-fetch recovery claim' USING ERRCODE='23514'; END IF;
  WITH exhausted AS(SELECT job_id FROM cinatoken_text_no_fetch_recovery.jobs_v389
    WHERE state IN ('pending','leased') AND attempts=7 AND available_at<=pg_catalog.clock_timestamp()
    ORDER BY available_at,job_id LIMIT 50 FOR UPDATE SKIP LOCKED)
  UPDATE cinatoken_text_no_fetch_recovery.jobs_v389 j SET state='quarantined',lease_token=NULL,lease_until=NULL,
    quarantine_reason='attempts_exhausted',updated_at=pg_catalog.clock_timestamp()
    FROM exhausted e WHERE j.job_id=e.job_id;
  SELECT * INTO job FROM cinatoken_text_no_fetch_recovery.jobs_v389 WHERE state IN ('pending','leased')
    AND attempts<7 AND available_at<=pg_catalog.clock_timestamp() ORDER BY available_at,job_id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF job.job_id IS NULL THEN RETURN pg_catalog.jsonb_build_object('status','empty'); END IF;
  at_time:=pg_catalog.clock_timestamp();
  UPDATE cinatoken_text_no_fetch_recovery.jobs_v389 SET state='leased',attempts=attempts+1,
    lease_generation=lease_generation+1,lease_token=pg_catalog.gen_random_uuid(),
    lease_until=at_time+p_lease_seconds*INTERVAL '1 second',available_at=at_time+p_lease_seconds*INTERVAL '1 second',
    last_error_code=NULL,updated_at=at_time WHERE job_id=job.job_id RETURNING * INTO job;
  RETURN pg_catalog.jsonb_build_object('status','claimed','jobId',job.job_id,'requestId',job.request_id,'grantId',job.grant_id,
    'resolutionNonce',job.resolution_nonce,'decisionNonce',job.decision_nonce,'leaseToken',job.lease_token,
    'leaseGeneration',job.lease_generation,'leaseUntil',job.lease_until,'attemptCount',job.attempts);
END;
$claim$;

-- Internal inspector: only stored platform identity/facts decide the result.
-- It never compares current shared-account/window counters to old snapshots.
CREATE FUNCTION cinatoken_text_no_fetch_recovery.inspect_v389(p_job_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,pg_temp AS $inspect$
DECLARE job record; g record; r record; t record; current_json jsonb; expected jsonb; item jsonb;
DECLARE outcome text; event_uuid uuid; terminal_uuid uuid; resolution_uuid uuid;
BEGIN
  SELECT * INTO job FROM cinatoken_text_no_fetch_recovery.jobs_v389 WHERE job_id=p_job_id;
  -- Serialize the multi-statement historical view with resolver and closer.
  -- Job rows never participate in the financial functions' lock order.
  PERFORM pg_catalog.pg_advisory_xact_lock(348,pg_catalog.hashtext(job.request_id));
  SELECT * INTO g FROM cinatoken_gateway.complete_text_attempt_grants_v362 WHERE grant_id=job.grant_id;
  SELECT * INTO r FROM cinatoken_gateway.complete_text_no_fetch_resolutions_v370 WHERE grant_id=job.grant_id;
  SELECT * INTO t FROM cinatoken_gateway.complete_text_platform_terminals_v388 WHERE grant_id=job.grant_id;
  resolution_uuid:=r.resolution_id;terminal_uuid:=t.terminal_id;event_uuid:=t.event_id;
  outcome:='conflict';
  IF job.job_id IS NOT NULL AND g.request_id=job.request_id AND g.attempt_number=1 AND g.obligation_state='unknown'
    AND (SELECT pg_catalog.count(*) FROM cinatoken_gateway.complete_text_attempt_grants_v362 WHERE request_id=job.request_id)=1
  THEN
    IF EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_send_starts_v365 WHERE request_id=job.request_id OR grant_id=job.grant_id) THEN
      outcome:='possible_send';
    ELSIF EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_result_facts_v366
        WHERE (request_id=job.request_id OR grant_id=job.grant_id) AND kind<>'no_fetch_attestation')
      OR EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_hold_renewals_v367 WHERE request_id=job.request_id)
    THEN outcome:='conflict';
    ELSIF r.resolution_id IS NULL THEN
      IF t.terminal_id IS NULL AND g.send_expires_at<pg_catalog.clock_timestamp() THEN outcome:='ready_to_resolve'; END IF;
    ELSIF r.result='verified_no_fetch' AND r.request_id=job.request_id AND r.quote_id=g.quote_id
      AND r.attempt_nonce=g.attempt_nonce AND r.attempt_number=g.attempt_number AND r.grant_claim_sha256=g.claim_sha256
      AND r.outbound_body_sha256=g.outbound_body_sha256 AND r.send_expires_at=g.send_expires_at AND r.fenced_at>g.send_expires_at
    THEN
      IF t.terminal_id IS NULL THEN outcome:='ready_to_close';
      ELSIF t.request_id=job.request_id AND t.resolution_id=r.resolution_id AND t.quote_id=g.quote_id
        AND t.buyer_charged_micros=0 AND t.supplier_cost_status='not_asserted' AND t.supplier_cost_micros IS NULL
        AND t.closed_at>=r.fenced_at AND t.decision->>'result'='verified_no_fetch'
        AND t.decision->>'requestId'=job.request_id AND t.decision->>'grantId'=g.grant_id::text
        AND t.decision->>'resolutionId'=r.resolution_id::text AND t.decision->>'terminalId'=t.terminal_id::text
        AND t.decision->>'eventId'=t.event_id::text AND t.decision->>'decisionNonce'=t.decision_nonce::text
        AND t.decision->'buyerChargedMicros'='0'::jsonb AND t.decision->'buyerBillableUnits'='0'::jsonb
        AND t.decision->>'supplierCostStatus'='not_asserted' AND t.decision->'supplierCostMicros'='null'::jsonb
        AND t.decision->'grant'=pg_catalog.to_jsonb(g) AND t.decision->'noFetchResolution'=pg_catalog.to_jsonb(r)
        AND t.decision_sha256=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(t.decision::text,'UTF8')),'hex')
        AND EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_quotes_v360 q WHERE q.quote_id=t.quote_id AND t.decision->'quote'=pg_catalog.to_jsonb(q))
        AND EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_platform_outbox_v388 e WHERE e.event_id=t.event_id
          AND e.terminal_id=t.terminal_id AND e.request_id=t.request_id AND e.event_type='platform_text_no_fetch_closed'
          AND e.event_version=1 AND e.payload=t.decision AND e.payload_sha256=t.decision_sha256 AND e.writer_xid=t.writer_xid AND e.created_at=t.closed_at)
        AND EXISTS(SELECT 1 FROM cinatoken_gateway.api_key_request_logs l WHERE l.id=t.request_id
          AND pg_catalog.to_jsonb(l) @> t.expected_log AND l.status='error' AND l.error_message='verified_no_fetch'
          AND l.charged_cost=0 AND l.budget_charged_micros=0)
      THEN
        outcome:='confirmed';
        SELECT pg_catalog.to_jsonb(h) INTO current_json FROM cinatoken_gateway.user_budget_reservations h WHERE request_id=t.request_id;
        expected:=CASE WHEN t.ordinary_before IS NULL THEN NULL ELSE t.ordinary_before || pg_catalog.jsonb_build_object(
          'state','settled','settled_micros',0,'terminal_at',t.closed_at,'terminal_reason','platform_verified_no_fetch_v388','updated_at',t.closed_at) END;
        IF current_json IS DISTINCT FROM expected THEN outcome:='conflict'; END IF;
        IF (SELECT pg_catalog.count(*) FROM cinatoken_gateway.guardrail_budget_reservations WHERE request_id=t.request_id)
          <>pg_catalog.jsonb_array_length(t.guardrails_before) THEN outcome:='conflict'; END IF;
        FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(t.guardrails_before) LOOP
          SELECT pg_catalog.to_jsonb(h) INTO current_json FROM cinatoken_gateway.guardrail_budget_reservations h WHERE id=item->>'id';
          expected:=item || pg_catalog.jsonb_build_object('state','settled','settled_micros',0,'terminal_at',t.closed_at,
            'terminal_reason','platform_verified_no_fetch_v388','updated_at',t.closed_at);
          IF current_json IS DISTINCT FROM expected THEN outcome:='conflict'; END IF;
        END LOOP;
      END IF;
    END IF;
  END IF;
  RETURN pg_catalog.jsonb_build_object('status',outcome,'jobId',job.job_id,'requestId',job.request_id,'grantId',job.grant_id,
    'resolutionNonce',job.resolution_nonce,'decisionNonce',job.decision_nonce,
    'resolutionId',resolution_uuid,'terminalId',terminal_uuid,'eventId',event_uuid);
END;
$inspect$;

CREATE FUNCTION cinatoken_gateway.observe_complete_text_no_fetch_recovery_v389(p_job_id uuid,p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,pg_temp
SET lock_timeout TO '2s' SET statement_timeout TO '15s' AS $observe$
DECLARE job record; observation jsonb;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_complete_text_recovery_observer' OR p_job_id IS NULL OR p_lease_token IS NULL
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
  THEN RAISE EXCEPTION 'invalid no-fetch recovery observation' USING ERRCODE='23514'; END IF;
  SELECT * INTO job FROM cinatoken_text_no_fetch_recovery.jobs_v389 WHERE job_id=p_job_id FOR SHARE;
  IF job.state IS DISTINCT FROM 'leased' OR job.lease_token IS DISTINCT FROM p_lease_token
    OR job.lease_until<=pg_catalog.clock_timestamp() THEN RETURN pg_catalog.jsonb_build_object('status','lease_lost'); END IF;
  observation:=cinatoken_text_no_fetch_recovery.inspect_v389(p_job_id);
  IF job.lease_until<=pg_catalog.clock_timestamp() THEN RETURN pg_catalog.jsonb_build_object('status','lease_lost'); END IF;
  RETURN observation;
END;
$observe$;

CREATE FUNCTION cinatoken_gateway.finish_complete_text_no_fetch_recovery_v389(p_job_id uuid,p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,pg_temp
SET lock_timeout TO '2s' SET statement_timeout TO '15s' AS $finish$
DECLARE job record; observation jsonb; at_time timestamptz; outcome text;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_complete_text_recovery_observer' OR p_job_id IS NULL OR p_lease_token IS NULL
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
  THEN RAISE EXCEPTION 'invalid no-fetch recovery finish' USING ERRCODE='23514'; END IF;
  SELECT * INTO job FROM cinatoken_text_no_fetch_recovery.jobs_v389 WHERE job_id=p_job_id FOR UPDATE;
  IF job.state='completed' AND job.completion_token=p_lease_token THEN
    RETURN pg_catalog.jsonb_build_object('status','completed','jobId',p_job_id,'terminalId',job.terminal_id,'eventId',job.event_id);
  END IF;
  at_time:=pg_catalog.clock_timestamp();
  IF job.state IS DISTINCT FROM 'leased' OR job.lease_token IS DISTINCT FROM p_lease_token OR job.lease_until<=at_time
  THEN RETURN pg_catalog.jsonb_build_object('status','lease_lost','jobId',p_job_id,'terminalId',NULL,'eventId',NULL); END IF;
  observation:=cinatoken_text_no_fetch_recovery.inspect_v389(p_job_id);
  IF job.lease_until<=pg_catalog.clock_timestamp() THEN
    RETURN pg_catalog.jsonb_build_object('status','lease_lost','jobId',p_job_id,'terminalId',NULL,'eventId',NULL);
  END IF;
  IF observation->>'status'='confirmed' THEN
    UPDATE cinatoken_text_no_fetch_recovery.jobs_v389 SET state='completed',lease_token=NULL,lease_until=NULL,
      terminal_id=(observation->>'terminalId')::uuid,event_id=(observation->>'eventId')::uuid,
      completion_token=p_lease_token,completed_at=at_time,updated_at=at_time WHERE job_id=p_job_id;
    outcome:='completed';
  ELSIF observation->>'status' IN ('possible_send','conflict') THEN
    UPDATE cinatoken_text_no_fetch_recovery.jobs_v389 SET state='quarantined',lease_token=NULL,lease_until=NULL,
      quarantine_reason=CASE WHEN observation->>'status'='possible_send' THEN 'possible_send' ELSE 'state_conflict' END,
      updated_at=at_time WHERE job_id=p_job_id;outcome:='quarantined';
  ELSE outcome:='not_confirmed'; END IF;
  RETURN pg_catalog.jsonb_build_object('status',outcome,'jobId',p_job_id,
    'terminalId',CASE WHEN outcome='completed' THEN observation->>'terminalId' ELSE NULL END,
    'eventId',CASE WHEN outcome='completed' THEN observation->>'eventId' ELSE NULL END);
END;
$finish$;

CREATE FUNCTION cinatoken_gateway.fail_complete_text_no_fetch_recovery_v389(p_job_id uuid,p_lease_token uuid,p_error_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,pg_temp SET lock_timeout TO '2s' SET statement_timeout TO '15s' AS $fail$
DECLARE job record; at_time timestamptz; permanent boolean;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_complete_text_recovery_worker' OR p_job_id IS NULL OR p_lease_token IS NULL
    OR p_error_code IS NULL OR p_error_code NOT IN ('possible_send','state_conflict','resolver_rejected','closer_rejected','not_confirmed')
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
  THEN RAISE EXCEPTION 'invalid no-fetch recovery failure' USING ERRCODE='23514'; END IF;
  SELECT * INTO job FROM cinatoken_text_no_fetch_recovery.jobs_v389 WHERE job_id=p_job_id FOR UPDATE;
  at_time:=pg_catalog.clock_timestamp();
  IF job.state IS DISTINCT FROM 'leased' OR job.lease_token IS DISTINCT FROM p_lease_token OR job.lease_until<=at_time
  THEN RETURN pg_catalog.jsonb_build_object('status','lease_lost'); END IF;
  permanent:=p_error_code IN ('possible_send','state_conflict') OR job.attempts=7;
  UPDATE cinatoken_text_no_fetch_recovery.jobs_v389 SET state=CASE WHEN permanent THEN 'quarantined' ELSE 'pending' END,
    lease_token=NULL,lease_until=NULL,last_error_code=p_error_code,
    quarantine_reason=CASE WHEN p_error_code IN ('possible_send','state_conflict') THEN p_error_code
      WHEN permanent THEN 'attempts_exhausted' ELSE NULL END,
    available_at=at_time+least(60,5*(1 << (job.attempts-1)))*INTERVAL '1 second',updated_at=at_time WHERE job_id=p_job_id;
  RETURN pg_catalog.jsonb_build_object('status',CASE WHEN permanent THEN 'quarantined' ELSE 'retry_scheduled' END);
END;
$fail$;

CREATE FUNCTION cinatoken_gateway.recover_complete_text_no_fetch_recovery_v389(p_job_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,pg_temp SET lock_timeout TO '2s' SET statement_timeout TO '15s' AS $recover$
DECLARE job record; at_time timestamptz;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_complete_text_recovery_operator' OR p_job_id IS NULL OR p_reason IS NULL
    OR pg_catalog.length(p_reason) NOT BETWEEN 8 AND 256 OR p_reason<>pg_catalog.btrim(p_reason)
    OR p_reason ~ '[\n\r\t]' OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
  THEN RAISE EXCEPTION 'invalid no-fetch manual recovery' USING ERRCODE='23514'; END IF;
  SELECT * INTO job FROM cinatoken_text_no_fetch_recovery.jobs_v389 WHERE job_id=p_job_id FOR UPDATE;
  IF job.state IS DISTINCT FROM 'quarantined' THEN RETURN pg_catalog.jsonb_build_object('status','not_quarantined'); END IF;
  IF job.recovery_count=3 THEN RETURN pg_catalog.jsonb_build_object('status','recovery_exhausted'); END IF;
  at_time:=pg_catalog.clock_timestamp();
  INSERT INTO cinatoken_text_no_fetch_recovery.manual_recoveries_v389 VALUES(p_job_id,job.recovery_count+1,p_reason,
    job.quarantine_reason,SESSION_USER,at_time);
  UPDATE cinatoken_text_no_fetch_recovery.jobs_v389 SET state='pending',attempts=0,recovery_count=recovery_count+1,
    quarantine_reason=NULL,last_error_code=NULL,available_at=at_time,updated_at=at_time WHERE job_id=p_job_id;
  RETURN pg_catalog.jsonb_build_object('status','requeued');
END;
$recover$;

REVOKE ALL ON ALL TABLES IN SCHEMA cinatoken_text_no_fetch_recovery FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cinatoken_text_no_fetch_recovery FROM PUBLIC;
REVOKE ALL ON FUNCTION cinatoken_gateway.scan_complete_text_no_fetch_recovery_v389(integer),
  cinatoken_gateway.claim_complete_text_no_fetch_recovery_v389(integer),
  cinatoken_gateway.observe_complete_text_no_fetch_recovery_v389(uuid,uuid),
  cinatoken_gateway.finish_complete_text_no_fetch_recovery_v389(uuid,uuid),
  cinatoken_gateway.fail_complete_text_no_fetch_recovery_v389(uuid,uuid,text),
  cinatoken_gateway.recover_complete_text_no_fetch_recovery_v389(uuid,text) FROM PUBLIC,cinatoken_gateway_runtime;
GRANT USAGE ON SCHEMA cinatoken_gateway TO cinatoken_gateway_complete_text_recovery_worker,
  cinatoken_gateway_complete_text_recovery_observer,cinatoken_gateway_complete_text_recovery_operator;
GRANT EXECUTE ON FUNCTION cinatoken_gateway.scan_complete_text_no_fetch_recovery_v389(integer),
  cinatoken_gateway.claim_complete_text_no_fetch_recovery_v389(integer),
  cinatoken_gateway.fail_complete_text_no_fetch_recovery_v389(uuid,uuid,text)
  TO cinatoken_gateway_complete_text_recovery_worker;
GRANT EXECUTE ON FUNCTION cinatoken_gateway.observe_complete_text_no_fetch_recovery_v389(uuid,uuid),
  cinatoken_gateway.finish_complete_text_no_fetch_recovery_v389(uuid,uuid)
  TO cinatoken_gateway_complete_text_recovery_observer;
GRANT EXECUTE ON FUNCTION cinatoken_gateway.recover_complete_text_no_fetch_recovery_v389(uuid,text)
  TO cinatoken_gateway_complete_text_recovery_operator;
