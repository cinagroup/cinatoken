// Owned PostgreSQL 18.6 proof for the review-only platform close fence seam.
import assert from 'node:assert/strict';
import { closePostgresCompleteTextNoFetchV388 } from '../../../packages/proxy/src/services/postgres-complete-text-no-fetch-close-v388.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { commitAckProxy } from '../../../packages/core/src/test-support/postgres-commit-ack-proxy.mjs';
import { confirmPostgresCompleteTextNoFetchV370 } from
  '../../../packages/proxy/src/services/postgres-complete-text-no-fetch-v372.ts';
import { computeRouteDataPolicySubjectFingerprintFromRows } from '../../../packages/core/src/route-data-policy.ts';
import { grantPostgresCompleteTextAttemptV362 } from '../../../packages/proxy/src/services/postgres-complete-text-attempt-grant-v362.ts';
import { claimPostgresCompleteTextCustodyV365,
  recordPostgresCompleteTextSendStartV365,
  PostgresCompleteTextSendStartRejectedError,
} from '../../../packages/proxy/src/services/postgres-complete-text-send-start-v365.ts';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';
import { activatePostgresBuyerSplitV348 } from './activate-postgres-buyer-split-v348.ts';
import { grantPostgresBuyerSplitV348 } from './grant-postgres-buyer-split-v348.ts';
import { activatePostgresBuyerGuardrailSplitV349 } from './activate-postgres-buyer-guardrail-split-v349.ts';
import { grantPostgresBuyerGuardrailSplitV349 } from './grant-postgres-buyer-guardrail-split-v349.ts';

const g='cinatoken_gateway';
const migrationDir=new URL('../../../packages/core/migrations-postgres/',import.meta.url);
const proposal=name=>new URL(`../../../packages/core/migrations-proposals/postgres/${name}`,import.meta.url);
const reportUrl=new URL('../../../docs/developers/architecture/implementation-evidence/C04-complete-text-no-fetch-platform-close-v388-report.json',import.meta.url);
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
  recovery:'cinatoken_gateway_budget_recovery'};

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

test('v388 no-fetch platform closer atomically frees holds and commits zero buyer terminal',
  {timeout:300_000,skip:!process.env.GATEWAY_NATIVE_PG_BIN},async()=>{
    const loadedFixtureSha256=sha(await readFile(new URL(import.meta.url)));
    const cluster=await startNativePostgres();
    const report={status:'RUNNING',cleanup:'PENDING',binaryVersion:cluster.binaryVersion,
      sourceSha256:{},stages:[],limitations:[
      'Review-only local PG73 and proposals; no formal migration, deployed Worker, remote database, production credential or Provider changed.',
      'v388 closes only database-verified no-fetch attempts; supplier cost is not asserted. No actual, sent-zero, unknown forfeiture or late-bill adjustment authority is implemented.',
      'The fixture shortens send deadlines with owned cluster-superuser fault injection; runtime principals do not have this power.',
      'Platform typed events are durably inserted but delivery/consumer deployment and fleet drain remain unverified.',
      'Each transaction closes one request. Shared-account legacy requests are fixture-seeded and settled by the real direct LOGIN v371 SQL writer, not by the full Proxy application.',
      'D1/MySQL parity, Linux CI outcome and real Worker/Hyperdrive behavior are not established by this local run.'
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
      const bill=connection(cluster,roles.bill,passwords.bill,'bill');
      const cap=connection(cluster,roles.cap,passwords.cap,'cap');
      const verifier=connection(cluster,roles.verifier,passwords.verifier,'verifier');
      const complete=connection(cluster,roles.complete,passwords.complete,'complete');
      clients.push(migrator,runtime,admission,recovery,buyer,renewer,
        granter,granterPeer,holder,holderPeer,
        cap,verifier,complete,resolver,resolverPeer,bill,closer,closerPeer);
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
        report.sourceSha256[name]=sha(body);
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

      for(const [name,setting] of later) {
        const body=await readFile(proposal(name),'utf8');
        report.sourceSha256[name]=sha(body);
        await migrator.begin(async tx=>{
          await tx.unsafe(`SET LOCAL cinatoken.${setting}='reviewed-v1'`);
          await tx.unsafe(body).simple();
        });
      }
      const sql=await readFile(proposal('complete-text-quote-budget-admission-v361.sql'),'utf8');
      report.sourceSha256['complete-text-quote-budget-admission-v361.sql']=sha(sql);
      report.sourceSha256.fixture=sha(await readFile(new URL(import.meta.url)));
      await assert.rejects(migrator.begin(tx=>tx.unsafe(sql).simple()),
        /activation or dependency differs/u);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`GRANT SELECT ON ${g}.complete_text_quotes_v360
          TO ${roles.admission}`);
        await tx.unsafe(`SET LOCAL cinatoken.complete_text_budget_admission_activation='reviewed-v1'`);
        await tx.unsafe(sql).simple();
      }),/activation or dependency differs/u);
      await migrator.begin(async tx=>{
        await tx.unsafe(`SET LOCAL cinatoken.complete_text_budget_admission_activation='reviewed-v1'`);
        await tx.unsafe(sql).simple();
      });
      stage('v361-default-off-and-role-drift-fail-before-atomic-install');

      const grantSql=await readFile(proposal('complete-text-attempt-grant-v362.sql'),'utf8');
      report.sourceSha256['complete-text-attempt-grant-v362.sql']=sha(grantSql);
      await assert.rejects(migrator.begin(tx=>tx.unsafe(grantSql).simple()),
        /activation or dependency differs/u);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`GRANT SELECT ON ${g}.complete_text_quotes_v360
          TO ${roles.granter}`);
        await tx.unsafe(`SET LOCAL cinatoken.complete_text_attempt_grant_activation='reviewed-v1'`);
        await tx.unsafe(grantSql).simple();
      }),/activation or dependency differs/u);
      await migrator.begin(async tx=>{
        await tx.unsafe(`SET LOCAL cinatoken.complete_text_attempt_grant_activation='reviewed-v1'`);
        await tx.unsafe(grantSql).simple();
      });
      stage('v362-default-off-and-role-drift-fail-before-atomic-install');

      const startSql=await readFile(proposal('complete-text-send-start-v365.sql'),'utf8');
      report.sourceSha256['complete-text-send-start-v365.sql']=sha(startSql);
      await assert.rejects(migrator.begin(tx=>tx.unsafe(startSql).simple()),
        /activation or dependency differs/u);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`GRANT SELECT ON ${g}.complete_text_attempt_grants_v362
          TO ${roles.holder}`);
        await tx.unsafe(`SET LOCAL cinatoken.complete_text_send_start_activation='reviewed-v1'`);
        await tx.unsafe(startSql).simple();
      }),/activation or dependency differs/u);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`GRANT USAGE ON SCHEMA cinatoken_economic_outbox
          TO ${roles.holder}`);
        await tx.unsafe(`SET LOCAL cinatoken.complete_text_send_start_activation='reviewed-v1'`);
        await tx.unsafe(startSql).simple();
      }),/activation or dependency differs/u);
      await migrator.begin(async tx=>{
        await tx.unsafe(`SET LOCAL cinatoken.complete_text_send_start_activation='reviewed-v1'`);
        await tx.unsafe(startSql).simple();
      });
      stage('v365-default-off-and-holder-role-drift-fail-before-atomic-install');

      await denied(runtime.unsafe(`SELECT ${g}.record_complete_text_send_start_v365(
        pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid(),1,
        repeat('a',64))`));
      await denied(admission.unsafe(`SELECT ${g}.record_complete_text_send_start_v365(
        pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid(),1,
        repeat('a',64))`));
      await denied(granter.unsafe(`SELECT ${g}.record_complete_text_send_start_v365(
        pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid(),1,
        repeat('a',64))`));
      await denied(runtime.unsafe(`SELECT ${g}.claim_complete_text_send_custody_v365(
        pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid())`));
      await denied(holder.unsafe(`SELECT * FROM ${g}.complete_text_send_starts_v365`));
      await denied(holder.unsafe(`SELECT * FROM ${g}.complete_text_send_custody_v365`));
      await denied(holder.unsafe(`SELECT * FROM ${g}.complete_text_attempt_grants_v362`));
      await denied(holder.unsafe(`SELECT ${g}.grant_complete_flat_text_attempt_v362(
        pg_catalog.gen_random_uuid(),'{}'::jsonb)`));
      const [holderAcl]=await migrator.unsafe(`SELECT
        pg_catalog.has_function_privilege('${roles.holder}',
          '${g}.record_complete_text_send_start_v365(uuid,uuid,bigint,text)','EXECUTE') AS start_call,
        pg_catalog.has_function_privilege('${roles.holder}',
          '${g}.claim_complete_text_send_custody_v365(uuid,uuid)','EXECUTE') AS custody_call,
        pg_catalog.has_function_privilege('${roles.holder}',
          '${g}.grant_complete_flat_text_attempt_v362(uuid,jsonb)','EXECUTE') AS grant_call,
        pg_catalog.has_table_privilege('${roles.holder}',
          '${g}.complete_text_send_starts_v365','SELECT,INSERT,UPDATE,DELETE') AS raw_start,
        pg_catalog.has_table_privilege('${roles.holder}',
          '${g}.complete_text_send_custody_v365','SELECT,INSERT,UPDATE,DELETE') AS raw_custody,
        (SELECT NOT rolinherit FROM pg_catalog.pg_roles
          WHERE rolname='${roles.holder}') AS noinherit,
        (SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_auth_members m
          JOIN pg_catalog.pg_roles r ON r.oid=m.member
          WHERE r.rolname='${roles.holder}') AS memberships`);
      assert.deepEqual(holderAcl,{start_call:true,custody_call:true,grant_call:false,
        raw_start:false,raw_custody:false,noinherit:true,memberships:0});
      stage('distinct-direct-holder-login-has-only-two-wrappers-and-no-raw-access',
        {holderAcl});

      await denied(runtime.unsafe(`SELECT ${g}.grant_complete_flat_text_attempt_v362(
        pg_catalog.gen_random_uuid(),'{}'::jsonb)`));
      await denied(admission.unsafe(`SELECT ${g}.grant_complete_flat_text_attempt_v362(
        pg_catalog.gen_random_uuid(),'{}'::jsonb)`));
      await denied(granter.unsafe(`SELECT * FROM ${g}.complete_text_attempt_grants_v362`));
      await denied(admission.unsafe(`SELECT ${g}.mark_user_budget_dispatched_v350(
        'x',now(),now()+interval '1 minute')`));
      await denied(admission.unsafe(`SELECT ${g}.mark_guardrail_budgets_dispatched_v351(
        'x',now(),now()+interval '1 minute')`));
      const [grantAcl]=await migrator.unsafe(`SELECT
        pg_catalog.has_function_privilege('${roles.granter}',
          '${g}.grant_complete_flat_text_attempt_v362(uuid,jsonb)','EXECUTE') AS grant_call,
        pg_catalog.has_table_privilege('${roles.granter}',
          '${g}.complete_text_attempt_grants_v362','SELECT,INSERT,UPDATE,DELETE') AS raw_table,
        pg_catalog.has_function_privilege('${roles.admission}',
          '${g}.mark_user_budget_dispatched_v350(text,timestamptz,timestamptz)','EXECUTE') AS raw_ordinary_mark,
        pg_catalog.has_function_privilege('${roles.admission}',
          '${g}.mark_guardrail_budgets_dispatched_v351(text,timestamptz,timestamptz)','EXECUTE') AS raw_guardrail_mark`);
      assert.deepEqual(grantAcl,{grant_call:true,raw_table:false,
        raw_ordinary_mark:false,raw_guardrail_mark:false});
      stage('isolated-granter-only-and-old-dispatch-mark-side-door-closed',{grantAcl});

      await denied(admission.unsafe(`SELECT ${g}.reserve_user_budget_v350(
        'one-micro','u','k',0,1,now(),now()+interval '1 minute')`));
      await denied(admission.unsafe(`SELECT ${g}.reserve_guardrail_budgets_v351(
        'one-micro','u','k','[]'::jsonb,1,'charged',now(),now()+interval '1 minute')`));
      await denied(runtime.unsafe(`SELECT ${g}.admit_complete_flat_text_quote_v361(
        'x',pg_catalog.gen_random_uuid(),'[]'::jsonb)`));
      await denied(admission.unsafe(`SELECT * FROM ${g}.complete_text_admissions_v361`));
      const [acl]=await migrator.unsafe(`SELECT
        pg_catalog.has_function_privilege('${roles.admission}',
          '${g}.admit_complete_flat_text_quote_v361(text,uuid,jsonb)','EXECUTE') AS wrapper,
        pg_catalog.has_function_privilege('${roles.admission}',
          '${g}.reserve_user_budget_v350(text,text,text,bigint,bigint,timestamptz,timestamptz)','EXECUTE') AS raw_ordinary,
        pg_catalog.has_function_privilege('${roles.admission}',
          '${g}.reserve_guardrail_budgets_v351(text,text,text,jsonb,bigint,text,timestamptz,timestamptz)','EXECUTE') AS raw_guardrail`);
      assert.deepEqual(acl,{wrapper:true,raw_ordinary:false,raw_guardrail:false});
      stage('direct-admission-login-can-call-only-no-amount-reserve-wrapper',{acl});

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
        report.sourceSha256[name]=sha(body);
        await migrator.begin(async tx=>{
          await tx.unsafe(`SET LOCAL cinatoken.${setting}='reviewed-v1'`);
          await tx.unsafe(body).simple();
        });
      }
      stage('v353-v354-reapers-v366-facts-v367-renewal-v370-facts-installed');

      const noFetchSql=await readFile(proposal(
        'complete-text-no-fetch-fence-v370.sql'),'utf8');
      report.sourceSha256['complete-text-no-fetch-fence-v370.sql']=sha(noFetchSql);
      report.sourceSha256['postgres-complete-text-no-fetch-v372.ts']=sha(
        await readFile(new URL('../../../packages/proxy/src/services/postgres-complete-text-no-fetch-v372.ts',import.meta.url)));
      report.sourceSha256.fixture=sha(await readFile(new URL(import.meta.url)));
      const installFence=async()=>migrator.begin(async tx=>{
        await tx.unsafe(`SET LOCAL
          cinatoken.complete_text_no_fetch_fence_v370_activation='reviewed-v1'`);
        await tx.unsafe(noFetchSql).simple();
      });
      await assert.rejects(migrator.begin(tx=>tx.unsafe(noFetchSql).simple()),
        /activation or dependency differs/u);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`GRANT SELECT ON ${g}.complete_text_send_starts_v365
          TO ${roles.resolver}`);
        await tx.unsafe(`SET LOCAL
          cinatoken.complete_text_no_fetch_fence_v370_activation='reviewed-v1'`);
        await tx.unsafe(noFetchSql).simple();
      }),/activation or dependency differs/u);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`SET LOCAL
          cinatoken.complete_text_no_fetch_fence_v370_activation='reviewed-v1'`);
        await tx.unsafe(noFetchSql).simple();
        throw new Error('rollback-v370-install');
      }),/rollback-v370-install/u);
      const [beforeInstall]=await migrator.unsafe(`SELECT
        pg_catalog.to_regclass(
          '${g}.complete_text_no_fetch_resolutions_v370') IS NULL AS no_table,
        (SELECT count(*)::integer FROM pg_catalog.pg_trigger
          WHERE tgname LIKE '%v370_no_fetch_fence') AS no_triggers`);
      assert.deepEqual(beforeInstall,{no_table:true,no_triggers:0});
      await installFence();
      const [installed]=await migrator.unsafe(`SELECT
        (SELECT count(*)::integer FROM pg_catalog.pg_trigger t
          WHERE NOT t.tgisinternal AND t.tgenabled='O'
            AND t.tgfoid='${g}.reject_complete_text_fenced_send_v370()'
              ::pg_catalog.regprocedure) AS active_insert_triggers,
        (SELECT count(*)::integer FROM pg_catalog.pg_trigger t
          WHERE NOT t.tgisinternal AND t.tgenabled='O'
            AND t.tgrelid='${g}.complete_text_no_fetch_resolutions_v370'
              ::pg_catalog.regclass) AS immutable_triggers`);
      assert.deepEqual(installed,{active_insert_triggers:2,immutable_triggers:2});
      stage('v370-default-off-role-drift-rollback-and-atomic-two-table-fence');

      const [fenceAcl]=await migrator.unsafe(`SELECT
        pg_catalog.has_function_privilege('${roles.resolver}',
          '${g}.resolve_complete_text_no_fetch_v370(uuid,uuid)',
          'EXECUTE') AS resolver_call,
        pg_catalog.has_function_privilege('${roles.holder}',
          '${g}.resolve_complete_text_no_fetch_v370(uuid,uuid)',
          'EXECUTE') AS holder_call,
        pg_catalog.has_function_privilege('${roles.runtime}',
          '${g}.resolve_complete_text_no_fetch_v370(uuid,uuid)',
          'EXECUTE') AS runtime_call,
        pg_catalog.has_function_privilege('${roles.bill}',
          '${g}.resolve_complete_text_no_fetch_v370(uuid,uuid)',
          'EXECUTE') AS bill_call,
        pg_catalog.has_function_privilege('${roles.resolver}',
          '${g}.record_complete_text_send_start_v365(uuid,uuid,bigint,text)',
          'EXECUTE') AS resolver_start,
        pg_catalog.has_function_privilege('${roles.resolver}',
          '${g}.renew_complete_text_holds_v367(uuid,uuid,uuid,bigint)',
          'EXECUTE') AS resolver_renew,
        pg_catalog.has_table_privilege('${roles.resolver}',
          '${g}.complete_text_no_fetch_resolutions_v370',
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS resolver_raw,
        (SELECT NOT rolinherit FROM pg_catalog.pg_roles
          WHERE rolname='${roles.resolver}') AS noinherit,
        (SELECT count(*)::integer FROM pg_catalog.pg_auth_members m
          JOIN pg_catalog.pg_roles r ON r.oid=m.member
          WHERE r.rolname='${roles.resolver}') AS memberships`);
      assert.deepEqual(fenceAcl,{resolver_call:true,holder_call:false,
        runtime_call:false,bill_call:false,resolver_start:false,
        resolver_renew:false,resolver_raw:false,noinherit:true,memberships:0});
      await denied(holder.unsafe(`SELECT
        ${g}.resolve_complete_text_no_fetch_v370(
          pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid())`));
      await denied(runtime.unsafe(`SELECT
        ${g}.resolve_complete_text_no_fetch_v370(
          pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid())`));
      await denied(bill.unsafe(`SELECT
        ${g}.resolve_complete_text_no_fetch_v370(
          pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid())`));
      await denied(resolver.unsafe(`SELECT *
        FROM ${g}.complete_text_no_fetch_resolutions_v370`));
      await denied(resolver.unsafe(`SELECT
        ${g}.record_complete_text_send_start_v365(
          pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid(),
          1,repeat('a',64))`));
      await denied(resolver.unsafe(`SET ROLE ${roles.holder}`));
      stage('direct-resolver-login-has-only-wrapper-and-no-raw-or-other-role-access',
        {fenceAcl});

      const resolveNoFetch=async(grantId,nonce,client=resolver)=>{
        const [row]=await client.unsafe(`SELECT
          ${g}.resolve_complete_text_no_fetch_v370(
            $1::uuid,$2::uuid) AS value`,[grantId,nonce]);
        return row.value;
      };
      const shorten=async(grantId,seconds=4)=>cluster.admin.begin(async tx=>{
        await tx.unsafe(`SET LOCAL session_replication_role='replica'`);
        await tx.unsafe(`UPDATE ${g}.complete_text_attempt_grants_v362
          SET send_expires_at=LEAST(send_expires_at,
            pg_catalog.clock_timestamp()+$2::integer*INTERVAL '1 second')
          WHERE grant_id=$1::uuid`,[grantId,seconds]);
      });
      const waitPastDeadline=async grantId=>{
        for(let attempt=0;attempt<20;attempt++){
          const [row]=await migrator.unsafe(`SELECT
            send_expires_at<pg_catalog.clock_timestamp() AS past,
            GREATEST(0,CEIL(EXTRACT(EPOCH FROM
              (send_expires_at-pg_catalog.clock_timestamp()))*1000))::integer
              AS milliseconds FROM ${g}.complete_text_attempt_grants_v362
            WHERE grant_id=$1::uuid`,[grantId]);
          if(row?.past)return;
          await new Promise(done=>setTimeout(done,
            Math.max(100,Math.min(1000,Number(row.milliseconds)+100))));
        }
        throw new Error('grant deadline did not pass');
      };
      const holdSnapshot=async requestId=>{
        const ordinary=await migrator.unsafe(`SELECT state,reserved_micros,
          settled_micros,expires_at FROM ${g}.user_budget_reservations
          WHERE request_id=$1`,[requestId]);
        const guardrails=await migrator.unsafe(`SELECT assignment_id,state,
          reserved_micros,settled_micros,expires_at
          FROM ${g}.guardrail_budget_reservations
          WHERE request_id=$1 ORDER BY assignment_id`,[requestId]);
        return JSON.stringify({ordinary,guardrails});
      };
      const counterSnapshot=async()=>{
        const [account]=await migrator.unsafe(`SELECT budget_epoch,
          budget_reserved_micros,budget_spent FROM ${g}.users
          WHERE id='v361-user'`);
        const windows=await migrator.unsafe(`SELECT scope_type,scope_id,period,
          period_start,reserved_micros,settled_micros
          FROM ${g}.guardrail_budget_windows
          WHERE workspace_id='v361-workspace'
          ORDER BY scope_type,scope_id,period,period_start`);
        return JSON.stringify({account,windows});
      };
      const waitForAdvisory=async label=>{
        for(let i=0;i<70;i++){
          const [row]=await cluster.admin.unsafe(`SELECT
            count(*)::integer AS n FROM pg_catalog.pg_stat_activity
            WHERE application_name=$1 AND wait_event_type='Lock'
              AND wait_event='advisory'`,
          [`complete-text-no-fetch-close-v388-${label}`]);
          if(row.n===1)return;
          await new Promise(done=>setTimeout(done,20));
        }
        throw new Error(`expected advisory lock wait for ${label}`);
      };

      for(const [name,setting] of [
        ['complete-text-legacy-buyer-held-writer-v368.sql','legacy_buyer_held_writer_v368_activation'],
        ['buyer-split-counter-grant-policy-v368.sql','buyer_counter_grant_policy_v368_activation'],
        ['complete-text-legacy-buyer-window-accountant-v371.sql','legacy_buyer_window_accountant_v371_activation'],
        ['complete-text-legacy-buyer-window-acl-v372.sql','legacy_buyer_window_acl_v372_activation'],
        ['complete-text-legacy-buyer-admission-fence-v380.sql','complete_text_legacy_buyer_admission_fence_v380_activation'],
        ['complete-text-platform-close-fence-v386.sql','complete_text_platform_close_fence_v386_activation'],
      ]) {
        const body=await readFile(proposal(name),'utf8');report.sourceSha256[name]=sha(body);
        await migrator.begin(async tx=>{
          await tx.unsafe(`SET LOCAL cinatoken.${setting}='reviewed-v1'`);
          await tx.unsafe(body).simple();
        });
      }
      stage('v368-v371-v372-v380-counter-authority-cutover-and-v386-installed');
      const closeSql=await readFile(proposal('complete-text-no-fetch-platform-close-v388.sql'),'utf8');
      report.sourceSha256['complete-text-no-fetch-platform-close-v388.sql']=sha(closeSql);
      report.sourceSha256['postgres-complete-text-no-fetch-close-v388.ts']=sha(await readFile(
        new URL('../../../packages/proxy/src/services/postgres-complete-text-no-fetch-close-v388.ts',import.meta.url)));
      report.sourceSha256['postgres-complete-text-no-fetch-close-v388.test.ts']=sha(await readFile(
        new URL('../../../packages/proxy/src/services/postgres-complete-text-no-fetch-close-v388.test.ts',import.meta.url)));
      const installClose=async tx=>{
        await tx.unsafe(`SET LOCAL cinatoken.complete_text_no_fetch_close_v388_activation='reviewed-v1'`);
        await tx.unsafe(closeSql).simple();
      };
      await assert.rejects(migrator.begin(tx=>tx.unsafe(closeSql).simple()),/activation or dependency differs/u);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`GRANT SELECT ON ${g}.users TO ${roles.closer}`);await installClose(tx);
      }),/activation or dependency differs/u);
      await assert.rejects(migrator.begin(async tx=>{
        await installClose(tx);throw new Error('v388-install-rollback');
      }),/v388-install-rollback/u);
      assert.equal((await migrator.unsafe(`SELECT pg_catalog.to_regclass(
        '${g}.complete_text_platform_terminals_v388') IS NULL AS absent`))[0].absent,true);
      await migrator.begin(installClose);
      stage('v388-default-off-role-drift-and-install-rollback-before-success');
      const closeRaw=async(scenario,resolutionId,nonce,client=closer)=>{
        const [row]=await client.unsafe(`SELECT ${g}.close_complete_text_no_fetch_v388(
          $1::uuid,$2::uuid,$3::uuid) AS value`,[scenario.result.grantId,resolutionId,nonce]);return row.value;
      };
      const closeInput=(scenario,resolutionId,nonce,connectionString=closerUrl)=>({
        closerConnectionString:connectionString,requestId:scenario.quote.requestId,
        grantId:scenario.result.grantId,resolutionId,decisionNonce:nonce});
      const makeNoFetch=async()=>{
        const scenario=await issueGranted();await shorten(scenario.result.grantId,1);
        await waitPastDeadline(scenario.result.grantId);
        const resolved=await resolveNoFetch(scenario.result.grantId,randomUUID());
        assert.equal(resolved.status,'verified_no_fetch_recorded');return {scenario,resolved};
      };
      const financial=async requestId=>{
        const [row]=await migrator.unsafe(`SELECT
          (SELECT count(*)::integer FROM ${g}.complete_text_platform_terminals_v388 WHERE request_id=$1) AS terminals,
          (SELECT count(*)::integer FROM ${g}.complete_text_platform_outbox_v388 WHERE request_id=$1) AS events,
          (SELECT count(*)::integer FROM ${g}.api_key_request_logs WHERE id=$1) AS logs`,[requestId]);
        return {counts:row,holds:await holdSnapshot(requestId),counters:await counterSnapshot()};
      };
      for(const actor of [runtime,buyer,holder,granter,resolver,bill,renewer,admission,recovery]) {
        await denied(actor.unsafe(`SELECT ${g}.close_complete_text_no_fetch_v388(
          pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid())`));
      }
      for(const table of ['complete_text_platform_terminals_v388','complete_text_platform_outbox_v388',
        'users','guardrail_budget_windows','user_budget_reservations','guardrail_budget_reservations']) {
        await denied(closer.unsafe(`SELECT * FROM ${g}.${table}`));
      }
      await denied(closer.unsafe(`SET ROLE ${roles.migrator}`));
      await denied(buyer.unsafe(`UPDATE ${g}.users SET budget_spent=budget_spent+0.000001 WHERE id='v361-user'`));
      await denied(buyer.unsafe(`UPDATE ${g}.guardrail_budget_windows SET settled_micros=settled_micros+1`));
      stage('isolated-closer-and-legacy-buyer-have-no-raw-money-authority');

      const first=await makeNoFetch();const firstNonce=randomUUID();
      const firstBefore=await financial(first.scenario.quote.requestId);
      const firstResult=await closePostgresCompleteTextNoFetchV388(closeInput(first.scenario,first.resolved.resolutionId,firstNonce));
      assert.equal(firstResult.status,'closed_no_fetch');assert.equal(firstResult.commitAcknowledged,true);
      assert.equal(firstResult.closeAcknowledged,true);assert.equal(firstResult.supplierCostStatus,'not_asserted');
      const firstAfter=await financial(first.scenario.quote.requestId);
      assert.deepEqual(firstAfter.counts,{terminals:1,events:1,logs:1});
      const closedHolds=JSON.parse(firstAfter.holds);
      assert.equal(closedHolds.ordinary.length,1);assert.equal(closedHolds.guardrails.length,3);
      for(const row of [...closedHolds.ordinary,...closedHolds.guardrails]) {
        assert.equal(row.state,'settled');assert.equal(Number(row.settled_micros),0);
      }
      const accountBefore=JSON.parse(firstBefore.counters).account;
      const accountAfter=JSON.parse(firstAfter.counters).account;
      assert.equal(Number(accountBefore.budget_reserved_micros)-Number(accountAfter.budget_reserved_micros),Number(first.scenario.quote.threeAttemptCeilingMicros));
      assert.equal(accountAfter.budget_spent,accountBefore.budget_spent);
      const [firstTerminal]=await migrator.unsafe(`SELECT supplier_cost_micros,supplier_cost_status,decision,
        buyer_charged_micros FROM ${g}.complete_text_platform_terminals_v388 WHERE request_id=$1`,[first.scenario.quote.requestId]);
      assert.equal(firstTerminal.supplier_cost_micros,null);assert.equal(firstTerminal.supplier_cost_status,'not_asserted');
      assert.equal(firstTerminal.decision.buyerBillableUnits,0);
      const replay=await closePostgresCompleteTextNoFetchV388(closeInput(first.scenario,first.resolved.resolutionId,firstNonce));
      assert.equal(replay.status,'already_closed_no_fetch');assert.equal(replay.terminalId,firstResult.terminalId);
      assert.equal(replay.eventId,firstResult.eventId);assert.deepEqual(await financial(first.scenario.quote.requestId),firstAfter);
      assert.equal((await closeRaw(first.scenario,first.resolved.resolutionId,randomUUID())).status,'decision_conflict');
      stage('real-client-four-hold-zero-terminal-log-typed-event-and-idempotent-replay',{
        terminalId:firstResult.terminalId,eventId:firstResult.eventId,holdCount:4,supplierCostStatus:'not_asserted'});

      const rolled=await makeNoFetch();const rollbackBefore=await financial(rolled.scenario.quote.requestId);
      await assert.rejects(closer.begin(async tx=>{
        assert.equal((await closeRaw(rolled.scenario,rolled.resolved.resolutionId,randomUUID(),tx)).status,'closed_no_fetch');
        throw new Error('v388-explicit-rollback');
      }),/v388-explicit-rollback/u);
      assert.deepEqual(await financial(rolled.scenario.quote.requestId),rollbackBefore);
      await assert.rejects(closer.begin(async tx=>{
        await tx.unsafe('SET CONSTRAINTS ALL IMMEDIATE');
        await closeRaw(rolled.scenario,rolled.resolved.resolutionId,randomUUID(),tx);
      }),/terminal\/log\/event set incomplete/u);
      assert.deepEqual(await financial(rolled.scenario.quote.requestId),rollbackBefore);
      stage('explicit-rollback-and-early-immediate-constraints-leave-all-money-and-artifacts-unchanged');

      await migrator.unsafe(`CREATE FUNCTION ${g}.test_fail_close_commit_v388() RETURNS trigger
        LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION 'forced-v388-commit-failure'; END; $body$;
        CREATE CONSTRAINT TRIGGER test_fail_close_commit_v388 AFTER INSERT
        ON ${g}.complete_text_platform_outbox_v388 DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION ${g}.test_fail_close_commit_v388()`).simple();
      await assert.rejects(closePostgresCompleteTextNoFetchV388(closeInput(rolled.scenario,
        rolled.resolved.resolutionId,randomUUID())),/forced-v388-commit-failure/u);
      assert.deepEqual(await financial(rolled.scenario.quote.requestId),rollbackBefore);
      await migrator.unsafe(`DROP TRIGGER test_fail_close_commit_v388 ON ${g}.complete_text_platform_outbox_v388;
        DROP FUNCTION ${g}.test_fail_close_commit_v388()`).simple();
      stage('real-client-deferred-commit-failure-rolls-back-terminal-log-event-and-four-holds');

      // Owned-superuser fault injection omits a companion after the real
      // function staged it. Runtime roles cannot disable these triggers.
      for(const table of ['complete_text_platform_outbox_v388','api_key_request_logs']) {
        await assert.rejects(cluster.admin.begin(async tx=>{
          await tx.unsafe(`SET LOCAL SESSION AUTHORIZATION ${roles.closer}`);
          await closeRaw(rolled.scenario,rolled.resolved.resolutionId,randomUUID(),tx);
          await tx.unsafe('RESET SESSION AUTHORIZATION');
          await tx.unsafe("SET LOCAL session_replication_role='replica'");
          await tx.unsafe(`DELETE FROM ${g}.${table} WHERE ${table==='api_key_request_logs'?'id':'request_id'}=$1`,[rolled.scenario.quote.requestId]);
          await tx.unsafe("SET LOCAL session_replication_role='origin'");
        }),/terminal\/log\/event set incomplete/u);
        assert.deepEqual(await financial(rolled.scenario.quote.requestId),rollbackBefore);
      }
      stage('deferred-verifier-rejects-missing-zero-log-or-platform-event-at-commit');

      for(const mutation of [
        `DELETE FROM ${g}.complete_text_platform_outbox_v388 WHERE request_id=$1`,
        `UPDATE ${g}.api_key_request_logs SET charged_cost=1 WHERE id=$1`,
        `DELETE FROM ${g}.api_key_request_logs WHERE id=$1`,
        `UPDATE ${g}.user_budget_reservations SET settled_micros=1 WHERE request_id=$1`,
      ]) {
        await assert.rejects(closer.begin(async tx=>{
          await closeRaw(rolled.scenario,rolled.resolved.resolutionId,randomUUID(),tx);
          await tx.unsafe('SET CONSTRAINTS ALL IMMEDIATE');
          await tx.unsafe(mutation,[rolled.scenario.quote.requestId]);
        }),/permission denied/u);
        assert.deepEqual(await financial(rolled.scenario.quote.requestId),rollbackBefore);
      }
      for(const mutation of [
        `DELETE FROM ${g}.complete_text_platform_outbox_v388 WHERE request_id=$1`,
        `UPDATE ${g}.api_key_request_logs SET charged_cost=1 WHERE id=$1`,
        `DELETE FROM ${g}.api_key_request_logs WHERE id=$1`,
        `UPDATE ${g}.user_budget_reservations SET settled_micros=1 WHERE request_id=$1`,
      ]) await assert.rejects(migrator.unsafe(mutation,[first.scenario.quote.requestId]),/protected append-only|immutable|exact atomic closer/u);
      stage('after-immediate-verification-closer-cannot-edit-companions-and-owner-trigger-immutability-holds');

      const raced=await makeNoFetch();const raceNonce=randomUUID();let staged,release;
      const stagedPromise=new Promise(resolve=>{staged=resolve;});const releasePromise=new Promise(resolve=>{release=resolve;});
      const firstClose=closer.begin(async tx=>{
        const result=await closeRaw(raced.scenario,raced.resolved.resolutionId,raceNonce,tx);staged(result);
        await releasePromise;return result;
      });
      assert.equal((await stagedPromise).status,'closed_no_fetch');
      const secondClose=closeRaw(raced.scenario,raced.resolved.resolutionId,raceNonce,closerPeer);
      try {await waitForAdvisory('closer-peer');} finally {release();}
      assert.equal((await firstClose).status,'closed_no_fetch');assert.equal((await secondClose).status,'already_closed_no_fetch');
      assert.deepEqual((await financial(raced.scenario.quote.requestId)).counts,{terminals:1,events:1,logs:1});
      stage('concurrent-direct-closers-observe-request-lock-and-commit-one-terminal');

      const lost=await makeNoFetch();const lostNonce=randomUUID();const proxy=await commitAckProxy(cluster.port);
      report.sourceSha256['postgres-commit-ack-proxy.mjs']=sha(await readFile(new URL(
        '../../../packages/core/src/test-support/postgres-commit-ack-proxy.mjs',import.meta.url)));
      try {
        proxy.arm();
        const proxied=closerUrl.replace(`:${cluster.port}/`,`:${proxy.port}/`);
        await assert.rejects(closePostgresCompleteTextNoFetchV388(closeInput(lost.scenario,lost.resolved.resolutionId,lostNonce,proxied)));
        await proxy.dropped;
        assert.equal(proxy.observations.droppedCommitAcks,1);
        const lostAfter=await financial(lost.scenario.quote.requestId);
        assert.deepEqual(lostAfter.counts,{terminals:1,events:1,logs:1});
        const recovered=await closePostgresCompleteTextNoFetchV388(closeInput(lost.scenario,lost.resolved.resolutionId,lostNonce));
        assert.equal(recovered.status,'already_closed_no_fetch');
        assert.deepEqual(await financial(lost.scenario.quote.requestId),lostAfter);
        stage('lost-real-commit-commandcomplete-is-recovered-by-same-nonce-without-second-release',{proxy:{...proxy.observations}});
      } finally {await proxy.close();}

      const drift=await makeNoFetch();const driftBefore=await financial(drift.scenario.quote.requestId);
      await migrator.unsafe(`UPDATE ${g}.users SET budget_epoch=budget_epoch+1 WHERE id='v361-user'`);
      assert.equal((await closeRaw(drift.scenario,drift.resolved.resolutionId,randomUUID())).status,'account_epoch_differs');
      await migrator.unsafe(`UPDATE ${g}.users SET budget_epoch=budget_epoch-1 WHERE id='v361-user'`);
      await migrator.unsafe(`UPDATE ${g}.users SET budget_reserved_micros=budget_reserved_micros+1 WHERE id='v361-user'`);
      assert.equal((await closeRaw(drift.scenario,drift.resolved.resolutionId,randomUUID())).status,'holds_differ');
      await migrator.unsafe(`UPDATE ${g}.users SET budget_reserved_micros=budget_reserved_micros-1 WHERE id='v361-user'`);
      const [picked]=await migrator.unsafe(`SELECT id FROM ${g}.guardrail_budget_reservations WHERE request_id=$1 LIMIT 1`,[drift.scenario.quote.requestId]);
      await cluster.admin.begin(async tx=>{
        await tx.unsafe(`SET LOCAL session_replication_role='replica'`);
        await tx.unsafe(`UPDATE ${g}.guardrail_budget_reservations SET reserved_micros=reserved_micros+1 WHERE id=$1`,[picked.id]);
      });
      assert.equal((await closeRaw(drift.scenario,drift.resolved.resolutionId,randomUUID())).status,'holds_differ');
      await cluster.admin.begin(async tx=>{
        await tx.unsafe(`SET LOCAL session_replication_role='replica'`);
        await tx.unsafe(`UPDATE ${g}.guardrail_budget_reservations SET reserved_micros=reserved_micros-1 WHERE id=$1`,[picked.id]);
      });
      assert.deepEqual(await financial(drift.scenario.quote.requestId),driftBefore);
      stage('epoch-reset-counter-drift-and-one-changed-hold-cannot-partially-close');

      // Seed an unrelated legacy held request sharing all account/window rows,
      // then use the actual isolated buyer LOGIN and v371 writer to settle it.
      const legacyId=`legacy-v388-${randomUUID()}`;
      const seedLegacy=async id=>migrator.begin(async tx=>{
        await tx.unsafe(`INSERT INTO ${g}.user_budget_reservations
          SELECT (pg_catalog.jsonb_populate_record(NULL::${g}.user_budget_reservations,
            pg_catalog.to_jsonb(r)||pg_catalog.jsonb_build_object('request_id',$2::text))).*
          FROM ${g}.user_budget_reservations r WHERE request_id=$1`,[drift.scenario.quote.requestId,id]);
        await tx.unsafe(`UPDATE ${g}.users SET budget_reserved_micros=budget_reserved_micros+$1::bigint
          WHERE id='v361-user'`,[drift.scenario.quote.threeAttemptCeilingMicros]);
        await tx.unsafe(`INSERT INTO ${g}.guardrail_budget_reservations
          SELECT (pg_catalog.jsonb_populate_record(NULL::${g}.guardrail_budget_reservations,
            pg_catalog.to_jsonb(r)||pg_catalog.jsonb_build_object('request_id',$2::text,'id',pg_catalog.gen_random_uuid()::text))).*
          FROM ${g}.guardrail_budget_reservations r WHERE request_id=$1`,[drift.scenario.quote.requestId,id]);
        await tx.unsafe(`UPDATE ${g}.guardrail_budget_windows w SET reserved_micros=w.reserved_micros+r.reserved_micros
          FROM ${g}.guardrail_budget_reservations r WHERE r.request_id=$1 AND w.workspace_id=r.workspace_id
            AND w.scope_type=r.scope_type AND w.scope_id=r.scope_id AND w.period=r.period AND w.period_start=r.period_start`,[id]);
      });
      await seedLegacy(legacyId);
      const reverseLegacyId=`legacy-v388-${randomUUID()}`;await seedLegacy(reverseLegacyId);
      const legacySettle=async(tx,id=legacyId)=>{
        await tx.unsafe(`INSERT INTO ${g}.api_key_request_logs(id,user_id,api_key_id,workspace_id,model_id,
          charged_cost,budget_charged_micros,budget_accounted_at,status,is_byok)
          VALUES($1,'v361-user','v361-key','v361-workspace','v361-model',0.001234,1234,clock_timestamp(),'success',false)`,[id]);
        const [row]=await tx.unsafe(`SELECT ${g}.settle_legacy_buyer_windowed_v371($1,'v388-legacy-peer') AS value`,[id]);
        assert.equal(row.value.status,'windowed_legacy_settled');return row.value;
      };
      const sharedCloseBefore=await financial(drift.scenario.quote.requestId);
      let legacyReady,legacyRelease;
      const legacyReadyPromise=new Promise(resolve=>{legacyReady=resolve;});
      const legacyReleasePromise=new Promise(resolve=>{legacyRelease=resolve;});
      const legacyTx=buyer.begin(async tx=>{
        await legacySettle(tx);legacyReady();await legacyReleasePromise;
      });
      await legacyReadyPromise;
      const concurrentPlatform=closeRaw(drift.scenario,drift.resolved.resolutionId,randomUUID(),closerPeer);
      try {
        for(let i=0;i<50;i++) {
          const [waiting]=await cluster.admin.unsafe(`SELECT count(*)::integer AS n FROM pg_stat_activity
            WHERE application_name='complete-text-no-fetch-close-v388-closer-peer' AND wait_event_type='Lock'`);
          if(waiting.n===1)break;
          if(i===49)throw new Error('closer did not wait on legacy account');
          await new Promise(resolve=>setTimeout(resolve,20));
        }
      } finally {legacyRelease();}
      await legacyTx;assert.equal((await concurrentPlatform).status,'closed_no_fetch');
      const [legacyLog]=await migrator.unsafe(`SELECT budget_charged_micros FROM ${g}.api_key_request_logs WHERE id=$1`,[legacyId]);
      assert.equal(Number(legacyLog.budget_charged_micros),1234);
      assert.equal(Number(JSON.parse((await financial(drift.scenario.quote.requestId)).counters).account.budget_spent)
        -Number(JSON.parse(sharedCloseBefore.counters).account.budget_spent),0.001234);
      stage('same-account-and-three-window-legacy-buyer-settles-while-platform-closer-waits-without-deadlock');
      let platformReady,platformRelease;
      const platformReadyPromise=new Promise(resolve=>{platformReady=resolve;});
      const platformReleasePromise=new Promise(resolve=>{platformRelease=resolve;});
      const platformTx=closer.begin(async tx=>{
        const result=await closeRaw(rolled.scenario,rolled.resolved.resolutionId,randomUUID(),tx);
        assert.equal(result.status,'closed_no_fetch');platformReady();await platformReleasePromise;
      });
      await platformReadyPromise;
      const reverseLegacyTx=buyer.begin(tx=>legacySettle(tx,reverseLegacyId));
      try {
        for(let i=0;i<50;i++) {
          const [waiting]=await cluster.admin.unsafe(`SELECT count(*)::integer AS n FROM pg_stat_activity
            WHERE application_name='complete-text-no-fetch-close-v388-buyer' AND wait_event_type='Lock'`);
          if(waiting.n===1)break;
          if(i===49)throw new Error('legacy buyer did not wait on platform account');
          await new Promise(resolve=>setTimeout(resolve,20));
        }
      } finally {platformRelease();}
      await platformTx;await reverseLegacyTx;
      assert.deepEqual((await financial(rolled.scenario.quote.requestId)).counts,{terminals:1,events:1,logs:1});
      stage('reverse-order-platform-close-commits-before-unrelated-legacy-buyer-on-shared-account-windows');

      const sent=await issueGranted();const run=randomUUID();assert.equal((await custody(sent.result.grantId,run)).status,'custody_claim_recorded');
      const started=await start(sent.result.grantId,run,1,sent.grantClaim.outboundBodySha256);
      assert.equal(started.status,'start_recorded');await shorten(sent.result.grantId,1);await waitPastDeadline(sent.result.grantId);
      const sentBefore=await financial(sent.quote.requestId);
      assert.equal((await resolveNoFetch(sent.result.grantId,randomUUID())).status,'possible_send_unknown');
      assert.equal((await closeRaw(sent,randomUUID(),randomUUID())).status,'missing_no_fetch_resolution');
      assert.deepEqual(await financial(sent.quote.requestId),sentBefore);
      stage('committed-possible-send-without-fetch-observation-stays-unknown-and-held');

      const heldNoFetch=await issueGranted();const heldRun=randomUUID();
      assert.equal((await custody(heldNoFetch.result.grantId,heldRun)).status,'custody_claim_recorded');
      const evidence={observation:'fetch_not_called'};
      const factInsert=async()=>holder.unsafe(`SELECT ${g}.append_complete_text_holder_fact_v366(
        $1::uuid,$2::uuid,1,$3::uuid,'no_fetch_attestation',$4::jsonb,
        encode(sha256(convert_to(($4::jsonb)::text,'UTF8')),'hex')) AS value`,[
        heldNoFetch.result.grantId,heldRun,randomUUID(),holder.json(evidence)]);
      assert.equal((await factInsert())[0].value.status,'fact_recorded');
      await shorten(heldNoFetch.result.grantId,1);await waitPastDeadline(heldNoFetch.result.grantId);
      const heldResolved=await resolveNoFetch(heldNoFetch.result.grantId,randomUUID());
      await closePostgresCompleteTextNoFetchV388(closeInput(heldNoFetch,heldResolved.resolutionId,randomUUID()));
      await denied(factInsert(),'23514','platform_terminal_egress_v388');
      stage('no-start-custody-closes-and-holder-observation-cannot-reopen-terminal');

      // Last, exercise the two shapes whose legitimate set has no ordinary or
      // no Guardrail hold. Change only the owned fixture's configuration.
      await migrator.unsafe(`UPDATE ${g}.users SET budget_max=NULL WHERE id='v361-user'`);
      const unlimited=await makeNoFetch();
      await closePostgresCompleteTextNoFetchV388(closeInput(unlimited.scenario,unlimited.resolved.resolutionId,randomUUID()));
      assert.equal(JSON.parse((await financial(unlimited.scenario.quote.requestId)).holds).ordinary.length,0);
      await migrator.unsafe(`UPDATE ${g}.api_keys SET limit_micros=NULL,limit_reset=NULL WHERE id='v361-key';
        DELETE FROM ${g}.workspace_budgets WHERE id='v361-budget';
        UPDATE ${g}.guardrails SET status='archived' WHERE id='v361-guardrail'`).simple();
      const noneQuote=await issueQuote();assert.equal((await admit(noneQuote,[])).status,'admitted');
      const noneClaim=await claimFor(noneQuote);const noneGrant=await grant(noneClaim);
      assert.equal(noneGrant.status,'grant_recorded');const none={quote:noneQuote,grantClaim:noneClaim,result:noneGrant};
      await shorten(noneGrant.grantId,1);await waitPastDeadline(noneGrant.grantId);
      const noneResolution=await resolveNoFetch(noneGrant.grantId,randomUUID());
      await closePostgresCompleteTextNoFetchV388(closeInput(none,noneResolution.resolutionId,randomUUID()));
      const noneAfter=await financial(noneQuote.requestId);
      assert.deepEqual(JSON.parse(noneAfter.holds),{ordinary:[],guardrails:[]});
      assert.deepEqual(noneAfter.counts,{terminals:1,events:1,logs:1});
      stage('unlimited-ordinary-and-zero-total-holds-still-write-one-zero-log-terminal-event');
      report.sourceSha256.fixture=sha(await readFile(new URL(import.meta.url)));
      assert.equal(report.sourceSha256.fixture,loadedFixtureSha256,'fixture changed during execution');
      report.status='PASS';
    } catch(error) {
      failure=error;report.status='FAIL';report.failedAfterStage=report.stages.at(-1)?.name??null;
      const cause=error?.cause??error;report.failure={code:cause?.code??null,constraint:cause?.constraint_name??null,
        message:String(error?.stack??error).slice(0,5000)};
    } finally {
      await Promise.allSettled(clients.map(c=>c.end({timeout:1})));
      try {await cluster.cleanup();report.cleanup='PASS';}
      catch(error) {report.cleanup='FAIL';report.cleanupError=String(error).slice(0,1500);failure??=error;}
      await writeFile(reportUrl,JSON.stringify(report,null,2)+'\n');
      process.stdout.write(`complete-text-no-fetch-platform-close-v388-report=${reportUrl.pathname}\n`);
    }
    if(failure) throw failure;assert.equal(report.cleanup,'PASS');
  });
