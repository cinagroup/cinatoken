-- REVIEW ONLY. PG73 + v392 + v396. Install atomically as the direct migrator.
-- Gateway-owned session/hash selection is bounded by a quote. No financial writes.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog,pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923596);
LOCK TABLE cinatoken_gateway.schema_migrations,cinatoken_gateway.route_pool_sticky_bindings,
 cinatoken_gateway.complete_text_quotes_v360,cinatoken_gateway.complete_text_attempt_grants_v362,
 cinatoken_gateway.complete_text_result_facts_v366,cinatoken_response_observation.observations_v392,
 cinatoken_gateway.complete_text_routing_projections_v396,cinatoken_gateway.complete_text_routing_members_v396
 IN SHARE ROW EXCLUSIVE MODE;
DO $preflight$
DECLARE owner_oid oid; sticky_oid oid; dependency record; proc_row record; table_row record;
DECLARE acl_contract text; column_contract jsonb; trigger_contract text; actor record;
BEGIN
 SELECT oid INTO owner_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_migrator';
 SELECT oid INTO sticky_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_complete_text_sticky_router';
 IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
  OR pg_catalog.current_setting('cinatoken.complete_text_sticky_routing_v398_activation',true) IS DISTINCT FROM 'reviewed-v1'
  OR owner_oid IS NULL OR sticky_oid IS NULL
  OR (SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname='cinatoken_gateway') IS DISTINCT FROM owner_oid
  OR (SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname='cinatoken_response_observation') IS DISTINCT FROM owner_oid
  OR (SELECT count(*) FROM cinatoken_gateway.schema_migrations)<>73
  OR (SELECT md5(string_agg(version,E'\n' ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)<>'ca1ea96a1b4bcd0675642f30dcf48042'
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE oid=sticky_oid
   AND NOT(rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls))
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid=sticky_oid OR member=sticky_oid)
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname LIKE 'cinatoken_%'
   AND (pg_catalog.has_schema_privilege(sticky_oid,n.oid,'CREATE')
    OR (n.nspname<>'cinatoken_gateway' AND pg_catalog.has_schema_privilege(sticky_oid,n.oid,'USAGE'))))
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname LIKE 'cinatoken_%' AND CASE WHEN c.relkind='S'
    THEN pg_catalog.has_sequence_privilege(sticky_oid,c.oid,'SELECT,USAGE,UPDATE') ELSE false END)
  OR pg_catalog.has_database_privilege(sticky_oid,current_database(),'CREATE')
  OR pg_catalog.has_schema_privilege(sticky_oid,'public','CREATE')
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname LIKE 'cinatoken_%' AND CASE WHEN c.relkind IN('r','p','v','m','f') THEN
    pg_catalog.has_table_privilege(sticky_oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
     OR pg_catalog.has_any_column_privilege(sticky_oid,c.oid,'SELECT,INSERT,UPDATE') ELSE false END)
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
   WHERE (n.nspname LIKE 'cinatoken_%' OR p.proowner=owner_oid) AND pg_catalog.has_function_privilege(sticky_oid,p.oid,'EXECUTE'))
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid IN(
   'cinatoken_gateway.route_pool_sticky_bindings'::regclass,'cinatoken_gateway.complete_text_quotes_v360'::regclass,
   'cinatoken_gateway.complete_text_attempt_grants_v362'::regclass,'cinatoken_gateway.complete_text_result_facts_v366'::regclass,
   'cinatoken_response_observation.observations_v392'::regclass,'cinatoken_gateway.complete_text_routing_projections_v396'::regclass,
   'cinatoken_gateway.complete_text_routing_members_v396'::regclass)
   AND (c.relowner<>owner_oid OR c.relkind<>'r' OR c.relrowsecurity OR c.relforcerowsecurity))
  OR pg_catalog.to_regprocedure('cinatoken_gateway.complete_text_sticky_action_v398(uuid,text,text,bigint,integer,text,text,boolean,text,text,text,text,text)') IS NOT NULL
 THEN RAISE EXCEPTION 'sticky v398 activation or dedicated role differs' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d,LATERAL pg_catalog.aclexplode(d.defaclacl) a
  WHERE d.defaclrole=owner_oid AND a.grantee<>owner_oid
   AND (d.defaclnamespace=0 OR d.defaclnamespace='cinatoken_gateway'::regnamespace)
   AND NOT(d.defaclobjtype='f' AND a.privilege_type='EXECUTE' AND NOT a.is_grantable
    AND a.grantee IN(0,(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_runtime')))
   AND NOT(d.defaclnamespace='cinatoken_gateway'::regnamespace AND NOT a.is_grantable
    AND a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_runtime')
    AND ((d.defaclobjtype='r' AND a.privilege_type='SELECT') OR (d.defaclobjtype='S' AND a.privilege_type IN('SELECT','USAGE','UPDATE')))))
 THEN RAISE EXCEPTION 'sticky v398 default ACL differs' USING ERRCODE='P0001'; END IF;
 -- This exact PG73 + v392 + frozen v396 branch has 30 dependency tables,
 -- 40 complete user-trigger definitions and 40 authority functions.
 -- ACL digests include grantee, grantor, privilege and grant option. Trigger
 -- digests include every definition and enabled/row/argument/deferral trait.
 -- Column ACLs are compared in full; an extra ACL, trigger or PUBLIC execution
 -- path fails before creating the sticky wrapper. v388/v389 are not this branch.
 FOR actor IN SELECT oid,rolname,rolcanlogin,rolinherit,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls
  FROM pg_catalog.pg_roles WHERE rolname=ANY(ARRAY['cinatoken_gateway_budget_admission','cinatoken_gateway_complete_text_attempt_granter','cinatoken_gateway_complete_text_private_reader','cinatoken_gateway_complete_text_provider_bill','cinatoken_gateway_complete_text_quote_issuer','cinatoken_gateway_complete_text_response_observer','cinatoken_gateway_complete_text_routing_projector','cinatoken_gateway_complete_text_send_holder','cinatoken_gateway_request_capability_claim','cinatoken_gateway_request_capability_issuer','cinatoken_gateway_request_route_ceiling_issuer','cinatoken_gateway_route_source_verifier']::text[]) LOOP
  IF NOT(actor.rolcanlogin AND NOT actor.rolinherit AND NOT actor.rolsuper AND NOT actor.rolcreaterole
   AND NOT actor.rolcreatedb AND NOT actor.rolreplication AND NOT actor.rolbypassrls)
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=actor.oid OR roleid=actor.oid)
   OR has_database_privilege(actor.oid,current_database(),'CREATE') OR has_schema_privilege(actor.oid,'public','CREATE')
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname LIKE 'cinatoken_%' AND has_schema_privilege(actor.oid,n.oid,'CREATE'))
  THEN RAISE EXCEPTION 'sticky v398 proof producer role differs: %',actor.rolname USING ERRCODE='P0001'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname=ANY(ARRAY['cinatoken_gateway_budget_admission','cinatoken_gateway_complete_text_attempt_granter','cinatoken_gateway_complete_text_private_reader','cinatoken_gateway_complete_text_provider_bill','cinatoken_gateway_complete_text_quote_issuer','cinatoken_gateway_complete_text_response_observer','cinatoken_gateway_complete_text_routing_projector','cinatoken_gateway_complete_text_send_holder','cinatoken_gateway_request_capability_claim','cinatoken_gateway_request_capability_issuer','cinatoken_gateway_request_route_ceiling_issuer','cinatoken_gateway_route_source_verifier']::text[]))<>12
 THEN RAISE EXCEPTION 'sticky v398 proof producer role missing' USING ERRCODE='P0001'; END IF;
 FOR dependency IN SELECT * FROM (VALUES
   ('cinatoken_economic_outbox.capture_buyer_budget_tx_receipt()','5b6be82c665fcb19b947496894010a42',true,'v','trigger','{"search_path=pg_catalog, pg_temp"}','df81f999cb719b7d75d581de5b53d126'),
   ('cinatoken_gateway.admit_complete_flat_text_quote_v361(text,uuid,jsonb)','1521e5c8001f78663c495a5e9dfd8fb1',true,'v','jsonb','{"search_path=pg_catalog, pg_temp",lock_timeout=2s,statement_timeout=15s}','7425e459d6ca97741716b3a98272aed9'),
   ('cinatoken_gateway.append_complete_text_holder_fact_v366(uuid,uuid,bigint,uuid,text,jsonb,text)','2d624e90797418b9087cfc3c203f3785',true,'v','jsonb','{"search_path=pg_catalog, pg_temp"}','ff2f9fcbb97338555499f28009e71a71'),
   ('cinatoken_gateway.append_complete_text_provider_bill_v366(uuid,uuid,jsonb,text)','5a4707db3ce3fdbc37f3fe526ded6caf',true,'v','jsonb','{"search_path=pg_catalog, pg_temp"}','2265c69698415d7d65c1888f53b9e581'),
   ('cinatoken_gateway.append_complete_text_response_observation_v392(uuid,uuid,uuid,bigint,uuid,jsonb)','b1ad1015e9146d0911bc6b6f9e6c7c37',true,'v','jsonb','{"search_path=pg_catalog, pg_temp",lock_timeout=2s,statement_timeout=15s}','ff2f9fcbb97338555499f28009e71a71'),
   ('cinatoken_gateway.append_complete_text_result_fact_internal_v366(uuid,uuid,bigint,uuid,text,jsonb,text,text)','9da0e543da322bfb973a30ca12321b5f',true,'v','jsonb','{"search_path=pg_catalog, pg_temp",lock_timeout=2s,statement_timeout=15s}','df81f999cb719b7d75d581de5b53d126'),
   ('cinatoken_gateway.attest_complete_text_routing_v396(bigint,jsonb)','65d0a385d33cc42a60ae65531e641651',true,'v','jsonb','{"search_path=pg_catalog, pg_temp"}','73ba08194c1e53ee6d46c7c4b0884293'),
   ('cinatoken_gateway.attest_text_route_source_v359(text,bigint,text)','487233ff3e574d3ada3dfbcfb364095b',true,'v','jsonb','{"search_path=pg_catalog, pg_temp",lock_timeout=2s,statement_timeout=15s}','73ba08194c1e53ee6d46c7c4b0884293'),
   ('cinatoken_gateway.check_complete_text_send_holds_v365(text,uuid,timestamp with time zone)','d8851f2897d6ec937da58b42c13798ae',true,'v','text','{"search_path=pg_catalog, pg_temp"}','df81f999cb719b7d75d581de5b53d126'),
   ('cinatoken_gateway.claim_complete_text_send_custody_v365(uuid,uuid)','6133110f0a7786fc02e0de74010539cb',true,'v','jsonb','{"search_path=pg_catalog, pg_temp",lock_timeout=2s,statement_timeout=15s}','ff2f9fcbb97338555499f28009e71a71'),
   ('cinatoken_gateway.claim_request_capability_v356(text,text,text)','4ea9f47c19936f4cb92041697fbd3136',true,'v','jsonb','{"search_path=pg_catalog, pg_temp",lock_timeout=2s,statement_timeout=15s}','0adeb3d15488511cd8767507886c1745'),
   ('cinatoken_gateway.fence_complete_text_routing_v396()','b5c5659f9445b7a7b8a8bb559c67e5b2',true,'v','trigger','{"search_path=pg_catalog, pg_temp"}','df81f999cb719b7d75d581de5b53d126'),
   ('cinatoken_gateway.grant_complete_flat_text_attempt_v362(uuid,jsonb)','0339e4f95fff26784032d2d73ec09a7a',true,'v','jsonb','{"search_path=pg_catalog, pg_temp",lock_timeout=2s,statement_timeout=15s}','c06ca95b53c1f337e0d21c4fff7504d6'),
   ('cinatoken_gateway.guard_request_dispatch_intent()','d8a89494930000d0178d34c08672af46',false,'v','trigger','{"search_path=pg_catalog, pg_temp"}','df81f999cb719b7d75d581de5b53d126'),
   ('cinatoken_gateway.invalidate_request_capabilities_v356()','331cc2f19e2673f9190d382d85735a40',true,'v','trigger','{"search_path=pg_catalog, pg_temp",lock_timeout=2s}','df81f999cb719b7d75d581de5b53d126'),
   ('cinatoken_gateway.invalidate_route_link_v359()','a1cc2f0716f0fd6d366424b4a12a6603',true,'v','trigger','{"search_path=pg_catalog, pg_temp"}','df81f999cb719b7d75d581de5b53d126'),
   ('cinatoken_gateway.invalidate_route_source_v359()','18ef9982fdd91c6fb4f66d4af40a196a',true,'v','trigger','{"search_path=pg_catalog, pg_temp"}','df81f999cb719b7d75d581de5b53d126'),
   ('cinatoken_gateway.invalidate_routing_policy_v396()','a2170b848d9a01dd13780368bc1328e8',true,'v','trigger','{"search_path=pg_catalog, pg_temp"}','df81f999cb719b7d75d581de5b53d126'),
   ('cinatoken_gateway.issue_complete_flat_text_quote_v360(text,text,text,text)','36dc527700329fb64f419785766413a3',true,'v','jsonb','{"search_path=pg_catalog, pg_temp",lock_timeout=2s,statement_timeout=15s}','2647b463e001e6511c6a6f02ee920498'),
   ('cinatoken_gateway.issue_request_capability_v356(text,text,text)','b8d756f1666c089a0e223914ec18bb5f',true,'v','jsonb','{"search_path=pg_catalog, pg_temp",lock_timeout=2s,statement_timeout=15s}','bfd429c0f85b8f17d58b8a1293d2bd20'),
   ('cinatoken_gateway.issue_request_text_route_ceiling_v357(text,text,text,text)','1d8dab6a6b5d7cee828cb47174425e22',true,'v','jsonb','{"search_path=pg_catalog, pg_temp",lock_timeout=2s,statement_timeout=15s}','f75e9bfedc6f4f0a076d2e5c83252aae'),
   ('cinatoken_gateway.lock_complete_text_routing_sources_v396()','a111bd64f0fc84926c837e586422aae3',true,'v','void','{"search_path=pg_catalog, pg_temp",lock_timeout=2s,statement_timeout=15s}','73ba08194c1e53ee6d46c7c4b0884293'),
   ('cinatoken_gateway.project_complete_text_routing_v396(text,uuid)','8cb4e60585afa68885da14e324d78cd8',true,'v','jsonb','{"search_path=pg_catalog, pg_temp",lock_timeout=2s,statement_timeout=15s}','86cee2fddd293415db3fc5a61b43a714'),
   ('cinatoken_gateway.read_complete_text_response_observation_v392(uuid)','1cf64d27d7b1b5b9285914928e31e12c',true,'v','jsonb','{"search_path=pg_catalog, pg_temp",lock_timeout=2s,statement_timeout=15s}','9f4c13d0d90dda5e6921572d75576618'),
   ('cinatoken_gateway.read_private_complete_text_route_v366(text,uuid,integer,text)','d3e9f701e19c7c0bc1ec575c138a59cd',true,'v','jsonb','{"search_path=pg_catalog, pg_temp",lock_timeout=2s,statement_timeout=15s}','a481abc2db38d78725cf3cd8634c9099'),
   ('cinatoken_gateway.record_complete_text_send_start_v365(uuid,uuid,bigint,text)','b9e8501cb001aadca9e41bd95c8fa6bd',true,'v','jsonb','{"search_path=pg_catalog, pg_temp",lock_timeout=2s,statement_timeout=15s}','ff2f9fcbb97338555499f28009e71a71'),
   ('cinatoken_gateway.reject_complete_text_admission_mutation_v361()','dd5b0152e3a87b2a5a771c00dd7376b1',true,'v','trigger','{"search_path=pg_catalog, pg_temp"}','df81f999cb719b7d75d581de5b53d126'),
   ('cinatoken_gateway.reject_complete_text_enrolled_hold_mutation_v366()','fbb71177d61d3e668bea3b662a5769f5',true,'v','trigger','{"search_path=pg_catalog, pg_temp"}','df81f999cb719b7d75d581de5b53d126'),
   ('cinatoken_gateway.reject_complete_text_grant_mutation_v362()','308d1f6c147c12d86e0b6ee969944a37',true,'v','trigger','{"search_path=pg_catalog, pg_temp"}','df81f999cb719b7d75d581de5b53d126'),
   ('cinatoken_gateway.reject_complete_text_quote_mutation_v360()','07d2c7536f037850a434320cd523fbdc',true,'v','trigger','{"search_path=pg_catalog, pg_temp"}','df81f999cb719b7d75d581de5b53d126'),
   ('cinatoken_gateway.reject_complete_text_result_fact_mutation_v366()','c80370311abec8d97074e10d27d344cf',true,'v','trigger','{"search_path=pg_catalog, pg_temp"}','df81f999cb719b7d75d581de5b53d126'),
   ('cinatoken_gateway.reject_complete_text_send_start_mutation_v365()','ae5a62591cab74acd0b30a9517fc5f9e',true,'v','trigger','{"search_path=pg_catalog, pg_temp"}','df81f999cb719b7d75d581de5b53d126'),
   ('cinatoken_gateway.reject_request_text_route_ceiling_mutation_v357()','33c51f9e19eef0d0060f76129e38b8d0',true,'v','trigger','{"search_path=pg_catalog, pg_temp"}','df81f999cb719b7d75d581de5b53d126'),
   ('cinatoken_gateway.reject_route_source_truncate_v359()','6d392fc7516eaea8da7842a3aaa0cf84',true,'v','trigger','{"search_path=pg_catalog, pg_temp"}','df81f999cb719b7d75d581de5b53d126'),
   ('cinatoken_gateway.reject_routing_projection_mutation_v396()','5d407242f182754b1c41c93c7be6e699',true,'v','trigger','{"search_path=pg_catalog, pg_temp"}','df81f999cb719b7d75d581de5b53d126'),
   ('cinatoken_gateway.require_current_routing_projection_v396(uuid,bigint,integer)','18f50fe2dce9abaa79dc8aef665d14fb',true,'v','void','{"search_path=pg_catalog, pg_temp"}','df81f999cb719b7d75d581de5b53d126'),
   ('cinatoken_gateway.require_current_routing_projection_v396(uuid,bigint,integer,boolean)','b1ef7b753d40818b1a63b2987452cacd',true,'v','void','{"search_path=pg_catalog, pg_temp"}','df81f999cb719b7d75d581de5b53d126'),
   ('cinatoken_gateway.require_text_route_source_v359()','e20c75fd627f947b37143dcad3814f17',true,'v','trigger','{"search_path=pg_catalog, pg_temp"}','df81f999cb719b7d75d581de5b53d126'),
   ('cinatoken_gateway.valid_complete_text_result_evidence_v366(text,jsonb)','3526560dc1f1fda236b3d43d94cdc98a',true,'i','boolean','{"search_path=pg_catalog, pg_temp"}','df81f999cb719b7d75d581de5b53d126'),
   ('cinatoken_response_observation.reject_mutation_v392()','9b814313c592a286c61defb7c1cd2453',true,'v','trigger','{"search_path=pg_catalog, pg_temp"}','df81f999cb719b7d75d581de5b53d126')
 ) expected(signature,body_md5,secdef,volatility,result_type,config,acl_md5) LOOP
  SELECT * INTO proc_row FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure(dependency.signature);
  IF NOT FOUND OR proc_row.proowner<>owner_oid OR proc_row.prosecdef IS DISTINCT FROM dependency.secdef
   OR proc_row.prokind<>'f' OR proc_row.proretset OR proc_row.proparallel<>'u' OR proc_row.proisstrict OR proc_row.proleakproof
   OR proc_row.prolang<>(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
   OR proc_row.provolatile::text<>dependency.volatility OR proc_row.prorettype<>pg_catalog.to_regtype(dependency.result_type)
   OR proc_row.proconfig IS DISTINCT FROM dependency.config::text[]
   OR md5(replace(proc_row.prosrc,E'\r\n',E'\n'))<>dependency.body_md5
  THEN RAISE EXCEPTION 'sticky v398 proof function differs: %',dependency.signature USING ERRCODE='P0001'; END IF;
  SELECT md5(string_agg((CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END)||':'
   ||pg_get_userbyid(a.grantor)||':'||a.privilege_type||':'||a.is_grantable::text,','
   ORDER BY (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END) COLLATE "C",a.privilege_type COLLATE "C"))
   INTO acl_contract FROM pg_catalog.aclexplode(COALESCE(proc_row.proacl,pg_catalog.acldefault('f',proc_row.proowner))) a;
  IF acl_contract IS DISTINCT FROM dependency.acl_md5
  THEN RAISE EXCEPTION 'sticky v398 proof function execution ACL differs: %',dependency.signature USING ERRCODE='P0001'; END IF;
 END LOOP;
 -- Locks also keep ALTER TRIGGER and source/proof writes outside this install.
 EXECUTE 'LOCK TABLE '||array_to_string(ARRAY['cinatoken_gateway.api_keys','cinatoken_gateway.authenticated_request_capabilities_v356','cinatoken_gateway.complete_text_admissions_v361','cinatoken_gateway.complete_text_attempt_grants_v362','cinatoken_gateway.complete_text_quote_routes_v360','cinatoken_gateway.complete_text_quotes_v360','cinatoken_gateway.complete_text_result_fact_conflicts_v366','cinatoken_gateway.complete_text_result_facts_v366','cinatoken_gateway.complete_text_routing_facts_v396','cinatoken_gateway.complete_text_routing_members_v396','cinatoken_gateway.complete_text_routing_projections_v396','cinatoken_gateway.complete_text_send_custody_v365','cinatoken_gateway.complete_text_send_starts_v365','cinatoken_gateway.model_endpoint_routes','cinatoken_gateway.model_endpoints','cinatoken_gateway.model_routes','cinatoken_gateway.model_surfaces','cinatoken_gateway.models','cinatoken_gateway.providers','cinatoken_gateway.request_dispatch_intents','cinatoken_gateway.request_text_route_ceilings_v357','cinatoken_gateway.route_pool_sticky_bindings','cinatoken_gateway.route_pools','cinatoken_gateway.route_source_generations_v359','cinatoken_gateway.routing_policy_epoch_v396','cinatoken_gateway.schema_migrations','cinatoken_gateway.system_config','cinatoken_gateway.users','cinatoken_gateway.workspaces','cinatoken_response_observation.observations_v392']::text[],',')||' IN SHARE ROW EXCLUSIVE MODE';
 FOR dependency IN SELECT * FROM (VALUES
   ('cinatoken_gateway.api_keys','86f5cf6a1b24c2a1841af660702999f0','[{"acl":"{cinatoken_gateway_buyer_settlement=w/cinatoken_gateway_migrator}","column":"updated_at"}]',1,'25aef4909cd9af197d3762a4762aa8f2'),
   ('cinatoken_gateway.authenticated_request_capabilities_v356','0d0f5e0a21da14d6dba9232147198718','null',0,NULL),
   ('cinatoken_gateway.complete_text_admissions_v361','0d0f5e0a21da14d6dba9232147198718','null',1,'9a9f414327d394e61b7b0a47983ea7dd'),
   ('cinatoken_gateway.complete_text_attempt_grants_v362','0d0f5e0a21da14d6dba9232147198718','null',2,'3976d0e774d9e496610826b0c3e5d200'),
   ('cinatoken_gateway.complete_text_quote_routes_v360','0d0f5e0a21da14d6dba9232147198718','null',1,'cd1b362eedcb789fc46bc9b8f22e3f88'),
   ('cinatoken_gateway.complete_text_quotes_v360','0d0f5e0a21da14d6dba9232147198718','null',1,'cb078d101ee3789b5b7a4eb020f8d263'),
   ('cinatoken_gateway.complete_text_result_fact_conflicts_v366','0d0f5e0a21da14d6dba9232147198718','null',1,'4b79b9998fea9b33004e3bd813bfe758'),
   ('cinatoken_gateway.complete_text_result_facts_v366','0d0f5e0a21da14d6dba9232147198718','null',1,'f29970c890577f5f7a64e97b68b7cc57'),
   ('cinatoken_gateway.complete_text_routing_facts_v396','0d0f5e0a21da14d6dba9232147198718','null',0,NULL),
   ('cinatoken_gateway.complete_text_routing_members_v396','0d0f5e0a21da14d6dba9232147198718','null',1,'441c630b3283c4f2a7af2d8015bd5d18'),
   ('cinatoken_gateway.complete_text_routing_projections_v396','0d0f5e0a21da14d6dba9232147198718','null',1,'2d7e443340e431e1b4feb9797c92c505'),
   ('cinatoken_gateway.complete_text_send_custody_v365','0d0f5e0a21da14d6dba9232147198718','null',2,'8c488c88abfba13ebd1a990c0ea321a4'),
   ('cinatoken_gateway.complete_text_send_starts_v365','0d0f5e0a21da14d6dba9232147198718','null',2,'14beb3d380da2b02d1874bb599c709dc'),
   ('cinatoken_gateway.model_endpoint_routes','8a94df5b874473a2533fcd0b9ac31bc0','null',3,'cb1d5f40ca08fe95a1590cf0a33b17bc'),
   ('cinatoken_gateway.model_endpoints','8a94df5b874473a2533fcd0b9ac31bc0','null',3,'ff51098583491b570a41c35745758461'),
   ('cinatoken_gateway.model_routes','8a94df5b874473a2533fcd0b9ac31bc0','null',3,'a3e0b7fc741a6dd1c6653bd14e255831'),
   ('cinatoken_gateway.model_surfaces','8a94df5b874473a2533fcd0b9ac31bc0','null',1,'267ebe9ec1bedcd154b8b70b5b3e36bf'),
   ('cinatoken_gateway.models','8a94df5b874473a2533fcd0b9ac31bc0','null',1,'b14ff071d9fd0484862ede9326971e9b'),
   ('cinatoken_gateway.providers','8a94df5b874473a2533fcd0b9ac31bc0','null',3,'0f764edf2f6b94f34e23afc2c879ca36'),
   ('cinatoken_gateway.request_dispatch_intents','0d0f5e0a21da14d6dba9232147198718','null',1,'a7022032052edd402f19e1a94d985370'),
   ('cinatoken_gateway.request_text_route_ceilings_v357','0d0f5e0a21da14d6dba9232147198718','null',2,'a303713562b8c87f9955be36f0d8445a'),
   ('cinatoken_gateway.route_pool_sticky_bindings','48765497ac38f7f601eac96369b7a1da','null',0,NULL),
   ('cinatoken_gateway.route_pools','8a94df5b874473a2533fcd0b9ac31bc0','null',3,'c34e275f0dd0356252181bcef663af2a'),
   ('cinatoken_gateway.route_source_generations_v359','c1be72890c8cc94893d59e34443dd6e3','null',0,NULL),
   ('cinatoken_gateway.routing_policy_epoch_v396','c1be72890c8cc94893d59e34443dd6e3','null',0,NULL),
   ('cinatoken_gateway.schema_migrations','0d0f5e0a21da14d6dba9232147198718','null',0,NULL),
   ('cinatoken_gateway.system_config','8a94df5b874473a2533fcd0b9ac31bc0','null',1,'886af608a833c1af55601875aa57a80a'),
   ('cinatoken_gateway.users','15831c93dcbd2c6e12762740bd908e25','[{"acl":"{cinatoken_gateway_buyer_settlement=w/cinatoken_gateway_migrator}","column":"budget_spent"},{"acl":"{cinatoken_gateway_buyer_settlement=w/cinatoken_gateway_migrator}","column":"updated_at"},{"acl":"{cinatoken_gateway_buyer_settlement=w/cinatoken_gateway_migrator}","column":"budget_reserved_micros"}]',2,'86906bd15af39d1c73c9617dbe933926'),
   ('cinatoken_gateway.workspaces','86f5cf6a1b24c2a1841af660702999f0','null',1,'d81becb7813811dbc5455232d8580ecf'),
   ('cinatoken_response_observation.observations_v392','0d0f5e0a21da14d6dba9232147198718','null',2,'4a272c187e6c8920c8d9414839e4e59e')
 ) expected(table_name,acl_md5,column_acl,trigger_count,trigger_md5) LOOP
  SELECT * INTO table_row FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass(dependency.table_name);
  IF NOT FOUND OR table_row.relowner<>owner_oid OR table_row.relkind<>'r' OR table_row.relrowsecurity OR table_row.relforcerowsecurity OR table_row.relhasrules
  THEN RAISE EXCEPTION 'sticky v398 proof table differs: %',dependency.table_name USING ERRCODE='P0001'; END IF;
  SELECT md5(string_agg((CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END)||':'
   ||pg_get_userbyid(a.grantor)||':'||a.privilege_type||':'||a.is_grantable::text,','
   ORDER BY (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END) COLLATE "C",a.privilege_type COLLATE "C"))
   INTO acl_contract FROM pg_catalog.aclexplode(COALESCE(table_row.relacl,pg_catalog.acldefault('r',table_row.relowner))) a;
  SELECT jsonb_agg(jsonb_build_object('column',attname,'acl',attacl::text) ORDER BY attnum)
   INTO column_contract FROM pg_catalog.pg_attribute WHERE attrelid=table_row.oid AND attacl IS NOT NULL;
  SELECT md5(string_agg(t.tgname||'|'||pg_get_triggerdef(t.oid)||'|'||t.tgenabled::text||'|'||t.tgtype::text||'|'
    ||COALESCE(t.tgqual::text,'NULL')||'|'||t.tgattr::text||'|'||t.tgnargs::text||'|'||t.tgdeferrable::text||'|'
    ||t.tginitdeferred::text||'|'||COALESCE(t.tgoldtable,'NULL')||'|'||COALESCE(t.tgnewtable,'NULL'),E'\n' ORDER BY t.tgname COLLATE "C"))
   INTO trigger_contract FROM pg_catalog.pg_trigger t WHERE t.tgrelid=table_row.oid AND NOT t.tgisinternal;
  IF acl_contract IS DISTINCT FROM dependency.acl_md5
   OR column_contract IS DISTINCT FROM NULLIF(dependency.column_acl::jsonb,'null'::jsonb)
   OR trigger_contract IS DISTINCT FROM dependency.trigger_md5
   OR (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE t.tgrelid=table_row.oid AND NOT t.tgisinternal)<>dependency.trigger_count
  THEN RAISE EXCEPTION 'sticky v398 exact proof table ACL or trigger catalog differs: %',dependency.table_name USING ERRCODE='P0001'; END IF;
 END LOOP;
END;
$preflight$;

CREATE FUNCTION cinatoken_gateway.complete_text_sticky_action_v398(
 p_quote uuid,p_request text,p_body_sha256 text,p_epoch bigint,p_candidate integer,
 p_pool text,p_affinity_hash text,p_session boolean,p_success_policy text,p_action text,
 p_target text,p_token text,p_expected_token text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp SET lock_timeout TO '2s' SET statement_timeout TO '15s' AS $sticky$
DECLARE projection record; candidate jsonb; sticky jsonb; old_row record;
DECLARE epoch_value bigint; ttl integer; effective_target text; changed_count integer; server_now timestamptz;
BEGIN
 IF SESSION_USER<>'cinatoken_gateway_complete_text_sticky_router' OR current_setting('transaction_isolation')<>'read committed'
  OR p_quote IS NULL OR p_request IS NULL OR p_body_sha256 IS NULL OR p_body_sha256!~'^[0-9a-f]{64}$'
  OR p_epoch IS NULL OR p_candidate IS NULL OR p_candidate NOT BETWEEN 0 AND 7
  OR p_pool IS NULL OR octet_length(p_pool) NOT BETWEEN 1 AND 256
  OR p_affinity_hash IS NULL OR p_affinity_hash!~'^[0-9a-f]{64}$' OR p_session IS NULL
  OR p_action IS NULL OR p_action NOT IN('get','bind','touch','clear')
  OR (p_session AND (p_success_policy IS NULL OR p_success_policy NOT IN('stream_success','cache_hit')))
  OR (NOT p_session AND p_success_policy IS NOT NULL)
  OR (p_action='get' AND (p_target IS NOT NULL OR p_token IS NOT NULL OR p_expected_token IS NOT NULL))
  OR (p_action='bind' AND (p_target IS NULL OR octet_length(p_target) NOT BETWEEN 1 AND 256
   OR p_token IS NULL OR p_token!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'))
  OR (p_action IN('touch','clear') AND (p_target IS NOT NULL OR p_token IS NOT NULL OR p_expected_token IS NULL))
  OR (p_expected_token IS NOT NULL AND octet_length(p_expected_token) NOT BETWEEN 1 AND 256)
 THEN RAISE EXCEPTION 'invalid sticky call' USING ERRCODE='23514'; END IF;
 -- Expiry can be waived only for a completed invocation/response proof below.
 PERFORM cinatoken_gateway.require_current_routing_projection_v396(p_quote,p_epoch,p_candidate,p_action<>'get');
 SELECT * INTO projection FROM cinatoken_gateway.complete_text_routing_projections_v396 WHERE quote_id=p_quote FOR SHARE;
 IF projection.request_id IS DISTINCT FROM p_request OR projection.final_body_sha256 IS DISTINCT FROM p_body_sha256
 THEN RAISE EXCEPTION 'sticky quote identity differs' USING ERRCODE='23514'; END IF;
 candidate:=projection.projection->'candidates'->p_candidate;
 IF (candidate->'surface'<>'null'::jsonb AND candidate->'surface'->>'poolId' IS DISTINCT FROM p_pool)
  OR NOT EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_routing_members_v396 m
   WHERE m.quote_id=p_quote AND m.candidate_index=p_candidate AND m.route_pool_id=p_pool AND m.default_endpoint_eligible)
 THEN RAISE EXCEPTION 'sticky pool differs' USING ERRCODE='23514'; END IF;
 sticky:=candidate->'surface'->'sticky';
 IF p_session THEN ttl:=600; epoch_value:=COALESCE((sticky->>'epoch')::bigint,0);
 ELSE
  IF (sticky->>'enabled')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'sticky disabled' USING ERRCODE='23514'; END IF;
  ttl:=(sticky->>'idleTtlSeconds')::integer; epoch_value:=(sticky->>'epoch')::bigint;
 END IF;
 IF ttl IS NULL OR ttl NOT BETWEEN 60 AND 86400 OR epoch_value IS NULL OR abs(epoch_value::numeric)>9007199254740991
 THEN RAISE EXCEPTION 'sticky configuration invalid' USING ERRCODE='23514'; END IF;
 SELECT * INTO old_row FROM cinatoken_gateway.route_pool_sticky_bindings
  WHERE route_pool_id=p_pool AND affinity_hash=p_affinity_hash FOR UPDATE;
 IF p_action='get' THEN
  RETURN jsonb_build_object('status','sticky_checked','binding',CASE WHEN old_row.route_pool_id IS NULL THEN NULL
   ELSE jsonb_build_object('route_pool_id',old_row.route_pool_id,'affinity_hash',old_row.affinity_hash,
    'route_target_id',old_row.route_target_id,'binding_token',old_row.binding_token,'pool_epoch',old_row.pool_epoch,
    'expires_at',old_row.expires_at,'created_at',old_row.created_at,'updated_at',old_row.updated_at) END);
 END IF;
 effective_target:=CASE WHEN p_action='bind' THEN p_target ELSE old_row.route_target_id END;
 IF effective_target IS NULL THEN RETURN jsonb_build_object('status','sticky_mutated','changed',false); END IF;
 IF NOT EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_attempt_grants_v362 g
  JOIN cinatoken_gateway.complete_text_routing_members_v396 m
   ON m.quote_id=g.quote_id AND m.candidate_index=g.candidate_index AND m.route_target_id=g.route_target_id
  WHERE g.quote_id=p_quote AND g.request_id=p_request AND g.final_body_sha256=p_body_sha256
   AND g.candidate_index=p_candidate AND g.route_target_id=effective_target AND m.default_endpoint_eligible
   -- Legacy routing uses the first eligible pool as the affinity namespace
   -- while retaining the whole model's eligible route set. Surface routing
   -- requires the selected target to belong to its explicit pool.
   AND (candidate->'surface'='null'::jsonb OR m.route_pool_id=p_pool)
   AND CASE WHEN p_action='clear' THEN EXISTS(SELECT 1 FROM cinatoken_gateway.complete_text_result_facts_v366 f
     WHERE f.grant_id=g.grant_id AND f.kind='fetch_invoked' AND f.source_kind='holder'
      AND f.request_id=g.request_id AND f.quote_id=g.quote_id AND f.route_target_id=g.route_target_id AND f.grant_claim_sha256=g.claim_sha256)
    ELSE EXISTS(SELECT 1 FROM cinatoken_response_observation.observations_v392 o
     JOIN cinatoken_gateway.complete_text_result_facts_v366 f ON f.fact_id=o.fact_id AND f.grant_id=o.grant_id
     WHERE o.grant_id=g.grant_id AND o.request_id=g.request_id AND f.kind='provider_usage' AND f.source_kind='holder'
      AND f.quote_id=g.quote_id AND f.route_target_id=g.route_target_id AND f.grant_claim_sha256=g.claim_sha256
      AND (p_success_policy IS DISTINCT FROM 'cache_hit' OR (m.beneficial_cache_read_pricing AND (o.observation->>'cacheReadTokens')::bigint>0))) END)
 THEN RAISE EXCEPTION 'sticky response or invocation proof missing' USING ERRCODE='23514'; END IF;
 server_now:=clock_timestamp();
 IF p_action='bind' THEN
  INSERT INTO cinatoken_gateway.route_pool_sticky_bindings(route_pool_id,affinity_hash,route_target_id,binding_token,pool_epoch,expires_at,created_at,updated_at)
   VALUES(p_pool,p_affinity_hash,p_target,p_token,epoch_value,server_now+ttl*interval '1 second',server_now,server_now)
   ON CONFLICT(route_pool_id,affinity_hash) DO UPDATE SET route_target_id=excluded.route_target_id,binding_token=excluded.binding_token,
    pool_epoch=excluded.pool_epoch,expires_at=excluded.expires_at,updated_at=excluded.updated_at
   WHERE route_pool_sticky_bindings.expires_at<=server_now OR route_pool_sticky_bindings.pool_epoch<>excluded.pool_epoch
    OR (p_expected_token IS NOT NULL AND route_pool_sticky_bindings.binding_token=p_expected_token);
 ELSIF p_action='touch' THEN
  UPDATE cinatoken_gateway.route_pool_sticky_bindings SET expires_at=server_now+ttl*interval '1 second',updated_at=server_now
   WHERE route_pool_id=p_pool AND affinity_hash=p_affinity_hash AND binding_token=p_expected_token;
 ELSE
  DELETE FROM cinatoken_gateway.route_pool_sticky_bindings WHERE route_pool_id=p_pool AND affinity_hash=p_affinity_hash AND binding_token=p_expected_token;
 END IF;
 GET DIAGNOSTICS changed_count=ROW_COUNT;
 RETURN jsonb_build_object('status','sticky_mutated','changed',changed_count=1);
END;
$sticky$;
REVOKE ALL ON FUNCTION cinatoken_gateway.complete_text_sticky_action_v398(uuid,text,text,bigint,integer,text,text,boolean,text,text,text,text,text)
 FROM PUBLIC,cinatoken_gateway_runtime,cinatoken_gateway_complete_text_sticky_router;
GRANT USAGE ON SCHEMA cinatoken_gateway TO cinatoken_gateway_complete_text_sticky_router;
GRANT EXECUTE ON FUNCTION cinatoken_gateway.complete_text_sticky_action_v398(uuid,text,text,bigint,integer,text,text,boolean,text,text,text,text,text)
 TO cinatoken_gateway_complete_text_sticky_router;
