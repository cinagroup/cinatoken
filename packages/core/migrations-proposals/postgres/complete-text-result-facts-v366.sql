-- REVIEW ONLY. Install after v362 and v365 in one migrator transaction with
-- cinatoken.complete_text_result_facts_activation=reviewed-v1. Provision a
-- separate direct NOINHERIT LOGIN cinatoken_gateway_complete_text_provider_bill
-- before installation. Neither this layer nor a holder observation resolves a
-- grant, settles a buyer, or makes a no-charge determination.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923562);
SELECT pg_catalog.pg_advisory_xact_lock(746923565);
SELECT pg_catalog.pg_advisory_xact_lock(746923566);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.complete_text_attempt_grants_v362,
  cinatoken_gateway.complete_text_send_custody_v365,
  cinatoken_gateway.complete_text_send_starts_v365
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; holder_oid oid; bill_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO holder_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_complete_text_send_holder';
  SELECT oid INTO bill_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_complete_text_provider_bill';
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting(
      'cinatoken.complete_text_result_facts_activation',true)
        IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR holder_oid IS NULL OR bill_oid IS NULL
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
      WHERE nspname='cinatoken_gateway') IS DISTINCT FROM migrator_oid
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE oid IN (holder_oid,bill_oid)
        AND NOT (rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
          AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
          AND NOT rolinherit))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid IN (holder_oid,bill_oid) OR member IN (holder_oid,bill_oid))
    OR pg_catalog.has_schema_privilege(bill_oid,'cinatoken_gateway','CREATE')
    OR pg_catalog.has_schema_privilege(holder_oid,'cinatoken_gateway','CREATE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
      WHERE n.nspname LIKE 'cinatoken_economic_%'
        AND (pg_catalog.has_schema_privilege(bill_oid,n.oid,'USAGE')
          OR pg_catalog.has_schema_privilege(holder_oid,n.oid,'USAGE')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('cinatoken_gateway','cinatoken_economic_outbox',
        'cinatoken_economic_quotes','cinatoken_economic_consumer')
        AND c.relkind IN ('r','p')
        AND (pg_catalog.has_table_privilege(bill_oid,c.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR pg_catalog.has_any_column_privilege(bill_oid,c.oid,
            'SELECT,INSERT,UPDATE')
          OR pg_catalog.has_table_privilege(holder_oid,c.oid,
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR pg_catalog.has_any_column_privilege(holder_oid,c.oid,
            'SELECT,INSERT,UPDATE')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='cinatoken_gateway'
        AND pg_catalog.has_function_privilege(bill_oid,p.oid,'EXECUTE'))
    OR NOT pg_catalog.has_function_privilege(holder_oid,
      'cinatoken_gateway.record_complete_text_send_start_v365(uuid,uuid,bigint,text)',
      'EXECUTE')
    OR pg_catalog.has_table_privilege(holder_oid,
      'cinatoken_gateway.complete_text_send_starts_v365',
      'SELECT,INSERT,UPDATE,DELETE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN (
        'cinatoken_gateway.complete_text_attempt_grants_v362'::pg_catalog.regclass,
        'cinatoken_gateway.complete_text_send_custody_v365'::pg_catalog.regclass,
        'cinatoken_gateway.complete_text_send_starts_v365'::pg_catalog.regclass)
        AND (c.relowner<>migrator_oid OR c.relkind<>'r'
          OR c.relrowsecurity OR c.relforcerowsecurity))
    OR pg_catalog.to_regclass(
      'cinatoken_gateway.complete_text_result_facts_v366') IS NOT NULL
    OR pg_catalog.to_regclass(
      'cinatoken_gateway.complete_text_result_fact_conflicts_v366') IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.append_complete_text_holder_fact_v366(uuid,uuid,bigint,uuid,text,jsonb,text)') IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.append_complete_text_provider_bill_v366(uuid,uuid,jsonb,text)') IS NOT NULL
  THEN RAISE EXCEPTION 'complete text result facts v366 activation or dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

CREATE TABLE cinatoken_gateway.complete_text_result_facts_v366 (
  fact_id uuid PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES
    cinatoken_gateway.complete_text_attempt_grants_v362(grant_id),
  request_id text NOT NULL,
  quote_id uuid NOT NULL,
  holder_run_id uuid NOT NULL,
  lease_epoch bigint NOT NULL CHECK (lease_epoch>=1),
  send_start_id uuid REFERENCES
    cinatoken_gateway.complete_text_send_starts_v365(send_start_id),
  evidence_nonce uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('no_fetch_attestation','fetch_invoked',
    'transport_unknown','provider_zero_charge_observation','provider_usage',
    'provider_bill')),
  source_kind text NOT NULL CHECK (source_kind IN ('holder','provider_bill')),
  provider_request_ref text,
  provider_event_id text,
  evidence jsonb NOT NULL,
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  grant_claim_sha256 text NOT NULL,
  final_body_sha256 text NOT NULL,
  route_target_id text NOT NULL,
  provider_id text NOT NULL,
  endpoint_id text NOT NULL,
  credential_class text NOT NULL,
  credential_id text NOT NULL,
  provider_ciphertext_sha256 text NOT NULL,
  credential_fingerprint_sha256 text NOT NULL,
  outbound_body_sha256 text NOT NULL,
  upstream_url_sha256 text NOT NULL,
  received_at timestamptz NOT NULL,
  UNIQUE (grant_id,evidence_nonce),
  CHECK ((kind='provider_bill')=(source_kind='provider_bill')),
  CHECK ((kind='no_fetch_attestation') OR send_start_id IS NOT NULL)
);
CREATE UNIQUE INDEX complete_text_result_facts_v366_bill_event
  ON cinatoken_gateway.complete_text_result_facts_v366
    (provider_id,provider_event_id)
  WHERE kind='provider_bill';
CREATE INDEX complete_text_result_facts_v366_request
  ON cinatoken_gateway.complete_text_result_facts_v366(request_id,received_at);

-- A conflicting nonce is recorded without retaining untrusted evidence.
CREATE TABLE cinatoken_gateway.complete_text_result_fact_conflicts_v366 (
  conflict_id uuid PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES
    cinatoken_gateway.complete_text_attempt_grants_v362(grant_id),
  evidence_nonce uuid NOT NULL,
  source_kind text NOT NULL,
  attempted_kind text NOT NULL,
  attempted_evidence_sha256 text NOT NULL,
  observed_at timestamptz NOT NULL,
  UNIQUE (grant_id,evidence_nonce,source_kind,attempted_kind,
    attempted_evidence_sha256)
);

CREATE FUNCTION cinatoken_gateway.reject_complete_text_result_fact_mutation_v366()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $immutable$
BEGIN
  RAISE EXCEPTION 'complete text result facts v366 are append-only'
    USING ERRCODE='P0001';
END;
$immutable$;
CREATE TRIGGER complete_text_result_facts_v366_no_mutation
  BEFORE UPDATE OR DELETE ON cinatoken_gateway.complete_text_result_facts_v366
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_gateway.reject_complete_text_result_fact_mutation_v366();
CREATE TRIGGER complete_text_result_fact_conflicts_v366_no_mutation
  BEFORE UPDATE OR DELETE ON cinatoken_gateway.complete_text_result_fact_conflicts_v366
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_gateway.reject_complete_text_result_fact_mutation_v366();

CREATE FUNCTION cinatoken_gateway.valid_complete_text_result_evidence_v366(
  p_kind text,p_evidence jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $valid$
DECLARE ref text;
BEGIN
  IF p_evidence IS NULL OR pg_catalog.jsonb_typeof(p_evidence)<>'object'
    OR pg_catalog.octet_length(p_evidence::text)>1024
  THEN RETURN false; END IF;
  IF p_kind='no_fetch_attestation' THEN
    RETURN p_evidence='{"observation":"fetch_not_called"}'::jsonb;
  ELSIF p_kind='fetch_invoked' THEN
    RETURN (p_evidence-ARRAY['observation','uploadSha256'])='{}'::jsonb
      AND p_evidence->>'observation'='fetch_invoked'
      AND (p_evidence->>'uploadSha256') ~ '^[0-9a-f]{64}$';
  ELSIF p_kind='transport_unknown' THEN
    RETURN (p_evidence-ARRAY['observation','phase'])='{}'::jsonb
      AND p_evidence->>'observation'='transport_unknown'
      AND p_evidence->>'phase' IN ('connect','headers','body','cancel');
  ELSIF p_kind IN ('provider_zero_charge_observation','provider_usage',
    'provider_bill') THEN
    ref:=p_evidence->>'providerRequestRef';
    IF ref IS NULL OR ref !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
    THEN RETURN false; END IF;
    IF p_kind='provider_zero_charge_observation' THEN
      RETURN (p_evidence-ARRAY['providerRequestRef',
          'reportedChargeMicros','signalSha256'])='{}'::jsonb
        AND pg_catalog.jsonb_typeof(p_evidence->'reportedChargeMicros')='number'
        AND p_evidence->>'reportedChargeMicros'='0'
        AND (p_evidence->>'signalSha256') ~ '^[0-9a-f]{64}$';
    ELSIF p_kind='provider_usage' THEN
      RETURN (p_evidence-ARRAY['providerRequestRef','inputTokens',
          'outputTokens'])='{}'::jsonb
        AND pg_catalog.jsonb_typeof(p_evidence->'inputTokens')='number'
        AND pg_catalog.jsonb_typeof(p_evidence->'outputTokens')='number'
        AND (p_evidence->>'inputTokens') ~ '^(0|[1-9][0-9]{0,8})$'
        AND (p_evidence->>'outputTokens') ~ '^(0|[1-9][0-9]{0,8})$';
    ELSE
      RETURN (p_evidence-ARRAY['providerRequestRef','providerEventId',
          'currency','amountMicros','billDocumentSha256'])='{}'::jsonb
        AND (p_evidence->>'providerEventId') ~
          '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
        AND p_evidence->>'currency'='USD'
        AND pg_catalog.jsonb_typeof(p_evidence->'amountMicros')='number'
        AND (p_evidence->>'amountMicros') ~ '^(0|[1-9][0-9]{0,17})$'
        AND (p_evidence->>'billDocumentSha256') ~ '^[0-9a-f]{64}$';
    END IF;
  END IF;
  RETURN false;
END;
$valid$;

-- This writer is callable only through one of the two role-bound wrappers.
-- No transport status, missing usage, or holder-supplied zero becomes a
-- verified billing resolution here.
CREATE FUNCTION cinatoken_gateway.append_complete_text_result_fact_internal_v366(
  p_grant_id uuid,p_holder_run_id uuid,p_expected_epoch bigint,
  p_evidence_nonce uuid,p_kind text,p_evidence jsonb,p_evidence_sha256 text,
  p_source_kind text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
SET lock_timeout TO '2s'
SET statement_timeout TO '15s' AS $append$
DECLARE grant_row record; custody record; start_row record; prior record;
DECLARE v_digest text; v_fact_id uuid; v_ref text; v_event text;
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
        OR p_expected_epoch<1 OR p_kind='provider_bill'))
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

  SELECT * INTO grant_row FROM cinatoken_gateway.complete_text_attempt_grants_v362
    WHERE grant_id=p_grant_id FOR SHARE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status','missing_grant'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(348,
    pg_catalog.hashtext(grant_row.request_id));
  SELECT * INTO custody FROM cinatoken_gateway.complete_text_send_custody_v365
    WHERE grant_id=p_grant_id FOR SHARE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status','custody_required'); END IF;
  IF custody.request_id IS DISTINCT FROM grant_row.request_id
    OR custody.mode IS DISTINCT FROM 'active'
    OR (p_source_kind='holder' AND
      (custody.holder_run_id IS DISTINCT FROM p_holder_run_id
        OR custody.lease_epoch IS DISTINCT FROM p_expected_epoch))
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
      AND prior.lease_epoch=custody.lease_epoch
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
      custody.holder_run_id,custody.lease_epoch,start_row.send_start_id,
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

CREATE FUNCTION cinatoken_gateway.append_complete_text_holder_fact_v366(
  p_grant_id uuid,p_holder_run_id uuid,p_expected_epoch bigint,
  p_evidence_nonce uuid,p_kind text,p_evidence jsonb,p_evidence_sha256 text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $holder$
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_complete_text_send_holder'
  THEN RAISE EXCEPTION 'invalid complete text holder fact caller'
    USING ERRCODE='23514'; END IF;
  RETURN cinatoken_gateway.append_complete_text_result_fact_internal_v366(
    p_grant_id,p_holder_run_id,p_expected_epoch,p_evidence_nonce,p_kind,
    p_evidence,p_evidence_sha256,'holder');
END;
$holder$;

CREATE FUNCTION cinatoken_gateway.append_complete_text_provider_bill_v366(
  p_grant_id uuid,p_evidence_nonce uuid,p_evidence jsonb,
  p_evidence_sha256 text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $bill$
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_complete_text_provider_bill'
  THEN RAISE EXCEPTION 'invalid complete text bill fact caller'
    USING ERRCODE='23514'; END IF;
  RETURN cinatoken_gateway.append_complete_text_result_fact_internal_v366(
    p_grant_id,NULL,NULL,p_evidence_nonce,'provider_bill',p_evidence,
    p_evidence_sha256,'provider_bill');
END;
$bill$;

REVOKE ALL ON cinatoken_gateway.complete_text_result_facts_v366,
  cinatoken_gateway.complete_text_result_fact_conflicts_v366
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_budget_admission,
    cinatoken_gateway_complete_text_attempt_granter,
    cinatoken_gateway_complete_text_send_holder,
    cinatoken_gateway_complete_text_provider_bill;
REVOKE ALL ON FUNCTION
  cinatoken_gateway.reject_complete_text_result_fact_mutation_v366(),
  cinatoken_gateway.valid_complete_text_result_evidence_v366(text,jsonb),
  cinatoken_gateway.append_complete_text_result_fact_internal_v366(
    uuid,uuid,bigint,uuid,text,jsonb,text,text),
  cinatoken_gateway.append_complete_text_holder_fact_v366(
    uuid,uuid,bigint,uuid,text,jsonb,text),
  cinatoken_gateway.append_complete_text_provider_bill_v366(
    uuid,uuid,jsonb,text)
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_budget_admission,
    cinatoken_gateway_complete_text_attempt_granter,
    cinatoken_gateway_complete_text_send_holder,
    cinatoken_gateway_complete_text_provider_bill;
GRANT USAGE ON SCHEMA cinatoken_gateway
  TO cinatoken_gateway_complete_text_provider_bill;
GRANT EXECUTE ON FUNCTION
  cinatoken_gateway.append_complete_text_holder_fact_v366(
    uuid,uuid,bigint,uuid,text,jsonb,text)
  TO cinatoken_gateway_complete_text_send_holder;
GRANT EXECUTE ON FUNCTION
  cinatoken_gateway.append_complete_text_provider_bill_v366(
    uuid,uuid,jsonb,text)
  TO cinatoken_gateway_complete_text_provider_bill;

DO $postflight$
BEGIN
  IF NOT pg_catalog.has_function_privilege(
      'cinatoken_gateway_complete_text_send_holder',
      'cinatoken_gateway.append_complete_text_holder_fact_v366(uuid,uuid,bigint,uuid,text,jsonb,text)',
      'EXECUTE')
    OR NOT pg_catalog.has_function_privilege(
      'cinatoken_gateway_complete_text_provider_bill',
      'cinatoken_gateway.append_complete_text_provider_bill_v366(uuid,uuid,jsonb,text)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(
      'cinatoken_gateway_complete_text_send_holder',
      'cinatoken_gateway.append_complete_text_provider_bill_v366(uuid,uuid,jsonb,text)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(
      'cinatoken_gateway_complete_text_provider_bill',
      'cinatoken_gateway.append_complete_text_holder_fact_v366(uuid,uuid,bigint,uuid,text,jsonb,text)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(
      'cinatoken_gateway_complete_text_send_holder',
      'cinatoken_gateway.append_complete_text_result_fact_internal_v366(uuid,uuid,bigint,uuid,text,jsonb,text,text)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(
      'cinatoken_gateway_complete_text_provider_bill',
      'cinatoken_gateway.append_complete_text_result_fact_internal_v366(uuid,uuid,bigint,uuid,text,jsonb,text,text)',
      'EXECUTE')
    OR pg_catalog.has_table_privilege(
      'cinatoken_gateway_complete_text_send_holder',
      'cinatoken_gateway.complete_text_result_facts_v366',
      'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege(
      'cinatoken_gateway_complete_text_provider_bill',
      'cinatoken_gateway.complete_text_result_facts_v366',
      'SELECT,INSERT,UPDATE,DELETE')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger
      WHERE tgname='complete_text_result_facts_v366_no_mutation'
        AND tgrelid='cinatoken_gateway.complete_text_result_facts_v366'::pg_catalog.regclass
        AND tgenabled='O' AND NOT tgisinternal)<>1
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger
      WHERE tgname='complete_text_result_fact_conflicts_v366_no_mutation'
        AND tgrelid='cinatoken_gateway.complete_text_result_fact_conflicts_v366'::pg_catalog.regclass
        AND tgenabled='O' AND NOT tgisinternal)<>1
  THEN RAISE EXCEPTION 'complete text result facts v366 postflight differs'
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
