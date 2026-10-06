import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { authenticatePostgresPersonalKeyV395,PostgresPersonalPeriodPendingV395 } from '../../../packages/proxy/src/services/postgres-personal-key-auth-v395.ts';
import { createHyperdriveDedicatedRoleTransportV390 } from '../../../packages/proxy/src/services/hyperdrive-dedicated-role-transport-v390.ts';
import { computeRouteDataPolicySubjectFingerprintFromRows } from '../../../packages/core/src/route-data-policy.ts';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { startJournalCommitAckDropProxyV381 } from '../../../packages/core/src/test-support/postgres-journal-commit-ack-proxy-v381.mjs';
import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';
import { activatePostgresBuyerSplitV348 } from './activate-postgres-buyer-split-v348.ts';
import { grantPostgresBuyerSplitV348 } from './grant-postgres-buyer-split-v348.ts';
import { activatePostgresBuyerGuardrailSplitV349 } from './activate-postgres-buyer-guardrail-split-v349.ts';
import { grantPostgresBuyerGuardrailSplitV349 } from './grant-postgres-buyer-guardrail-split-v349.ts';
const g='cinatoken_gateway';
const migrationDir=new URL('../../../packages/core/migrations-postgres/',import.meta.url);
const proposal=name=>new URL(`../../../packages/core/migrations-proposals/postgres/${name}`,import.meta.url);
const reportUrl=new URL('../../../docs/developers/architecture/implementation-evidence/C04-personal-key-auth-period-v395-report.json',import.meta.url);
const sha=value=>createHash('sha256').update(value).digest('hex');
const bearer='sk-local-complete-text-admission-v361-bearer';
const keyHash=`sha256:${sha(bearer)}`;
const originalHash=sha('original-v361-ingress-body');
const finalBody=JSON.stringify({model:'v361-model',models:['v361-model'],
  messages:[{role:'user',content:'hello'}],max_completion_tokens:300});
const preliminary=[
  ['shared-key-quote-versions.sql','shared_key_quote_versions_activation'],
  ['shared-key-dispatch-quote-attempts.sql','shared_quote_attempt_activation'],
  ['shared-key-economic-outbox.sql','shared_key_economic_outbox_activation'],
  ['shared-key-economic-outbox-producer.sql','shared_key_economic_producer_activation'],
  ['shared-key-snapshot-earning-consumer.sql','shared_key_snapshot_consumer_activation'],
  ['shared-key-buyer-debit-v2.sql','shared_key_buyer_debit_v2_activation'],
  ['shared-key-economic-producer-v2.sql','shared_key_economic_producer_v2_activation'],
  ['shared-key-buyer-budget-receipt-v2.sql','shared_key_buyer_budget_receipt_activation'],
];
const later=[
  ['budget-admission-login-v350.sql','budget_admission_login_activation'],
  ['guardrail-budget-admission-login-v351.sql','guardrail_budget_admission_v351_activation'],
  ['authenticated-request-capability-login-v356.sql','request_capability_login_activation'],
  ['authenticated-text-route-ceiling-issuer-v357.sql','request_route_ceiling_activation'],
  ['authenticated-text-route-source-fence-v359.sql','route_source_fence_activation'],
  ['authenticated-complete-text-quote-v360.sql','complete_text_quote_activation'],
];
const roles={migrator:'cinatoken_gateway_migrator',runtime:'cinatoken_gateway_runtime',
  buyer:'cinatoken_gateway_buyer_settlement',
  admission:'cinatoken_gateway_budget_admission',
  sharedProducer:'cinatoken_gateway_shared_quote_attempt_producer',
  sharedConsumer:'cinatoken_gateway_shared_earning_consumer',
  cap:'cinatoken_gateway_request_capability_issuer',
  claim:'cinatoken_gateway_request_capability_claim',
  fragment:'cinatoken_gateway_request_route_ceiling_issuer',
  verifier:'cinatoken_gateway_route_source_verifier',
  complete:'cinatoken_gateway_complete_text_quote_issuer',
  granter:'cinatoken_gateway_complete_text_attempt_granter',
  holder:'cinatoken_gateway_complete_text_send_holder',
  bill:'cinatoken_gateway_complete_text_provider_bill',
  renewer:'cinatoken_gateway_complete_text_hold_renewer',
  resolver:'cinatoken_gateway_complete_text_no_fetch_resolver',
  closer:'cinatoken_gateway_complete_text_platform_closer',
  worker:'cinatoken_gateway_complete_text_recovery_worker',
  observer:'cinatoken_gateway_complete_text_recovery_observer',
  operator:'cinatoken_gateway_complete_text_recovery_operator',
  recovery:'cinatoken_gateway_budget_recovery',auth:'cinatoken_gateway_personal_key_auth'};

function connection(cluster,name,password,label) {
  return postgres({host:'127.0.0.1',port:cluster.port,database:'postgres',
    username:name,password,ssl:false,max:1,prepare:false,fetch_types:false,
    connect_timeout:3,idle_timeout:0,max_lifetime:0,backoff:false,onnotice(){},
    connection:{application_name:`complete-text-no-fetch-close-v388-${label}`}});
}
async function denied(work,code='42501',constraint) {
  await assert.rejects(work,error=>{
    const cause=error?.cause??error;
    assert.equal(cause?.code,code,String(error));
    if(constraint) assert.equal(cause?.constraint_name,constraint,String(error));
    return true;
  });
}

test('v395 direct personal bearer auth preserves unresolved obligations before UTC period reset',
{timeout:300000,skip:!process.env.GATEWAY_NATIVE_PG_BIN},async()=>{
const loadedFixtureSha256=sha(await readFile(new URL(import.meta.url)));
const cluster=await startNativePostgres();
const report={status:'RUNNING',cleanup:'PENDING',binaryVersion:cluster.binaryVersion,sourceSha256:{},stages:[],limitations:[
'Review-only PG18.6 local cluster, PG73 and proposal prerequisites. No remote database, deployment or paid Provider call.',
'Personal workspaces only. Organization authorization remains outside this entry.',
'Due rollover denies authentication while ordinary/Guardrail or nonterminal C04 obligations remain. This conservative policy does not provide uninterrupted cross-period renewal or financial closure.',
'Owned fixtures can set clocks/state through cluster-superuser fault injection; the dedicated auth LOGIN cannot choose those inputs.',
'Adapter origin-role checks use local PostgreSQL URLs, not deployed Cloudflare Hyperdrive.',
'No quote/admission/Provider POST is executed after an auth COMMIT ACK loss; the rerun proves idempotent maintenance only.'
]};
const stage=(name,detail={})=>report.stages.push({name,result:'PASS',...detail});
const clients=[];let failure;
try {
      assert.match(cluster.binaryVersion,/PostgreSQL\) 18\.6/u);
      const passwords=Object.fromEntries(Object.keys(roles).map(x=>[
        x,randomBytes(24).toString('hex')]));
      const resolverUrl='postgres://'+roles.resolver+':'+passwords.resolver
        +'@127.0.0.1:'+cluster.port+'/postgres?sslmode=disable';
      await cluster.admin.unsafe(`${Object.entries(roles).map(([label,name])=>
        `CREATE ROLE ${name} LOGIN ${label==='migrator'||label==='runtime'||
          label==='sharedProducer'||label==='sharedConsumer'?'':'NOINHERIT'} PASSWORD '${passwords[label]}';`).join('\n')}
        CREATE SCHEMA ${g} AUTHORIZATION ${roles.migrator};
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO ${Object.values(roles).join(',')};
        GRANT CREATE ON DATABASE postgres TO ${roles.migrator};`).simple();
      const migrator=connection(cluster,roles.migrator,passwords.migrator,'migrator');
      const runtime=connection(cluster,roles.runtime,passwords.runtime,'runtime');
      const admission=connection(cluster,roles.admission,passwords.admission,'admission');
      const recovery=connection(cluster,roles.recovery,passwords.recovery,'recovery');
      const buyer=connection(cluster,roles.buyer,passwords.buyer,'buyer');
      const renewer=connection(cluster,roles.renewer,passwords.renewer,'renewer');
      const granter=connection(cluster,roles.granter,passwords.granter,'granter');
      const granterPeer=connection(cluster,roles.granter,passwords.granter,'granter-peer');
      const holder=connection(cluster,roles.holder,passwords.holder,'holder');
      const holderPeer=connection(cluster,roles.holder,passwords.holder,'holder-peer');
      const resolver=connection(cluster,roles.resolver,passwords.resolver,'resolver');
      const resolverPeer=connection(cluster,roles.resolver,passwords.resolver,'resolver-peer');
      const closer=connection(cluster,roles.closer,passwords.closer,'closer');
      const closerPeer=connection(cluster,roles.closer,passwords.closer,'closer-peer');
      const closerUrl='postgres://'+roles.closer+':'+passwords.closer+'@127.0.0.1:'+cluster.port+'/postgres?sslmode=disable';
      const worker=connection(cluster,roles.worker,passwords.worker,'worker');
      const workerPeer=connection(cluster,roles.worker,passwords.worker,'worker-peer');
      const observer=connection(cluster,roles.observer,passwords.observer,'observer');
      const operator=connection(cluster,roles.operator,passwords.operator,'operator');
      const bill=connection(cluster,roles.bill,passwords.bill,'bill');
      const cap=connection(cluster,roles.cap,passwords.cap,'cap');
      const verifier=connection(cluster,roles.verifier,passwords.verifier,'verifier');
      const complete=connection(cluster,roles.complete,passwords.complete,'complete');
      clients.push(migrator,runtime,admission,recovery,buyer,renewer,
        granter,granterPeer,holder,holderPeer,
        cap,verifier,complete,resolver,resolverPeer,bill,closer,closerPeer,worker,workerPeer,observer,operator);
      await migrator.unsafe(`CREATE TABLE ${g}.schema_migrations
        (version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`);
      const migrationNames=await listPg73Migrations();
      assert.equal(migrationNames.length,73);
      const corpus=[];
      for(const name of migrationNames) {
        const body=await readFile(new URL(name,migrationDir),'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx=>{
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${g}.schema_migrations(version) VALUES($1)`,[name]);
        });
      }
      report.sourceSha256.formalMigrations=sha(corpus.join('\n'));
      const migratorUrl=`postgres://${roles.migrator}:${passwords.migrator}`
        +`@127.0.0.1:${cluster.port}/postgres`;
      // Keep original grant calls and rejection checks on the owned PG73 ledger.
      const grantPostgresRuntime = ({ DATABASE_URL }) =>
        grantPg73RuntimeFixture({ cluster, migrator, migratorUrl: DATABASE_URL });
      await grantPostgresRuntime({DATABASE_URL:migratorUrl});
      for(const [name,setting] of preliminary) {
        const body=await readFile(proposal(name),'utf8');
        report.sourceSha256['packages/core/migrations-proposals/postgres/'+name]=sha(body);
        await migrator.begin(async tx=>{
          await tx.unsafe(`SET LOCAL cinatoken.${setting}='reviewed-v1'`);
          if(name==='shared-key-quote-versions.sql')
            await tx.unsafe(`SET LOCAL cinatoken.${setting}='reviewed-v2'`);
          await tx.unsafe(body).simple();
        });
      }
      await activatePostgresBuyerSplitV348({DATABASE_URL:migratorUrl});
      await grantPostgresBuyerSplitV348({DATABASE_URL:migratorUrl});
      await activatePostgresBuyerGuardrailSplitV349({DATABASE_URL:migratorUrl});
      await grantPostgresBuyerGuardrailSplitV349({DATABASE_URL:migratorUrl});
      stage('formal-pg73-and-buyer-budget-split-prerequisites-installed');


const install=async(name,setting)=>{const body=await readFile(proposal(name),'utf8');
report.sourceSha256['packages/core/migrations-proposals/postgres/'+name]=sha(body);
await migrator.begin(async tx=>{await tx.unsafe('SET LOCAL cinatoken.'+setting+"='reviewed-v1'");await tx.unsafe(body).simple();});};
for(const [name,setting] of later)await install(name,setting);
for(const [name,setting] of [
['complete-text-quote-budget-admission-v361.sql','complete_text_budget_admission_activation'],
['complete-text-attempt-grant-v362.sql','complete_text_attempt_grant_activation'],
['complete-text-send-start-v365.sql','complete_text_send_start_activation']])await install(name,setting);
      await migrator.unsafe(`INSERT INTO ${g}.users(id,email,budget_max)
        VALUES('v361-user','v361@example.invalid',10);
        INSERT INTO ${g}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
        VALUES('v361-workspace','personal','v361-user','Admission','v361','active');`).simple();
      await migrator.unsafe(`INSERT INTO ${g}.api_keys
        (id,key,key_hash,user_id,workspace_id,status,limit_micros,limit_reset)
        VALUES('v361-key',$1,$2,'v361-user','v361-workspace','active',2000000,'daily')`,
        [`hashref:${keyHash}`,keyHash]);
      await migrator.unsafe(`INSERT INTO ${g}.workspace_budgets
          (id,workspace_id,reset_interval,limit_micros)
          VALUES('v361-budget','v361-workspace','daily',2000000);
        INSERT INTO ${g}.guardrails
          (id,workspace_id,owner_user_id,name,status)
          VALUES('v361-guardrail','v361-workspace','v361-user','Budget','active');
        INSERT INTO ${g}.guardrail_versions(id,guardrail_id,version,config_json)
          VALUES('v361-version','v361-guardrail',1,
            '{"budget":{"limit":2,"period":"daily"}}');
        INSERT INTO ${g}.guardrail_assignments
          (id,workspace_id,guardrail_id,scope_type,scope_id)
          VALUES('v361-assignment','v361-workspace','v361-guardrail',
            'user','v361-user');
        INSERT INTO ${g}.providers(id,name,api_key,status)
          VALUES('v361-provider','V361 Provider','enc:v2:fixture','active');
        INSERT INTO ${g}.models(id,vendor) VALUES('v361-model','other');
        INSERT INTO ${g}.route_pools(id,model_id,route_group,name,status)
          VALUES('v361-pool','v361-model','default','Default','active');
        INSERT INTO ${g}.model_surfaces
          (id,model_id,route_group,request_protocol,request_operation,
            route_pool_id,status)
          VALUES('v361-surface','v361-model','default','openai','chat',
            'v361-pool','active');
        INSERT INTO ${g}.model_routes
          (id,model_id,provider_id,provider_model_name,route_pool_id,
            upstream_protocol,upstream_operation,adapter,status)
          VALUES('v361-route','v361-model','v361-provider','upstream-v361',
            'v361-pool','openai','chat','passthrough','active');
        INSERT INTO ${g}.model_endpoints
          (id,model_id,provider_id,provider_slug,tag,context_length,pricing,
            evidence_url,verified_by,verified_at,expires_at,status)
          VALUES('v361-endpoint','v361-model','v361-provider','v361-provider',
            'default',1000,'{"currency":"USD","prompt":"0.000010","completion":"0.000020"}',
            'https://example.invalid/v361','fixture',now()-interval '1 minute',
            now()+interval '5 minutes','verified');
        INSERT INTO ${g}.model_endpoint_routes(endpoint_id,route_target_id)
          VALUES('v361-endpoint','v361-route');`).simple();
      const attest=async()=>{
        const [route]=await migrator.unsafe(`SELECT provider_id,provider_model_name,
          custom_params,upstream_protocol,upstream_operation,adapter
          FROM ${g}.model_routes WHERE id='v361-route'`);
        const [provider]=await migrator.unsafe(`SELECT id,endpoints,api_key,
          shared_channel_type FROM ${g}.providers WHERE id=$1`,[route.provider_id]);
        const fingerprint=await computeRouteDataPolicySubjectFingerprintFromRows(route,provider);
        await migrator.unsafe(`UPDATE ${g}.model_endpoint_routes
          SET subject_fingerprint=$1 WHERE route_target_id='v361-route'`,[fingerprint]);
        const [generation]=await verifier.unsafe(`SELECT generation::text AS generation
          FROM ${g}.route_source_generations_v359 WHERE route_target_id='v361-route'`);
        const [row]=await verifier.unsafe(`SELECT ${g}.attest_text_route_source_v359(
          'v361-route',$1,$2) AS value`,[generation.generation,fingerprint]);
        assert.equal(row.value.status,'attested');
      };
      await attest();
      stage('authoritative-route-and-three-budget-source-fixture-ready');

      const issueQuote=async(bearerValue=bearer)=>{
        const id=`v362-${randomUUID()}`;
        const [issued]=await cap.unsafe(`SELECT ${g}.issue_request_capability_v356(
          $1,$2,$3) AS value`,[id,bearerValue,originalHash]);
        assert.equal(issued.value.status,'issued');
        const [quoted]=await complete.unsafe(`SELECT ${g}.issue_complete_flat_text_quote_v360(
          $1,$2,$3,$4) AS value`,[id,issued.value.capability,originalHash,finalBody]);
        assert.equal(quoted.value.status,'quoted_complete_subset');
        return quoted.value;
      };
      const intents=()=>{
        const at=new Date();
        const start=new Date(Date.UTC(at.getUTCFullYear(),at.getUTCMonth(),at.getUTCDate()));
        const end=new Date(start.getTime()+86_400_000);
        const common={workspaceId:'v361-workspace',guardrailVersion:1,
          period:'daily',periodStart:start.toISOString(),periodEnd:end.toISOString(),
          limitMicros:2_000_000};
        return [
          {...common,assignmentId:'v361-assignment',guardrailId:'v361-guardrail',
            scopeType:'user',scopeId:'v361-user'},
          {...common,assignmentId:'workspace-budget:v361-budget',
            guardrailId:'workspace-budget:v361-budget',scopeType:'workspace',
            scopeId:'v361-workspace'},
          {...common,assignmentId:'gateway-key-limit:v361-key',
            guardrailId:'gateway-key-limit:v361-key',scopeType:'api_key',
            scopeId:'v361-key'}];
      };
      const admit=async(quote,items=intents(),requestId=quote.requestId,
        quoteId=quote.quoteId)=>{
        const [row]=await admission.unsafe(`SELECT
          ${g}.admit_complete_flat_text_quote_v361($1,$2::uuid,$3::jsonb) AS value`,
          [requestId,quoteId,admission.json(items)]);
        return row.value;
      };
      const claimFor=async(quote,overrides={})=>{
        const [manifest]=await migrator.unsafe(`SELECT candidate_index,model_id,
          route_target_id,provider_id,endpoint_id,credential_class,
          credential_id,provider_ciphertext_sha256
          FROM ${g}.complete_text_quote_routes_v360
          WHERE quote_id=$1::uuid ORDER BY candidate_index,route_target_id
          LIMIT 1`,[quote.quoteId]);
        assert.ok(manifest);
        return {requestId:quote.requestId,quoteId:quote.quoteId,
          finalBodySha256:quote.finalBodySha256,
          candidateIndex:manifest.candidate_index,modelId:manifest.model_id,
          routeTargetId:manifest.route_target_id,providerId:manifest.provider_id,
          endpointId:manifest.endpoint_id,credentialClass:manifest.credential_class,
          credentialId:manifest.credential_id,
          providerCiphertextSha256:manifest.provider_ciphertext_sha256,
          preparedRouteSourceSha256:sha('prepared-v362-route-dto'),method:'POST',
          upstreamUrlSha256:sha('https://example.invalid/v1/chat/completions'),
          outboundBodySha256:sha(finalBody),
          outboundBodyCanonicalSha256:sha(JSON.stringify(JSON.parse(finalBody))),
          outboundBodyBytes:Buffer.byteLength(finalBody),
          credentialFingerprintSha256:sha('opaque-plaintext-bearer'),
          ...overrides};
      };
      const grant=async(claim,nonce=randomUUID(),client=granter)=>{
        const [row]=await client.unsafe(`SELECT
          ${g}.grant_complete_flat_text_attempt_v362($1::uuid,$2::jsonb) AS value`,
          [nonce,client.json(claim)]);
        return row.value;
      };

      const issueGranted=async()=>{
        const quote=await issueQuote();
        assert.equal((await admit(quote)).status,'admitted');
        const grantClaim=await claimFor(quote);
        const result=await grant(grantClaim);
        assert.equal(result.status,'grant_recorded');
        return {quote,grantClaim,result};
      };
      const custody=async(grantId,runId,client=holder)=>{
        const [row]=await client.unsafe(`SELECT
          ${g}.claim_complete_text_send_custody_v365(
            $1::uuid,$2::uuid) AS value`,[grantId,runId]);
        return row.value;
      };
      const start=async(grantId,runId,epoch,uploadSha,client=holder)=>{
        const [row]=await client.unsafe(`SELECT
          ${g}.record_complete_text_send_start_v365(
            $1::uuid,$2::uuid,$3::bigint,$4) AS value`,
          [grantId,runId,epoch,uploadSha]);
        return row.value;
      };
      const countRows=async(table,grantId)=>{
        assert.ok(['complete_text_send_custody_v365',
          'complete_text_send_starts_v365'].includes(table));
        const [row]=await migrator.unsafe(`SELECT count(*)::integer AS n
          FROM ${g}.${table} WHERE grant_id=$1::uuid`,[grantId]);
        return row.n;
      };
      for(const [name,setting] of [
        ['guardrail-budget-lifecycle-login-v353.sql',
          'guardrail_budget_lifecycle_v353_activation'],
        ['ordinary-budget-recovery-login-v354.sql',
          'ordinary_budget_recovery_v354_activation'],
        ['complete-text-result-facts-v366.sql',
          'complete_text_result_facts_activation'],
        ['complete-text-legacy-reaper-fence-v366.sql',
          'complete_text_legacy_reaper_fence_v366_activation'],
        ['complete-text-all-hold-renewal-v367.sql',
          'complete_text_all_hold_renewal_v367_activation'],
        ['complete-text-renewed-holder-facts-v370.sql',
          'complete_text_renewed_facts_v370_activation']]) {
        const body=await readFile(proposal(name),'utf8');
        report.sourceSha256['packages/core/migrations-proposals/postgres/'+name]=sha(body);
        await migrator.begin(async tx=>{
          await tx.unsafe(`SET LOCAL cinatoken.${setting}='reviewed-v1'`);
          await tx.unsafe(body).simple();
        });
      }
      stage('v353-v354-reapers-v366-facts-v367-renewal-v370-facts-installed');


await install('complete-text-no-fetch-fence-v370.sql','complete_text_no_fetch_fence_v370_activation');
for(const [name,setting] of [
['complete-text-legacy-buyer-held-writer-v368.sql','legacy_buyer_held_writer_v368_activation'],
['buyer-split-counter-grant-policy-v368.sql','buyer_counter_grant_policy_v368_activation'],
['complete-text-legacy-buyer-window-accountant-v371.sql','legacy_buyer_window_accountant_v371_activation'],
['complete-text-legacy-buyer-window-acl-v372.sql','legacy_buyer_window_acl_v372_activation'],
['complete-text-legacy-buyer-admission-fence-v380.sql','complete_text_legacy_buyer_admission_fence_v380_activation'],
['complete-text-platform-close-fence-v386.sql','complete_text_platform_close_fence_v386_activation'],
['complete-text-no-fetch-platform-close-v388.sql','complete_text_no_fetch_close_v388_activation']])await install(name,setting);
stage('real-grant-send-start-and-v388-terminal-authorities-installed');
report.dependencyCatalog=await migrator.begin(async tx=>{
  await tx.unsafe('SET LOCAL search_path TO pg_catalog,pg_temp');
  const tables=['api_keys','users','workspaces','user_audit_logs','user_budget_reservations',
    'guardrail_budget_reservations','guardrail_budget_windows','complete_text_quotes_v360',
    'complete_text_attempt_grants_v362','complete_text_platform_terminals_v388',
    'complete_text_platform_outbox_v388','api_key_request_logs','complete_text_hold_renewals_v367','complete_text_result_facts_v366'];
  const triggers=await tx.unsafe(`SELECT c.relname AS table_name,t.tgname AS trigger_name,
    pg_get_triggerdef(t.oid,true) AS definition,t.tgenabled::text AS enabled
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE NOT t.tgisinternal AND n.nspname='cinatoken_gateway' AND c.relname IN (SELECT jsonb_array_elements_text($1::text::jsonb))
    ORDER BY c.relname COLLATE "C",t.tgname COLLATE "C"`,[JSON.stringify(tables)]);
  const functions=await tx.unsafe(`SELECT p.oid::regprocedure::text AS signature,
    pg_get_userbyid(p.proowner) AS owner,p.prosecdef AS security_definer,p.provolatile::text AS volatility,
    p.prokind::text AS kind,p.proretset AS returns_set,l.lanname AS language,p.proconfig AS config,
    md5(replace(p.prosrc,E'\\r\\n',E'\\n')) AS body_md5,
    (SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable)
      ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END COLLATE "C",a.privilege_type COLLATE "C")
      FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a) AS acl
    FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
    WHERE p.oid IN (SELECT t.tgfoid FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname='cinatoken_gateway'
        AND c.relname IN (SELECT jsonb_array_elements_text($1::text::jsonb)))
      OR p.oid IN ('cinatoken_gateway.grant_complete_flat_text_attempt_v362(uuid,jsonb)'::regprocedure,
        'cinatoken_gateway.close_complete_text_no_fetch_v388(uuid,uuid,uuid)'::regprocedure)
    ORDER BY p.oid::regprocedure::text COLLATE "C"`,[JSON.stringify(tables)]);
  return {tables,triggers,functions};
});
const authSql=await readFile(proposal('personal-key-auth-period-v395.sql'),'utf8');
report.sourceSha256['packages/core/migrations-proposals/postgres/personal-key-auth-period-v395.sql']=sha(authSql);
const installAuth=async tx=>{await tx.unsafe("SET LOCAL cinatoken.personal_key_auth_period_v395_activation='reviewed-v1'");await tx.unsafe(authSql).simple();};
await assert.rejects(migrator.begin(tx=>tx.unsafe(authSql).simple()),/activation or dependency differs/u);
const authorityFaults=[
  `GRANT SELECT(api_key) ON ${g}.providers TO ${roles.auth}`,
  `GRANT EXECUTE ON FUNCTION ${g}.issue_request_capability_v356(text,text,text) TO ${roles.auth}`,
  `ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO ${roles.runtime} WITH GRANT OPTION`,
  `ALTER DEFAULT PRIVILEGES IN SCHEMA ${g} GRANT SELECT ON TABLES TO ${roles.auth}`,
  `GRANT EXECUTE ON FUNCTION ${g}.protect_platform_close_rows_v388() TO ${roles.runtime}`,
  `GRANT EXECUTE ON FUNCTION ${g}.grant_complete_flat_text_attempt_v362(uuid,jsonb) TO ${roles.granter} WITH GRANT OPTION`,
  `CREATE TRIGGER v395_extra_user_trigger AFTER UPDATE ON ${g}.users
    FOR EACH ROW EXECUTE FUNCTION ${g}.invalidate_request_capabilities_v356()`,
  `ALTER TABLE ${g}.users DISABLE TRIGGER invalidate_request_capabilities_user_v356`,
  `ALTER TABLE ${g}.complete_text_platform_terminals_v388 DISABLE TRIGGER platform_terminal_complete_v388`,
  `DROP TRIGGER platform_terminal_grant_v388 ON ${g}.complete_text_attempt_grants_v362;
    CREATE TRIGGER platform_terminal_grant_v388 BEFORE INSERT ON ${g}.complete_text_attempt_grants_v362
      FOR EACH ROW WHEN (false) EXECUTE FUNCTION ${g}.reject_platform_terminal_egress_v388()`,
  `CREATE OR REPLACE FUNCTION ${g}.protect_platform_close_rows_v388() RETURNS trigger LANGUAGE plpgsql
    SECURITY DEFINER SET search_path TO pg_catalog,pg_temp AS $fault$BEGIN RETURN NEW; END;$fault$`,
  `UPDATE ${g}.schema_migrations SET version='unrecognized-v395' WHERE version='0073_recovery_api_key_workspace_lock.sql'`,
];
for(const fault of authorityFaults)await assert.rejects(migrator.begin(async tx=>{
  await tx.unsafe(fault).simple();await installAuth(tx);
}),/differs/u);
await assert.rejects(migrator.begin(async tx=>{await installAuth(tx);throw new Error('v395-install-rollback');}),/v395-install-rollback/u);
assert.equal((await migrator.unsafe("SELECT to_regnamespace('cinatoken_personal_auth') IS NULL AS absent"))[0].absent,true);
stage('default-off-role-column-function-default-grant-trigger-body-and-pg73-drift-refused-before-atomic-install',
  {negativeCases:authorityFaults.length+2});
await migrator.begin(installAuth);
const directUrl=(label,port=cluster.port)=>`postgres://${roles[label]}:${passwords[label]}@127.0.0.1:${port}/postgres?sslmode=disable`;
const auth=connection(cluster,roles.auth,passwords.auth,'auth');clients.push(auth);
const transport=createHyperdriveDedicatedRoleTransportV390({connectionString:directUrl('auth')},roles.auth);
const authenticate=(key=bearer,signal)=>authenticatePostgresPersonalKeyV395({authConnectionString:transport.roleConnectionString,bearer:key,signal},transport.createSql);
const badTransport=createHyperdriveDedicatedRoleTransportV390({connectionString:directUrl('runtime')},roles.auth);
await assert.rejects(authenticatePostgresPersonalKeyV395({authConnectionString:badTransport.roleConnectionString,bearer},badTransport.createSql),TypeError);
const [acl]=await migrator.unsafe(`SELECT
  has_function_privilege('${roles.auth}','${g}.authenticate_personal_gateway_key_v395(text)','EXECUTE') AS wrapper,
  has_function_privilege('${roles.auth}','cinatoken_personal_auth.reset_due_period_v395(text,text,text)','EXECUTE') AS reset,
  has_schema_privilege('${roles.auth}','cinatoken_personal_auth','USAGE') AS private_schema,
  has_table_privilege('${roles.auth}','${g}.api_keys','SELECT,INSERT,UPDATE,DELETE') AS keys,
  has_table_privilege('${roles.auth}','${g}.users','SELECT,INSERT,UPDATE,DELETE') AS users,
  has_table_privilege('${roles.auth}','${g}.providers','SELECT') AS providers,
  has_function_privilege('${roles.auth}','${g}.issue_request_capability_v356(text,text,text)','EXECUTE') AS capability,
  has_function_privilege('${roles.auth}','${g}.close_complete_text_no_fetch_v388(uuid,uuid,uuid)','EXECUTE') AS closer,
  has_function_privilege('${roles.runtime}','${g}.authenticate_personal_gateway_key_v395(text)','EXECUTE') AS runtime_wrapper`);
assert.deepEqual(acl,{wrapper:true,reset:false,private_schema:false,keys:false,users:false,providers:false,capability:false,closer:false,runtime_wrapper:false});
for(const query of [`SELECT * FROM ${g}.api_keys`,`SELECT api_key FROM ${g}.providers`,
  `SELECT cinatoken_personal_auth.next_period_v395(now(),'daily',now())`,
  `SELECT ${g}.issue_request_capability_v356('unauthorized','${bearer}',repeat('a',64))`,
  `SET ROLE ${roles.runtime}`])await denied(auth.unsafe(query));
await denied(runtime.unsafe(`SELECT ${g}.authenticate_personal_gateway_key_v395($1)`,[bearer]));
stage('dedicated-login-has-one-bearer-wrapper-and-real-adapter-origin-role-is-checked',{acl});

// The private period helper is independently checked by the migrator; the auth
// LOGIN cannot inject an anchor or current time into any reset operation.
for(const [anchor,period,now,expected] of [
  ['2024-02-28T23:12:34.567Z','daily','2024-02-29T23:12:34.567Z','2024-03-01T23:12:34.567Z'],
  ['2024-02-29T23:12:34.567Z','weekly','2024-03-07T23:12:34.567Z','2024-03-14T23:12:34.567Z'],
  ['2024-01-31T23:12:34.567Z','monthly','2024-03-01T00:00:00.000Z','2024-03-29T23:12:34.567Z'],
  ['2023-01-31T00:00:00.000Z','monthly','2023-03-28T00:00:00.000Z','2023-04-28T00:00:00.000Z'],
]){
  const [row]=await migrator.unsafe(`SELECT cinatoken_personal_auth.next_period_v395($1::timestamptz,$2,$3::timestamptz) AS next`,[anchor,period,now]);
  assert.equal(new Date(row.next).toISOString(),expected);
}
await denied(migrator.unsafe("SELECT cinatoken_personal_auth.next_period_v395('infinity','daily',now())"),'23514');
stage('private-utc-period-helper-preserves-leap-day-week-and-iterative-month-clamp-boundaries');

const financialSnapshot=async()=>{
  const [user]=await migrator.unsafe(`SELECT budget_max,budget_base,budget_spent,budget_period,budget_reset_at,
    budget_epoch,budget_reserved_micros FROM ${g}.users WHERE id='v361-user'`);
  const holds=await migrator.unsafe(`SELECT to_jsonb(r) AS value FROM ${g}.user_budget_reservations r WHERE user_id='v361-user' ORDER BY request_id`);
  const guardrails=await migrator.unsafe(`SELECT to_jsonb(r) AS value FROM ${g}.guardrail_budget_reservations r WHERE workspace_id='v361-workspace' ORDER BY id`);
  const windows=await migrator.unsafe(`SELECT to_jsonb(w) AS value FROM ${g}.guardrail_budget_windows w WHERE workspace_id='v361-workspace' ORDER BY scope_type,scope_id,period,period_start`);
  const audits=await migrator.unsafe(`SELECT to_jsonb(a) AS value FROM ${g}.user_audit_logs a WHERE user_id='v361-user' ORDER BY id`);
  return JSON.stringify({user,holds,guardrails,windows,audits});
};
const makeDue=async()=>migrator.unsafe(`UPDATE ${g}.users SET budget_base=7,budget_spent=1,budget_max=9,
  budget_period='daily',budget_reset_at=clock_timestamp()-INTERVAL '1 day' WHERE id='v361-user'`);
const deferPeriod=async()=>migrator.unsafe(`UPDATE ${g}.users SET budget_period='none',budget_reset_at=NULL WHERE id='v361-user'`);
const modern=await authenticate();assert.equal(modern.userId,'v361-user');assert.equal(modern.keyId,'v361-key');assert.equal(modern.keyLimitEpoch,0);
assert.equal(modern.budgetEpoch,0);assert.equal(Object.keys(modern).some(k=>/bearer|cipher|provider|secret/u.test(k)),false);
const noPeriodBefore=await financialSnapshot();assert.equal((await authenticate()).budgetEpoch,0);assert.equal(await financialSnapshot(),noPeriodBefore);
stage('modern-bearer-authenticates-personal-whitelist-with-no-period-write');
const legacy='sk-v395-local-owned-legacy-bearer',legacyHash='sha256:'+sha(legacy);
await migrator.unsafe(`INSERT INTO ${g}.api_keys(id,key,user_id,workspace_id,status,metadata)
  VALUES('v395-legacy',$1,'v361-user','v361-workspace','active','{"fromKey":true}')`,[legacy]);
assert.equal((await authenticate(legacy)).keyId,'v395-legacy');
assert.deepEqual((await migrator.unsafe(`SELECT key,key_hash,key_preview FROM ${g}.api_keys WHERE id='v395-legacy'`))[0],
  {key:'hashref:'+legacyHash,key_hash:legacyHash,key_preview:legacy.slice(0,8)+'…'+legacy.slice(-4)});
assert.equal((await authenticate(legacy)).keyId,'v395-legacy');
stage('legacy-plaintext-bearer-migrates-hashref-hash-and-preview-once-in-owned-auth-transaction');

await denied(migrator.unsafe(`SELECT ${g}.authenticate_personal_gateway_key_v395($1)`,[bearer]),'23514');
// Change each source in an owned committed transaction and restore it before
// the next real dedicated LOGIN authentication call.
for(const [set,restore] of [
  [`UPDATE ${g}.api_keys SET status='revoked' WHERE id='v361-key'`,`UPDATE ${g}.api_keys SET status='active' WHERE id='v361-key'`],
  [`UPDATE ${g}.api_keys SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id='v361-key'`,`UPDATE ${g}.api_keys SET expires_at=NULL WHERE id='v361-key'`],
  [`UPDATE ${g}.users SET status='disabled' WHERE id='v361-user'`,`UPDATE ${g}.users SET status='active' WHERE id='v361-user'`],
  [`UPDATE ${g}.workspaces SET status='archived' WHERE id='v361-workspace'`,`UPDATE ${g}.workspaces SET status='active' WHERE id='v361-workspace'`],
]){await migrator.unsafe(set);assert.equal(await authenticate(),null);await migrator.unsafe(restore);}
assert.equal(await authenticate('sk-cina-mgmt-v395-owned-management-bearer'),null);
assert.equal(await authenticate('sk-v395-unknown-owned-bearer'),null);
stage('revoked-expired-disabled-user-workspace-management-and-unknown-bearers-cannot-authorize');

await makeDue();const beforeReset=JSON.parse(await financialSnapshot());
const reset=await authenticate();assert.equal(reset.budgetMax,7);assert.equal(reset.budgetSpent,0);assert.equal(reset.budgetEpoch,1);
assert.ok(Date.parse(reset.budgetResetAt)>Date.now());
const [audit]=await migrator.unsafe(`SELECT api_key_id,event_type,actor_type,before_user_snapshot,after_user_snapshot,
  changed_fields,source,reason_code FROM ${g}.user_audit_logs WHERE user_id='v361-user' AND event_type='period_reset'`);
assert.equal(audit.api_key_id,'v361-key');assert.equal(audit.actor_type,'system');assert.equal(audit.reason_code,'api_key_auth_lazy_reset');
assert.equal(JSON.parse(audit.before_user_snapshot).budget_spent,1);assert.equal(JSON.parse(audit.after_user_snapshot).budget_epoch,1);
assert.deepEqual(JSON.parse(audit.changed_fields),['budget_max','budget_spent','budget_reset_at','budget_epoch']);
const resetSnapshot=await financialSnapshot();assert.equal((await authenticate()).budgetEpoch,1);assert.equal(await financialSnapshot(),resetSnapshot);
stage('due-unencumbered-period-atomically-restores-base-clears-spent-increments-epoch-and-appends-one-audit');

await makeDue();const rollbackBefore=await financialSnapshot();
await migrator.unsafe(`CREATE FUNCTION ${g}.reject_v395_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $fault$
  BEGIN RAISE EXCEPTION 'owned v395 audit fault' USING ERRCODE='23514'; END;$fault$;
  CREATE TRIGGER v395_audit_fault BEFORE INSERT ON ${g}.user_audit_logs FOR EACH ROW EXECUTE FUNCTION ${g}.reject_v395_audit_fault()` ).simple();
await denied(authenticate(),'23514');assert.equal(await financialSnapshot(),rollbackBefore);
await migrator.unsafe(`DROP TRIGGER v395_audit_fault ON ${g}.user_audit_logs;DROP FUNCTION ${g}.reject_v395_audit_fault()` ).simple();
await authenticate();await deferPeriod();
stage('failed-audit-insert-rolls-back-reset-financial-state-and-epoch');

const heldQuote=await issueQuote();assert.equal((await admit(heldQuote)).status,'admitted');
await migrator.unsafe(`UPDATE ${g}.users SET budget_period='daily',budget_reset_at=clock_timestamp()-INTERVAL '1 day' WHERE id='v361-user'`);
const reservedBefore=await financialSnapshot();
await assert.rejects(authenticate(),PostgresPersonalPeriodPendingV395);assert.equal(await financialSnapshot(),reservedBefore);
stage('admitted-not-granted-ordinary-and-guardrail-reservations-block-reset-without-clearing-reserved');
await deferPeriod();const heldClaim=await claimFor(heldQuote);const heldResult=await grant(heldClaim);assert.equal(heldResult.status,'grant_recorded');
const held={quote:heldQuote,grantClaim:heldClaim,result:heldResult};
await migrator.unsafe(`UPDATE ${g}.users SET budget_period='daily',budget_reset_at=clock_timestamp()-INTERVAL '1 day' WHERE id='v361-user'`);
const heldBefore=await financialSnapshot();
await assert.rejects(authenticate(),PostgresPersonalPeriodPendingV395);assert.equal(await financialSnapshot(),heldBefore);
stage('due-live-dispatched-ordinary-and-all-guardrail-holds-deny-auth-with-every-amount-preserved');
await cluster.admin.begin(async tx=>{await tx.unsafe("SET LOCAL session_replication_role='replica'");
  await tx.unsafe(`UPDATE ${g}.complete_text_attempt_grants_v362 SET send_expires_at=LEAST(send_expires_at,clock_timestamp()+INTERVAL '1 second') WHERE grant_id=$1::uuid`,[held.result.grantId]);});
await new Promise(resolve=>setTimeout(resolve,1200));
const [resolution]=await resolver.unsafe(`SELECT ${g}.resolve_complete_text_no_fetch_v370($1::uuid,$2::uuid) AS value`,[held.result.grantId,randomUUID()]);
assert.equal(resolution.value.status,'verified_no_fetch_recorded');
await closer.unsafe("SET TIME ZONE 'Asia/Singapore'");
const [closed]=await closer.unsafe(`SELECT ${g}.close_complete_text_no_fetch_v388($1::uuid,$2::uuid,$3::uuid) AS value`,
  [held.result.grantId,resolution.value.resolutionId,randomUUID()]);assert.equal(closed.value.status,'closed_no_fetch');
const [eventBackup]=await migrator.unsafe(`SELECT to_jsonb(e) AS value FROM ${g}.complete_text_platform_outbox_v388 e WHERE request_id=$1`,[held.quote.requestId]);
await cluster.admin.begin(async tx=>{await tx.unsafe("SET LOCAL session_replication_role='replica'");
  await tx.unsafe(`DELETE FROM ${g}.complete_text_platform_outbox_v388 WHERE request_id=$1`,[held.quote.requestId]);});
const incompleteBefore=await financialSnapshot();await assert.rejects(authenticate(),PostgresPersonalPeriodPendingV395);
assert.equal(await financialSnapshot(),incompleteBefore);
await cluster.admin.begin(async tx=>{await tx.unsafe("SET LOCAL session_replication_role='replica'");
  await tx.unsafe(`INSERT INTO ${g}.complete_text_platform_outbox_v388 SELECT (jsonb_populate_record(NULL::${g}.complete_text_platform_outbox_v388,$1::text::jsonb)).*`,[JSON.stringify(eventBackup.value)]);});
stage('zero-remaining-counter-with-missing-terminal-event-remains-pending-and-financial-state-is-preserved');
const beforeTerminalReset=(await migrator.unsafe(`SELECT budget_epoch FROM ${g}.users WHERE id='v361-user'`))[0].budget_epoch;
assert.equal((await authenticate()).budgetEpoch,Number(beforeTerminalReset)+1);
stage('real-no-fetch-terminal-written-in-singapore-time-releases-obligations-for-utc-auth-reset');

// Remove all fixture limit policies to exercise an actual admitted unlimited
// request with no financial holds, rather than deleting or clearing a hold.
await deferPeriod();await migrator.unsafe(`UPDATE ${g}.users SET budget_max=NULL,budget_base=7 WHERE id='v361-user';
  UPDATE ${g}.api_keys SET limit_micros=NULL WHERE id='v361-key';
  DELETE FROM ${g}.workspace_budgets WHERE id='v361-budget';
  UPDATE ${g}.guardrails SET status='archived' WHERE id='v361-guardrail'`).simple();
const admittedOnly=await issueQuote();assert.equal((await admit(admittedOnly,[])).status,'admitted');
const staleClaim=await claimFor(admittedOnly);await makeDue();await authenticate();
assert.equal((await grant(staleClaim)).status,'stale');
assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM ${g}.complete_text_attempt_grants_v362 WHERE request_id=$1`,[admittedOnly.requestId]))[0].n,0);
stage('admitted-unlimited-no-hold-request-cannot-grant-after-authorized-epoch-advance');

await deferPeriod();await migrator.unsafe(`UPDATE ${g}.users SET budget_max=NULL WHERE id='v361-user'`);
const zeroQuote=await issueQuote();assert.equal((await admit(zeroQuote,[])).status,'admitted');
const zeroClaim=await claimFor(zeroQuote);const zeroGrant=await grant(zeroClaim);assert.equal(zeroGrant.status,'grant_recorded');
const run=randomUUID();const ownedCustody=await custody(zeroGrant.grantId,run);assert.equal(ownedCustody.status,'custody_claim_recorded');
const started=await start(zeroGrant.grantId,run,ownedCustody.leaseEpoch,zeroClaim.outboundBodySha256);assert.equal(started.status,'start_recorded');
assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM ${g}.user_budget_reservations WHERE request_id=$1`,[zeroQuote.requestId]))[0].n,0);
await makeDue();const zeroBefore=await financialSnapshot();await assert.rejects(authenticate(),PostgresPersonalPeriodPendingV395);
assert.equal(await financialSnapshot(),zeroBefore);
stage('started-zero-hold-c04-grant-still-blocks-period-reset-and-authentication');

// ACK-loss maintenance uses a separate unencumbered real personal identity,
// because the sent zero-hold obligation above intentionally remains unknown.
const ackBearer='sk-v395-real-physical-commit-loss-bearer',ackHash='sha256:'+sha(ackBearer);
await migrator.unsafe(`INSERT INTO ${g}.users(id,email,budget_max,budget_base,budget_spent,budget_period,budget_reset_at)
  VALUES('v395-ack-user','ack@example.invalid',9,7,1,'daily',clock_timestamp()-INTERVAL '1 day');
  INSERT INTO ${g}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
  VALUES('v395-ack-workspace','personal','v395-ack-user','ACK','v395-ack','active')`).simple();
await migrator.unsafe(`INSERT INTO ${g}.api_keys(id,key,user_id,workspace_id,status)
  VALUES('v395-ack-key',$1,'v395-ack-user','v395-ack-workspace','active')`,[ackBearer]);
await migrator.unsafe(`CREATE FUNCTION ${g}.reject_v395_key_migration_fault() RETURNS trigger LANGUAGE plpgsql AS $fault$
  BEGIN RAISE EXCEPTION 'owned v395 key migration fault' USING ERRCODE='23514'; END;$fault$;
  CREATE TRIGGER v395_key_migration_fault BEFORE UPDATE OF key ON ${g}.api_keys
    FOR EACH ROW WHEN (OLD.id='v395-ack-key') EXECUTE FUNCTION ${g}.reject_v395_key_migration_fault()`).simple();
await denied(authenticate(ackBearer),'23514');
const [legacyRollback]=await migrator.unsafe(`SELECT u.budget_epoch,u.budget_spent,k.key,k.key_hash,
  (SELECT count(*)::int FROM ${g}.user_audit_logs WHERE user_id=u.id) AS audits
  FROM ${g}.users u JOIN ${g}.api_keys k ON k.user_id=u.id WHERE k.id='v395-ack-key'`);
assert.equal(Number(legacyRollback.budget_epoch),0);assert.equal(Number(legacyRollback.budget_spent),1);
assert.equal(legacyRollback.key,ackBearer);assert.equal(legacyRollback.key_hash,null);assert.equal(legacyRollback.audits,0);
await migrator.unsafe(`DROP TRIGGER v395_key_migration_fault ON ${g}.api_keys;DROP FUNCTION ${g}.reject_v395_key_migration_fault()`).simple();
stage('legacy-migration-write-failure-rolls-back-earlier-reset-and-audit-in-same-transaction');
const ackProxy=await startJournalCommitAckDropProxyV381({upstreamPort:cluster.port});
try{
  const ackTransport=createHyperdriveDedicatedRoleTransportV390({connectionString:directUrl('auth',ackProxy.port)},roles.auth);
  await assert.rejects(authenticatePostgresPersonalKeyV395({authConnectionString:ackTransport.roleConnectionString,bearer:ackBearer},ackTransport.createSql));
  await ackProxy.waitForDrop();
  assert.equal(ackProxy.facts.backendCommitCompletes,1);assert.equal(ackProxy.facts.droppedCommitAcks,1);
  const [persisted]=await migrator.unsafe(`SELECT u.budget_epoch,u.budget_spent,u.budget_max,k.key,k.key_hash,
    (SELECT count(*)::int FROM ${g}.user_audit_logs WHERE user_id=u.id) AS audits
    FROM ${g}.users u JOIN ${g}.api_keys k ON k.user_id=u.id WHERE k.id='v395-ack-key'`);
  assert.equal(Number(persisted.budget_epoch),1);assert.equal(Number(persisted.budget_spent),0);
  assert.equal(Number(persisted.budget_max),7);assert.equal(persisted.key,'hashref:'+ackHash);assert.equal(persisted.key_hash,ackHash);assert.equal(persisted.audits,1);
  const quotesBefore=(await migrator.unsafe(`SELECT count(*)::int AS n FROM ${g}.complete_text_quotes_v360`))[0].n;
  assert.equal((await authenticate(ackBearer)).budgetEpoch,1);
  assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM ${g}.user_audit_logs WHERE user_id='v395-ack-user'`))[0].n,1);
  assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM ${g}.complete_text_quotes_v360`))[0].n,quotesBefore);
  stage('real-backend-commit-response-loss-persists-legacy-migration-and-one-reset-then-fresh-auth-reconciles-without-quote-or-post',
    {proxy:{...ackProxy.facts}});
}finally{await ackProxy.close();}

for(const relative of [
  'scripts/db/cutover/postgres-personal-key-auth-period-v395.native.test.mjs',
  'packages/proxy/src/services/postgres-personal-key-auth-v395.ts',
  'packages/proxy/src/services/postgres-personal-key-auth-v395.test.mjs',
  'packages/proxy/src/services/hyperdrive-dedicated-role-transport-v390.ts',
  'packages/core/src/lib/resolve-me-metadata.ts','packages/core/src/lib/key-hash.ts',
  'packages/core/src/services/user-service.ts','packages/core/src/db/user-audit-snapshot.ts',
  'packages/core/src/test-support/postgres-native-cluster.mjs',
  'packages/core/src/test-support/postgres-journal-commit-ack-proxy-v381.mjs',
  'scripts/db/cutover/grant-postgres-runtime.ts','scripts/db/cutover/activate-postgres-buyer-split-v348.ts',
  'scripts/db/cutover/grant-postgres-buyer-split-v348.ts','scripts/db/cutover/activate-postgres-buyer-guardrail-split-v349.ts',
  'scripts/db/cutover/grant-postgres-buyer-guardrail-split-v349.ts']){
  report.sourceSha256[relative]=sha(await readFile(new URL('../../../'+relative,import.meta.url)));
}
assert.equal(report.sourceSha256['scripts/db/cutover/postgres-personal-key-auth-period-v395.native.test.mjs'],loadedFixtureSha256,'fixture changed during execution');
report.status='PASS';
} catch(error){failure=error;report.status='FAIL';report.failedAfterStage=report.stages.at(-1)?.name??null;
report.failure={message:String(error?.stack??error).slice(0,5000),code:error?.code??error?.cause?.code??null};
} finally{
await Promise.allSettled(clients.map(c=>c.end({timeout:1})));
try{await cluster.cleanup();report.cleanup='PASS';}catch(error){report.cleanup='FAIL';report.cleanupError=String(error).slice(0,1500);failure??=error;}
await writeFile(reportUrl,JSON.stringify(report,null,2)+'\n');
process.stdout.write('personal-key-auth-period-v395-report='+reportUrl.pathname+'\n');
}
if(failure)throw failure;assert.equal(report.cleanup,'PASS');
});
