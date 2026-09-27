-- Review-only PG73 successor. Not a formal migration or monetary authority.
-- Activation: cinatoken.complete_text_response_observation_v392_activation=reviewed-v1.
-- The holder attests fetch-readable response bytes; PostgreSQL cannot observe HTTP.
-- Installation branch: after v370 renewed-holder-facts, before the extra v388 /
-- v389 terminal/recovery triggers. This exact preflight does not attest coexistence
-- with the installed no-fetch closer/recovery branch; that combined cutover is unproved.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923562);
SELECT pg_catalog.pg_advisory_xact_lock(746923565);
SELECT pg_catalog.pg_advisory_xact_lock(746923566);
SELECT pg_catalog.pg_advisory_xact_lock(746923567);
SELECT pg_catalog.pg_advisory_xact_lock(746923592);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.complete_text_attempt_grants_v362,
  cinatoken_gateway.complete_text_send_custody_v365,
  cinatoken_gateway.complete_text_send_starts_v365,
  cinatoken_gateway.complete_text_result_facts_v366,
  cinatoken_gateway.complete_text_result_fact_conflicts_v366,
  cinatoken_gateway.complete_text_hold_renewals_v367,
  cinatoken_gateway.complete_text_result_epoch_conflicts_v370
  IN SHARE ROW EXCLUSIVE MODE;
DO $preflight$
DECLARE actor record; dependency record; proc_row record;
DECLARE migrator oid; holder_oid oid; observer_oid oid; runtime_oid oid;
DECLARE dependency_tables oid[];
BEGIN
  SELECT oid INTO migrator FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO holder_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_complete_text_send_holder';
  SELECT oid INTO observer_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_complete_text_response_observer';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_runtime';
  IF SESSION_USER<>'cinatoken_gateway_migrator' OR CURRENT_USER<>SESSION_USER
    OR pg_catalog.current_setting('cinatoken.complete_text_response_observation_v392_activation',true) IS DISTINCT FROM 'reviewed-v1'
    OR migrator IS NULL OR holder_oid IS NULL OR observer_oid IS NULL OR runtime_oid IS NULL
    OR (SELECT count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n' ORDER BY version COLLATE "C"))
      FROM cinatoken_gateway.schema_migrations) IS DISTINCT FROM 'ca1ea96a1b4bcd0675642f30dcf48042'
    OR (SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname='cinatoken_gateway') IS DISTINCT FROM migrator
    OR pg_catalog.to_regnamespace('cinatoken_response_observation') IS NOT NULL
    OR pg_catalog.to_regprocedure('cinatoken_gateway.append_complete_text_response_observation_v392(uuid,uuid,uuid,bigint,uuid,jsonb)') IS NOT NULL
    OR pg_catalog.to_regprocedure('cinatoken_gateway.read_complete_text_response_observation_v392(uuid)') IS NOT NULL
  THEN RAISE EXCEPTION 'response observation v392 activation or dependency differs' USING ERRCODE='P0001'; END IF;

  FOR actor IN SELECT * FROM pg_catalog.pg_roles WHERE oid IN (holder_oid,observer_oid) LOOP
    IF NOT actor.rolcanlogin OR actor.rolinherit OR actor.rolsuper OR actor.rolcreaterole
      OR actor.rolcreatedb OR actor.rolreplication OR actor.rolbypassrls
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=actor.oid OR roleid=actor.oid)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname LIKE 'cinatoken_%'
        AND (pg_catalog.has_schema_privilege(actor.oid,n.oid,'CREATE')
          OR (n.nspname<>'cinatoken_gateway' AND pg_catalog.has_schema_privilege(actor.oid,n.oid,'USAGE'))))
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname LIKE 'cinatoken_%' AND CASE WHEN c.relkind IN ('r','p','v','m','f')
          THEN pg_catalog.has_table_privilege(actor.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            OR pg_catalog.has_any_column_privilege(actor.oid,c.oid,'SELECT,INSERT,UPDATE') ELSE false END)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname LIKE 'cinatoken_%' AND CASE WHEN c.relkind='S'
          THEN pg_catalog.has_sequence_privilege(actor.oid,c.oid,'SELECT,USAGE,UPDATE') ELSE false END)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE (n.nspname LIKE 'cinatoken_%' OR p.proowner=migrator)
          AND pg_catalog.has_function_privilege(actor.oid,p.oid,'EXECUTE')
          AND (actor.oid=observer_oid OR p.oid NOT IN (
            'cinatoken_gateway.claim_complete_text_send_custody_v365(uuid,uuid)'::regprocedure,
            'cinatoken_gateway.record_complete_text_send_start_v365(uuid,uuid,bigint,text)'::regprocedure,
            'cinatoken_gateway.append_complete_text_holder_fact_v366(uuid,uuid,bigint,uuid,text,jsonb,text)'::regprocedure)
            OR pg_catalog.has_function_privilege(actor.oid,p.oid,'EXECUTE WITH GRANT OPTION')))
    THEN RAISE EXCEPTION 'response observation v392 role differs' USING ERRCODE='P0001'; END IF;
  END LOOP;
  IF NOT pg_catalog.has_function_privilege(holder_oid,'cinatoken_gateway.claim_complete_text_send_custody_v365(uuid,uuid)','EXECUTE')
    OR NOT pg_catalog.has_function_privilege(holder_oid,'cinatoken_gateway.record_complete_text_send_start_v365(uuid,uuid,bigint,text)','EXECUTE')
    OR NOT pg_catalog.has_function_privilege(holder_oid,'cinatoken_gateway.append_complete_text_holder_fact_v366(uuid,uuid,bigint,uuid,text,jsonb,text)','EXECUTE')
  THEN RAISE EXCEPTION 'response observation v392 holder wrapper missing' USING ERRCODE='P0001'; END IF;

  -- New private tables/schema inherit global defaults. New gateway/private
  -- functions may inherit only non-grantable PUBLIC/runtime EXECUTE, both of
  -- which the final REVOKEs remove. Gateway-scoped relation defaults cannot
  -- apply: this proposal creates no relations in cinatoken_gateway.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl d,
      LATERAL pg_catalog.aclexplode(d.defaclacl) a
      WHERE d.defaclrole=migrator AND a.grantee<>migrator
        AND (d.defaclnamespace=0 OR d.defaclnamespace='cinatoken_gateway'::regnamespace)
        AND NOT (d.defaclobjtype='f' AND a.privilege_type='EXECUTE' AND NOT a.is_grantable
          AND a.grantee IN (0,runtime_oid))
        AND NOT (d.defaclnamespace='cinatoken_gateway'::regnamespace AND d.defaclobjtype IN ('r','S')))
  THEN RAISE EXCEPTION 'response observation v392 default privileges differ' USING ERRCODE='P0001'; END IF;

  dependency_tables:=ARRAY[
    'cinatoken_gateway.complete_text_attempt_grants_v362'::regclass,
    'cinatoken_gateway.complete_text_send_custody_v365'::regclass,
    'cinatoken_gateway.complete_text_send_starts_v365'::regclass,
    'cinatoken_gateway.complete_text_result_facts_v366'::regclass,
    'cinatoken_gateway.complete_text_result_fact_conflicts_v366'::regclass,
    'cinatoken_gateway.complete_text_hold_renewals_v367'::regclass,
    'cinatoken_gateway.complete_text_result_epoch_conflicts_v370'::regclass];
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=ANY(dependency_tables)
      AND (c.relowner<>migrator OR c.relkind<>'r' OR c.relrowsecurity OR c.relforcerowsecurity
        OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
          WHERE a.grantee<>migrator)))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute t,
      LATERAL pg_catalog.aclexplode(t.attacl) a WHERE t.attrelid=ANY(dependency_tables) AND a.grantee<>migrator)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=ANY(dependency_tables))
  THEN RAISE EXCEPTION 'response observation v392 dependency table authority differs' USING ERRCODE='P0001'; END IF;

  -- Exact normalized prosrc pins from the reviewed v362/v365/v366/v367/v370
  -- sources. v370's internal writer is required; an old or replaced writer
  -- cannot silently stand in for the renewed-fact identity contract.
  FOR dependency IN SELECT * FROM (VALUES
    ('reject_complete_text_grant_mutation_v362()','308d1f6c147c12d86e0b6ee969944a37','trigger','v',false),
    ('grant_complete_flat_text_attempt_v362(uuid,jsonb)','0339e4f95fff26784032d2d73ec09a7a','jsonb','v',true),
    ('reject_complete_text_send_start_mutation_v365()','ae5a62591cab74acd0b30a9517fc5f9e','trigger','v',false),
    ('check_complete_text_send_holds_v365(text,uuid,timestamp with time zone)','d8851f2897d6ec937da58b42c13798ae','text','v',false),
    ('claim_complete_text_send_custody_v365(uuid,uuid)','6133110f0a7786fc02e0de74010539cb','jsonb','v',true),
    ('record_complete_text_send_start_v365(uuid,uuid,bigint,text)','b9e8501cb001aadca9e41bd95c8fa6bd','jsonb','v',true),
    ('reject_complete_text_result_fact_mutation_v366()','c80370311abec8d97074e10d27d344cf','trigger','v',false),
    ('valid_complete_text_result_evidence_v366(text,jsonb)','3526560dc1f1fda236b3d43d94cdc98a','boolean','i',false),
    ('append_complete_text_result_fact_internal_v366(uuid,uuid,bigint,uuid,text,jsonb,text,text)','9da0e543da322bfb973a30ca12321b5f','jsonb','v',true),
    ('append_complete_text_holder_fact_v366(uuid,uuid,bigint,uuid,text,jsonb,text)','2d624e90797418b9087cfc3c203f3785','jsonb','v',false),
    ('reject_complete_text_hold_renewal_mutation_v367()','1df01ab632d99f44ff967a31ee27ec9d','trigger','v',false),
    ('renew_complete_text_holds_v367(uuid,uuid,uuid,bigint)','61cef47071a34d3821b1377e959abf7b','jsonb','v',true),
    ('reject_complete_text_result_epoch_conflict_mutation_v370()','af2eb8ec40a4d210bb8898a467071ce9','trigger','v',false)
  ) AS expected(signature,body_md5,result_type,volatility,timed) LOOP
    SELECT * INTO proc_row FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure('cinatoken_gateway.'||dependency.signature);
    IF NOT FOUND OR proc_row.proowner<>migrator OR NOT proc_row.prosecdef OR proc_row.prokind<>'f'
      OR proc_row.provolatile::text<>dependency.volatility OR proc_row.proretset OR proc_row.proisstrict OR proc_row.proleakproof
      OR proc_row.proparallel<>'u' OR proc_row.prorettype<>pg_catalog.to_regtype(dependency.result_type)
      OR proc_row.prolang<>(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
      OR proc_row.proconfig IS DISTINCT FROM (CASE WHEN dependency.timed
        THEN ARRAY['search_path=pg_catalog, pg_temp','lock_timeout=2s','statement_timeout=15s']::text[]
        ELSE ARRAY['search_path=pg_catalog, pg_temp']::text[] END)
      OR pg_catalog.md5(pg_catalog.replace(proc_row.prosrc,E'\r\n',E'\n'))<>dependency.body_md5
    THEN RAISE EXCEPTION 'response observation v392 function dependency differs: %',dependency.signature USING ERRCODE='P0001'; END IF;
  END LOOP;

  -- These baseline tables have eight reviewed user triggers. No extra trigger
  -- may precede an immutable-row trigger and suppress its rejection. Original
  -- tables without a truncate trigger instead require zero external raw ACLs.
  IF (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid=ANY(dependency_tables) AND NOT tgisinternal)<>8
    OR (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal
      AND t.tgqual IS NULL AND t.tgattr::text='' AND t.tgnargs=0 AND NOT t.tgdeferrable AND NOT t.tginitdeferred
      AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
      AND (t.tgrelid,t.tgname,t.tgfoid,t.tgenabled,t.tgtype) IN (
        ('cinatoken_gateway.complete_text_attempt_grants_v362'::regclass,'complete_text_attempt_grants_v362_no_mutation','cinatoken_gateway.reject_complete_text_grant_mutation_v362()'::regprocedure,'O',27),
        ('cinatoken_gateway.complete_text_send_custody_v365'::regclass,'complete_text_send_custody_v365_no_mutation','cinatoken_gateway.reject_complete_text_send_start_mutation_v365()'::regprocedure,'O',27),
        ('cinatoken_gateway.complete_text_send_starts_v365'::regclass,'complete_text_send_starts_v365_no_mutation','cinatoken_gateway.reject_complete_text_send_start_mutation_v365()'::regprocedure,'O',27),
        ('cinatoken_gateway.complete_text_result_facts_v366'::regclass,'complete_text_result_facts_v366_no_mutation','cinatoken_gateway.reject_complete_text_result_fact_mutation_v366()'::regprocedure,'O',27),
        ('cinatoken_gateway.complete_text_result_fact_conflicts_v366'::regclass,'complete_text_result_fact_conflicts_v366_no_mutation','cinatoken_gateway.reject_complete_text_result_fact_mutation_v366()'::regprocedure,'O',27),
        ('cinatoken_gateway.complete_text_hold_renewals_v367'::regclass,'complete_text_hold_renewals_v367_no_mutation','cinatoken_gateway.reject_complete_text_hold_renewal_mutation_v367()'::regprocedure,'O',27),
        ('cinatoken_gateway.complete_text_result_epoch_conflicts_v370'::regclass,'complete_text_result_epoch_conflicts_v370_no_mutation','cinatoken_gateway.reject_complete_text_result_epoch_conflict_mutation_v370()'::regprocedure,'O',27),
        ('cinatoken_gateway.complete_text_result_epoch_conflicts_v370'::regclass,'complete_text_result_epoch_conflicts_v370_no_truncate','cinatoken_gateway.reject_complete_text_result_epoch_conflict_mutation_v370()'::regprocedure,'O',34)))<>8
  THEN RAISE EXCEPTION 'response observation v392 trigger dependency differs' USING ERRCODE='P0001'; END IF;
END;
$preflight$;

CREATE SCHEMA cinatoken_response_observation AUTHORIZATION cinatoken_gateway_migrator;
REVOKE ALL ON SCHEMA cinatoken_response_observation FROM PUBLIC;
CREATE TABLE cinatoken_response_observation.observations_v392 (
  observation_id uuid PRIMARY KEY,
  grant_id uuid NOT NULL UNIQUE REFERENCES cinatoken_gateway.complete_text_attempt_grants_v362(grant_id),
  request_id text NOT NULL,
  holder_run_id uuid NOT NULL,
  send_start_id uuid NOT NULL REFERENCES cinatoken_gateway.complete_text_send_starts_v365(send_start_id),
  evidence_nonce uuid NOT NULL,
  fact_id uuid NOT NULL UNIQUE REFERENCES cinatoken_gateway.complete_text_result_facts_v366(fact_id),
  observation jsonb NOT NULL,
  observation_sha256 text NOT NULL CHECK(observation_sha256 ~ '^[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(grant_id,evidence_nonce)
);
CREATE FUNCTION cinatoken_response_observation.reject_mutation_v392()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,pg_temp AS $fn$
BEGIN RAISE EXCEPTION 'response observation immutable'
  USING ERRCODE='23514',CONSTRAINT='response_observation_immutable_v392'; END;
$fn$;
CREATE TRIGGER response_observation_immutable_v392 BEFORE UPDATE OR DELETE
  ON cinatoken_response_observation.observations_v392 FOR EACH ROW
  EXECUTE FUNCTION cinatoken_response_observation.reject_mutation_v392();
CREATE TRIGGER response_observation_no_truncate_v392 BEFORE TRUNCATE
  ON cinatoken_response_observation.observations_v392 FOR EACH STATEMENT
  EXECUTE FUNCTION cinatoken_response_observation.reject_mutation_v392();

CREATE FUNCTION cinatoken_gateway.append_complete_text_response_observation_v392(
  p_grant_id uuid,p_holder_run_id uuid,p_send_start_id uuid,p_expected_epoch bigint,
  p_evidence_nonce uuid,p_observation jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp SET lock_timeout TO '2s' SET statement_timeout TO '15s' AS $append$
DECLARE r record; s record; old_row record; fact_result jsonb; fact_evidence jsonb;
DECLARE request_key text; digest text; nonce_hex text; expected_nonce uuid;
DECLARE observation_id uuid; fact_id uuid; response_status text; k text;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_complete_text_send_holder'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_grant_id IS NULL OR p_holder_run_id IS NULL OR p_send_start_id IS NULL
    OR p_expected_epoch IS DISTINCT FROM 1 OR p_evidence_nonce IS NULL
    OR p_observation IS NULL OR pg_catalog.jsonb_typeof(p_observation)<>'object'
    OR pg_catalog.octet_length(p_observation::text)>2048
    OR (SELECT array_agg(key ORDER BY key) FROM pg_catalog.jsonb_object_keys(p_observation) key)
      IS DISTINCT FROM ARRAY['acceptedPredictionTokens','audioInputTokens','audioOutputTokens','cacheReadTokens','cacheWriteTokens','endMarker','format','httpRequestId',
      'imageInputTokens','inputTokens','outputTokens','providerRequestRef','rawResponseBytes','rawResponseSha256','reasoningTokens','rejectedPredictionTokens','reportedModel','serviceTier','textInputTokens','textOutputTokens','totalTokens']::text[]
  THEN RAISE EXCEPTION 'invalid response observation call' USING ERRCODE='23514'; END IF;
  FOR k IN SELECT unnest(ARRAY['inputTokens','outputTokens','totalTokens','rawResponseBytes']) LOOP
    IF jsonb_typeof(p_observation->k)<>'number' OR p_observation->>k !~ '^(0|[1-9][0-9]{0,8})$'
    THEN RAISE EXCEPTION 'invalid response observation count' USING ERRCODE='23514'; END IF;
  END LOOP;
  FOR k IN SELECT unnest(ARRAY['cacheReadTokens','cacheWriteTokens','reasoningTokens','audioInputTokens','imageInputTokens','textInputTokens','audioOutputTokens','textOutputTokens','acceptedPredictionTokens','rejectedPredictionTokens']) LOOP
    IF p_observation->k<>'null'::jsonb AND
      (jsonb_typeof(p_observation->k)<>'number' OR p_observation->>k !~ '^(0|[1-9][0-9]{0,8})$')
    THEN RAISE EXCEPTION 'invalid response observation detail' USING ERRCODE='23514'; END IF;
  END LOOP;
  FOR k IN SELECT unnest(ARRAY['providerRequestRef','reportedModel']) LOOP
    IF jsonb_typeof(p_observation->k)<>'string' OR p_observation->>k !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
    THEN RAISE EXCEPTION 'invalid response observation identity' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF (p_observation->'serviceTier'<>'null'::jsonb AND (jsonb_typeof(p_observation->'serviceTier')<>'string' OR p_observation->>'serviceTier' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'))
    OR jsonb_typeof(p_observation->'format')<>'string' OR p_observation->>'format' NOT IN ('json','sse')
    OR p_observation->>'endMarker' IS DISTINCT FROM (CASE p_observation->>'format' WHEN 'json' THEN 'json_eof' ELSE 'sse_done_eof' END)
    OR jsonb_typeof(p_observation->'rawResponseSha256')<>'string' OR p_observation->>'rawResponseSha256' !~ '^[0-9a-f]{64}$'
    OR (p_observation->'httpRequestId'<>'null'::jsonb AND (jsonb_typeof(p_observation->'httpRequestId')<>'string'
      OR p_observation->>'httpRequestId' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'))
    OR (p_observation->>'rawResponseBytes')::bigint NOT BETWEEN 1 AND (CASE p_observation->>'format' WHEN 'json' THEN 1048576 ELSE 16777216 END)
    OR (p_observation->>'totalTokens')::bigint<>(p_observation->>'inputTokens')::bigint+(p_observation->>'outputTokens')::bigint
    OR COALESCE((p_observation->>'cacheReadTokens')::bigint,0)+COALESCE((p_observation->>'cacheWriteTokens')::bigint,0)>(p_observation->>'inputTokens')::bigint
    OR COALESCE((p_observation->>'reasoningTokens')::bigint,0)>(p_observation->>'outputTokens')::bigint
  THEN RAISE EXCEPTION 'invalid response observation shape' USING ERRCODE='23514'; END IF;
  nonce_hex:=encode(sha256(convert_to('cinatoken.complete_text.response.v392','UTF8')||decode('00','hex')
    ||convert_to(p_grant_id::text,'UTF8')||decode('00','hex')||convert_to(p_holder_run_id::text,'UTF8')
    ||decode('00','hex')||convert_to(p_send_start_id::text,'UTF8')),'hex');
  expected_nonce:=(substr(nonce_hex,1,12)||'5'||substr(nonce_hex,14,3)
    ||to_hex(((get_byte(decode(nonce_hex,'hex'),8)>>4)&3)+8)||substr(nonce_hex,18,15))::uuid;
  IF expected_nonce<>p_evidence_nonce THEN RAISE EXCEPTION 'response observation nonce differs' USING ERRCODE='23514'; END IF;
  SELECT request_id INTO request_key FROM cinatoken_gateway.complete_text_attempt_grants_v362 WHERE grant_id=p_grant_id;
  IF request_key IS NULL THEN RAISE EXCEPTION 'response observation grant required' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(348,hashtext(request_key));
  SELECT * INTO r FROM cinatoken_gateway.complete_text_attempt_grants_v362 WHERE grant_id=p_grant_id FOR SHARE;
  SELECT * INTO s FROM cinatoken_gateway.complete_text_send_starts_v365 WHERE grant_id=p_grant_id FOR SHARE;
  IF s.send_start_id IS DISTINCT FROM p_send_start_id OR s.holder_run_id IS DISTINCT FROM p_holder_run_id
    OR s.lease_epoch IS DISTINCT FROM 1 OR s.request_id IS DISTINCT FROM r.request_id
    OR s.outbound_body_sha256 IS DISTINCT FROM r.outbound_body_sha256
    OR NOT EXISTS (SELECT 1 FROM cinatoken_gateway.complete_text_result_facts_v366 f
      WHERE f.grant_id=p_grant_id AND f.holder_run_id=p_holder_run_id AND f.send_start_id=p_send_start_id
        AND f.source_kind='holder' AND f.kind='fetch_invoked'
        AND ROW(f.request_id,f.quote_id,f.grant_claim_sha256,f.final_body_sha256,f.route_target_id,
          f.provider_id,f.endpoint_id,f.credential_class,f.credential_id,f.provider_ciphertext_sha256,
          f.credential_fingerprint_sha256,f.outbound_body_sha256,f.upstream_url_sha256)
          IS NOT DISTINCT FROM ROW(r.request_id,r.quote_id,r.claim_sha256,r.final_body_sha256,r.route_target_id,
          r.provider_id,r.endpoint_id,r.credential_class,r.credential_id,r.provider_ciphertext_sha256,
          r.credential_fingerprint_sha256,r.outbound_body_sha256,r.upstream_url_sha256)
        AND f.evidence=jsonb_build_object('observation','fetch_invoked','uploadSha256',r.outbound_body_sha256)
        AND f.evidence_sha256=encode(sha256(convert_to(f.evidence::text,'UTF8')),'hex'))
  THEN RAISE EXCEPTION 'response observation committed invocation required' USING ERRCODE='23514'; END IF;
  digest:=encode(sha256(convert_to(p_observation::text,'UTF8')),'hex');
  SELECT * INTO old_row FROM cinatoken_response_observation.observations_v392 WHERE grant_id=p_grant_id;
  IF FOUND THEN
    IF old_row.holder_run_id<>p_holder_run_id OR old_row.send_start_id<>p_send_start_id
      OR old_row.evidence_nonce<>p_evidence_nonce OR old_row.observation_sha256<>digest OR old_row.observation<>p_observation
    THEN RAISE EXCEPTION 'response observation conflict' USING ERRCODE='23514'; END IF;
    observation_id:=old_row.observation_id; fact_id:=old_row.fact_id; response_status:='already_recorded';
  ELSE
    fact_evidence:=jsonb_build_object('providerRequestRef',p_observation->>'providerRequestRef',
      'inputTokens',(p_observation->>'inputTokens')::bigint,'outputTokens',(p_observation->>'outputTokens')::bigint);
    fact_result:=cinatoken_gateway.append_complete_text_holder_fact_v366(p_grant_id,p_holder_run_id,1,
      p_evidence_nonce,'provider_usage',fact_evidence,encode(sha256(convert_to(fact_evidence::text,'UTF8')),'hex'));
    IF fact_result->>'status' IS DISTINCT FROM 'fact_recorded'
    THEN RAISE EXCEPTION 'response observation fact unavailable' USING ERRCODE='23514'; END IF;
    fact_id:=(fact_result->>'factId')::uuid; observation_id:=gen_random_uuid();
    INSERT INTO cinatoken_response_observation.observations_v392
      (observation_id,grant_id,request_id,holder_run_id,send_start_id,evidence_nonce,fact_id,observation,observation_sha256)
      VALUES(observation_id,p_grant_id,r.request_id,p_holder_run_id,p_send_start_id,p_evidence_nonce,fact_id,p_observation,digest);
    response_status:='observation_recorded';
  END IF;
  RETURN jsonb_build_object('status',response_status,'requestId',r.request_id,'grantId',p_grant_id,
    'holderRunId',p_holder_run_id,'sendStartId',p_send_start_id,'evidenceNonce',p_evidence_nonce,
    'observationId',observation_id,'factId',fact_id,'observationSha256',digest);
END;
$append$;

-- Independent reader confirms a durable linked observation without caller completion claims.
CREATE FUNCTION cinatoken_gateway.read_complete_text_response_observation_v392(p_grant_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp SET lock_timeout TO '2s' SET statement_timeout TO '15s' AS $read$
DECLARE o record; f record; g record; s record; c record;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_complete_text_response_observer'
    OR current_setting('transaction_isolation')<>'read committed' OR p_grant_id IS NULL
  THEN RAISE EXCEPTION 'invalid response observation reader' USING ERRCODE='23514'; END IF;
  SELECT * INTO o FROM cinatoken_response_observation.observations_v392 WHERE grant_id=p_grant_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','missing'); END IF;
  SELECT * INTO f FROM cinatoken_gateway.complete_text_result_facts_v366 WHERE fact_id=o.fact_id;
  SELECT * INTO g FROM cinatoken_gateway.complete_text_attempt_grants_v362 WHERE grant_id=o.grant_id;
  SELECT * INTO s FROM cinatoken_gateway.complete_text_send_starts_v365 WHERE grant_id=o.grant_id;
  SELECT * INTO c FROM cinatoken_gateway.complete_text_send_custody_v365 WHERE grant_id=o.grant_id;
  IF f.grant_id IS DISTINCT FROM o.grant_id OR f.request_id IS DISTINCT FROM o.request_id
    OR f.holder_run_id IS DISTINCT FROM o.holder_run_id OR f.send_start_id IS DISTINCT FROM o.send_start_id
    OR f.evidence_nonce IS DISTINCT FROM o.evidence_nonce OR f.lease_epoch IS DISTINCT FROM 1
    OR f.kind IS DISTINCT FROM 'provider_usage' OR f.source_kind IS DISTINCT FROM 'holder'
    OR f.evidence IS DISTINCT FROM jsonb_build_object('providerRequestRef',o.observation->>'providerRequestRef',
      'inputTokens',(o.observation->>'inputTokens')::bigint,'outputTokens',(o.observation->>'outputTokens')::bigint)
    OR o.observation_sha256 IS DISTINCT FROM encode(sha256(convert_to(o.observation::text,'UTF8')),'hex')
    OR f.evidence_sha256 IS DISTINCT FROM encode(sha256(convert_to(f.evidence::text,'UTF8')),'hex')
    OR ROW(f.request_id,f.quote_id,f.grant_claim_sha256,f.final_body_sha256,f.route_target_id,
      f.provider_id,f.endpoint_id,f.credential_class,f.credential_id,f.provider_ciphertext_sha256,
      f.credential_fingerprint_sha256,f.outbound_body_sha256,f.upstream_url_sha256)
      IS DISTINCT FROM ROW(g.request_id,g.quote_id,g.claim_sha256,g.final_body_sha256,g.route_target_id,
      g.provider_id,g.endpoint_id,g.credential_class,g.credential_id,g.provider_ciphertext_sha256,
      g.credential_fingerprint_sha256,g.outbound_body_sha256,g.upstream_url_sha256)
    OR ROW(s.send_start_id,s.request_id,s.holder_run_id,s.lease_epoch,s.outbound_body_sha256)
      IS DISTINCT FROM ROW(o.send_start_id,o.request_id,o.holder_run_id,1::bigint,g.outbound_body_sha256)
    OR ROW(c.request_id,c.holder_run_id,c.lease_epoch,c.mode)
      IS DISTINCT FROM ROW(o.request_id,o.holder_run_id,1::bigint,'active'::text)
  THEN RAISE EXCEPTION 'response observation persisted identity differs' USING ERRCODE='23514'; END IF;
  RETURN jsonb_build_object('status','observed','requestId',o.request_id,'grantId',o.grant_id,
    'holderRunId',o.holder_run_id,'sendStartId',o.send_start_id,'evidenceNonce',o.evidence_nonce,
    'observationId',o.observation_id,'factId',o.fact_id,'observationSha256',o.observation_sha256,
    'observation',o.observation,'supplierCostStatus','not_asserted');
END;
$read$;
REVOKE ALL ON ALL TABLES IN SCHEMA cinatoken_response_observation FROM PUBLIC,cinatoken_gateway_runtime,
  cinatoken_gateway_complete_text_send_holder,cinatoken_gateway_complete_text_response_observer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cinatoken_response_observation FROM PUBLIC,cinatoken_gateway_runtime;
REVOKE ALL ON FUNCTION cinatoken_gateway.append_complete_text_response_observation_v392(uuid,uuid,uuid,bigint,uuid,jsonb),
  cinatoken_gateway.read_complete_text_response_observation_v392(uuid)
  FROM PUBLIC,cinatoken_gateway_runtime,cinatoken_gateway_complete_text_send_holder,cinatoken_gateway_complete_text_response_observer;
GRANT USAGE ON SCHEMA cinatoken_gateway TO cinatoken_gateway_complete_text_response_observer;
GRANT EXECUTE ON FUNCTION cinatoken_gateway.append_complete_text_response_observation_v392(uuid,uuid,uuid,bigint,uuid,jsonb)
  TO cinatoken_gateway_complete_text_send_holder;
GRANT EXECUTE ON FUNCTION cinatoken_gateway.read_complete_text_response_observation_v392(uuid)
  TO cinatoken_gateway_complete_text_response_observer;
