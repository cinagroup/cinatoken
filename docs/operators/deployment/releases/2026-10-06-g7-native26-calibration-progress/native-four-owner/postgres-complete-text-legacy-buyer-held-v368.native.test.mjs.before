// Owned PostgreSQL 18.6 proof of a narrow non-grant buyer writer and ACL cutover.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql as drizzleSql } from 'drizzle-orm';
import { pgCoreSchema } from '../../../packages/core/src/storage/drizzle/schema.pg.ts';
import { stageLegacyBuyerHeldSettlementV369 } from
  '../../../packages/core/src/db/postgres/legacy-buyer-held-transaction-v369.ts';
import { computeRouteDataPolicySubjectFingerprintFromRows } from '../../../packages/core/src/route-data-policy.ts';
import { grantPostgresCompleteTextAttemptV362 } from '../../../packages/proxy/src/services/postgres-complete-text-attempt-grant-v362.ts';
import { claimPostgresCompleteTextCustodyV365,
  recordPostgresCompleteTextSendStartV365,
  PostgresCompleteTextSendStartRejectedError,
} from '../../../packages/proxy/src/services/postgres-complete-text-send-start-v365.ts';
import { settlePostgresLegacyBuyerHeldV368 } from
  '../../../packages/proxy/src/services/postgres-legacy-buyer-held-v368.ts';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';
import { activatePostgresBuyerSplitV348 } from './activate-postgres-buyer-split-v348.ts';
import { grantPostgresBuyerSplitV348 } from './grant-postgres-buyer-split-v348.ts';
import { activatePostgresBuyerGuardrailSplitV349 } from './activate-postgres-buyer-guardrail-split-v349.ts';
import { grantPostgresBuyerGuardrailSplitV349 } from './grant-postgres-buyer-guardrail-split-v349.ts';

const g='cinatoken_gateway';
const migrationDir=new URL('../../../packages/core/migrations-postgres/',import.meta.url);
const proposal=name=>new URL(`../../../packages/core/migrations-proposals/postgres/${name}`,import.meta.url);
const reportUrl=new URL('../../../docs/developers/architecture/implementation-evidence/C04-complete-text-legacy-buyer-held-v368-report.json',import.meta.url);
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
  recovery:'cinatoken_gateway_budget_recovery'};

function connection(cluster,name,password,label) {
  return postgres({host:'127.0.0.1',port:cluster.port,database:'postgres',
    username:name,password,ssl:false,max:1,prepare:false,fetch_types:false,
    connect_timeout:3,idle_timeout:0,max_lifetime:0,backoff:false,onnotice(){},
    connection:{application_name:`complete-send-start-v365-${label}`}});
}
async function denied(work,code='42501') {
  await assert.rejects(work,error=>{
    assert.equal((error?.cause??error)?.code,code,String(error));return true;
  });
}

test('v368 request-scoped legacy buyer writer and successor counter ACL',
  {timeout:300_000,skip:!process.env.GATEWAY_NATIVE_PG_BIN},async()=>{
    const cluster=await startNativePostgres();
    const report={status:'RUNNING',cleanup:'PENDING',binaryVersion:cluster.binaryVersion,
      sourceSha256:{},stages:[],limitations:[
        'Review-only PG73 proposal; no formal migration, deployed Worker, remote database or production credential changed.',
        'NON-ACTIVATABLE: v368 covers only a current-epoch charged-basis held request within its reserved amount. Existing buyer application paths are not switched to it.',
        'Caller-supplied ordinary and Guardrail amounts are not bound to a verified Provider bill, request log, economic event or immutable buyer fact.',
        'The companion v368 policy revokes direct buyer counter and hold rights in the owned fixture only; installing it without a complete application cutover would break legacy paths.',
        'The v366 trigger freezes all grant-linked reservation mutation. Lease renewal and atomic result closure require replacement of this trigger in the same future activation transaction.',
        'The fixture uses privileged timestamp and state fault injection for expiry and pre-grant dispatched legacy rows. It never grants those privileges to a runtime caller.',
        'The native client proves local transaction COMMIT and dedicated LOGIN close acknowledgement, not provider send, provider billing, stream cancellation, production Worker/Hyperdrive acknowledgement, or a fleet cutover.',
        'The v369 Drizzle transaction seam proves one actual/actual v2 log, audit and economic event co-transaction with held counters, but is not wired into the existing application critical writer and does not bind caller amounts to a bill.',
        'Bounded candidate selection with anti-join is tested on a small dataset; large-backlog query cost and fairness among busy non-grant rows remain unproven.',
        'D1/MySQL parity, Linux CI outcome and real Worker/Hyperdrive behavior are not established by this local run.'
      ]};
    const stage=(name,detail={})=>report.stages.push({name,result:'PASS',...detail});
    const clients=[];let failure;
    try {
      assert.match(cluster.binaryVersion,/PostgreSQL\) 18\.6/u);
      const passwords=Object.fromEntries(Object.keys(roles).map(x=>[
        x,randomBytes(24).toString('hex')]));
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
      const granter=connection(cluster,roles.granter,passwords.granter,'granter');
      const granterPeer=connection(cluster,roles.granter,passwords.granter,'granter-peer');
      const holder=connection(cluster,roles.holder,passwords.holder,'holder');
      const buyer=connection(cluster,roles.buyer,passwords.buyer,'buyer');
      const sharedProducer=connection(cluster,roles.sharedProducer,
        passwords.sharedProducer,'shared-producer');
      const recovery=connection(cluster,roles.recovery,passwords.recovery,'recovery');
      const holderPeer=connection(cluster,roles.holder,passwords.holder,'holder-peer');
      const cap=connection(cluster,roles.cap,passwords.cap,'cap');
      const verifier=connection(cluster,roles.verifier,passwords.verifier,'verifier');
      const complete=connection(cluster,roles.complete,passwords.complete,'complete');
      clients.push(migrator,runtime,admission,granter,granterPeer,holder,holderPeer,
        cap,verifier,complete,recovery,buyer,sharedProducer);
      await migrator.unsafe(`CREATE TABLE ${g}.schema_migrations
        (version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`);
      const migrationNames=(await readdir(migrationDir)).filter(x=>x.endsWith('.sql')).sort();
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
      report.sourceSha256['postgres-legacy-buyer-held-v368.ts']=sha(await readFile(
        new URL('../../../packages/proxy/src/services/postgres-legacy-buyer-held-v368.ts',import.meta.url)));
      report.sourceSha256['legacy-buyer-held-transaction-v369.ts']=sha(await readFile(
        new URL('../../../packages/core/src/db/postgres/legacy-buyer-held-transaction-v369.ts',import.meta.url)));
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

      const issueQuote=async(bearerValue=bearer,id=`v362-${randomUUID()}`)=>{
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

      const issueGranted=async(id)=>{
        const quote=await issueQuote(bearer,id);
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
          'ordinary_budget_recovery_v354_activation']]){
        const body=await readFile(proposal(name),'utf8');
        report.sourceSha256[name]=sha(body);
        await migrator.begin(async tx=>{
          await tx.unsafe(`SET LOCAL cinatoken.${setting}='reviewed-v1'`);
          await tx.unsafe(body).simple();
        });
      }
      stage('real-v353-v354-installed-before-replacement');

      const fenceSql=await readFile(proposal(
        'complete-text-legacy-reaper-fence-v366.sql'),'utf8');
      report.sourceSha256['complete-text-legacy-reaper-fence-v366.sql']=sha(fenceSql);
      const install=async()=>migrator.begin(async tx=>{
        await tx.unsafe(`SET LOCAL
          cinatoken.complete_text_legacy_reaper_fence_v366_activation='reviewed-v1'`);
        await tx.unsafe(fenceSql).simple();
      });
      await assert.rejects(migrator.begin(tx=>tx.unsafe(fenceSql).simple()),
        /activation or role differs/u);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`GRANT UPDATE (state) ON ${g}.user_budget_reservations
          TO ${roles.recovery}`);
        await tx.unsafe(`SET LOCAL
          cinatoken.complete_text_legacy_reaper_fence_v366_activation='reviewed-v1'`);
        await tx.unsafe(fenceSql).simple();
      }),/activation or role differs/u);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`SET LOCAL
          cinatoken.complete_text_legacy_reaper_fence_v366_activation='reviewed-v1'`);
        await tx.unsafe(fenceSql).simple();
        throw new Error('test-rollback-after-activation');
      }),/test-rollback-after-activation/u);
      const [rolledBack]=await migrator.unsafe(`SELECT
        (SELECT count(*)::integer FROM pg_catalog.pg_trigger
          WHERE tgname LIKE 'complete_text_%_hold_fence_v366'
            AND NOT tgisinternal) AS trigger_count,
        pg_catalog.pg_get_functiondef(
          '${g}.forfeit_user_budget_dispatched_v354(text,timestamptz,text)'
            ::pg_catalog.regprocedure) LIKE '%pg_advisory_xact_lock(348%'
          AS successor_present`);
      assert.deepEqual(rolledBack,{trigger_count:0,successor_present:false});
      await install();
      const [installed]=await migrator.unsafe(`SELECT
        (SELECT count(*)::integer FROM pg_catalog.pg_trigger
          WHERE tgname LIKE 'complete_text_%_hold_fence_v366'
            AND NOT tgisinternal AND tgenabled='O') AS trigger_count,
        pg_catalog.pg_get_functiondef(
          '${g}.forfeit_user_budget_dispatched_v354(text,timestamptz,text)'
            ::pg_catalog.regprocedure) LIKE '%pg_advisory_xact_lock(348%'
          AS successor_present`);
      assert.deepEqual(installed,{trigger_count:2,successor_present:true});
      stage('default-off-role-drift-and-deliberate-rollback-leave-no-partial-install');

      const guardrailForfeit=async(requestId)=>{
        const [row]=await admission.unsafe(`SELECT
          ${g}.forfeit_guardrail_budgets_v353($1,$2) AS n`,
          [requestId,'unknown_provider_outcome']);
        return row.n;
      };
      const ordinaryForfeit=async(requestId,client=recovery)=>{
        const [row]=await client.unsafe(`SELECT
          ${g}.forfeit_user_budget_dispatched_v354($1,now(),$2) AS n`,
          [requestId,'unknown_provider_outcome']);
        return row.n;
      };
      const expectEnrolled=async(work)=>assert.rejects(work,error=>{
        const cause=error?.cause??error;
        assert.equal(cause.code,'23514',String(error));
        assert.equal(cause.constraint_name,'complete_text_enrolled_hold_v366');
        return true;
      });
      const first=await issueGranted('v366-00-before-start');
      await expectEnrolled(()=>guardrailForfeit(first.quote.requestId));
      await expectEnrolled(()=>ordinaryForfeit(first.quote.requestId));
      const firstRun=randomUUID();
      assert.equal((await custody(first.result.grantId,firstRun)).status,
        'custody_claim_recorded');
      assert.equal((await start(first.result.grantId,firstRun,1,
        first.grantClaim.outboundBodySha256)).status,'start_recorded');
      stage('forfeit-before-send-start-denied-and-start-still-recorded');

      const second=await issueGranted('v366-01-after-start');
      const secondRun=randomUUID();
      assert.equal((await custody(second.result.grantId,secondRun)).status,
        'custody_claim_recorded');
      assert.equal((await start(second.result.grantId,secondRun,1,
        second.grantClaim.outboundBodySha256)).status,'start_recorded');
      await expectEnrolled(()=>guardrailForfeit(second.quote.requestId));
      await expectEnrolled(()=>ordinaryForfeit(second.quote.requestId));
      await expectEnrolled(()=>migrator.unsafe(`UPDATE ${g}.user_budget_reservations
        SET expires_at=expires_at+interval '1 second' WHERE request_id=$1`,
        [second.quote.requestId]));
      await expectEnrolled(()=>migrator.unsafe(`UPDATE ${g}.guardrail_budget_reservations
        SET expires_at=expires_at+interval '1 second' WHERE request_id=$1`,
        [second.quote.requestId]));
      stage('send-start-before-forfeit-denied-and-direct-hold-mutation-fenced');

      const [counterAcl]=await migrator.unsafe(`SELECT
        pg_catalog.has_column_privilege('${roles.buyer}',
          '${g}.users','budget_spent','UPDATE') AS buyer_user_spent_update,
        pg_catalog.has_column_privilege('${roles.buyer}',
          '${g}.users','budget_reserved_micros','UPDATE') AS buyer_user_hold_update,
        pg_catalog.has_table_privilege('${roles.buyer}',
          '${g}.guardrail_budget_windows','UPDATE') AS buyer_window_update`);
      assert.deepEqual(counterAcl,{buyer_user_spent_update:true,
        buyer_user_hold_update:true,buyer_window_update:true});
      const [accountBefore]=await migrator.unsafe(`SELECT budget_spent
        FROM ${g}.users WHERE id='v361-user'`);
      const changedAccount=await buyer.unsafe(`UPDATE ${g}.users
        SET budget_spent=budget_spent+0.000001 WHERE id='v361-user'
        RETURNING budget_spent`);
      assert.equal(changedAccount.length,1);
      const [committedAccount]=await migrator.unsafe(`SELECT budget_spent
        FROM ${g}.users WHERE id='v361-user'`);
      assert.equal(Number(committedAccount.budget_spent),
        Number(accountBefore.budget_spent)+0.000001);
      await buyer.unsafe(`UPDATE ${g}.users
        SET budget_spent=budget_spent-0.000001 WHERE id='v361-user'`);
      const [restoredAccount]=await migrator.unsafe(`SELECT budget_spent
        FROM ${g}.users WHERE id='v361-user'`);
      assert.equal(restoredAccount.budget_spent,accountBefore.budget_spent);
      const [windowBefore]=await migrator.unsafe(`SELECT
        sum(settled_micros)::bigint AS settled FROM ${g}.guardrail_budget_windows
        WHERE workspace_id='v361-workspace'`);
      const changedWindows=await buyer.unsafe(`UPDATE ${g}.guardrail_budget_windows
        SET settled_micros=settled_micros+1
        WHERE workspace_id='v361-workspace' RETURNING workspace_id`);
      assert.ok(changedWindows.length>0);
      const [committedWindows]=await migrator.unsafe(`SELECT
        sum(settled_micros)::bigint AS settled FROM ${g}.guardrail_budget_windows
        WHERE workspace_id='v361-workspace'`);
      assert.equal(Number(committedWindows.settled),
        Number(windowBefore.settled)+changedWindows.length);
      await buyer.unsafe(`UPDATE ${g}.guardrail_budget_windows
        SET settled_micros=settled_micros-1
        WHERE workspace_id='v361-workspace'`);
      const [restoredWindows]=await migrator.unsafe(`SELECT
        sum(settled_micros)::bigint AS settled FROM ${g}.guardrail_budget_windows
        WHERE workspace_id='v361-workspace'`);
      assert.equal(restoredWindows.settled,windowBefore.settled);
      stage('native-buyer-counter-writes-commit-across-enrolled-grant-then-restore',
        {counterAcl,activationBlocker:true});

      const legacyQuote=await issueQuote(bearer,'v366-99-legacy-expiry');
      assert.equal((await admit(legacyQuote)).status,'admitted');
      await cluster.admin.begin(async tx=>{
        await tx.unsafe(`SET LOCAL session_replication_role='replica'`);
        await tx.unsafe(`UPDATE ${g}.user_budget_reservations
          SET created_at=now()-interval '3 minutes',
            expires_at=now()-interval '2 minutes'
          WHERE request_id IN ($1,$2,$3)`,
          [first.quote.requestId,second.quote.requestId,legacyQuote.requestId]);
        await tx.unsafe(`UPDATE ${g}.guardrail_budget_reservations
          SET created_at=now()-interval '3 minutes',
            expires_at=now()-interval '2 minutes'
          WHERE request_id IN ($1,$2,$3)`,
          [first.quote.requestId,second.quote.requestId,legacyQuote.requestId]);
      });
      const [guardrailScan]=await admission.unsafe(`SELECT
        ${g}.expire_guardrail_budgets_v353(50) AS n`);
      const [ordinaryScan]=await recovery.unsafe(`SELECT
        ${g}.expire_user_budget_leases_v354(now(),100) AS n`);
      assert.equal(guardrailScan.n,3);
      assert.equal(ordinaryScan.n,1);
      const states=await migrator.unsafe(`SELECT request_id,state,
        count(*)::integer AS n FROM ${g}.guardrail_budget_reservations
        WHERE request_id IN ($1,$2,$3) GROUP BY request_id,state
        ORDER BY request_id`,
        [first.quote.requestId,second.quote.requestId,legacyQuote.requestId]);
      assert.deepEqual(states.map(x=>[x.request_id,x.state,x.n]),[
        [first.quote.requestId,'dispatched',3],
        [second.quote.requestId,'dispatched',3],
        [legacyQuote.requestId,'released',3]]);
      const ordinaryStates=await migrator.unsafe(`SELECT request_id,state
        FROM ${g}.user_budget_reservations
        WHERE request_id IN ($1,$2,$3) ORDER BY request_id`,
        [first.quote.requestId,second.quote.requestId,legacyQuote.requestId]);
      assert.deepEqual(ordinaryStates.map(x=>[x.request_id,x.state]),[
        [first.quote.requestId,'dispatched'],
        [second.quote.requestId,'dispatched'],
        [legacyQuote.requestId,'released']]);
      stage('both-scanners-continue-past-expired-enrolled-prefix-to-legacy-rows');

      const forfeitQuote=await issueQuote(bearer,'v366-98-legacy-forfeit');
      assert.equal((await admit(forfeitQuote)).status,'admitted');
      await cluster.admin.begin(async tx=>{
        await tx.unsafe(`SET LOCAL session_replication_role='replica'`);
        await tx.unsafe(`UPDATE ${g}.user_budget_reservations
          SET state='dispatched',dispatched_at=now()
          WHERE request_id=$1`,[forfeitQuote.requestId]);
        await tx.unsafe(`UPDATE ${g}.guardrail_budget_reservations
          SET state='dispatched',dispatched_at=now()
          WHERE request_id=$1`,[forfeitQuote.requestId]);
      });
      await assert.rejects(recovery.begin(async tx=>{
        await tx.unsafe(`SELECT ${g}.forfeit_user_budget_dispatched_v354(
          $1,now(),$2)`, [forfeitQuote.requestId,'unknown_provider_outcome']);
        throw new Error('test-forfeit-rollback');
      }),/test-forfeit-rollback/u);
      const [afterRollback]=await migrator.unsafe(`SELECT state FROM
        ${g}.user_budget_reservations WHERE request_id=$1`,[forfeitQuote.requestId]);
      assert.equal(afterRollback.state,'dispatched');
      assert.equal(await guardrailForfeit(forfeitQuote.requestId),3);
      assert.equal(await ordinaryForfeit(forfeitQuote.requestId),1);
      await migrator.begin(async tx=>{
        await tx.unsafe(`SELECT id FROM ${g}.users
          WHERE id='v361-user' FOR UPDATE`);
        assert.equal(await ordinaryForfeit(forfeitQuote.requestId),1);
      });
      const laterGrant=await grant(await claimFor(forfeitQuote));
      assert.notEqual(laterGrant.status,'grant_recorded');
      const [noGrant]=await migrator.unsafe(`SELECT count(*)::integer AS n FROM
        ${g}.complete_text_attempt_grants_v362 WHERE request_id=$1`,
        [forfeitQuote.requestId]);
      assert.equal(noGrant.n,0);
      stage('legacy-forfeit-commits-or-rolls-back-atomically-and-later-grant-fails');

      const prepareDispatchedLegacy=async(id)=>{
        const quote=await issueQuote(bearer,id);
        assert.equal((await admit(quote)).status,'admitted');
        await cluster.admin.begin(async tx=>{
          await tx.unsafe(`SET LOCAL session_replication_role='replica'`);
          await tx.unsafe(`UPDATE ${g}.user_budget_reservations
            SET state='dispatched',dispatched_at=now()
            WHERE request_id=$1`,[quote.requestId]);
          await tx.unsafe(`UPDATE ${g}.guardrail_budget_reservations
            SET state='dispatched',dispatched_at=now()
            WHERE request_id=$1`,[quote.requestId]);
        });
        return quote;
      };
      const waitForLock=async(label)=>{
        for(let attempt=0;attempt<40;attempt++){
          const [waiter]=await cluster.admin.unsafe(`SELECT count(*)::integer AS n
            FROM pg_catalog.pg_stat_activity WHERE application_name=$1
              AND wait_event_type='Lock'`,[`complete-send-start-v365-${label}`]);
          if(waiter.n>0)return;
          await new Promise(resolve=>setTimeout(resolve,50));
        }
        assert.fail(`${label} did not reach a native PostgreSQL lock wait`);
      };
      const raceLegacyA=await prepareDispatchedLegacy('v366-95-lock-legacy-a');
      const raceGrantA=await issueGranted('v366-96-lock-grant-a');
      const raceRunA=randomUUID();
      assert.equal((await custody(raceGrantA.result.grantId,raceRunA)).status,
        'custody_claim_recorded');
      let releaseA,readyAResolve,readyAReject;
      const gateA=new Promise(resolve=>{releaseA=resolve;});
      const readyA=new Promise((resolve,reject)=>{
        readyAResolve=resolve;readyAReject=reject;
      });
      const heldStart=holder.begin(async tx=>{
        try{
          const [row]=await tx.unsafe(`SELECT
            ${g}.record_complete_text_send_start_v365(
              $1::uuid,$2::uuid,1,$3) AS value`,
            [raceGrantA.result.grantId,raceRunA,
              raceGrantA.grantClaim.outboundBodySha256]);
          assert.equal(row.value.status,'start_recorded');
          readyAResolve();
          await gateA;
        }catch(error){readyAReject(error);throw error;}
      });
      await readyA;
      const waitingForfeit=Promise.resolve(admission.unsafe(`SELECT
        ${g}.forfeit_guardrail_budgets_v353($1,$2) AS n`,
        [raceLegacyA.requestId,'unknown_provider_outcome']));
      try{await waitForLock('admission');}finally{releaseA();}
      const [,forfeitResult]=await Promise.all([heldStart,waitingForfeit]);
      assert.equal(forfeitResult[0].n,3);
      stage('native-start-before-other-request-forfeit-waits-without-table-window-cycle');

      const raceLegacyB=await prepareDispatchedLegacy('v366-97-lock-legacy-b');
      const raceGrantB=await issueGranted('v366-98-lock-grant-b');
      const raceRunB=randomUUID();
      assert.equal((await custody(raceGrantB.result.grantId,raceRunB)).status,
        'custody_claim_recorded');
      let releaseB,readyBResolve,readyBReject;
      const gateB=new Promise(resolve=>{releaseB=resolve;});
      const readyB=new Promise((resolve,reject)=>{
        readyBResolve=resolve;readyBReject=reject;
      });
      const heldForfeit=admission.begin(async tx=>{
        try{
          const [row]=await tx.unsafe(`SELECT
            ${g}.forfeit_guardrail_budgets_v353($1,$2) AS n`,
            [raceLegacyB.requestId,'unknown_provider_outcome']);
          assert.equal(row.n,3);
          readyBResolve();
          await gateB;
        }catch(error){readyBReject(error);throw error;}
      });
      await readyB;
      const waitingStart=Promise.resolve(holder.unsafe(`SELECT
        ${g}.record_complete_text_send_start_v365(
          $1::uuid,$2::uuid,1,$3) AS value`,
        [raceGrantB.result.grantId,raceRunB,
          raceGrantB.grantClaim.outboundBodySha256]));
      try{await waitForLock('holder');}finally{releaseB();}
      const [,startResult]=await Promise.all([heldForfeit,waitingStart]);
      assert.equal(startResult[0].value.status,'start_recorded');
      stage('native-other-request-forfeit-before-start-waits-without-table-window-cycle');

      // A legacy request can share both the user and every budget window with
      // an enrolled complete-text grant. Counter-row identity alone cannot
      // distinguish its settlement from a forged update of the grant.
      const sharedLegacyQuote=await issueQuote(bearer,'v367-legacy-shared-counter');
      assert.equal((await admit(sharedLegacyQuote)).status,'admitted');
      const [sharedOrdinary]=await migrator.unsafe(`SELECT request_id,user_id,
        reserved_micros,state FROM ${g}.user_budget_reservations
        WHERE request_id=$1`,[sharedLegacyQuote.requestId]);
      const sharedGuardrails=await migrator.unsafe(`SELECT workspace_id,
        scope_type,scope_id,period,period_start,reserved_micros,state
        FROM ${g}.guardrail_budget_reservations WHERE request_id=$1
        ORDER BY workspace_id,scope_type,scope_id,period,period_start`,
        [sharedLegacyQuote.requestId]);
      assert.equal(sharedOrdinary.state,'reserved');
      assert.equal(sharedGuardrails.length,3);
      const [overlap]=await migrator.unsafe(`SELECT
        (SELECT count(*)::integer FROM ${g}.complete_text_attempt_grants_v362 grant_row
          JOIN ${g}.user_budget_reservations hold_row
            ON hold_row.request_id=grant_row.request_id
          WHERE hold_row.user_id=$1 AND hold_row.state='dispatched') AS user_grants,
        (SELECT count(*)::integer FROM ${g}.guardrail_budget_reservations
          legacy_row JOIN ${g}.guardrail_budget_reservations grant_hold
            ON (legacy_row.workspace_id,legacy_row.scope_type,
              legacy_row.scope_id,legacy_row.period,legacy_row.period_start)
             =(grant_hold.workspace_id,grant_hold.scope_type,
              grant_hold.scope_id,grant_hold.period,grant_hold.period_start)
          JOIN ${g}.complete_text_attempt_grants_v362 grant_row
            ON grant_row.request_id=grant_hold.request_id
          WHERE legacy_row.request_id=$2 AND grant_hold.state='dispatched')
            AS shared_windows`,[sharedOrdinary.user_id,sharedLegacyQuote.requestId]);
      assert.ok(overlap.user_grants>0);
      assert.ok(overlap.shared_windows>=3);
      stage('ungranted-legacy-request-shares-user-and-windows-with-enrolled-grants',
        {overlap});

      // Deliberately test, then remove, the tempting row-level guard. This is
      // fixture-only DDL: it is not a v367 production proposal.
      await migrator.unsafe(`CREATE FUNCTION ${g}.v367_fixture_reject_shared_counter()
        RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path TO pg_catalog,pg_temp AS $naive$
        BEGIN
          IF TG_RELID='${g}.users'::regclass THEN
            IF EXISTS (
              SELECT 1 FROM ${g}.complete_text_attempt_grants_v362 grant_row
              JOIN ${g}.user_budget_reservations hold_row
                ON hold_row.request_id=grant_row.request_id
              WHERE hold_row.user_id=NEW.id) THEN
              RAISE EXCEPTION 'shared grant user counter blocked'
                USING ERRCODE='23514';
            END IF;
          ELSIF TG_RELID='${g}.guardrail_budget_windows'::regclass THEN
            IF EXISTS (
              SELECT 1 FROM ${g}.complete_text_attempt_grants_v362 grant_row
              JOIN ${g}.guardrail_budget_reservations hold_row
                ON hold_row.request_id=grant_row.request_id
              WHERE (hold_row.workspace_id,hold_row.scope_type,
                hold_row.scope_id,hold_row.period,hold_row.period_start)
               =(NEW.workspace_id,NEW.scope_type,NEW.scope_id,
                 NEW.period,NEW.period_start)) THEN
              RAISE EXCEPTION 'shared grant window counter blocked'
                USING ERRCODE='23514';
            END IF;
          END IF;
          RETURN NEW;
        END $naive$;
        CREATE TRIGGER v367_fixture_user_counter_guard
          BEFORE UPDATE OF budget_spent,budget_reserved_micros
          ON ${g}.users FOR EACH ROW EXECUTE FUNCTION
          ${g}.v367_fixture_reject_shared_counter();
        CREATE TRIGGER v367_fixture_window_counter_guard
          BEFORE UPDATE OF reserved_micros,settled_micros
          ON ${g}.guardrail_budget_windows FOR EACH ROW EXECUTE FUNCTION
          ${g}.v367_fixture_reject_shared_counter();`).simple();
      await denied(buyer.unsafe(`UPDATE ${g}.users
        SET budget_reserved_micros=budget_reserved_micros-$1
        WHERE id=$2`,[Number(sharedOrdinary.reserved_micros),sharedOrdinary.user_id]),
        '23514');
      const sharedWindow=sharedGuardrails[0];
      await denied(buyer.unsafe(`UPDATE ${g}.guardrail_budget_windows
        SET reserved_micros=reserved_micros-$1
        WHERE workspace_id=$2 AND scope_type=$3 AND scope_id=$4
          AND period=$5 AND period_start=$6`,[
          Number(sharedWindow.reserved_micros),sharedWindow.workspace_id,
          sharedWindow.scope_type,sharedWindow.scope_id,sharedWindow.period,
          sharedWindow.period_start]),'23514');
      await migrator.unsafe(`DROP TRIGGER v367_fixture_user_counter_guard
          ON ${g}.users;
        DROP TRIGGER v367_fixture_window_counter_guard
          ON ${g}.guardrail_budget_windows;
        DROP FUNCTION ${g}.v367_fixture_reject_shared_counter();`).simple();
      stage('blanket-grant-aware-row-guards-reject-legitimate-legacy-counter-deltas');

      // Current v349 buyer DML succeeds when those blanket guards are absent.
      // This is the counter/hold portion of its real transaction, with the
      // ordinary user update before its reservation update, then Guardrail
      // reservation updates before window updates.
      await buyer.begin(async tx=>{
        await tx.unsafe(`UPDATE ${g}.users SET
          budget_reserved_micros=budget_reserved_micros-$1,
          budget_spent=budget_spent+0.000001,updated_at=now()
          WHERE id=$2`,[Number(sharedOrdinary.reserved_micros),sharedOrdinary.user_id]);
        await tx.unsafe(`UPDATE ${g}.user_budget_reservations SET
          state='settled',settled_micros=1,terminal_at=now(),
          terminal_reason='v367_native_legacy',updated_at=now()
          WHERE request_id=$1 AND state='reserved'`,[sharedLegacyQuote.requestId]);
        const claimed=await tx.unsafe(`UPDATE ${g}.guardrail_budget_reservations
          SET state='settled',settled_micros=1,terminal_at=now(),
            terminal_reason='v367_native_legacy',updated_at=now()
          WHERE request_id=$1 AND state='reserved'
          RETURNING workspace_id,scope_type,scope_id,period,period_start,
            reserved_micros`,[sharedLegacyQuote.requestId]);
        assert.equal(claimed.length,3);
        for(const row of claimed){
          const updated=await tx.unsafe(`UPDATE ${g}.guardrail_budget_windows
            SET reserved_micros=reserved_micros-$1,
              settled_micros=settled_micros+1,updated_at=now()
            WHERE workspace_id=$2 AND scope_type=$3 AND scope_id=$4
              AND period=$5 AND period_start=$6 RETURNING workspace_id`,[
              Number(row.reserved_micros),row.workspace_id,row.scope_type,
              row.scope_id,row.period,row.period_start]);
          assert.equal(updated.length,1);
        }
      });
      const [legacyAfter]=await migrator.unsafe(`SELECT state,settled_micros
        FROM ${g}.user_budget_reservations WHERE request_id=$1`,
        [sharedLegacyQuote.requestId]);
      const [grantedAfter]=await migrator.unsafe(`SELECT count(*)::integer AS n
        FROM ${g}.user_budget_reservations hold_row
        JOIN ${g}.complete_text_attempt_grants_v362 grant_row
          ON grant_row.request_id=hold_row.request_id
        WHERE hold_row.user_id=$1 AND hold_row.state='dispatched'`,
        [sharedOrdinary.user_id]);
      assert.equal(legacyAfter.state,'settled');
      assert.equal(Number(legacyAfter.settled_micros),1);
      assert.ok(grantedAfter.n>0);
      stage('legacy-buyer-counter-and-hold-deltas-commit-beside-frozen-grants');

      const anotherLegacy=await issueQuote(bearer,'v367-legacy-after-revoke');
      assert.equal((await admit(anotherLegacy)).status,'admitted');
      await migrator.unsafe(`REVOKE UPDATE
          (budget_spent,budget_reserved_micros,updated_at)
          ON ${g}.users FROM ${roles.buyer};
        REVOKE UPDATE ON ${g}.guardrail_budget_windows
          FROM ${roles.buyer};`).simple();
      await denied(buyer.unsafe(`UPDATE ${g}.users
        SET budget_spent=budget_spent+0.000001 WHERE id='v361-user'`));
      await denied(buyer.unsafe(`UPDATE ${g}.guardrail_budget_windows
        SET settled_micros=settled_micros+1
        WHERE workspace_id='v361-workspace'`));
      const [revokeAcl]=await migrator.unsafe(`SELECT
        pg_catalog.has_column_privilege('${roles.buyer}',
          '${g}.users','budget_spent','UPDATE') AS user_update,
        pg_catalog.has_table_privilege('${roles.buyer}',
          '${g}.guardrail_budget_windows','UPDATE') AS window_update`);
      assert.deepEqual(revokeAcl,{user_update:false,window_update:false});
      stage('bare-revoke-closes-bypass-and-breaks-current-legacy-buyer-writer',
        {revokeAcl});

      await grantPostgresBuyerGuardrailSplitV349({DATABASE_URL:migratorUrl});
      const [rerunAcl]=await migrator.unsafe(`SELECT
        pg_catalog.has_column_privilege('${roles.buyer}',
          '${g}.users','budget_spent','UPDATE') AS user_update,
        pg_catalog.has_table_privilege('${roles.buyer}',
          '${g}.guardrail_budget_windows','UPDATE') AS window_update`);
      assert.deepEqual(rerunAcl,{user_update:true,window_update:true});
      stage('v349-grant-runner-reopens-revoked-buyer-counter-rights',
        {rerunAcl});

      const writerSql=await readFile(proposal(
        'complete-text-legacy-buyer-held-writer-v368.sql'),'utf8');
      const policySql=await readFile(proposal(
        'buyer-split-counter-grant-policy-v368.sql'),'utf8');
      report.sourceSha256['complete-text-legacy-buyer-held-writer-v368.sql']=sha(writerSql);
      report.sourceSha256['buyer-split-counter-grant-policy-v368.sql']=sha(policySql);
      await assert.rejects(migrator.begin(tx=>tx.unsafe(writerSql).simple()),
        /activation or dependency differs/u);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`SET LOCAL
          cinatoken.legacy_buyer_held_writer_v368_activation='reviewed-v1'`);
        await tx.unsafe(writerSql).simple();
        await tx.unsafe(policySql).simple();
      }),/activation or dependency differs/u);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`SET LOCAL
          cinatoken.legacy_buyer_held_writer_v368_activation='reviewed-v1'`);
        await tx.unsafe(`SET LOCAL
          cinatoken.buyer_counter_grant_policy_v368_activation='reviewed-v1'`);
        await tx.unsafe(writerSql).simple();
        await tx.unsafe(`CREATE OR REPLACE FUNCTION
          ${g}.settle_legacy_buyer_held_v368(
            p_request_id text,p_ordinary_micros bigint,
            p_guardrail_micros bigint,p_reason text)
          RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
          SET search_path TO pg_catalog, pg_temp
          AS $drift$ BEGIN RETURN '{"status":"forged"}'::jsonb; END $drift$`);
        await tx.unsafe(policySql).simple();
      }),/activation or dependency differs/u);
      stage('v368-revoke-preflight-rejects-replaced-writer-body');
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`SET LOCAL
          cinatoken.legacy_buyer_held_writer_v368_activation='reviewed-v1'`);
        await tx.unsafe(`SET LOCAL
          cinatoken.buyer_counter_grant_policy_v368_activation='reviewed-v1'`);
        await tx.unsafe(writerSql).simple();
        await tx.unsafe(policySql).simple();
        throw new Error('v368-deliberate-cutover-rollback');
      }),/v368-deliberate-cutover-rollback/u);
      const [rolledBack368]=await migrator.unsafe(`SELECT
        pg_catalog.to_regprocedure(
          '${g}.settle_legacy_buyer_held_v368(text,bigint,bigint,text)') IS NULL
          AS no_writer,
        pg_catalog.to_regprocedure(
          '${g}.buyer_split_counter_policy_v368()') IS NULL AS no_marker,
        pg_catalog.has_column_privilege('${roles.buyer}',
          '${g}.users','budget_spent','UPDATE') AS direct_user,
        pg_catalog.has_table_privilege('${roles.buyer}',
          '${g}.guardrail_budget_windows','UPDATE') AS direct_window`);
      assert.deepEqual(rolledBack368,{no_writer:true,no_marker:true,
        direct_user:true,direct_window:true});
      stage('v368-default-off-and-deliberate-rollback-leave-old-policy-intact',
        {rolledBack368});

      await migrator.begin(async tx=>{
        await tx.unsafe(`SET LOCAL
          cinatoken.legacy_buyer_held_writer_v368_activation='reviewed-v1'`);
        await tx.unsafe(`SET LOCAL
          cinatoken.buyer_counter_grant_policy_v368_activation='reviewed-v1'`);
        await tx.unsafe(writerSql).simple();
        await tx.unsafe(policySql).simple();
      });
      const [cutoverAcl]=await migrator.unsafe(`SELECT
        pg_catalog.has_column_privilege('${roles.buyer}',
          '${g}.users','budget_spent','UPDATE') AS direct_user,
        pg_catalog.has_any_column_privilege('${roles.buyer}',
          '${g}.user_budget_reservations','UPDATE') AS direct_ordinary,
        pg_catalog.has_table_privilege('${roles.buyer}',
          '${g}.guardrail_budget_reservations','UPDATE') AS direct_guardrail,
        pg_catalog.has_table_privilege('${roles.buyer}',
          '${g}.guardrail_budget_windows','UPDATE') AS direct_window,
        pg_catalog.has_function_privilege('${roles.buyer}',
          '${g}.settle_legacy_buyer_held_v368(text,bigint,bigint,text)',
          'EXECUTE') AS wrapper,
        pg_catalog.has_function_privilege('${roles.runtime}',
          '${g}.settle_legacy_buyer_held_v368(text,bigint,bigint,text)',
          'EXECUTE') AS runtime_wrapper,
        (SELECT count(*)::integer FROM pg_catalog.pg_trigger
          WHERE tgname IN ('complete_text_ordinary_hold_fence_v366',
            'complete_text_guardrail_hold_fence_v366')
            AND NOT tgisinternal AND tgenabled='O') AS frozen_triggers`);
      assert.deepEqual(cutoverAcl,{direct_user:false,direct_ordinary:false,
        direct_guardrail:false,direct_window:false,wrapper:true,
        runtime_wrapper:false,frozen_triggers:2});
      stage('v368-atomic-policy-removes-direct-writes-and-keeps-v366-fences',
        {cutoverAcl});

      await denied(buyer.unsafe(`UPDATE ${g}.users
        SET budget_spent=budget_spent+0.000001 WHERE id='v361-user'`));
      await denied(buyer.unsafe(`UPDATE ${g}.user_budget_reservations
        SET state='settled' WHERE request_id=$1`,[anotherLegacy.requestId]));
      await denied(buyer.unsafe(`UPDATE ${g}.guardrail_budget_reservations
        SET state='settled' WHERE request_id=$1`,[anotherLegacy.requestId]));
      await denied(buyer.unsafe(`UPDATE ${g}.guardrail_budget_windows
        SET settled_micros=settled_micros+1
        WHERE workspace_id='v361-workspace'`));
      await denied(runtime.unsafe(`SELECT ${g}.settle_legacy_buyer_held_v368(
        $1,1,1,'runtime_forbidden')`,[anotherLegacy.requestId]));
      stage('buyer-direct-counter-and-hold-bypass-denied-after-policy');

      await denied(buyer.unsafe(`SELECT ${g}.settle_legacy_buyer_held_v368(
        $1,1,1,'grant_forbidden')`,[first.quote.requestId]),'23514');
      const [anotherOrdinary]=await migrator.unsafe(`SELECT reserved_micros
        FROM ${g}.user_budget_reservations WHERE request_id=$1`,
        [anotherLegacy.requestId]);
      await denied(buyer.unsafe(`SELECT ${g}.settle_legacy_buyer_held_v368(
        $1,$2,1,'amount_overrun')`,
        [anotherLegacy.requestId,Number(anotherOrdinary.reserved_micros)+1]),
        '23514');
      stage('grant-linked-request-and-unverified-over-reserve-amount-rejected');

      const snapshot=async()=>{
        const [account]=await migrator.unsafe(`SELECT budget_spent,
          budget_reserved_micros FROM ${g}.users WHERE id='v361-user'`);
        const [ordinary]=await migrator.unsafe(`SELECT state,settled_micros
          FROM ${g}.user_budget_reservations WHERE request_id=$1`,
          [anotherLegacy.requestId]);
        const windows=await migrator.unsafe(`SELECT scope_type,scope_id,
          reserved_micros,settled_micros FROM ${g}.guardrail_budget_windows
          WHERE workspace_id='v361-workspace'
          ORDER BY scope_type,scope_id`);
        return {account,ordinary,windows};
      };
      const before368=await snapshot();
      await assert.rejects(buyer.begin(async tx=>{
        const [row]=await tx.unsafe(`SELECT ${g}.settle_legacy_buyer_held_v368(
          $1,1,1,'native_rollback') AS value`,[anotherLegacy.requestId]);
        assert.equal(row.value.status,'legacy_settled');
        throw new Error('v368-buyer-rollback');
      }),/v368-buyer-rollback/u);
      assert.deepEqual(await snapshot(),before368);
      stage('request-scoped-buyer-rollback-restores-all-counter-and-hold-rows');

      const buyerUrl=`postgres://${roles.buyer}:${passwords.buyer}`
        +`@127.0.0.1:${cluster.port}/postgres`;
      await assert.rejects(settlePostgresLegacyBuyerHeldV368({
        buyerConnectionString:migratorUrl,requestId:anotherLegacy.requestId,
        ordinarySettledMicros:1,guardrailSettledMicros:1,
        reason:'wrong_login'}),/connection invalid/u);
      const committed=await settlePostgresLegacyBuyerHeldV368({
        buyerConnectionString:buyerUrl,requestId:anotherLegacy.requestId,
        ordinarySettledMicros:1,guardrailSettledMicros:1,
        reason:'native_legacy_settled'});
      assert.equal(committed.status,'legacy_settled');
      assert.equal(committed.commitAcknowledged,true);
      assert.equal(committed.guardrailRows,3);
      const after368=await snapshot();
      assert.equal(after368.ordinary.state,'settled');
      assert.equal(Number(after368.ordinary.settled_micros),1);
      assert.equal(Number(after368.account.budget_reserved_micros),
        Number(before368.account.budget_reserved_micros)
          -Number(anotherOrdinary.reserved_micros));
      assert.equal(Number(after368.account.budget_spent),
        Number(before368.account.budget_spent)+0.000001);
      stage('dedicated-buyer-client-commits-shared-account-legacy-settlement',
        {guardrailRows:committed.guardrailRows});

      await assert.rejects(grantPostgresBuyerGuardrailSplitV349(
        {DATABASE_URL:migratorUrl}),/drift or dependency differs/u);
      await assert.rejects(grantPostgresBuyerSplitV348(
        {DATABASE_URL:migratorUrl}),/drift or dependency differs/u);
      const [afterOldRunner]=await migrator.unsafe(`SELECT
        pg_catalog.has_column_privilege('${roles.buyer}',
          '${g}.users','budget_spent','UPDATE') AS user_update,
        pg_catalog.has_table_privilege('${roles.buyer}',
          '${g}.guardrail_budget_windows','UPDATE') AS window_update`);
      assert.deepEqual(afterOldRunner,{user_update:false,window_update:false});
      stage('v348-and-v349-grant-reruns-fail-before-counter-regrant',
        {afterOldRunner});

      // v369 transaction seam: stage the narrow v368 settlement through the
      // same Drizzle tx object that inserts the buyer log and v2 economic event.
      await migrator.unsafe(`INSERT INTO ${g}.users
          (id,email,budget_max) VALUES
          ('v369-seller','v369-seller@example.invalid',10);
        INSERT INTO ${g}.user_earnings(user_id) VALUES('v369-seller');
        INSERT INTO ${g}.shared_keys
          (id,seller_user_id,channel_type,api_key,key_fingerprint,status)
          VALUES('v369-shared-key','v369-seller','openai',
            'synthetic-upstream-v369','synthetic-fingerprint-v369','active');
        INSERT INTO cinatoken_economic_quotes.shared_key_quote_versions
          (version_id,shared_key_id,seller_user_id,input_price_per_million,
            output_price_per_million,cache_read_price_per_million,
            cache_write_price_per_million,commission_rate,currency,price_unit,
            billing_mode,entitlement_version)
          VALUES('v369-quote','v369-shared-key','v369-seller',1.25,2.5,0.1,0.2,
            0.1,'USD','per_million_tokens','shared_seller_key','synthetic-v1');
        INSERT INTO cinatoken_economic_quotes.shared_key_quote_transitions
          (transition_id,shared_key_id,supersedes_transition_id,transition_kind,
            quote_version_id,seller_user_id)
          VALUES('v369-transition','v369-shared-key',NULL,'activate',
            'v369-quote','v369-seller');`).simple();
      const sameTxQuote=await issueQuote(bearer,'v369-same-buyer-transaction');
      assert.equal((await admit(sameTxQuote)).status,'admitted');
      const [sameTxClaim]=await sharedProducer.unsafe(`SELECT * FROM
        cinatoken_economic_quotes.claim_shared_key_dispatch_quote_attempt(
          $1::uuid,$2,1,'v369-shared-key','synthetic-target-v369')`,
        [randomUUID(),sameTxQuote.requestId]);
      assert.equal(sameTxClaim.request_log_id,sameTxQuote.requestId);
      const sameTxPayload=JSON.stringify([{
        attempt_id:sameTxClaim.attempt_id,attempt_index:1,
        shared_key_id:sameTxClaim.shared_key_id,
        transition_id:sameTxClaim.transition_id,
        quote_version_id:sameTxClaim.quote_version_id,
        usage_certainty:'actual',input_tokens:10,output_tokens:5,
        cache_read_tokens:0,cache_write_tokens:0,
        provider_cost_certainty:'unknown',provider_cost_micros:null,
        evidence_kind:'provider_usage',evidence_sha256:'a'.repeat(64),
        observed_at:new Date().toISOString()}]);
      const sameTxDb=drizzle(buyer,{schema:pgCoreSchema});
      const sameTxState=async()=>{
        const [row]=await migrator.unsafe(`SELECT
          (SELECT budget_spent::text FROM ${g}.users
            WHERE id='v361-user') AS spent,
          (SELECT budget_reserved_micros::text FROM ${g}.users
            WHERE id='v361-user') AS reserved,
          (SELECT state FROM ${g}.user_budget_reservations
            WHERE request_id=$1) AS ordinary_state,
          (SELECT count(*)::int FROM ${g}.guardrail_budget_reservations
            WHERE request_id=$1 AND state='settled') AS guardrail_settled,
          (SELECT count(*)::int FROM ${g}.api_key_request_logs
            WHERE id=$1) AS logs,
          (SELECT count(*)::int FROM ${g}.user_audit_logs
            WHERE request_log_id=$1) AS audits,
          (SELECT count(*)::int FROM
            cinatoken_economic_outbox.shared_key_economic_events
            WHERE request_log_id=$1) AS events,
          (SELECT count(*)::int FROM
            cinatoken_economic_outbox.shared_key_economic_event_attempts
            WHERE request_log_id=$1) AS event_attempts`,
          [sameTxQuote.requestId]);
        return row;
      };
      const runSameTx=async()=>sameTxDb.transaction(async tx=>{
        const [identity]=await tx.execute(drizzleSql`SELECT
          pg_catalog.pg_current_xact_id()::text AS xact_id`);
        const staged=await stageLegacyBuyerHeldSettlementV369(tx,{
          requestId:sameTxQuote.requestId,ordinarySettledMicros:1,
          guardrailSettledMicros:1,reason:'v369_same_transaction'});
        assert.equal(staged.status,'staged_legacy_settlement');
        assert.equal(staged.guardrailRows,3);
        await tx.execute(drizzleSql`INSERT INTO
          cinatoken_gateway.api_key_request_logs
          (id,user_id,api_key_id,workspace_id,charged_cost,
            budget_charged_micros,input_tokens,output_tokens,
            cache_read_tokens,cache_write_tokens)
          VALUES(${sameTxQuote.requestId},'v361-user','v361-key',
            'v361-workspace',0.000001,1,10,5,0,0)`);
        const [event]=await tx.execute(drizzleSql`SELECT
          cinatoken_economic_outbox.write_shared_key_economic_event_v2(
            ${sameTxQuote.requestId},'actual','actual',1,
            ${sameTxPayload}::jsonb,'create') AS outcome`);
        assert.equal(event.outcome,'inserted');
        await tx.execute(drizzleSql`INSERT INTO
          cinatoken_gateway.user_audit_logs
          (id,user_id,api_key_id,event_type,request_log_id)
          VALUES(${`v369-audit-${sameTxQuote.requestId}`},
            'v361-user','v361-key','usage_charge',${sameTxQuote.requestId})`);
        const [after]=await tx.execute(drizzleSql`SELECT
          pg_catalog.pg_current_xact_id()::text AS xact_id`);
        assert.equal(after.xact_id,identity.xact_id);
        return identity.xact_id;
      });
      const beforeSameTx=await sameTxState();
      await assert.rejects(sameTxDb.transaction(async tx=>{
        const [identity]=await tx.execute(drizzleSql`SELECT
          pg_catalog.pg_current_xact_id()::text AS xact_id`);
        const staged=await stageLegacyBuyerHeldSettlementV369(tx,{
          requestId:sameTxQuote.requestId,ordinarySettledMicros:1,
          guardrailSettledMicros:1,reason:'v369_rollback'});
        assert.equal(staged.status,'staged_legacy_settlement');
        await tx.execute(drizzleSql`INSERT INTO
          cinatoken_gateway.api_key_request_logs
          (id,user_id,api_key_id,workspace_id,charged_cost,
            budget_charged_micros,input_tokens,output_tokens,
            cache_read_tokens,cache_write_tokens)
          VALUES(${sameTxQuote.requestId},'v361-user','v361-key',
            'v361-workspace',0.000001,1,10,5,0,0)`);
        const [event]=await tx.execute(drizzleSql`SELECT
          cinatoken_economic_outbox.write_shared_key_economic_event_v2(
            ${sameTxQuote.requestId},'actual','actual',1,
            ${sameTxPayload}::jsonb,'create') AS outcome`);
        assert.equal(event.outcome,'inserted');
        await tx.execute(drizzleSql`INSERT INTO
          cinatoken_gateway.user_audit_logs
          (id,user_id,api_key_id,event_type,request_log_id)
          VALUES(${`v369-audit-${sameTxQuote.requestId}`},
            'v361-user','v361-key','usage_charge',${sameTxQuote.requestId})`);
        const [after]=await tx.execute(drizzleSql`SELECT
          pg_catalog.pg_current_xact_id()::text AS xact_id`);
        assert.equal(after.xact_id,identity.xact_id);
        throw new Error('v369-deliberate-full-buyer-transaction-rollback');
      }),/v369-deliberate-full-buyer-transaction-rollback/u);
      assert.deepEqual(await sameTxState(),beforeSameTx);
      stage('v369-same-buyer-transaction-rollback-removes-holds-log-audit-event');

      const committedXid=await runSameTx();
      const afterSameTx=await sameTxState();
      assert.equal(afterSameTx.ordinary_state,'settled');
      assert.equal(afterSameTx.guardrail_settled,3);
      assert.equal(afterSameTx.logs,1);
      assert.equal(afterSameTx.audits,1);
      assert.equal(afterSameTx.events,1);
      assert.equal(afterSameTx.event_attempts,1);
      assert.equal(Number(afterSameTx.spent),Number(beforeSameTx.spent)+0.000001);
      const [sameTxReceipt]=await migrator.unsafe(`SELECT
        e.buyer_debit_micros::text AS debit,
        m.log_xact_id::text AS log_xact_id,
        r.xact_id::text AS receipt_xact_id,
        r.spent_delta_micros::text AS spent_delta
        FROM cinatoken_economic_outbox.shared_key_economic_events e
        JOIN cinatoken_economic_outbox.shared_key_economic_producer_tx_markers m
          ON m.request_log_id=e.request_log_id
        JOIN cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts r
          ON r.xact_id=m.log_xact_id AND r.user_id=e.buyer_user_id
        WHERE e.request_log_id=$1`,[sameTxQuote.requestId]);
      assert.deepEqual(sameTxReceipt,{debit:'1',log_xact_id:committedXid,
        receipt_xact_id:committedXid,spent_delta:'1.000000'});
      stage('v369-same-buyer-transaction-commits-holds-log-audit-v2-event',
        {sameTxReceipt});

      report.status='PASS';
    } catch(error) {
      failure=error;report.status='FAIL';
      const cause=error?.cause??error;
      report.failure={code:cause?.code??null,constraint:cause?.constraint_name??null,
        message:String(error?.stack??error).slice(0,5000)};
    } finally {
      await Promise.allSettled(clients.map(c=>c.end({timeout:1})));
      try {await cluster.cleanup();report.cleanup='PASS';}
      catch(error) {report.cleanup='FAIL';report.cleanupError=String(error).slice(0,1500);
        failure??=error;}
      await writeFile(reportUrl,JSON.stringify(report,null,2)+'\n');
      process.stdout.write(`complete-text-legacy-buyer-held-v368-report=${reportUrl.pathname}\n`);
    }
    if(failure) throw failure;
    assert.equal(report.cleanup,'PASS');
  });
