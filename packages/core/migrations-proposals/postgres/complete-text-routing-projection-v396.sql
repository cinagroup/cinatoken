-- REVIEW ONLY. Install atomically after v359/v360/v361/v362/v365; default off.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog,pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923596);
LOCK TABLE cinatoken_gateway.schema_migrations,cinatoken_gateway.models,
 cinatoken_gateway.model_surfaces,cinatoken_gateway.system_config,cinatoken_gateway.model_routes,
 cinatoken_gateway.providers,cinatoken_gateway.route_pools,cinatoken_gateway.model_endpoints,
 cinatoken_gateway.model_endpoint_routes,cinatoken_gateway.route_source_generations_v359,
 cinatoken_gateway.complete_text_quotes_v360,cinatoken_gateway.complete_text_attempt_grants_v362,
 cinatoken_gateway.complete_text_send_custody_v365,cinatoken_gateway.complete_text_send_starts_v365 IN SHARE ROW EXCLUSIVE MODE;
DO $preflight$
DECLARE owner_oid oid; projector_oid oid; verifier_oid oid; dependency record; proc_row record;
BEGIN
 SELECT oid INTO owner_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_migrator';
 SELECT oid INTO projector_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_complete_text_routing_projector';
 SELECT oid INTO verifier_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_route_source_verifier';
 IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
  OR pg_catalog.current_setting('cinatoken.complete_text_routing_projection_activation',true) IS DISTINCT FROM 'reviewed-v1'
  OR owner_oid IS NULL OR projector_oid IS NULL OR verifier_oid IS NULL
  OR (SELECT count(*) FROM cinatoken_gateway.schema_migrations)<>73
  OR (SELECT md5(string_agg(version,E'\n' ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)<>'ca1ea96a1b4bcd0675642f30dcf48042'
  OR (SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname='cinatoken_gateway') IS DISTINCT FROM owner_oid
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE oid IN(projector_oid,verifier_oid)
   AND NOT(rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls))
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid IN(projector_oid,verifier_oid) OR member IN(projector_oid,verifier_oid))
  OR pg_catalog.has_schema_privilege(projector_oid,'cinatoken_gateway','CREATE')
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='cinatoken_gateway' AND c.relkind IN('r','p') AND c.relowner<>owner_oid)
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname NOT IN('pg_catalog','information_schema') AND c.relkind IN('r','p') AND
    (pg_catalog.has_table_privilege(projector_oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
     OR pg_catalog.has_any_column_privilege(projector_oid,c.oid,'SELECT,INSERT,UPDATE')))
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname NOT IN('pg_catalog','information_schema') AND pg_catalog.has_function_privilege(projector_oid,p.oid,'EXECUTE'))
  OR pg_catalog.to_regclass('cinatoken_gateway.routing_policy_epoch_v396') IS NOT NULL
  OR pg_catalog.to_regprocedure('cinatoken_gateway.attest_text_route_source_v359(text,bigint,text)') IS NULL
  OR pg_catalog.to_regprocedure('cinatoken_gateway.grant_complete_flat_text_attempt_v362(uuid,jsonb)') IS NULL
  OR pg_catalog.to_regprocedure('cinatoken_gateway.record_complete_text_send_start_v365(uuid,uuid,bigint,text)') IS NULL
 THEN RAISE EXCEPTION 'routing projection v396 activation or dependency differs' USING ERRCODE='P0001'; END IF;

 IF EXISTS(SELECT 1 FROM pg_class c WHERE c.oid IN(
  'cinatoken_gateway.schema_migrations'::regclass,'cinatoken_gateway.models'::regclass,
  'cinatoken_gateway.model_surfaces'::regclass,'cinatoken_gateway.system_config'::regclass,
  'cinatoken_gateway.model_routes'::regclass,'cinatoken_gateway.providers'::regclass,
  'cinatoken_gateway.route_pools'::regclass,'cinatoken_gateway.model_endpoints'::regclass,
  'cinatoken_gateway.model_endpoint_routes'::regclass,'cinatoken_gateway.route_source_generations_v359'::regclass,
  'cinatoken_gateway.complete_text_quotes_v360'::regclass,'cinatoken_gateway.complete_text_quote_routes_v360'::regclass,
  'cinatoken_gateway.complete_text_attempt_grants_v362'::regclass,'cinatoken_gateway.complete_text_send_custody_v365'::regclass,
  'cinatoken_gateway.complete_text_send_starts_v365'::regclass)
  AND (c.relkind<>'r' OR c.relowner<>owner_oid OR c.relrowsecurity OR c.relforcerowsecurity
   OR EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=c.oid)))
 THEN RAISE EXCEPTION 'routing projection v396 source relation semantics differ'; END IF;

 IF EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d,LATERAL pg_catalog.aclexplode(d.defaclacl) a
  WHERE d.defaclrole=owner_oid AND a.grantee<>owner_oid AND (d.defaclnamespace=0 OR d.defaclnamespace='cinatoken_gateway'::regnamespace)
  AND NOT(d.defaclobjtype='f' AND a.privilege_type='EXECUTE' AND NOT a.is_grantable AND a.grantee IN(0,(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_runtime')))
  AND NOT(d.defaclnamespace='cinatoken_gateway'::regnamespace AND d.defaclobjtype='r' AND a.privilege_type='SELECT' AND NOT a.is_grantable AND a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_runtime'))
  AND NOT(d.defaclnamespace='cinatoken_gateway'::regnamespace AND d.defaclobjtype='S' AND a.privilege_type IN('SELECT','USAGE','UPDATE') AND NOT a.is_grantable AND a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_runtime')))
 THEN RAISE EXCEPTION 'routing projection v396 default privileges differ'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname LIKE 'cinatoken_%' AND c.relkind IN('r','p','v','m','f') AND
   (pg_catalog.has_table_privilege(verifier_oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    OR (c.oid NOT IN('cinatoken_gateway.model_routes'::regclass,'cinatoken_gateway.providers'::regclass,'cinatoken_gateway.route_pools'::regclass,
      'cinatoken_gateway.model_endpoints'::regclass,'cinatoken_gateway.model_endpoint_routes'::regclass,'cinatoken_gateway.route_source_generations_v359'::regclass)
      AND (pg_catalog.has_table_privilege(verifier_oid,c.oid,'SELECT') OR pg_catalog.has_any_column_privilege(verifier_oid,c.oid,'SELECT,INSERT,UPDATE')))))
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'cinatoken_%'
    AND pg_catalog.has_function_privilege(verifier_oid,p.oid,'EXECUTE') AND (p.oid<>'cinatoken_gateway.attest_text_route_source_v359(text,bigint,text)'::regprocedure
    OR pg_catalog.has_function_privilege(verifier_oid,p.oid,'EXECUTE WITH GRANT OPTION')))
 THEN RAISE EXCEPTION 'routing projection v396 verifier authority differs'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid IN('cinatoken_gateway.complete_text_attempt_grants_v362'::regclass,
  'cinatoken_gateway.complete_text_send_custody_v365'::regclass,'cinatoken_gateway.complete_text_send_starts_v365'::regclass)
  AND (c.relowner<>owner_oid OR c.relkind<>'r' OR c.relrowsecurity OR c.relforcerowsecurity OR EXISTS(
   SELECT 1 FROM pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a WHERE a.grantee<>owner_oid)))
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute t,LATERAL pg_catalog.aclexplode(t.attacl) a WHERE t.attrelid IN(
   'cinatoken_gateway.complete_text_attempt_grants_v362'::regclass,'cinatoken_gateway.complete_text_send_custody_v365'::regclass,'cinatoken_gateway.complete_text_send_starts_v365'::regclass) AND a.grantee<>owner_oid)
 THEN RAISE EXCEPTION 'routing projection v396 grant/start table authority differs'; END IF;
 FOR dependency IN SELECT * FROM (VALUES
 ('invalidate_route_source_v359()','18ef9982fdd91c6fb4f66d4af40a196a','trigger',false,NULL),
 ('invalidate_route_link_v359()','a1cc2f0716f0fd6d366424b4a12a6603','trigger',false,NULL),
 ('reject_route_source_truncate_v359()','6d392fc7516eaea8da7842a3aaa0cf84','trigger',false,NULL),
 ('attest_text_route_source_v359(text,bigint,text)','487233ff3e574d3ada3dfbcfb364095b','jsonb',true,'cinatoken_gateway_route_source_verifier'),
 ('require_text_route_source_v359()','e20c75fd627f947b37143dcad3814f17','trigger',false,NULL),
 ('reject_complete_text_quote_mutation_v360()','07d2c7536f037850a434320cd523fbdc','trigger',false,NULL),
 ('issue_complete_flat_text_quote_v360(text,text,text,text)','36dc527700329fb64f419785766413a3','jsonb',true,'cinatoken_gateway_complete_text_quote_issuer'),
 ('reject_complete_text_grant_mutation_v362()','308d1f6c147c12d86e0b6ee969944a37','trigger',false,NULL),
 ('grant_complete_flat_text_attempt_v362(uuid,jsonb)','0339e4f95fff26784032d2d73ec09a7a','jsonb',true,'cinatoken_gateway_complete_text_attempt_granter'),
 ('reject_complete_text_send_start_mutation_v365()','ae5a62591cab74acd0b30a9517fc5f9e','trigger',false,NULL),
 ('check_complete_text_send_holds_v365(text,uuid,timestamptz)','d8851f2897d6ec937da58b42c13798ae','text',false,NULL),
 ('claim_complete_text_send_custody_v365(uuid,uuid)','6133110f0a7786fc02e0de74010539cb','jsonb',true,'cinatoken_gateway_complete_text_send_holder'),
 ('record_complete_text_send_start_v365(uuid,uuid,bigint,text)','b9e8501cb001aadca9e41bd95c8fa6bd','jsonb',true,'cinatoken_gateway_complete_text_send_holder')
 ) expected(signature,body_md5,result_type,timed,actor) LOOP
  SELECT * INTO proc_row FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure('cinatoken_gateway.'||dependency.signature);
  IF NOT FOUND OR proc_row.proowner<>owner_oid OR NOT proc_row.prosecdef OR proc_row.prokind<>'f'
   OR proc_row.prolang<>(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
   OR proc_row.proparallel<>'u' OR proc_row.proretset OR proc_row.proleakproof OR proc_row.proisstrict
   OR proc_row.prorettype<>to_regtype(dependency.result_type) OR proc_row.provolatile<>'v'
   OR proc_row.proconfig IS DISTINCT FROM (CASE WHEN dependency.timed THEN ARRAY['search_path=pg_catalog, pg_temp','lock_timeout=2s','statement_timeout=15s']::text[] ELSE ARRAY['search_path=pg_catalog, pg_temp']::text[] END)
   OR pg_catalog.md5(pg_catalog.replace(proc_row.prosrc,E'\r\n',E'\n'))<>dependency.body_md5
   OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(proc_row.proacl,pg_catalog.acldefault('f',proc_row.proowner))) a
    WHERE a.privilege_type<>'EXECUTE' OR a.is_grantable OR (a.grantee<>owner_oid AND a.grantee IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname=dependency.actor)))
   OR (SELECT count(*) FROM pg_catalog.aclexplode(coalesce(proc_row.proacl,pg_catalog.acldefault('f',proc_row.proowner))))<>(CASE WHEN dependency.actor IS NULL THEN 1 ELSE 2 END)

  THEN RAISE EXCEPTION 'routing projection v396 function differs: %',dependency.signature; END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid IN('cinatoken_gateway.complete_text_attempt_grants_v362'::regclass,
  'cinatoken_gateway.complete_text_send_custody_v365'::regclass,'cinatoken_gateway.complete_text_send_starts_v365'::regclass) AND NOT tgisinternal)<>3
  OR (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE NOT tgisinternal AND tgenabled='O' AND tgtype=27 AND tgqual IS NULL AND tgattr::text='' AND tgnargs=0
   AND NOT tgdeferrable AND NOT tginitdeferred AND tgoldtable IS NULL AND tgnewtable IS NULL AND tgconstraint=0 AND tgconstrrelid=0 AND encode(tgargs,'hex')='' AND (tgrelid,tgname,tgfoid) IN(
    ('cinatoken_gateway.complete_text_attempt_grants_v362'::regclass,'complete_text_attempt_grants_v362_no_mutation','cinatoken_gateway.reject_complete_text_grant_mutation_v362()'::regprocedure),
    ('cinatoken_gateway.complete_text_send_custody_v365'::regclass,'complete_text_send_custody_v365_no_mutation','cinatoken_gateway.reject_complete_text_send_start_mutation_v365()'::regprocedure),
    ('cinatoken_gateway.complete_text_send_starts_v365'::regclass,'complete_text_send_starts_v365_no_mutation','cinatoken_gateway.reject_complete_text_send_start_mutation_v365()'::regprocedure)))<>3
 THEN RAISE EXCEPTION 'routing projection v396 immutable triggers differ'; END IF;

 IF EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname LIKE 'cinatoken_%' AND
  ((n.nspname<>'cinatoken_gateway' AND (has_schema_privilege(projector_oid,n.oid,'USAGE') OR has_schema_privilege(verifier_oid,n.oid,'USAGE')))
   OR has_schema_privilege(projector_oid,n.oid,'CREATE') OR has_schema_privilege(verifier_oid,n.oid,'CREATE')))
  OR has_database_privilege(projector_oid,current_database(),'CREATE') OR has_database_privilege(verifier_oid,current_database(),'CREATE')
  OR has_schema_privilege(projector_oid,'public','CREATE') OR has_schema_privilege(verifier_oid,'public','CREATE')
  OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'cinatoken_%'
   AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(projector_oid,c.oid,'SELECT,USAGE,UPDATE') OR has_sequence_privilege(verifier_oid,c.oid,'SELECT,USAGE,UPDATE') ELSE false END)
 THEN RAISE EXCEPTION 'routing projection v396 surrounding authority differs'; END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN(
  'cinatoken_gateway.models'::regclass,'cinatoken_gateway.model_surfaces'::regclass,'cinatoken_gateway.system_config'::regclass,
  'cinatoken_gateway.model_routes'::regclass,'cinatoken_gateway.providers'::regclass,'cinatoken_gateway.route_pools'::regclass,
  'cinatoken_gateway.model_endpoints'::regclass,'cinatoken_gateway.model_endpoint_routes'::regclass,'cinatoken_gateway.route_source_generations_v359'::regclass))<>10
  OR (SELECT count(*) FROM pg_trigger t WHERE NOT tgisinternal AND tgenabled='O' AND tgqual IS NULL AND tgattr::text='' AND tgnargs=0
   AND NOT tgdeferrable AND NOT tginitdeferred AND tgoldtable IS NULL AND tgnewtable IS NULL AND tgconstraint=0 AND tgconstrrelid=0 AND encode(tgargs,'hex')='' AND (tgrelid,tgname,tgfoid,tgtype) IN(
  ('cinatoken_gateway.model_routes'::regclass,'route_source_v359_route','cinatoken_gateway.invalidate_route_source_v359()'::regprocedure,29),
  ('cinatoken_gateway.model_routes'::regclass,'route_source_v359_route_truncate','cinatoken_gateway.reject_route_source_truncate_v359()'::regprocedure,34),
  ('cinatoken_gateway.providers'::regclass,'route_source_v359_provider','cinatoken_gateway.invalidate_route_source_v359()'::regprocedure,29),
  ('cinatoken_gateway.providers'::regclass,'route_source_v359_provider_truncate','cinatoken_gateway.reject_route_source_truncate_v359()'::regprocedure,34),
  ('cinatoken_gateway.route_pools'::regclass,'route_source_v359_pool','cinatoken_gateway.invalidate_route_source_v359()'::regprocedure,29),
  ('cinatoken_gateway.route_pools'::regclass,'route_source_v359_pool_truncate','cinatoken_gateway.reject_route_source_truncate_v359()'::regprocedure,34),
  ('cinatoken_gateway.model_endpoints'::regclass,'route_source_v359_endpoint','cinatoken_gateway.invalidate_route_source_v359()'::regprocedure,29),
  ('cinatoken_gateway.model_endpoints'::regclass,'route_source_v359_endpoint_truncate','cinatoken_gateway.reject_route_source_truncate_v359()'::regprocedure,34),
  ('cinatoken_gateway.model_endpoint_routes'::regclass,'route_source_v359_link','cinatoken_gateway.invalidate_route_link_v359()'::regprocedure,29),
  ('cinatoken_gateway.model_endpoint_routes'::regclass,'route_source_v359_link_truncate','cinatoken_gateway.reject_route_source_truncate_v359()'::regprocedure,34)))<>10
 THEN RAISE EXCEPTION 'routing projection v396 source triggers differ'; END IF;
END;
$preflight$;
CREATE TABLE cinatoken_gateway.routing_policy_epoch_v396(singleton boolean PRIMARY KEY CHECK(singleton),epoch bigint NOT NULL CHECK(epoch BETWEEN 1 AND 9223372036854775806));
INSERT INTO cinatoken_gateway.routing_policy_epoch_v396 VALUES(true,1);
CREATE TABLE cinatoken_gateway.complete_text_routing_facts_v396(model_id text PRIMARY KEY,routing_epoch bigint NOT NULL,expires_at timestamptz NOT NULL,facts jsonb NOT NULL);
CREATE TABLE cinatoken_gateway.complete_text_routing_projections_v396(
 quote_id uuid PRIMARY KEY REFERENCES cinatoken_gateway.complete_text_quotes_v360(quote_id),request_id text NOT NULL UNIQUE,
 routing_epoch bigint NOT NULL,final_body_sha256 text NOT NULL CHECK(final_body_sha256~'^[0-9a-f]{64}$'),expires_at timestamptz NOT NULL,projection jsonb NOT NULL);
CREATE TABLE cinatoken_gateway.complete_text_routing_members_v396(
 quote_id uuid NOT NULL REFERENCES cinatoken_gateway.complete_text_routing_projections_v396(quote_id),candidate_index integer NOT NULL CHECK(candidate_index BETWEEN 0 AND 7),
 model_id text NOT NULL,route_target_id text NOT NULL,provider_id text NOT NULL,endpoint_id text NOT NULL,route_pool_id text,
 source_generation bigint NOT NULL,attested_source_sha256 text NOT NULL CHECK(attested_source_sha256~'^[0-9a-f]{64}$'),beneficial_cache_read_pricing boolean NOT NULL,default_endpoint_eligible boolean NOT NULL,
 PRIMARY KEY(quote_id,route_target_id));
-- SHARE table locks need stronger authority than SELECT. The trusted reader
-- calls this narrow definer instead of receiving source UPDATE privileges.
CREATE FUNCTION cinatoken_gateway.lock_complete_text_routing_sources_v396() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,pg_temp SET lock_timeout TO '2s' SET statement_timeout TO '15s' AS $lock$
BEGIN
 IF SESSION_USER<>'cinatoken_gateway_route_source_verifier' OR current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'invalid routing source reader'; END IF;
 LOCK TABLE cinatoken_gateway.models,cinatoken_gateway.model_surfaces,cinatoken_gateway.system_config,cinatoken_gateway.model_routes,
  cinatoken_gateway.providers,cinatoken_gateway.route_pools,cinatoken_gateway.model_endpoints,cinatoken_gateway.model_endpoint_routes,
  cinatoken_gateway.route_source_generations_v359 IN SHARE MODE NOWAIT;
 IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(746923596) THEN
  RAISE EXCEPTION 'routing policy writer busy' USING ERRCODE='55P03',CONSTRAINT='complete_text_routing_writer_busy_v396';
 END IF;
END;
$lock$;
CREATE FUNCTION cinatoken_gateway.invalidate_routing_policy_v396() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,pg_temp AS $invalidate$
BEGIN
 IF TG_TABLE_SCHEMA<>'cinatoken_gateway' OR TG_TABLE_NAME NOT IN('models','model_surfaces','system_config','model_routes','providers','route_pools','model_endpoints','model_endpoint_routes') THEN RAISE EXCEPTION 'invalid routing trigger'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(746923596);
 UPDATE cinatoken_gateway.routing_policy_epoch_v396 SET epoch=epoch+1 WHERE singleton;
 RETURN NULL;
END;
$invalidate$;
DO $triggers$
DECLARE tab text;
BEGIN
 FOREACH tab IN ARRAY ARRAY['models','model_surfaces','system_config','model_routes','providers','route_pools','model_endpoints','model_endpoint_routes'] LOOP
  EXECUTE pg_catalog.format('CREATE TRIGGER routing_policy_v396_%I BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON cinatoken_gateway.%I FOR EACH STATEMENT EXECUTE FUNCTION cinatoken_gateway.invalidate_routing_policy_v396()',tab,tab);
 END LOOP;
END;
$triggers$;
CREATE FUNCTION cinatoken_gateway.attest_complete_text_routing_v396(p_epoch bigint,p_facts jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,pg_temp AS $attest$
DECLARE item jsonb; route jsonb; current_epoch bigint; expiry timestamptz; selected_surface record;
BEGIN
 IF SESSION_USER<>'cinatoken_gateway_route_source_verifier' OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
  OR p_epoch IS NULL OR p_epoch<1 OR jsonb_typeof(p_facts)<>'array' OR jsonb_array_length(p_facts) NOT BETWEEN 1 AND 8 THEN RAISE EXCEPTION 'invalid routing attestation'; END IF;
 LOCK TABLE cinatoken_gateway.models,cinatoken_gateway.model_surfaces,cinatoken_gateway.system_config,cinatoken_gateway.model_routes,
  cinatoken_gateway.providers,cinatoken_gateway.route_pools,cinatoken_gateway.model_endpoints,cinatoken_gateway.model_endpoint_routes,
  cinatoken_gateway.route_source_generations_v359 IN SHARE MODE NOWAIT;
 IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(746923596) THEN
  RAISE EXCEPTION 'routing policy writer busy' USING ERRCODE='55P03',CONSTRAINT='complete_text_routing_writer_busy_v396';
 END IF;
 SELECT epoch INTO current_epoch FROM cinatoken_gateway.routing_policy_epoch_v396 WHERE singleton;
 IF current_epoch<>p_epoch THEN RETURN jsonb_build_object('status','stale'); END IF;
 IF (SELECT count(DISTINCT f->>'modelId') FROM jsonb_array_elements(p_facts) f)<>jsonb_array_length(p_facts) THEN RAISE EXCEPTION 'duplicate model facts'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_facts) LOOP
  IF jsonb_typeof(item)<>'object' OR (SELECT string_agg(key,',' ORDER BY key) FROM jsonb_object_keys(item) key)<>'expiresAt,modelId,routes,routingEpoch,strategy,surface'
   OR item->>'routingEpoch'<>p_epoch::text OR octet_length(item->>'modelId') NOT BETWEEN 1 AND 240
   OR jsonb_typeof(item->'routes')<>'array' OR jsonb_array_length(item->'routes')>100
   OR jsonb_typeof(item->'strategy')<>'object' OR (SELECT string_agg(key,',' ORDER BY key) FROM jsonb_object_keys(item->'strategy') key)<>'base,tierOverrides'
   OR item->'strategy'->>'base' NOT IN('hash_affinity','weighted_random','weight_priority','weighted_round_robin')
   OR jsonb_typeof(item->'strategy'->'tierOverrides')<>'array' OR jsonb_array_length(item->'strategy'->'tierOverrides')>100
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(item->'strategy'->'tierOverrides') t
    WHERE jsonb_typeof(t)<>'object' OR (SELECT string_agg(key,',' ORDER BY key) FROM jsonb_object_keys(t) key)<>'priority,strategy'
     OR t->>'priority'!~'^-?[0-9]+$' OR abs((t->>'priority')::numeric)>9007199254740991
     OR t->>'strategy' NOT IN('hash_affinity','weighted_random','weight_priority','weighted_round_robin'))
  THEN RAISE EXCEPTION 'invalid safe routing facts'; END IF;
  expiry:=(item->>'expiresAt')::timestamptz;
  IF expiry<=clock_timestamp() OR expiry>clock_timestamp()+interval '61 seconds' THEN RAISE EXCEPTION 'invalid routing facts expiry'; END IF;
  SELECT ms.id,ms.route_pool_id,ms.request_operation,rp.sticky_enabled,rp.sticky_idle_ttl_seconds,rp.sticky_epoch INTO selected_surface
   FROM cinatoken_gateway.model_surfaces ms JOIN cinatoken_gateway.route_pools rp ON rp.id=ms.route_pool_id
   WHERE ms.model_id=item->>'modelId' AND lower(ms.route_group)='default' AND lower(ms.request_protocol)='openai'
    AND ms.request_operation IN('chat','*') AND ms.status='active' AND rp.status='active'
   ORDER BY CASE WHEN ms.request_operation='chat' THEN 0 ELSE 1 END LIMIT 1;
  IF (selected_surface.id IS NULL AND item->'surface'<>'null'::jsonb) OR (selected_surface.id IS NOT NULL AND item->'surface' IS DISTINCT FROM jsonb_build_object(
   'id',selected_surface.id,'poolId',selected_surface.route_pool_id,'match',CASE WHEN selected_surface.request_operation='chat' THEN 'exact' ELSE 'wildcard' END,
   'sticky',jsonb_build_object('enabled',selected_surface.sticky_enabled,'idleTtlSeconds',greatest(60,least(86400,selected_surface.sticky_idle_ttl_seconds)),'epoch',selected_surface.sticky_epoch))) THEN RAISE EXCEPTION 'routing surface differs'; END IF;
  FOR route IN SELECT value FROM jsonb_array_elements(item->'routes') LOOP
   IF jsonb_typeof(route)<>'object' OR (SELECT string_agg(key,',' ORDER BY key) FROM jsonb_object_keys(route) key)<>'attestedSourceSha256,beneficialCacheReadPricing,defaultEndpointEligible,endpointClass,endpointId,maxCompletionTokens,priceScore,providerId,routePoolId,routePriority,routeWeight,sourceGeneration,targetId'
    OR jsonb_typeof(route->'beneficialCacheReadPricing')<>'boolean' OR jsonb_typeof(route->'defaultEndpointEligible')<>'boolean'
    OR jsonb_typeof(route->'routePriority')<>'number' OR (route->>'routePriority')::numeric<>trunc((route->>'routePriority')::numeric)
    OR abs((route->>'routePriority')::numeric)>9007199254740991 OR jsonb_typeof(route->'routeWeight')<>'number' OR (route->>'routeWeight')::numeric<=0
    OR (route->'priceScore'<>'null'::jsonb AND (jsonb_typeof(route->'priceScore')<>'number' OR (route->>'priceScore')::numeric<0))
    OR NOT EXISTS(SELECT 1 FROM cinatoken_gateway.model_routes r JOIN cinatoken_gateway.providers p ON p.id=r.provider_id
     JOIN cinatoken_gateway.model_endpoint_routes er ON er.route_target_id=r.id JOIN cinatoken_gateway.model_endpoints e ON e.id=er.endpoint_id
     JOIN cinatoken_gateway.route_source_generations_v359 f ON f.route_target_id=r.id
     WHERE r.id=route->>'targetId' AND r.model_id=item->>'modelId' AND r.status='active' AND p.status='active'
      AND r.provider_id=route->>'providerId' AND r.route_pool_id IS NOT DISTINCT FROM route->>'routePoolId'
      AND r.priority::numeric=(route->>'routePriority')::numeric AND CASE WHEN r.weight>0 THEN r.weight ELSE 1 END=(route->>'routeWeight')::numeric
      AND e.id=route->>'endpointId' AND e.model_id=r.model_id AND e.provider_id=r.provider_id AND e.status='verified'
      AND e.verified_at<=clock_timestamp() AND e.expires_at>=expiry AND e.endpoint_class IS NOT DISTINCT FROM route->>'endpointClass'
      AND e.max_completion_tokens IS NOT DISTINCT FROM (route->>'maxCompletionTokens')::bigint
      AND f.generation::text=route->>'sourceGeneration' AND f.verified_generation=f.generation AND f.attested_source_sha256=route->>'attestedSourceSha256'
      AND f.verified_subject_fingerprint=er.subject_fingerprint
      AND (CASE WHEN selected_surface.id IS NOT NULL THEN r.route_pool_id=selected_surface.route_pool_id ELSE lower(coalesce(nullif(btrim(r.route_group),''),'default'))='default' END))
   THEN RAISE EXCEPTION 'routing source differs'; END IF;
  END LOOP;
  INSERT INTO cinatoken_gateway.complete_text_routing_facts_v396 VALUES(item->>'modelId',p_epoch,expiry,item)
   ON CONFLICT(model_id) DO UPDATE SET routing_epoch=excluded.routing_epoch,expires_at=excluded.expires_at,facts=excluded.facts;
 END LOOP;
 RETURN jsonb_build_object('status','routing_attested','routingEpoch',p_epoch::text,'modelCount',jsonb_array_length(p_facts));
END;
$attest$;
CREATE FUNCTION cinatoken_gateway.require_current_routing_projection_v396(p_quote uuid,p_epoch bigint,p_candidate integer,p_allow_expired boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,pg_temp AS $require$
DECLARE projection record; current_epoch bigint;
BEGIN
 -- Existing send wrappers already hold source relation SHARE locks. Never wait
 -- here for a writer that holds the exclusive epoch gate and needs those locks.
 IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(746923596) THEN
  RAISE EXCEPTION 'routing policy writer busy' USING ERRCODE='55P03',CONSTRAINT='complete_text_routing_writer_busy_v396';
 END IF;
 SELECT epoch INTO current_epoch FROM cinatoken_gateway.routing_policy_epoch_v396 WHERE singleton;
 SELECT * INTO projection FROM cinatoken_gateway.complete_text_routing_projections_v396 WHERE quote_id=p_quote FOR SHARE;
 IF NOT FOUND OR p_epoch IS NULL OR p_candidate IS NULL OR p_allow_expired IS NULL OR p_candidate NOT BETWEEN 0 AND 7
  OR projection.routing_epoch<>p_epoch OR current_epoch<>p_epoch OR (NOT p_allow_expired AND projection.expires_at<=clock_timestamp())
  OR jsonb_array_length(projection.projection->'candidates')<=p_candidate
  OR EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_routing_members_v396 m
   LEFT JOIN cinatoken_gateway.route_source_generations_v359 f ON f.route_target_id=m.route_target_id
   WHERE m.quote_id=p_quote AND (f.generation IS DISTINCT FROM m.source_generation OR f.verified_generation IS DISTINCT FROM f.generation
    OR f.attested_source_sha256 IS DISTINCT FROM m.attested_source_sha256))
 THEN RAISE EXCEPTION 'routing projection stale' USING ERRCODE='23514',CONSTRAINT='complete_text_routing_freshness_v396'; END IF;
END;
$require$;
CREATE FUNCTION cinatoken_gateway.require_current_routing_projection_v396(p_quote uuid,p_epoch bigint,p_candidate integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,pg_temp AS $require$
BEGIN PERFORM cinatoken_gateway.require_current_routing_projection_v396(p_quote,p_epoch,p_candidate,false); END;
$require$;
CREATE FUNCTION cinatoken_gateway.fence_complete_text_routing_v396() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,pg_temp AS $fence$
DECLARE grant_row record; p record;
BEGIN
 IF TG_TABLE_NAME='complete_text_attempt_grants_v362' THEN grant_row:=NEW;
 ELSE SELECT * INTO grant_row FROM cinatoken_gateway.complete_text_attempt_grants_v362 WHERE grant_id=NEW.grant_id FOR SHARE; END IF;
 SELECT * INTO p FROM cinatoken_gateway.complete_text_routing_projections_v396 WHERE quote_id=grant_row.quote_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'routing projection missing' USING ERRCODE='23514',CONSTRAINT='complete_text_routing_freshness_v396'; END IF;
 PERFORM cinatoken_gateway.require_current_routing_projection_v396(grant_row.quote_id,p.routing_epoch,grant_row.candidate_index);
 IF p.request_id IS DISTINCT FROM grant_row.request_id OR p.final_body_sha256 IS DISTINCT FROM grant_row.final_body_sha256
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p.projection->'candidates') candidate WHERE NOT EXISTS(
   SELECT 1 FROM cinatoken_gateway.complete_text_routing_members_v396 m
   JOIN cinatoken_gateway.complete_text_quote_routes_v360 quoted ON quoted.quote_id=m.quote_id
    AND quoted.candidate_index=m.candidate_index AND quoted.route_target_id=m.route_target_id
   JOIN cinatoken_gateway.model_endpoints endpoint ON endpoint.id=m.endpoint_id
   WHERE m.quote_id=p.quote_id AND m.candidate_index=(candidate->>'candidateIndex')::integer AND m.default_endpoint_eligible
    AND (coalesce((quoted.source_snapshot->>'requestedOutputTokens')::bigint,0)=0
     OR endpoint.max_completion_tokens>=(quoted.source_snapshot->>'requestedOutputTokens')::bigint)))
  OR NOT EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_routing_members_v396 m
   JOIN cinatoken_gateway.complete_text_quote_routes_v360 quoted ON quoted.quote_id=m.quote_id
    AND quoted.candidate_index=m.candidate_index AND quoted.route_target_id=m.route_target_id
   JOIN cinatoken_gateway.model_endpoints endpoint ON endpoint.id=m.endpoint_id
   WHERE m.quote_id=grant_row.quote_id AND m.default_endpoint_eligible
   AND m.candidate_index=grant_row.candidate_index AND m.model_id=grant_row.model_id AND m.route_target_id=grant_row.route_target_id
   AND m.provider_id=grant_row.provider_id AND m.endpoint_id=grant_row.endpoint_id AND m.source_generation=grant_row.manifest_source_generation
   AND m.attested_source_sha256=grant_row.manifest_attested_source_sha256
   AND (coalesce((quoted.source_snapshot->>'requestedOutputTokens')::bigint,0)=0
    OR endpoint.max_completion_tokens>=(quoted.source_snapshot->>'requestedOutputTokens')::bigint))
 THEN RAISE EXCEPTION 'routing selection differs' USING ERRCODE='23514',CONSTRAINT='complete_text_routing_membership_v396'; END IF;
 RETURN NEW;
END;
$fence$;
CREATE TRIGGER complete_text_routing_v396_grant BEFORE INSERT ON cinatoken_gateway.complete_text_attempt_grants_v362 FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.fence_complete_text_routing_v396();
CREATE TRIGGER complete_text_routing_v396_custody BEFORE INSERT ON cinatoken_gateway.complete_text_send_custody_v365 FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.fence_complete_text_routing_v396();
CREATE TRIGGER complete_text_routing_v396_start BEFORE INSERT ON cinatoken_gateway.complete_text_send_starts_v365 FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.fence_complete_text_routing_v396();
CREATE FUNCTION cinatoken_gateway.reject_routing_projection_mutation_v396() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,pg_temp AS $immutable$
BEGIN RAISE EXCEPTION 'routing projection is immutable' USING ERRCODE='23514'; END;
$immutable$;
CREATE TRIGGER complete_text_routing_projection_immutable_v396 BEFORE UPDATE OR DELETE OR TRUNCATE ON cinatoken_gateway.complete_text_routing_projections_v396 FOR EACH STATEMENT EXECUTE FUNCTION cinatoken_gateway.reject_routing_projection_mutation_v396();
CREATE TRIGGER complete_text_routing_members_immutable_v396 BEFORE UPDATE OR DELETE OR TRUNCATE ON cinatoken_gateway.complete_text_routing_members_v396 FOR EACH STATEMENT EXECUTE FUNCTION cinatoken_gateway.reject_routing_projection_mutation_v396();
CREATE FUNCTION cinatoken_gateway.project_complete_text_routing_v396(
  p_request_id text,p_quote_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
SET lock_timeout TO '2s'
SET statement_timeout TO '15s' AS $plan$
DECLARE q record; cap record; key_row record; user_row record;
DECLARE workspace_row record; manifest record; server_now timestamptz;
DECLARE candidate_count integer; manifest_count integer; active_count integer;
DECLARE max_ceiling bigint; routes jsonb:='[]'::jsonb;
DECLARE policy record; prior record; item record; members jsonb; candidates jsonb:='[]'::jsonb;
DECLARE current_epoch bigint; valid_until timestamptz; safe_projection jsonb;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_complete_text_routing_projector'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_request_id IS NULL OR pg_catalog.length(p_request_id) NOT BETWEEN 1 AND 128
    OR p_quote_id IS NULL
  THEN RAISE EXCEPTION 'invalid complete text plan call'
    USING ERRCODE='23514',CONSTRAINT='complete_text_plan_call_v365'; END IF;
  SELECT * INTO q FROM cinatoken_gateway.complete_text_quotes_v360
    WHERE request_id=p_request_id AND quote_id=p_quote_id FOR SHARE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status','not_found'); END IF;

  SELECT * INTO cap FROM cinatoken_gateway.authenticated_request_capabilities_v356
    WHERE request_id=q.request_id FOR SHARE;
  SELECT * INTO key_row FROM cinatoken_gateway.api_keys
    WHERE id=q.api_key_id FOR SHARE;
  SELECT * INTO user_row FROM cinatoken_gateway.users
    WHERE id=q.user_id FOR SHARE;
  SELECT * INTO workspace_row FROM cinatoken_gateway.workspaces
    WHERE id=q.workspace_id FOR SHARE;
  server_now:=pg_catalog.clock_timestamp();
  IF q.expires_at<=server_now OR q.credential_class IS DISTINCT FROM 'platform'
    OR cap.request_id IS NULL OR cap.state<>'claimed'
    OR cap.invalidated_at IS NOT NULL OR cap.expires_at<=server_now
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
    OR user_row.id IS NULL OR user_row.status IS DISTINCT FROM 'active'
    OR user_row.budget_epoch IS DISTINCT FROM q.budget_epoch
    OR user_row.charged_cost_factors IS NOT NULL
    OR workspace_row.id IS NULL OR workspace_row.status IS DISTINCT FROM 'active'
    OR workspace_row.scope_type IS DISTINCT FROM 'personal'
    OR workspace_row.personal_owner_user_id IS DISTINCT FROM q.user_id
  THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;

  -- A complete current route predicate is needed even for a read projection.
  -- v362 repeats all authority checks at grant time; this lock only gives the
  -- planner a coherent snapshot for this transaction, not a send lease.
  LOCK TABLE cinatoken_gateway.system_config,cinatoken_gateway.models,
    cinatoken_gateway.model_surfaces,
    cinatoken_gateway.model_routes,
    cinatoken_gateway.route_pools,
    cinatoken_gateway.providers,
    cinatoken_gateway.model_endpoints,
    cinatoken_gateway.model_endpoint_routes,
    cinatoken_gateway.route_source_generations_v359,
    cinatoken_gateway.byok_keys
    IN SHARE MODE NOWAIT;
  IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(746923596) THEN
  RAISE EXCEPTION 'routing policy writer busy' USING ERRCODE='55P03',CONSTRAINT='complete_text_routing_writer_busy_v396';
 END IF;
  server_now:=pg_catalog.clock_timestamp();
  IF q.expires_at<=server_now OR cap.expires_at<=server_now
    OR (key_row.expires_at IS NOT NULL AND key_row.expires_at<=server_now)
    OR EXISTS (SELECT 1 FROM cinatoken_gateway.byok_keys b
      WHERE b.workspace_id=q.workspace_id AND b.deleted_at IS NULL
        AND NOT b.disabled)
  THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  candidate_count:=pg_catalog.jsonb_array_length(q.ordered_model_ids);
  SELECT pg_catalog.count(*)::integer,pg_catalog.max(per_attempt_ceiling_micros)
    INTO manifest_count,max_ceiling
    FROM cinatoken_gateway.complete_text_quote_routes_v360
    WHERE quote_id=q.quote_id;
  IF candidate_count NOT BETWEEN 1 AND 8 OR manifest_count<>q.route_count
    OR manifest_count NOT BETWEEN 1 AND 100 OR max_ceiling IS NULL
    OR max_ceiling<=0 OR max_ceiling<>q.max_per_attempt_ceiling_micros
    OR q.three_attempt_ceiling_micros<>max_ceiling*3
  THEN RETURN pg_catalog.jsonb_build_object('status','invalid_manifest'); END IF;

  FOR manifest IN SELECT * FROM cinatoken_gateway.complete_text_quote_routes_v360
    WHERE quote_id=q.quote_id ORDER BY candidate_index,route_target_id
  LOOP
    IF manifest.candidate_index NOT BETWEEN 0 AND candidate_count-1
      OR manifest.model_id IS DISTINCT FROM
        q.ordered_model_ids->>manifest.candidate_index
      OR pg_catalog.octet_length(manifest.model_id)>240
      OR pg_catalog.octet_length(manifest.route_target_id)>256
      OR manifest.credential_class IS DISTINCT FROM 'platform'
      OR manifest.credential_id IS DISTINCT FROM manifest.provider_id
      OR manifest.source_sha256 IS DISTINCT FROM pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(
          manifest.source_snapshot::text,'UTF8')),'hex')
      OR manifest.source_snapshot->>'modelId' IS DISTINCT FROM manifest.model_id
      OR manifest.source_snapshot->>'routeTargetId' IS DISTINCT FROM
        manifest.route_target_id
      OR manifest.source_snapshot->>'providerId' IS DISTINCT FROM
        manifest.provider_id
      OR manifest.source_snapshot->>'endpointId' IS DISTINCT FROM
        manifest.endpoint_id
      OR manifest.source_snapshot->>'providerCiphertextSha256' IS DISTINCT FROM
        manifest.provider_ciphertext_sha256
      OR manifest.source_snapshot->>'sourceGeneration' IS DISTINCT FROM
        manifest.source_generation::text
      OR manifest.source_snapshot->>'attestedSourceSha256' IS DISTINCT FROM
        manifest.attested_source_sha256
      OR NOT EXISTS (SELECT 1 FROM cinatoken_gateway.model_routes r
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
        WHERE r.id=manifest.route_target_id AND r.model_id=manifest.model_id
          AND r.provider_id=manifest.provider_id
          AND r.status='active' AND r.route_group='default'
          AND r.upstream_protocol='openai' AND r.upstream_operation='chat'
          AND r.adapter='passthrough' AND r.price_override IS NULL
          AND r.custom_params IS NULL AND r.routing_metadata IS NULL
          AND rp.status='active' AND po.status='active'
          AND po.shared_channel_type IS NULL AND po.api_key LIKE 'enc:v2:%'
          AND pg_catalog.encode(pg_catalog.sha256(
            pg_catalog.convert_to(po.api_key,'UTF8')),'hex')
              =manifest.provider_ciphertext_sha256
          AND e.id=manifest.endpoint_id AND e.status='verified'
          AND e.expires_at>server_now
          AND f.generation=manifest.source_generation
          AND f.verified_generation=f.generation
          AND f.attested_source_sha256=manifest.attested_source_sha256
          AND f.verified_subject_fingerprint=er.subject_fingerprint)
    THEN RETURN pg_catalog.jsonb_build_object('status','stale_manifest'); END IF;
    routes:=routes || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'candidateIndex',manifest.candidate_index,
      'modelId',manifest.model_id,
      'routeTargetId',manifest.route_target_id,
      'sourceGeneration',manifest.source_generation::text,
      'attestedSourceSha256',manifest.attested_source_sha256));
  END LOOP;
  SELECT pg_catalog.count(*)::integer INTO active_count
    FROM pg_catalog.jsonb_array_elements_text(q.ordered_model_ids)
      WITH ORDINALITY AS candidates(model_id,ordinal)
    JOIN cinatoken_gateway.model_routes r
      ON r.model_id=candidates.model_id AND r.status='active';
  IF active_count<>manifest_count OR EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements_text(q.ordered_model_ids)
      WITH ORDINALITY AS candidates(model_id,ordinal)
    JOIN cinatoken_gateway.model_routes r
      ON r.model_id=candidates.model_id AND r.status='active'
    WHERE NOT EXISTS (SELECT 1
      FROM cinatoken_gateway.complete_text_quote_routes_v360 m
      WHERE m.quote_id=q.quote_id AND m.candidate_index=candidates.ordinal-1
        AND m.route_target_id=r.id))
    OR EXISTS (SELECT 1 FROM cinatoken_gateway.model_surfaces s
      JOIN cinatoken_gateway.route_pools rp ON rp.id=s.route_pool_id
      WHERE s.model_id IN (SELECT value FROM pg_catalog.jsonb_array_elements_text(
          q.ordered_model_ids)) AND lower(s.route_group)='default'
        AND lower(s.request_protocol)='openai'
        AND s.request_operation IN ('chat','*') AND s.status='active'
        AND rp.status='active' AND (rp.model_id<>s.model_id OR EXISTS (
          SELECT 1 FROM cinatoken_gateway.model_routes sr
          WHERE sr.route_pool_id=s.route_pool_id AND sr.status='active'
            AND sr.model_id<>s.model_id)))
  THEN RETURN pg_catalog.jsonb_build_object('status','stale_manifest'); END IF;
  server_now:=pg_catalog.clock_timestamp();
  IF q.expires_at<=server_now OR cap.expires_at<=server_now
    OR (key_row.expires_at IS NOT NULL AND key_row.expires_at<=server_now)
  THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  SELECT epoch INTO current_epoch FROM cinatoken_gateway.routing_policy_epoch_v396 WHERE singleton;
  SELECT * INTO prior FROM cinatoken_gateway.complete_text_routing_projections_v396 WHERE quote_id=q.quote_id FOR SHARE;
  IF FOUND THEN
    IF prior.routing_epoch<>current_epoch OR prior.expires_at<=server_now THEN
      RETURN pg_catalog.jsonb_build_object('status','stale_projection'); END IF;
    PERFORM cinatoken_gateway.require_current_routing_projection_v396(q.quote_id,current_epoch,0);
    RETURN prior.projection;
  END IF;
  valid_until:=q.expires_at;
  FOR item IN SELECT value AS model_id,ordinality::integer-1 AS candidate_index
    FROM pg_catalog.jsonb_array_elements_text(q.ordered_model_ids) WITH ORDINALITY LOOP
    SELECT * INTO policy FROM cinatoken_gateway.complete_text_routing_facts_v396 WHERE model_id=item.model_id FOR SHARE;
    IF NOT FOUND OR policy.routing_epoch<>current_epoch OR policy.expires_at<=server_now THEN
      RETURN pg_catalog.jsonb_build_object('status','unverified_routing'); END IF;
    valid_until:=least(valid_until,policy.expires_at);
    SELECT coalesce(pg_catalog.jsonb_agg(f.value ORDER BY (f.value->>'routePriority')::bigint DESC,f.ordinality),'[]'::jsonb)
      INTO members FROM pg_catalog.jsonb_array_elements(policy.facts->'routes') WITH ORDINALITY f(value,ordinality)
      JOIN cinatoken_gateway.complete_text_quote_routes_v360 m
        ON m.quote_id=q.quote_id AND m.candidate_index=item.candidate_index AND m.route_target_id=f.value->>'targetId'
        AND m.model_id=item.model_id AND m.provider_id=f.value->>'providerId' AND m.endpoint_id=f.value->>'endpointId'
        AND m.source_generation::text=f.value->>'sourceGeneration' AND m.attested_source_sha256=f.value->>'attestedSourceSha256';
    candidates:=candidates||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'candidateIndex',item.candidate_index,'modelId',item.model_id,'routeGroup','default',
      'requestProtocol','openai','requestOperation','chat','surface',policy.facts->'surface',
      'strategy',policy.facts->'strategy','routes',members));
  END LOOP;
  safe_projection:=pg_catalog.jsonb_build_object('status','routing_projected','requestId',q.request_id,
    'quoteId',q.quote_id,'finalBodySha256',q.final_body_sha256,'modelIds',q.ordered_model_ids,
    'expiresAt',valid_until,'routingEpoch',current_epoch::text,'candidates',candidates);
  INSERT INTO cinatoken_gateway.complete_text_routing_projections_v396
    (quote_id,request_id,routing_epoch,final_body_sha256,expires_at,projection)
    VALUES(q.quote_id,q.request_id,current_epoch,q.final_body_sha256,valid_until,safe_projection);
  INSERT INTO cinatoken_gateway.complete_text_routing_members_v396
    (quote_id,candidate_index,model_id,route_target_id,provider_id,endpoint_id,route_pool_id,source_generation,attested_source_sha256,beneficial_cache_read_pricing,default_endpoint_eligible)
    SELECT q.quote_id,(c->>'candidateIndex')::integer,c->>'modelId',r->>'targetId',r->>'providerId',r->>'endpointId',r->>'routePoolId',
      (r->>'sourceGeneration')::bigint,r->>'attestedSourceSha256',(r->>'beneficialCacheReadPricing')::boolean,(r->>'defaultEndpointEligible')::boolean
    FROM pg_catalog.jsonb_array_elements(candidates) c CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(c->'routes') r;
  RETURN safe_projection;
END;
$plan$;

REVOKE ALL ON cinatoken_gateway.routing_policy_epoch_v396,cinatoken_gateway.complete_text_routing_facts_v396,
 cinatoken_gateway.complete_text_routing_projections_v396,cinatoken_gateway.complete_text_routing_members_v396 FROM PUBLIC,cinatoken_gateway_runtime,cinatoken_gateway_route_source_verifier,cinatoken_gateway_complete_text_routing_projector;
REVOKE ALL ON FUNCTION cinatoken_gateway.invalidate_routing_policy_v396(),cinatoken_gateway.attest_complete_text_routing_v396(bigint,jsonb),
 cinatoken_gateway.lock_complete_text_routing_sources_v396(),
 cinatoken_gateway.require_current_routing_projection_v396(uuid,bigint,integer),cinatoken_gateway.require_current_routing_projection_v396(uuid,bigint,integer,boolean),
 cinatoken_gateway.fence_complete_text_routing_v396(),cinatoken_gateway.reject_routing_projection_mutation_v396(),
 cinatoken_gateway.project_complete_text_routing_v396(text,uuid) FROM PUBLIC,cinatoken_gateway_runtime,cinatoken_gateway_route_source_verifier,cinatoken_gateway_complete_text_routing_projector;
GRANT USAGE ON SCHEMA cinatoken_gateway TO cinatoken_gateway_complete_text_routing_projector;
GRANT EXECUTE ON FUNCTION cinatoken_gateway.project_complete_text_routing_v396(text,uuid) TO cinatoken_gateway_complete_text_routing_projector;
GRANT EXECUTE ON FUNCTION cinatoken_gateway.attest_complete_text_routing_v396(bigint,jsonb) TO cinatoken_gateway_route_source_verifier;
GRANT EXECUTE ON FUNCTION cinatoken_gateway.lock_complete_text_routing_sources_v396() TO cinatoken_gateway_route_source_verifier;
GRANT SELECT ON cinatoken_gateway.routing_policy_epoch_v396,cinatoken_gateway.models,cinatoken_gateway.model_surfaces,cinatoken_gateway.system_config TO cinatoken_gateway_route_source_verifier;
DO $postflight$
BEGIN
 IF pg_catalog.has_table_privilege('cinatoken_gateway_complete_text_routing_projector','cinatoken_gateway.providers','SELECT')
  OR pg_catalog.has_column_privilege('cinatoken_gateway_complete_text_routing_projector','cinatoken_gateway.providers','api_key','SELECT')
  OR pg_catalog.has_function_privilege('cinatoken_gateway_complete_text_routing_projector','cinatoken_gateway.attest_complete_text_routing_v396(bigint,jsonb)','EXECUTE')
  OR pg_catalog.has_function_privilege('cinatoken_gateway_route_source_verifier','cinatoken_gateway.require_current_routing_projection_v396(uuid,bigint,integer,boolean)','EXECUTE')
  OR (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgname LIKE 'routing_policy_v396_%' AND tgenabled='O' AND NOT tgisinternal)<>8
  OR (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgname LIKE 'complete_text_routing_v396_%' AND tgenabled='O' AND NOT tgisinternal)<>3
 THEN RAISE EXCEPTION 'routing projection v396 postflight differs'; END IF;
END;
$postflight$;
