-- REVIEW ONLY. Install after v366 result facts and v367 all-hold renewal in
-- one direct migrator transaction with
-- cinatoken.complete_text_renewed_facts_v370_activation=reviewed-v1.
-- This revises the private v366 fact writer; no fact becomes a bill, no new
-- sender or monetary authority is granted, and no old row is edited.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923566);
SELECT pg_catalog.pg_advisory_xact_lock(746923567);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.complete_text_result_facts_v366,
  cinatoken_gateway.complete_text_hold_renewals_v367
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; holder_oid oid; bill_oid oid; proc_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO holder_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_complete_text_send_holder';
  SELECT oid INTO bill_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_complete_text_provider_bill';
  proc_oid:=pg_catalog.to_regprocedure(
    'cinatoken_gateway.append_complete_text_result_fact_internal_v366(uuid,uuid,bigint,uuid,text,jsonb,text,text)');
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting(
      'cinatoken.complete_text_renewed_facts_v370_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR holder_oid IS NULL OR bill_oid IS NULL
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
      WHERE nspname='cinatoken_gateway') IS DISTINCT FROM migrator_oid
    OR proc_oid IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc
      WHERE oid=proc_oid AND proowner=migrator_oid AND prosecdef
        AND provolatile='v' AND prolang=(SELECT oid FROM pg_catalog.pg_language
          WHERE lanname='plpgsql')
        AND proconfig @> ARRAY['search_path=pg_catalog, pg_temp',
          'lock_timeout=2s','statement_timeout=15s']::text[])
    OR NOT pg_catalog.has_function_privilege(holder_oid,
      'cinatoken_gateway.append_complete_text_holder_fact_v366(uuid,uuid,bigint,uuid,text,jsonb,text)','EXECUTE')
    OR NOT pg_catalog.has_function_privilege(bill_oid,
      'cinatoken_gateway.append_complete_text_provider_bill_v366(uuid,uuid,jsonb,text)','EXECUTE')
    OR pg_catalog.has_function_privilege(holder_oid,proc_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(bill_oid,proc_oid,'EXECUTE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid IN (holder_oid,bill_oid) OR member IN (holder_oid,bill_oid))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN (
        'cinatoken_gateway.complete_text_result_facts_v366'::pg_catalog.regclass,
        'cinatoken_gateway.complete_text_hold_renewals_v367'::pg_catalog.regclass)
        AND (c.relowner<>migrator_oid OR c.relkind<>'r'
          OR c.relrowsecurity OR c.relforcerowsecurity))
    OR pg_catalog.to_regclass(
      'cinatoken_gateway.complete_text_result_epoch_conflicts_v370') IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.reject_complete_text_result_epoch_conflict_mutation_v370()')
      IS NOT NULL
  THEN RAISE EXCEPTION 'complete text renewed facts v370 dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

-- v366's nonce conflict key predates renewal epochs. Keep that table intact;
-- this private side ledger preserves which committed epoch was claimed by a
-- conflicting replay, without storing the untrusted evidence body.
CREATE TABLE cinatoken_gateway.complete_text_result_epoch_conflicts_v370 (
  epoch_conflict_id uuid PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES
    cinatoken_gateway.complete_text_attempt_grants_v362(grant_id),
  request_id text NOT NULL,
  evidence_nonce uuid NOT NULL,
  recorded_fact_id uuid NOT NULL REFERENCES
    cinatoken_gateway.complete_text_result_facts_v366(fact_id),
  recorded_source_kind text NOT NULL,
  recorded_kind text NOT NULL,
  recorded_evidence_sha256 text NOT NULL
    CHECK (recorded_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_lease_epoch bigint NOT NULL CHECK (recorded_lease_epoch>=1),
  attempted_source_kind text NOT NULL,
  attempted_kind text NOT NULL,
  attempted_evidence_sha256 text NOT NULL
    CHECK (attempted_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  attempted_lease_epoch bigint NOT NULL CHECK (attempted_lease_epoch>=1),
  observed_at timestamptz NOT NULL,
  CHECK (recorded_lease_epoch<>attempted_lease_epoch),
  UNIQUE (grant_id,evidence_nonce,attempted_lease_epoch,
    attempted_source_kind,attempted_kind,attempted_evidence_sha256)
);
CREATE FUNCTION
  cinatoken_gateway.reject_complete_text_result_epoch_conflict_mutation_v370()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $immutable$
BEGIN
  RAISE EXCEPTION 'complete text result epoch conflict v370 is append-only'
    USING ERRCODE='23514',
      CONSTRAINT='complete_text_result_epoch_conflict_append_v370';
END;
$immutable$;
CREATE TRIGGER complete_text_result_epoch_conflicts_v370_no_mutation
  BEFORE UPDATE OR DELETE ON
    cinatoken_gateway.complete_text_result_epoch_conflicts_v370
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_gateway.reject_complete_text_result_epoch_conflict_mutation_v370();
CREATE TRIGGER complete_text_result_epoch_conflicts_v370_no_truncate
  BEFORE TRUNCATE ON
    cinatoken_gateway.complete_text_result_epoch_conflicts_v370
  FOR EACH STATEMENT EXECUTE FUNCTION
    cinatoken_gateway.reject_complete_text_result_epoch_conflict_mutation_v370();

CREATE OR REPLACE FUNCTION cinatoken_gateway.append_complete_text_result_fact_internal_v366(
  p_grant_id uuid,p_holder_run_id uuid,p_expected_epoch bigint,
  p_evidence_nonce uuid,p_kind text,p_evidence jsonb,p_evidence_sha256 text,
  p_source_kind text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
SET lock_timeout TO '2s'
SET statement_timeout TO '15s' AS $append$
DECLARE request_key text; grant_row record; custody record;
DECLARE start_row record; prior record;
DECLARE v_digest text; v_fact_id uuid; v_ref text; v_event text;
DECLARE renewal record; v_fact_epoch bigint;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_grant_id IS NULL OR p_evidence_nonce IS NULL
    OR p_evidence_sha256 IS NULL
    OR p_evidence_sha256 !~ '^[0-9a-f]{64}$'
    OR NOT COALESCE(cinatoken_gateway.valid_complete_text_result_evidence_v366(
      p_kind,p_evidence),false)
    OR (p_source_kind='holder' AND
      (SESSION_USER<>'cinatoken_gateway_complete_text_send_holder'
        OR p_holder_run_id IS NULL OR p_expected_epoch IS NULL
        OR p_expected_epoch NOT BETWEEN 1 AND 9007199254740991
        OR p_kind='provider_bill'))
    OR (p_source_kind='provider_bill' AND
      (SESSION_USER<>'cinatoken_gateway_complete_text_provider_bill'
        OR p_holder_run_id IS NOT NULL OR p_expected_epoch IS NOT NULL
        OR p_kind<>'provider_bill'))
    OR p_source_kind NOT IN ('holder','provider_bill')
  THEN RAISE EXCEPTION 'invalid complete text result fact call'
    USING ERRCODE='23514',CONSTRAINT='complete_text_result_fact_call_v366'; END IF;
  v_digest:=pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(p_evidence::text,'UTF8')),'hex');
  IF v_digest IS DISTINCT FROM p_evidence_sha256
  THEN RAISE EXCEPTION 'complete text result fact digest differs'
    USING ERRCODE='23514',CONSTRAINT='complete_text_result_fact_digest_v366'; END IF;

  -- Take the request lock before a grant row lock, matching renewal and the
  -- future terminal closer. The grant is immutable; re-read it under lock.
  SELECT request_id INTO request_key FROM
    cinatoken_gateway.complete_text_attempt_grants_v362
    WHERE grant_id=p_grant_id;
  IF request_key IS NULL
  THEN RETURN pg_catalog.jsonb_build_object('status','missing_grant'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(348,
    pg_catalog.hashtext(request_key));
  SELECT * INTO grant_row FROM cinatoken_gateway.complete_text_attempt_grants_v362
    WHERE grant_id=p_grant_id AND request_id=request_key FOR SHARE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status','missing_grant'); END IF;
  SELECT * INTO custody FROM cinatoken_gateway.complete_text_send_custody_v365
    WHERE grant_id=p_grant_id FOR SHARE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status','custody_required'); END IF;
  IF custody.request_id IS DISTINCT FROM grant_row.request_id
    OR custody.mode IS DISTINCT FROM 'active'
    OR custody.lease_epoch IS DISTINCT FROM 1
    OR (p_source_kind='holder' AND
      custody.holder_run_id IS DISTINCT FROM p_holder_run_id)
  THEN RETURN pg_catalog.jsonb_build_object('status','holder_run_conflict'); END IF;
  SELECT * INTO start_row FROM cinatoken_gateway.complete_text_send_starts_v365
    WHERE grant_id=p_grant_id FOR SHARE;
  IF start_row.send_start_id IS NOT NULL AND
    (start_row.request_id IS DISTINCT FROM grant_row.request_id
      OR start_row.holder_run_id IS DISTINCT FROM custody.holder_run_id
      OR start_row.lease_epoch IS DISTINCT FROM custody.lease_epoch
      OR start_row.outbound_body_sha256 IS DISTINCT FROM
        grant_row.outbound_body_sha256)
  THEN RETURN pg_catalog.jsonb_build_object('status','send_start_conflict'); END IF;
  -- A fact names the committed hold epoch observed by the holder. The
  -- physical send-start remains epoch 1; a later epoch must be an immutable
  -- renewal for the same run and send-start. Older committed observations
  -- remain receivable after a newer renewal, so evidence is not discarded.
  v_fact_epoch:=custody.lease_epoch;
  IF p_source_kind='holder' AND p_expected_epoch<>custody.lease_epoch THEN
    SELECT * INTO renewal FROM cinatoken_gateway.complete_text_hold_renewals_v367
      WHERE grant_id=p_grant_id AND lease_epoch=p_expected_epoch FOR SHARE;
    IF renewal.grant_id IS NULL
      OR renewal.request_id IS DISTINCT FROM grant_row.request_id
      OR renewal.holder_run_id IS DISTINCT FROM custody.holder_run_id
      OR renewal.send_start_id IS DISTINCT FROM start_row.send_start_id
      OR renewal.prior_lease_until IS NULL
      OR renewal.lease_until<=renewal.prior_lease_until
    THEN RETURN pg_catalog.jsonb_build_object('status','renewal_epoch_required'); END IF;
    v_fact_epoch:=p_expected_epoch;
  END IF;
  IF p_kind<>'no_fetch_attestation' AND start_row.send_start_id IS NULL
  THEN RETURN pg_catalog.jsonb_build_object('status','send_start_required'); END IF;
  IF p_kind='fetch_invoked' AND
    p_evidence->>'uploadSha256' IS DISTINCT FROM
      grant_row.outbound_body_sha256
  THEN RETURN pg_catalog.jsonb_build_object('status','grant_upload_differs'); END IF;

  SELECT * INTO prior FROM cinatoken_gateway.complete_text_result_facts_v366
    WHERE grant_id=p_grant_id AND evidence_nonce=p_evidence_nonce FOR SHARE;
  IF FOUND THEN
    IF prior.evidence_sha256=v_digest AND prior.kind=p_kind
      AND prior.source_kind=p_source_kind
      AND prior.holder_run_id=custody.holder_run_id
      AND prior.lease_epoch=v_fact_epoch
      AND prior.send_start_id IS NOT DISTINCT FROM start_row.send_start_id
    THEN RETURN pg_catalog.jsonb_build_object('status','already_recorded',
      'factId',prior.fact_id,'evidenceSha256',v_digest); END IF;
    INSERT INTO cinatoken_gateway.complete_text_result_fact_conflicts_v366
      (conflict_id,grant_id,evidence_nonce,source_kind,attempted_kind,
        attempted_evidence_sha256,observed_at)
      VALUES(pg_catalog.gen_random_uuid(),p_grant_id,p_evidence_nonce,
        p_source_kind,p_kind,v_digest,pg_catalog.clock_timestamp())
      ON CONFLICT (grant_id,evidence_nonce,source_kind,attempted_kind,
        attempted_evidence_sha256) DO NOTHING;
    IF prior.lease_epoch IS DISTINCT FROM v_fact_epoch THEN
      INSERT INTO cinatoken_gateway.complete_text_result_epoch_conflicts_v370
        (epoch_conflict_id,grant_id,request_id,evidence_nonce,
          recorded_fact_id,recorded_source_kind,recorded_kind,
          recorded_evidence_sha256,recorded_lease_epoch,
          attempted_source_kind,attempted_kind,attempted_evidence_sha256,
          attempted_lease_epoch,observed_at)
        VALUES(pg_catalog.gen_random_uuid(),p_grant_id,grant_row.request_id,
          p_evidence_nonce,prior.fact_id,prior.source_kind,prior.kind,
          prior.evidence_sha256,prior.lease_epoch,p_source_kind,p_kind,
          v_digest,v_fact_epoch,pg_catalog.clock_timestamp())
        ON CONFLICT (grant_id,evidence_nonce,attempted_lease_epoch,
          attempted_source_kind,attempted_kind,attempted_evidence_sha256)
          DO NOTHING;
    END IF;
    RETURN pg_catalog.jsonb_build_object('status','evidence_nonce_conflict');
  END IF;

  v_ref:=p_evidence->>'providerRequestRef';
  IF p_source_kind='provider_bill' THEN
    v_event:=p_evidence->>'providerEventId';
    IF EXISTS (SELECT 1 FROM cinatoken_gateway.complete_text_result_facts_v366
      WHERE kind='provider_bill' AND provider_id=grant_row.provider_id
        AND provider_event_id=v_event)
    THEN RETURN pg_catalog.jsonb_build_object('status','provider_event_conflict'); END IF;
  END IF;
  v_fact_id:=pg_catalog.gen_random_uuid();
  INSERT INTO cinatoken_gateway.complete_text_result_facts_v366
    (fact_id,grant_id,request_id,quote_id,holder_run_id,lease_epoch,
      send_start_id,evidence_nonce,kind,source_kind,provider_request_ref,
      provider_event_id,evidence,evidence_sha256,grant_claim_sha256,
      final_body_sha256,route_target_id,provider_id,endpoint_id,
      credential_class,credential_id,provider_ciphertext_sha256,
      credential_fingerprint_sha256,outbound_body_sha256,upstream_url_sha256,
      received_at)
    VALUES(v_fact_id,p_grant_id,grant_row.request_id,grant_row.quote_id,
      custody.holder_run_id,v_fact_epoch,start_row.send_start_id,
      p_evidence_nonce,p_kind,p_source_kind,v_ref,v_event,p_evidence,v_digest,
      grant_row.claim_sha256,grant_row.final_body_sha256,
      grant_row.route_target_id,grant_row.provider_id,grant_row.endpoint_id,
      grant_row.credential_class,grant_row.credential_id,
      grant_row.provider_ciphertext_sha256,
      grant_row.credential_fingerprint_sha256,
      grant_row.outbound_body_sha256,grant_row.upstream_url_sha256,
      pg_catalog.clock_timestamp());
  RETURN pg_catalog.jsonb_build_object('status','fact_recorded',
    'factId',v_fact_id,'evidenceSha256',v_digest);
END;
$append$;

-- The external holder and bill wrappers retain their v366 signatures and
-- grants. Both resolve this same function OID after replacement. A provider
-- bill still names custody/send epoch 1; only holder observations name a
-- committed renewal epoch. No SQL result certifies a charge or no-fetch.
REVOKE ALL ON cinatoken_gateway.complete_text_result_epoch_conflicts_v370
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_complete_text_send_holder,
    cinatoken_gateway_complete_text_provider_bill,
    cinatoken_gateway_complete_text_hold_renewer;
REVOKE ALL ON FUNCTION
  cinatoken_gateway.reject_complete_text_result_epoch_conflict_mutation_v370()
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_complete_text_send_holder,
    cinatoken_gateway_complete_text_provider_bill,
    cinatoken_gateway_complete_text_hold_renewer;
DO $postflight$
DECLARE holder_oid oid; bill_oid oid; proc_oid oid;
BEGIN
  SELECT oid INTO holder_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_complete_text_send_holder';
  SELECT oid INTO bill_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_complete_text_provider_bill';
  proc_oid:=pg_catalog.to_regprocedure(
    'cinatoken_gateway.append_complete_text_result_fact_internal_v366(uuid,uuid,bigint,uuid,text,jsonb,text,text)');
  IF proc_oid IS NULL
    OR pg_catalog.has_function_privilege(holder_oid,proc_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(bill_oid,proc_oid,'EXECUTE')
    OR NOT pg_catalog.has_function_privilege(holder_oid,
      'cinatoken_gateway.append_complete_text_holder_fact_v366(uuid,uuid,bigint,uuid,text,jsonb,text)','EXECUTE')
    OR NOT pg_catalog.has_function_privilege(bill_oid,
      'cinatoken_gateway.append_complete_text_provider_bill_v366(uuid,uuid,jsonb,text)','EXECUTE')
    OR pg_catalog.has_table_privilege(holder_oid,
      'cinatoken_gateway.complete_text_result_epoch_conflicts_v370',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    OR pg_catalog.has_table_privilege(bill_oid,
      'cinatoken_gateway.complete_text_result_epoch_conflicts_v370',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
      WHERE NOT t.tgisinternal AND t.tgenabled='O'
        AND t.tgrelid=
          'cinatoken_gateway.complete_text_result_epoch_conflicts_v370'::pg_catalog.regclass
        AND t.tgfoid=
          'cinatoken_gateway.reject_complete_text_result_epoch_conflict_mutation_v370()'::pg_catalog.regprocedure
        AND t.tgname IN (
          'complete_text_result_epoch_conflicts_v370_no_mutation',
          'complete_text_result_epoch_conflicts_v370_no_truncate'))<>2
  THEN RAISE EXCEPTION 'complete text renewed facts v370 postflight differs'
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
