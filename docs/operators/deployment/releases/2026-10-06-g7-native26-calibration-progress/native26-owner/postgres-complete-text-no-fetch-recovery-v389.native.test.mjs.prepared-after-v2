// Owned PostgreSQL 18.6 proof for the review-only platform close fence seam.
import { runPostgresCompleteTextNoFetchRecoveryV389 } from '../../../packages/proxy/src/services/postgres-complete-text-no-fetch-recovery-v389.ts';
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
const reportUrl=new URL('../../../docs/developers/architecture/implementation-evidence/C04-complete-text-no-fetch-recovery-v389-report.json',import.meta.url);
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

test('v389 durable no-fetch recovery survives every acknowledged boundary and process-local nonce loss',
  {timeout:300_000,skip:!process.env.GATEWAY_NATIVE_PG_BIN},async()=>{
    const loadedFixtureSha256=sha(await readFile(new URL(import.meta.url)));
    const cluster=await startNativePostgres();
    const report={status:'RUNNING',cleanup:'PENDING',binaryVersion:cluster.binaryVersion,
      sourceSha256:{},stages:[],limitations:[
      'Review-only local PG73 and proposals; no formal migration, deployed Worker, remote database, production credential or Provider changed.',
      'v389 recovers only database-verified no-fetch work and completes jobs only after an independent terminal read. v388 closes only database-verified no-fetch attempts; supplier cost is not asserted. No actual, sent-zero, unknown forfeiture or late-bill adjustment authority is implemented.',
      'The fixture shortens send deadlines with owned cluster-superuser fault injection; runtime principals do not have this power.',
      'Platform typed events are durably inserted but delivery/consumer deployment and fleet drain remain unverified.',
      'Queue delivery of platform economic events is not implemented by the recovery job. Each transaction closes one request. Shared-account legacy requests are fixture-seeded and settled by the real direct LOGIN v371 SQL writer, not by the full Proxy application.',
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
      const jobs='cinatoken_text_no_fetch_recovery.jobs_v389';
      const directUrl=label=>'postgres://'+roles[label]+':'+passwords[label]+'@127.0.0.1:'+cluster.port+'/postgres?sslmode=disable';
      const connections={workerConnectionString:directUrl('worker'),observerConnectionString:directUrl('observer'),
        resolverConnectionString:directUrl('resolver'),closerConnectionString:closerUrl};
      const options={scanLimit:50,maxItems:1,admissionBudgetMs:25000,leaseSeconds:300};
      const run=overrides=>runPostgresCompleteTextNoFetchRecoveryV389({...connections,...overrides},options);
      const closeDirect=async(scenario,resolutionId,nonce=randomUUID())=>closePostgresCompleteTextNoFetchV388({
        closerConnectionString:closerUrl,requestId:scenario.quote.requestId,grantId:scenario.result.grantId,
        resolutionId,decisionNonce:nonce});
      const old=await issueGranted();await shorten(old.result.grantId,1);await waitPastDeadline(old.result.grantId);
      const oldResolutionNonce=randomUUID();const oldResolution=await resolveNoFetch(old.result.grantId,oldResolutionNonce);
      const oldDecisionNonce=randomUUID();const oldTerminal=await closeDirect(old,oldResolution.resolutionId,oldDecisionNonce);
      const orphan=await issueGranted();await shorten(orphan.result.grantId,1);await waitPastDeadline(orphan.result.grantId);
      const recoverySql=await readFile(proposal('complete-text-no-fetch-recovery-v389.sql'),'utf8');
      report.sourceSha256['complete-text-no-fetch-recovery-v389.sql']=sha(recoverySql);
      for(const name of ['postgres-complete-text-no-fetch-recovery-v389.ts','postgres-complete-text-no-fetch-recovery-v389.test.ts'])
        report.sourceSha256[name]=sha(await readFile(new URL('../../../packages/proxy/src/services/'+name,import.meta.url)));
      for(const relative of ['src/runtime/complete-text-no-fetch-recovery-worker-v389.ts',
        'src/runtime/complete-text-no-fetch-recovery-worker-v389.test.ts',
        'src/runtime/complete-text-no-fetch-recovery-v389-env.d.ts',
        'wrangler.complete-text-no-fetch-recovery-v389.jsonc',
        'src/services/hyperdrive-dedicated-role-transport-v390.ts',
        'src/services/hyperdrive-dedicated-role-transport-v390.test.ts'])
        report.sourceSha256[relative]=sha(await readFile(new URL('../../../packages/proxy/'+relative,import.meta.url)));
      const installRecovery=async tx=>{
        await tx.unsafe(`SET LOCAL cinatoken.complete_text_no_fetch_recovery_v389_activation='reviewed-v1'`);
        await tx.unsafe(recoverySql).simple();
      };
      await assert.rejects(migrator.begin(tx=>tx.unsafe(recoverySql).simple()),/activation or dependency differs/u);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`GRANT SELECT ON ${g}.users TO ${roles.worker}`);await installRecovery(tx);
      }),/role authority differs/u);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO ${roles.runtime}`);
        await installRecovery(tx);
      }),/inherited default ACL differs/u);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`DROP TRIGGER platform_terminal_complete_v388 ON ${g}.complete_text_platform_terminals_v388;
          CREATE CONSTRAINT TRIGGER platform_terminal_complete_v388 AFTER INSERT
          ON ${g}.complete_text_platform_terminals_v388 DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW WHEN (false) EXECUTE FUNCTION ${g}.verify_platform_close_v388()`).simple();
        await installRecovery(tx);
      }),/terminal guards differ/u);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`CREATE OR REPLACE FUNCTION ${g}.verify_platform_close_v388() RETURNS trigger
          LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,pg_temp AS $body$
          BEGIN RETURN NULL; END; $body$`);
        await installRecovery(tx);
      }),/terminal function body differs/u);
      await assert.rejects(migrator.begin(async tx=>{await installRecovery(tx);throw new Error('v389-install-rollback');}),/v389-install-rollback/u);
      assert.equal((await migrator.unsafe(`SELECT to_regclass('${jobs}') IS NULL AS absent`))[0].absent,true);
      await migrator.begin(installRecovery);
      stage('v389-default-off-role-default-acl-false-trigger-body-drift-and-install-rollback-before-atomic-enqueue-trigger');
      const scan=async(limit=50,client=worker)=>(await client.unsafe(`SELECT ${g}.scan_complete_text_no_fetch_recovery_v389($1) AS value`,[limit]))[0].value;
      const claim=async(client=worker,seconds=300)=>(await client.unsafe(`SELECT ${g}.claim_complete_text_no_fetch_recovery_v389($1) AS value`,[seconds]))[0].value;
      const observe=async(item,client=observer)=>(await client.unsafe(`SELECT ${g}.observe_complete_text_no_fetch_recovery_v389($1::uuid,$2::uuid) AS value`,[item.jobId,item.leaseToken]))[0].value;
      const finish=async(item,client=observer)=>(await client.unsafe(`SELECT ${g}.finish_complete_text_no_fetch_recovery_v389($1::uuid,$2::uuid) AS value`,[item.jobId,item.leaseToken]))[0].value;
      const fail=async(item,code='not_confirmed',client=worker)=>(await client.unsafe(`SELECT ${g}.fail_complete_text_no_fetch_recovery_v389($1::uuid,$2::uuid,$3) AS value`,[item.jobId,item.leaseToken,code]))[0].value;
      const jobFor=async scenario=>(await migrator.unsafe(`SELECT * FROM ${jobs} WHERE grant_id=$1::uuid`,[scenario.result.grantId]))[0];
      const makeReady=async()=>{
        const scenario=await issueGranted();await shorten(scenario.result.grantId,1);await waitPastDeadline(scenario.result.grantId);
        await migrator.unsafe(`UPDATE ${jobs} SET available_at=clock_timestamp()-interval '1 second' WHERE grant_id=$1::uuid`,[scenario.result.grantId]);
        return scenario;
      };
      const expireLease=async scenario=>migrator.unsafe(`UPDATE ${jobs} SET lease_until=clock_timestamp()-interval '1 second',
        available_at=clock_timestamp()-interval '1 second' WHERE grant_id=$1::uuid AND state='leased'`,[scenario.result.grantId]);
      const money=async scenario=>{
        const [counts]=await migrator.unsafe(`SELECT
          (SELECT count(*)::int FROM ${g}.complete_text_platform_terminals_v388 WHERE grant_id=$1) AS terminals,
          (SELECT count(*)::int FROM ${g}.complete_text_platform_outbox_v388 WHERE request_id=$2) AS events,
          (SELECT count(*)::int FROM ${g}.api_key_request_logs WHERE id=$2) AS logs`,[scenario.result.grantId,scenario.quote.requestId]);
        return {counts,holds:await holdSnapshot(scenario.quote.requestId)};
      };
      for(const actor of [worker,observer,operator]) {
        await denied(actor.unsafe(`SELECT * FROM ${jobs}`));
        await denied(actor.unsafe(`SELECT ${g}.close_complete_text_no_fetch_v388(gen_random_uuid(),gen_random_uuid(),gen_random_uuid())`));
        await denied(actor.unsafe(`SELECT ${g}.resolve_complete_text_no_fetch_v370(gen_random_uuid(),gen_random_uuid())`));
        await denied(actor.unsafe(`UPDATE ${g}.users SET budget_spent=budget_spent+1`));
        await denied(actor.unsafe(`SET ROLE ${roles.closer}`));
      }
      await denied(worker.unsafe(`SELECT ${g}.finish_complete_text_no_fetch_recovery_v389(gen_random_uuid(),gen_random_uuid())`));
      await denied(observer.unsafe(`SELECT ${g}.claim_complete_text_no_fetch_recovery_v389(30)`));
      await denied(worker.unsafe(`SELECT ${g}.recover_complete_text_no_fetch_recovery_v389(gen_random_uuid(),'reviewed-recovery')`));
      stage('worker-observer-operator-separate-logins-have-no-source-financial-or-other-role-authority');
      assert.equal((await scan(1)).enqueued,1);assert.equal((await scan(1)).enqueued,1);assert.equal((await scan(1)).enqueued,0);
      const oldJob=await jobFor(old);assert.equal(oldJob.resolution_nonce,oldResolutionNonce);assert.equal(oldJob.decision_nonce,oldDecisionNonce);
      assert.equal((await run()).completed,1);assert.equal((await jobFor(old)).terminal_id,oldTerminal.terminalId);
      assert.equal((await run()).completed,1);assert.equal((await jobFor(orphan)).state,'completed');
      assert.deepEqual((await money(orphan)).counts,{terminals:1,events:1,logs:1});
      stage('bounded-backfill-adopts-preexisting-nonces-and-real-runner-recovers-orphan-with-no-js-nonce');

      const fresh=await makeReady();const freshJob=await jobFor(fresh);
      assert.ok(freshJob);assert.equal(freshJob.state,'pending');
      assert.equal((await run()).completed,1);assert.equal((await jobFor(fresh)).state,'completed');
      stage('new-grant-enqueues-same-transaction-and-real-runner-resolves-closes-confirms');
      // A grant transaction rollback also erases the new job.
      const rollbackQuote=await issueQuote();assert.equal((await admit(rollbackQuote)).status,'admitted');
      const rollbackClaim=await claimFor(rollbackQuote);
      await assert.rejects(granter.begin(async tx=>{assert.equal((await grant(rollbackClaim,randomUUID(),tx)).status,'grant_recorded');throw new Error('v389-grant-rollback');}),/v389-grant-rollback/u);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM ${jobs} WHERE request_id=$1`,[rollbackQuote.requestId]))[0].n,0);
      stage('grant-rollback-leaves-no-recovery-job');

      const oldDifferent=await makeReady();const stableBefore=await jobFor(oldDifferent);
      const externalResolution=await resolveNoFetch(oldDifferent.result.grantId,randomUUID());
      const externalTerminal=await closeDirect(oldDifferent,externalResolution.resolutionId);
      assert.equal((await run()).completed,1);
      const stableAfter=await jobFor(oldDifferent);
      assert.equal(stableAfter.resolution_nonce,stableBefore.resolution_nonce);assert.equal(stableAfter.decision_nonce,stableBefore.decision_nonce);
      assert.equal(stableAfter.terminal_id,externalTerminal.terminalId);
      const resolvedOnly=await makeReady();const resolvedOnlyStable=await jobFor(resolvedOnly);
      await resolveNoFetch(resolvedOnly.result.grantId,randomUUID());assert.equal((await run()).completed,1);
      assert.equal((await jobFor(resolvedOnly)).resolution_nonce,resolvedOnlyStable.resolution_nonce);
      stage('existing-job-adopts-legitimate-different-nonce-resolution-and-terminal-without-rewriting-stable-nonces');

      // Each wire proxy drops PostgreSQL COMMIT CommandComplete only after
      // the real backend committed. A fresh runner retains no JS claim/nonce.
      for(const boundary of ['claim','resolve','close']) {
        const scenario=await makeReady();const before=await jobFor(scenario);const proxy=await commitAckProxy(cluster.port);
        try {
          proxy.arm();
          const role=boundary==='claim'?'worker':boundary==='resolve'?'resolver':'closer';
          const proxied=directUrl(role).replace(`:${cluster.port}/`,`:${proxy.port}/`);
          if(boundary==='claim') {
            const proxyWorker=connection({...cluster,port:proxy.port},roles.worker,passwords.worker,'claim-ack-proxy');clients.push(proxyWorker);
            await assert.rejects(proxyWorker.begin(tx=>claim(tx)));
          } else {
            await assert.rejects(run({[role+'ConnectionString']:proxied}));
          }
          await proxy.dropped;assert.equal(proxy.observations.droppedCommitAcks,1);
          const uncertain=await jobFor(scenario);assert.equal(uncertain.state,'leased');
          assert.equal(uncertain.resolution_nonce,before.resolution_nonce);assert.equal(uncertain.decision_nonce,before.decision_nonce);
          await expireLease(scenario);
          assert.equal((await run()).completed,1);
          assert.deepEqual((await money(scenario)).counts,{terminals:1,events:1,logs:1});
          stage('lost-'+boundary+'-commit-ack-is-recovered-by-fresh-runner-and-stable-db-nonces',{proxy:{...proxy.observations}});
        } finally {await proxy.close();}
      }
      const finishLost=await makeReady();const finishClaim=await claim();
      const finishResolution=await resolveNoFetch(finishLost.result.grantId,finishClaim.resolutionNonce);
      await closeDirect(finishLost,finishResolution.resolutionId,finishClaim.decisionNonce);
      const finishProxy=await commitAckProxy(cluster.port);
      try {
        const proxyObserver=connection({...cluster,port:finishProxy.port},roles.observer,passwords.observer,'finish-ack-proxy');clients.push(proxyObserver);
        finishProxy.arm();await assert.rejects(proxyObserver.begin(tx=>finish(finishClaim,tx)));await finishProxy.dropped;
        const before=await money(finishLost);assert.equal((await jobFor(finishLost)).state,'completed');
        assert.equal((await run()).claimed,0);assert.equal((await finish(finishClaim)).status,'completed');
        assert.deepEqual(await money(finishLost),before);
        stage('lost-finish-commit-ack-preserves-completed-job-and-does-not-reclose',{proxy:{...finishProxy.observations}});
      } finally {await finishProxy.close();}

      const competition=await makeReady();const claims=await Promise.all([claim(worker),claim(workerPeer)]);
      assert.equal(claims.filter(x=>x.status==='claimed').length,1);assert.equal(claims.filter(x=>x.status==='empty').length,1);
      const winner=claims.find(x=>x.status==='claimed');await expireLease(competition);const successor=await claim();
      assert.notEqual(successor.leaseToken,winner.leaseToken);assert.equal(successor.resolutionNonce,winner.resolutionNonce);
      assert.equal(successor.decisionNonce,winner.decisionNonce);assert.equal((await observe(winner)).status,'lease_lost');
      assert.equal((await fail(winner)).status,'lease_lost');assert.equal((await finish(winner)).status,'lease_lost');
      assert.equal((await finish(successor)).status,'not_confirmed');
      await expireLease(competition);assert.equal((await run()).completed,1);
      stage('two-workers-claim-once-expired-worker-cannot-observe-fail-or-finish-and-successor-keeps-nonces');
      const lockBlocked=await makeReady();const lockClaim=await claim();let lockReady,lockRelease;
      const lockReadyPromise=new Promise(resolve=>{lockReady=resolve;});
      const lockReleasePromise=new Promise(resolve=>{lockRelease=resolve;});
      const locked=migrator.begin(async tx=>{
        await tx.unsafe(`SELECT pg_advisory_xact_lock(348,hashtext($1))`,[lockBlocked.quote.requestId]);
        lockReady();await lockReleasePromise;
      });
      await lockReadyPromise;
      try {await denied(observe(lockClaim),'55P03');} finally {lockRelease();}
      await locked;
      assert.equal((await jobFor(lockBlocked)).state,'leased');
      assert.equal((await jobFor(lockBlocked)).resolution_nonce,lockClaim.resolutionNonce);
      await expireLease(lockBlocked);assert.equal((await run()).completed,1);
      stage('observer-request-lock-timeout-keeps-lease-and-stable-nonce-for-fresh-recovery');

      const possible=await issueGranted();const possibleRun=randomUUID();await custody(possible.result.grantId,possibleRun);
      assert.equal((await start(possible.result.grantId,possibleRun,1,possible.grantClaim.outboundBodySha256)).status,'start_recorded');
      await shorten(possible.result.grantId,1);await waitPastDeadline(possible.result.grantId);
      await migrator.unsafe(`UPDATE ${jobs} SET available_at=clock_timestamp()-interval '1 second' WHERE grant_id=$1`,[possible.result.grantId]);
      const possibleBefore=await money(possible);assert.equal((await run()).quarantined,1);
      assert.equal((await jobFor(possible)).quarantine_reason,'possible_send');assert.deepEqual(await money(possible),possibleBefore);
      stage('possible-send-is-quarantined-with-unknown-grant-and-all-holds-preserved');
      const possibleJob=await jobFor(possible);
      for(let i=1;i<=3;i++) {
        const [restored]=await operator.unsafe(`SELECT ${g}.recover_complete_text_no_fetch_recovery_v389($1,'Reviewed possible-send incident; inspect again without send authority') AS value`,[possibleJob.job_id]);
        assert.equal(restored.value.status,'requeued');assert.equal((await run()).quarantined,1);
      }
      const [recoveryCap]=await operator.unsafe(`SELECT ${g}.recover_complete_text_no_fetch_recovery_v389($1,'Reviewed incident still unresolved after three recoveries') AS value`,[possibleJob.job_id]);
      assert.equal(recoveryCap.value.status,'recovery_exhausted');
      assert.equal((await jobFor(possible)).recovery_count,3);assert.deepEqual(await money(possible),possibleBefore);
      stage('three-manual-recoveries-remain-bounded-and-cannot-convert-possible-send-to-zero');

      const exhaustion=await makeReady();const exhaustBefore=await jobFor(exhaustion);
      for(let i=1;i<=7;i++) {
        const current=await claim();assert.equal(current.attemptCount,i);
        const result=await fail(current);assert.equal(result.status,i===7?'quarantined':'retry_scheduled');
        if(i<7)await migrator.unsafe(`UPDATE ${jobs} SET available_at=clock_timestamp()-interval '1 second' WHERE grant_id=$1`,[exhaustion.result.grantId]);
      }
      assert.equal((await claim()).status,'empty');assert.equal((await jobFor(exhaustion)).quarantine_reason,'attempts_exhausted');
      const [requeued]=await operator.unsafe(`SELECT ${g}.recover_complete_text_no_fetch_recovery_v389($1,'Reviewed transient dependency failure; retry authorized') AS value`,[exhaustBefore.job_id]);
      assert.equal(requeued.value.status,'requeued');assert.equal((await run()).completed,1);
      const exhaustAfter=await jobFor(exhaustion);assert.equal(exhaustAfter.resolution_nonce,exhaustBefore.resolution_nonce);
      assert.equal(exhaustAfter.decision_nonce,exhaustBefore.decision_nonce);assert.equal(exhaustAfter.recovery_count,1);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM cinatoken_text_no_fetch_recovery.manual_recoveries_v389 WHERE job_id=$1`,[exhaustBefore.job_id]))[0].n,1);
      stage('seven-attempt-exhaustion-stops-and-reasoned-operator-recovery-retains-nonces-and-audit');

      // Confirmation remains valid after unrelated account/window activity.
      const historical=await makeReady();const historicalClaim=await claim();
      const historicalResolution=await resolveNoFetch(historical.result.grantId,historicalClaim.resolutionNonce);
      await closeDirect(historical,historicalResolution.resolutionId,historicalClaim.decisionNonce);
      const extra=await issueGranted();
      assert.equal((await observe(historicalClaim)).status,'confirmed');assert.equal((await finish(historicalClaim)).status,'completed');
      const extraBefore=await money(extra);assert.equal(extraBefore.counts.terminals,0);
      stage('historical-terminal-confirmation-does-not-compare-live-shared-account-or-window-counters');

      const missing=await makeReady();const missingClaim=await claim();assert.equal(missingClaim.grantId,missing.result.grantId);
      const missingResolution=await resolveNoFetch(missing.result.grantId,missingClaim.resolutionNonce);
      await closeDirect(missing,missingResolution.resolutionId,missingClaim.decisionNonce);
      const [eventBackup]=await migrator.unsafe(`SELECT to_jsonb(e) AS value FROM ${g}.complete_text_platform_outbox_v388 e WHERE request_id=$1`,[missing.quote.requestId]);
      await cluster.admin.begin(async tx=>{await tx.unsafe("SET LOCAL session_replication_role='replica'");
        await tx.unsafe(`DELETE FROM ${g}.complete_text_platform_outbox_v388 WHERE request_id=$1`,[missing.quote.requestId]);});
      assert.equal((await observe(missingClaim)).status,'conflict');assert.equal((await finish(missingClaim)).status,'quarantined');
      await cluster.admin.begin(async tx=>{await tx.unsafe("SET LOCAL session_replication_role='replica'");
        await tx.unsafe(`INSERT INTO ${g}.complete_text_platform_outbox_v388 SELECT (jsonb_populate_record(NULL::${g}.complete_text_platform_outbox_v388,$1::jsonb)).*`,[tx.json(eventBackup.value)]);});
      stage('independent-observer-rejects-missing-terminal-companion-instead-of-trusting-completion-claim');

      const repaired=await makeReady();const repairedBefore=await jobFor(repaired);
      await cluster.admin.begin(async tx=>{await tx.unsafe("SET LOCAL session_replication_role='replica'");
        await tx.unsafe(`DELETE FROM ${jobs} WHERE job_id=$1`,[repairedBefore.job_id]);});
      assert.equal((await scan(1)).enqueued,1);assert.equal((await scan(1)).enqueued,0);
      assert.equal((await run()).completed,1);
      stage('bounded-anti-join-reconstructs-missing-job-without-time-watermark');
      for(const name of ['postgres-commit-ack-proxy.mjs']) report.sourceSha256[name]=sha(await readFile(new URL('../../../packages/core/src/test-support/'+name,import.meta.url)));
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
      process.stdout.write(`complete-text-no-fetch-recovery-v389-report=${reportUrl.pathname}\n`);
    }
    if(failure)throw failure;assert.equal(report.cleanup,'PASS');
  });
