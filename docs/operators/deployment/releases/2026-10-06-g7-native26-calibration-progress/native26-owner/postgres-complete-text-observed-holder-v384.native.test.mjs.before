// Owned PostgreSQL 18.6 proof of one private-holder POST and its v366 fact.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import postgres from 'postgres';
import { encryptSharedKeySecret } from '@octafuse/core';
import { computeRouteDataPolicySubjectFingerprintFromRows } from '../../../packages/core/src/route-data-policy.ts';
import { grantPostgresCompleteTextAttemptV362 } from '../../../packages/proxy/src/services/postgres-complete-text-attempt-grant-v362.ts';
import { readPostgresPrivateCompleteTextRouteV366 } from '../../../packages/proxy/src/services/postgres-private-complete-text-reader-v366.ts';
import { createPrivateCompleteTextHolderV365 } from '../../../packages/proxy/src/services/private-complete-text-holder-v365.ts';
import { createObservedPrivateCompleteTextHolderV384,
  fetchInvokedEvidenceNonceV384,
} from '../../../packages/proxy/src/services/private-complete-text-observed-holder-v384.ts';
import { appendPostgresCompleteTextHolderFactV367 } from '../../../packages/proxy/src/services/postgres-complete-text-result-facts-v367.ts';
import { claimPostgresCompleteTextCustodyV365,
  recordPostgresCompleteTextSendStartV365,
  PostgresCompleteTextSendStartRejectedError,
} from '../../../packages/proxy/src/services/postgres-complete-text-send-start-v365.ts';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';
import { activatePostgresBuyerSplitV348 } from './activate-postgres-buyer-split-v348.ts';
import { grantPostgresBuyerSplitV348 } from './grant-postgres-buyer-split-v348.ts';
import { activatePostgresBuyerGuardrailSplitV349 } from './activate-postgres-buyer-guardrail-split-v349.ts';
import { grantPostgresBuyerGuardrailSplitV349 } from './grant-postgres-buyer-guardrail-split-v349.ts';

const g='cinatoken_gateway';
const migrationDir=new URL('../../../packages/core/migrations-postgres/',import.meta.url);
const proposal=name=>new URL(`../../../packages/core/migrations-proposals/postgres/${name}`,import.meta.url);
const reportUrl=new URL('../../../docs/developers/architecture/implementation-evidence/C04-complete-text-observed-holder-v384-report.json',import.meta.url);
const sha=value=>createHash('sha256').update(value).digest('hex');
const providerSecret='v367-local-provider-kek-with-no-production-use';
const providerBearer='v367-local-provider-bearer';
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
  reader:'cinatoken_gateway_complete_text_private_reader',
  bill:'cinatoken_gateway_complete_text_provider_bill'};

function connection(cluster,name,password,label) {
  return postgres({host:'127.0.0.1',port:cluster.port,database:'postgres',
    username:name,password,ssl:false,max:1,prepare:false,fetch_types:false,
    connect_timeout:3,idle_timeout:0,max_lifetime:0,backoff:false,onnotice(){},
    connection:{application_name:`complete-observed-holder-v384-${label}`}});
}
async function denied(work,code='42501') {
  await assert.rejects(work,error=>{
    assert.equal((error?.cause??error)?.code,code,String(error));return true;
  });
}

test('v384 private holder posts once and commits a same-run invocation fact',
  {timeout:300_000,skip:!process.env.GATEWAY_NATIVE_PG_BIN},async()=>{
    const cluster=await startNativePostgres();
    const report={status:'RUNNING',cleanup:'PENDING',binaryVersion:cluster.binaryVersion,
      sourceSha256:{},stages:[],limitations:[
        'Review-only PG73 proposal; no formal migration, deployed Worker, remote database or production credentials changed.',
        'The fixture exercises committed private reads and real v362 grant, v365 start, and v366 result functions under separate direct LOGINs. It is not a deployed Worker.',
        'The physical POST goes to one owned 127.0.0.1 HTTP server. The counter and received upload bytes observe only that server; they do not observe a Provider.',
        'The real private holder and dedicated LOGIN clients cross grant, custody, send-start and one loopback POST before appending a v366 fetch_invoked observation through the v367 result client. The loopback is not a Provider.',
        'fetch_invoked means the holder called fetch, not that the Provider received every upload byte, accepted the request, or billed it. A committed send-start remains possible-send after all errors.',
        'No provider_usage, zero-charge observation, provider_bill, buyer settlement or terminal closer is called. Streaming result parsing and renewed epoch 2+ result facts are outside this proof.',
        'The v370 renewed fact successor is reviewed but not installed in this fixture; all appended facts bind initial custody/send-start epoch 1.',
        'The fact-ACK negative injects a caller-visible error after the direct v367 client has already observed COMMIT and close. It does not physically drop a PostgreSQL COMMIT or close response.',
        'After a fetch transport error, the wrapper waits for the in-flight fact write to settle before returning. A stalled dedicated DB call may prolong that failure; this review-only wrapper has no durable retry scheduler or liveness guarantee.',
        'Broad selected-source locks are review-only; long SSE renewal, result settlement and legacy reaper coordination remain open.',
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
      const holderPeer=connection(cluster,roles.holder,passwords.holder,'holder-peer');
      const reader=connection(cluster,roles.reader,passwords.reader,'reader');
      const bill=connection(cluster,roles.bill,passwords.bill,'bill');
      const cap=connection(cluster,roles.cap,passwords.cap,'cap');
      const verifier=connection(cluster,roles.verifier,passwords.verifier,'verifier');
      const complete=connection(cluster,roles.complete,passwords.complete,'complete');
      clients.push(migrator,runtime,admission,granter,granterPeer,holder,holderPeer,
        reader,bill,cap,verifier,complete);
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
      report.sourceSha256['private-complete-text-observed-holder-v384.ts']=sha(
        await readFile(new URL('../../../packages/proxy/src/services/private-complete-text-observed-holder-v384.ts',import.meta.url)));
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

      const readerSql=await readFile(proposal('complete-text-private-route-reader-v366.sql'),'utf8');
      report.sourceSha256['complete-text-private-route-reader-v366.sql']=sha(readerSql);
      await migrator.begin(async tx=>{
        await tx.unsafe(`SET LOCAL cinatoken.complete_text_private_route_reader_activation='reviewed-v1'`);
        await tx.unsafe(readerSql).simple();
      });
      await denied(runtime.unsafe(`SELECT ${g}.read_private_complete_text_route_v366(
        'x',pg_catalog.gen_random_uuid(),0,'v361-route')`));
      await denied(granter.unsafe(`SELECT ${g}.read_private_complete_text_route_v366(
        'x',pg_catalog.gen_random_uuid(),0,'v361-route')`));
      await denied(reader.unsafe(`SELECT * FROM ${g}.providers`));
      stage('v366-private-reader-installed-with-distinct-login-and-no-raw-provider-select');

      const resultSql=await readFile(proposal('complete-text-result-facts-v366.sql'),'utf8');
      report.sourceSha256['complete-text-result-facts-v366.sql']=sha(resultSql);
      report.sourceSha256['complete-text-renewed-holder-facts-v370.sql']=sha(
        await readFile(proposal('complete-text-renewed-holder-facts-v370.sql'),'utf8'));
      report.sourceSha256['private-complete-text-holder-v365.ts']=sha(
        await readFile(new URL('../../../packages/proxy/src/services/private-complete-text-holder-v365.ts',import.meta.url)));
      report.sourceSha256['postgres-complete-text-result-facts-v367.ts']=sha(
        await readFile(new URL('../../../packages/proxy/src/services/postgres-complete-text-result-facts-v367.ts',import.meta.url)));
      await assert.rejects(migrator.begin(tx=>tx.unsafe(resultSql).simple()),
        /activation or dependency differs/u);
      await migrator.begin(async tx=>{
        await tx.unsafe(`SET LOCAL cinatoken.complete_text_result_facts_activation='reviewed-v1'`);
        await tx.unsafe(resultSql).simple();
      });
      await denied(runtime.unsafe(`SELECT ${g}.append_complete_text_holder_fact_v366(
        pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid(),1,
        pg_catalog.gen_random_uuid(),'fetch_invoked',
        '{"observation":"fetch_invoked","uploadSha256":"${'a'.repeat(64)}"}'::jsonb,
        '${'a'.repeat(64)}')`));
      await denied(bill.unsafe(`SELECT ${g}.append_complete_text_holder_fact_v366(
        pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid(),1,
        pg_catalog.gen_random_uuid(),'fetch_invoked',
        '{"observation":"fetch_invoked","uploadSha256":"${'a'.repeat(64)}"}'::jsonb,
        '${'a'.repeat(64)}')`));
      await denied(holder.unsafe(`SELECT * FROM ${g}.complete_text_result_facts_v366`));
      await denied(holder.unsafe(`SELECT ${g}.append_complete_text_provider_bill_v366(
        pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid(),'{}'::jsonb,
        '${'a'.repeat(64)}')`));
      stage('v366-result-facts-default-off-installed-and-role-separated');

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
        VALUES('v361-user','v361@example.invalid',100);
        INSERT INTO ${g}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
        VALUES('v361-workspace','personal','v361-user','Admission','v361','active');`).simple();
      await migrator.unsafe(`INSERT INTO ${g}.api_keys
        (id,key,key_hash,user_id,workspace_id,status,limit_micros,limit_reset)
        VALUES('v361-key',$1,$2,'v361-user','v361-workspace','active',100000000,'daily')`,
        [`hashref:${keyHash}`,keyHash]);
      await migrator.unsafe(`INSERT INTO ${g}.workspace_budgets
          (id,workspace_id,reset_interval,limit_micros)
          VALUES('v361-budget','v361-workspace','daily',100000000);
        INSERT INTO ${g}.guardrails
          (id,workspace_id,owner_user_id,name,status)
          VALUES('v361-guardrail','v361-workspace','v361-user','Budget','active');
        INSERT INTO ${g}.guardrail_versions(id,guardrail_id,version,config_json)
          VALUES('v361-version','v361-guardrail',1,
            '{"budget":{"limit":100,"period":"daily"}}');
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
            supports_tool_choice,supports_implicit_caching,supports_voice_cloning,
            evidence_url,verified_by,verified_at,expires_at,status)
          VALUES('v361-endpoint','v361-model','v361-provider','v361-provider',
            'default',1000,'{"currency":"USD","prompt":"0.000010","completion":"0.000020"}',
            '{"auto":true,"function":false,"none":true,"required":false}',false,false,
            'https://example.invalid/v361','fixture',now()-interval '1 minute',
            now()+interval '5 minutes','verified');
        INSERT INTO ${g}.model_endpoint_routes(endpoint_id,route_target_id)
          VALUES('v361-endpoint','v361-route');`).simple();
      const ciphertext=await encryptSharedKeySecret(providerBearer,providerSecret,
        'cinatoken:provider-key:v361-provider');
      await migrator.unsafe(`UPDATE ${g}.providers SET api_key=$1,
        endpoints=$2 WHERE id='v361-provider'`,
        [ciphertext,JSON.stringify({openai:{base:'https://v367-local.invalid/v1'}})]);
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
          limitMicros:100_000_000};
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
      const readerConnectionString=`postgres://${roles.reader}:${passwords.reader}`
        +`@127.0.0.1:${cluster.port}/postgres?sslmode=disable`;
      const readAdmitted=async()=>{
        const quote=await issueQuote();
        assert.equal((await admit(quote)).status,'admitted');
        const request={requestId:quote.requestId,quoteId:quote.quoteId,
          attemptNonce:randomUUID(),candidateIndex:0,
          routeTargetId:'v361-route',finalBodyUtf8:finalBody};
        const snapshot=await readPostgresPrivateCompleteTextRouteV366({
          readerConnectionString,request,
        });
        assert.equal(snapshot.quote.quoteId,quote.quoteId);
        assert.equal(snapshot.route.targetId,'v361-route');
        assert.equal(snapshot.providerCiphertext,ciphertext);
        assert.equal(snapshot.route.providerApiKey,ciphertext);
        return {quote,request,snapshot};
      };
      const counts=async(requestId)=>{
        const [row]=await migrator.unsafe(`SELECT
          (SELECT count(*)::integer FROM ${g}.complete_text_attempt_grants_v362
            WHERE request_id=$1) AS grants,
          (SELECT count(*)::integer FROM ${g}.complete_text_send_custody_v365 c
            JOIN ${g}.complete_text_attempt_grants_v362 a USING(grant_id)
            WHERE a.request_id=$1) AS custody,
          (SELECT count(*)::integer FROM ${g}.complete_text_send_starts_v365 s
            JOIN ${g}.complete_text_attempt_grants_v362 a USING(grant_id)
            WHERE a.request_id=$1) AS starts,
          (SELECT state FROM ${g}.user_budget_reservations
            WHERE request_id=$1) AS ordinary_state`,[requestId]);
        return row;
      };
      const deniedAfterRead=async(label,mutate,restore)=>{
        const prior=await readAdmitted();
        stage(`${label}-v366-private-read-committed-before-mutation`,
          {requestId:prior.quote.requestId});
        await mutate();
        const stale=await grant(await claimFor(prior.quote));
        assert.equal(stale.status,'stale_manifest');
        assert.deepEqual(await counts(prior.quote.requestId),
          {grants:0,custody:0,starts:0,ordinary_state:'reserved'});
        let grantCalls=0,custodyCalls=0,startCalls=0,fetchCalls=0;
        let holderGrantStatus=null;
        const holder=createPrivateCompleteTextHolderV365({
          providerEncryptionSecret:providerSecret,
          async loadQuote(){return prior.snapshot.quote;},
          async loadRoute(){return prior.snapshot.route;},
          async loadProviderCiphertext(){return prior.snapshot.providerCiphertext;},
          async grantAttempt(nonce,claim){
            grantCalls++;
            const result=await grant(claim,nonce);
            holderGrantStatus=result.status;
            return result;
          },
          async claimSendCustody(){custodyCalls++;throw new Error('unexpected custody');},
          async recordSendStart(){startCalls++;throw new Error('unexpected start');},
          async fetchUpstream(){fetchCalls++;throw new Error('unexpected fetch');},
        });
        await assert.rejects(holder.run(prior.request,new AbortController().signal),
          error=>error?.name==='TextGrantEgressRejectedError');
        assert.deepEqual({grantCalls,custodyCalls,startCalls,fetchCalls},
          {grantCalls:1,custodyCalls:0,startCalls:0,fetchCalls:0});
        assert.equal(holderGrantStatus,'stale_manifest');
        assert.deepEqual(await counts(prior.quote.requestId),
          {grants:0,custody:0,starts:0,ordinary_state:'reserved'});
        stage(`${label}-stale-v362-grant-denies-custody-start-and-local-fetch`,
          {grantStatus:stale.status,holderGrantStatus,grantCalls,
            custodyCalls,startCalls,fetchCalls});
        await restore();
        await attest();
      };

      await deniedAfterRead('route-model-name',
        ()=>migrator.unsafe(`UPDATE ${g}.model_routes
          SET provider_model_name='changed-after-private-read'
          WHERE id='v361-route'`),
        ()=>migrator.unsafe(`UPDATE ${g}.model_routes
          SET provider_model_name='upstream-v361'
          WHERE id='v361-route'`));
      await deniedAfterRead('provider-ciphertext',
        ()=>migrator.unsafe(`UPDATE ${g}.providers
          SET api_key='enc:v2:replacement-after-private-read'
          WHERE id='v361-provider'`),
        ()=>migrator.unsafe(`UPDATE ${g}.providers
          SET api_key=$1 WHERE id='v361-provider'`,[ciphertext]));
      await deniedAfterRead('route-attestation',
        ()=>migrator.unsafe(`UPDATE ${g}.model_endpoint_routes
          SET subject_fingerprint=$1 WHERE route_target_id='v361-route'`,
          [sha('invalid-v367-fingerprint')]),
        async()=>{});

      const current=await readAdmitted();
      const currentClaim=await claimFor(current.quote);
      const positive=await grant(currentClaim);
      assert.equal(positive.status,'grant_recorded');
      const run=randomUUID();
      const held=await custody(positive.grantId,run);
      assert.equal(held.status,'custody_claim_recorded');
      const started=await start(positive.grantId,run,held.leaseEpoch,
        currentClaim.outboundBodySha256);
      assert.equal(started.status,'start_recorded');
      assert.equal(await countRows('complete_text_send_starts_v365',positive.grantId),1);
      assert.deepEqual(await counts(current.quote.requestId),
        {grants:1,custody:1,starts:1,ordinary_state:'dispatched'});
      stage('fresh-private-read-positive-sql-grant-custody-and-start-control',
        {grantId:positive.grantId});

      const prestart=await issueGranted();
      const prestartRunId=randomUUID();
      const factHolderConnection=`postgres://${roles.holder}:${passwords.holder}`
        +`@127.0.0.1:${cluster.port}/postgres?sslmode=disable`;
      const prestartCustody=await claimPostgresCompleteTextCustodyV365({
        holderConnectionString:factHolderConnection,
        grantId:prestart.result.grantId,holderRunId:prestartRunId,
      });
      assert.equal(prestartCustody.commitAcknowledged,true);
      const noFetchInput={holderConnectionString:factHolderConnection,
        grantId:prestart.result.grantId,holderRunId:prestartRunId,
        expectedEpoch:1,evidenceNonce:randomUUID(),
        evidence:{kind:'no_fetch_attestation',observation:'fetch_not_called'}};
      const noFetch=await appendPostgresCompleteTextHolderFactV367(noFetchInput);
      assert.equal(noFetch.status,'fact_recorded');
      const laterStart=await recordPostgresCompleteTextSendStartV365({
        holderConnectionString:factHolderConnection,
        grantId:prestart.result.grantId,holderRunId:prestartRunId,
        expectedEpoch:1,uploadSha256:prestart.grantClaim.outboundBodySha256,
      });
      assert.equal(laterStart.status,'start_recorded');
      await assert.rejects(appendPostgresCompleteTextHolderFactV367(noFetchInput),
        /evidence_nonce_conflict/u);
      stage('prestart-no-fetch-observation-does-not-fence-later-send-start-or-replay');

      const wireRequests=[];
      let resolveEndlessClose;
      const endlessClosed=new Promise(resolve=>{resolveEndlessClose=resolve;});
      const loopback=createServer(async(request,response)=>{
        const chunks=[];
        for await (const chunk of request) chunks.push(chunk);
        wireRequests.push({method:request.method,url:request.url,
          authorization:request.headers.authorization,
          body:Buffer.concat(chunks)});
        if(request.url==='/disconnect') {
          request.socket.destroy();
          return;
        }
        if(request.url==='/endless') {
          response.once('close',()=>resolveEndlessClose());
          response.writeHead(200,{'Content-Type':'text/event-stream'});
          response.write('data: {"partial":true}\n\n');
          return;
        }
        if(request.url==='/partial') {
          response.writeHead(200,{'Content-Type':'text/event-stream'});
          response.write('data: {"partial":true}\n\n');
          setTimeout(()=>response.destroy(),25);
          return;
        }
        response.writeHead(200,{'Content-Type':'application/json'});
        response.end('{"ok":true}');
      });
      loopback.listen(0,'127.0.0.1');
      await once(loopback,'listening');
      try {
        const granterConnectionString=`postgres://${roles.granter}:${passwords.granter}`
          +`@127.0.0.1:${cluster.port}/postgres?sslmode=disable`;
        const holderConnectionString=`postgres://${roles.holder}:${passwords.holder}`
          +`@127.0.0.1:${cluster.port}/postgres?sslmode=disable`;
        const runObserved=async(mode='success',repeat=null)=>{
          const fresh=repeat??await readAdmitted();
          const facts=[];const starts=[];let fetchCalls=0;
          const privateHolder=createObservedPrivateCompleteTextHolderV384({
            providerEncryptionSecret:providerSecret,
            async loadQuote(){return fresh.snapshot.quote;},
            async loadRoute(){return fresh.snapshot.route;},
            async loadProviderCiphertext(){return fresh.snapshot.providerCiphertext;},
            grantAttempt:(attemptNonce,claim)=>grantPostgresCompleteTextAttemptV362({
              granterConnectionString,attemptNonce,claim,
            }),
            claimSendCustody:(grantId,holderRunId)=>
              claimPostgresCompleteTextCustodyV365({
                holderConnectionString,grantId,holderRunId,
              }),
            async recordSendStart(grantId,holderRunId,expectedEpoch,uploadSha256){
              const receipt=await recordPostgresCompleteTextSendStartV365({
                holderConnectionString,grantId,holderRunId,
                expectedEpoch,uploadSha256,
              });
              starts.push(receipt);
              return receipt;
            },
            async appendFetchInvokedFact(input){
              facts.push(input);
              const receipt=await appendPostgresCompleteTextHolderFactV367({
                holderConnectionString,...input,
              });
              if(mode==='lost-fact-ack'||mode==='endless-stream-ack-loss')
                throw new Error('v384 injected caller ACK loss after fact COMMIT and close');
              return receipt;
            },
            fetchUpstream:(url,init)=>{
              fetchCalls++;
              if(mode==='synchronous-fetch-throw')
                throw new Error('v384 injected synchronous fetch throw');
              const parsed=new URL(url);
              assert.equal(parsed.hostname,'v367-local.invalid');
              assert.equal(parsed.protocol,'https:');
              assert.equal(init?.redirect,'error');
              const address=loopback.address();
              assert.ok(address && typeof address==='object');
              const path=mode==='disconnected-fetch' ? '/disconnect'
                : mode==='endless-stream-ack-loss' ? '/endless'
                : mode==='partial-stream' ? '/partial' : parsed.pathname;
              return fetch(`http://127.0.0.1:${address.port}${path}`,init);
            },
          });
          let response=null;let error=null;
          try {response=await privateHolder.run(fresh.request,new AbortController().signal);}
          catch(cause){error=cause;}
          return {fresh,facts,starts,fetchCalls,response,error};
        };
        const successful=await runObserved();
        assert.equal(successful.error,null);
        assert.equal(successful.response.status,200);
        assert.deepEqual(await successful.response.json(),{ok:true});
        assert.equal(successful.fetchCalls,1);
        assert.equal(wireRequests.length,1);
        assert.equal(wireRequests[0].method,'POST');
        assert.equal(wireRequests[0].url,'/v1/chat/completions');
        assert.equal(wireRequests[0].authorization,`Bearer ${providerBearer}`);
        assert.ok(wireRequests[0].body.length>0);
        assert.equal(successful.starts.length,1);
        assert.equal(successful.starts[0].commitAcknowledged,true);
        assert.equal(successful.facts.length,1);
        const identity=successful.facts[0];
        assert.equal(identity.evidenceNonce,fetchInvokedEvidenceNonceV384(
          identity.grantId,identity.holderRunId,successful.starts[0].sendStartId));
        assert.equal(identity.evidence.uploadSha256,sha(wireRequests[0].body));
        const [committed]=await migrator.unsafe(`SELECT a.grant_id,a.request_id,
          a.outbound_body_sha256,a.upstream_url_sha256,
          s.send_start_id,s.holder_run_id,s.outbound_body_sha256 AS start_sha,
          f.fact_id,f.holder_run_id AS fact_run_id,f.send_start_id AS fact_start_id,
          f.lease_epoch,f.evidence_nonce,f.kind,f.source_kind,
          f.outbound_body_sha256 AS fact_sha,f.evidence->>'uploadSha256' AS evidence_sha
          FROM ${g}.complete_text_attempt_grants_v362 a
          JOIN ${g}.complete_text_send_starts_v365 s ON s.grant_id=a.grant_id
          JOIN ${g}.complete_text_result_facts_v366 f ON f.grant_id=a.grant_id
          WHERE a.request_id=$1`,[successful.fresh.quote.requestId]);
        assert.ok(committed);
        assert.equal(committed.grant_id,identity.grantId);
        assert.equal(committed.holder_run_id,identity.holderRunId);
        assert.equal(committed.fact_run_id,identity.holderRunId);
        assert.equal(committed.fact_start_id,committed.send_start_id);
        assert.equal(committed.evidence_nonce,identity.evidenceNonce);
        assert.equal(String(committed.lease_epoch),'1');
        assert.equal(committed.kind,'fetch_invoked');
        assert.equal(committed.source_kind,'holder');
        for(const digest of [committed.outbound_body_sha256,
          committed.start_sha,committed.fact_sha,committed.evidence_sha])
          assert.equal(digest,sha(wireRequests[0].body));
        assert.equal(committed.upstream_url_sha256,
          sha('https://v367-local.invalid/v1/chat/completions'));
        assert.deepEqual(await counts(successful.fresh.quote.requestId),
          {grants:1,custody:1,starts:1,ordinary_state:'dispatched'});
        stage('one-loopback-post-and-v366-fact-share-grant-run-start-and-upload-sha',
          {requestId:committed.request_id,grantId:committed.grant_id,
            sendStartId:committed.send_start_id,factId:committed.fact_id,
            physicalPosts:wireRequests.length,outboundBodySha256:committed.outbound_body_sha256});

        const beforeReplayPost=wireRequests.length;
        const repeated=await runObserved('success',successful.fresh);
        assert.ok(repeated.error);
        assert.equal(repeated.fetchCalls,0);
        assert.equal(repeated.starts.length,0);
        assert.equal(repeated.facts.length,0);
        assert.equal(wireRequests.length,beforeReplayPost);
        stage('second-holder-instance-same-envelope-cannot-repeat-post');

        const replay=await appendPostgresCompleteTextHolderFactV367({
          holderConnectionString,...identity,
        });
        assert.equal(replay.status,'already_recorded');
        assert.equal(replay.factId,committed.fact_id);
        await assert.rejects(appendPostgresCompleteTextHolderFactV367({
          holderConnectionString,...identity,
          evidence:{kind:'transport_unknown',observation:'transport_unknown',phase:'body'},
        }),/evidence_nonce_conflict/u);
        stage('same-nonce-identical-fact-replays-original-id-and-kind-drift-conflicts');

        const beforeLost=wireRequests.length;
        const lost=await runObserved('lost-fact-ack');
        assert.match(String(lost.error),/injected caller ACK loss/u);
        assert.equal(lost.response,null);
        assert.equal(lost.fetchCalls,1);
        assert.equal(wireRequests.length,beforeLost+1);
        assert.equal(lost.facts.length,1);
        const recovered=await appendPostgresCompleteTextHolderFactV367({
          holderConnectionString,...lost.facts[0],
        });
        assert.equal(recovered.status,'already_recorded');
        const [lostCount]=await migrator.unsafe(`SELECT count(*)::integer AS n
          FROM ${g}.complete_text_result_facts_v366
          WHERE grant_id=$1::uuid`,[lost.facts[0].grantId]);
        assert.equal(lostCount.n,1);
        stage('caller-visible-fact-ack-loss-does-not-return-response-or-repeat-post',
          {grantId:lost.facts[0].grantId,physicalPosts:wireRequests.length-beforeLost,
            sameNonceFactId:recovered.factId});

        const beforeEndless=wireRequests.length;
        const endless=await runObserved('endless-stream-ack-loss');
        assert.match(String(endless.error),/injected caller ACK loss/u);
        assert.equal(endless.response,null);
        assert.equal(endless.fetchCalls,1);
        assert.equal(wireRequests.length,beforeEndless+1);
        await Promise.race([endlessClosed,
          new Promise((_,reject)=>setTimeout(()=>reject(new Error('endless response not cancelled')),2000))]);
        stage('fact-ack-loss-aborts-unhanded-endless-response-after-one-post');

        const beforeSync=wireRequests.length;
        const sync=await runObserved('synchronous-fetch-throw');
        assert.match(String(sync.error),/synchronous fetch throw/u);
        assert.equal(sync.fetchCalls,1);
        assert.equal(sync.starts.length,1);
        assert.equal(sync.facts.length,0);
        assert.equal(wireRequests.length,beforeSync);
        assert.deepEqual(await counts(sync.fresh.quote.requestId),
          {grants:1,custody:1,starts:1,ordinary_state:'dispatched'});
        stage('synchronous-fetch-throw-keeps-committed-start-unknown-without-no-fetch');

        const beforeDisconnect=wireRequests.length;
        const disconnected=await runObserved('disconnected-fetch');
        assert.ok(disconnected.error);
        assert.equal(disconnected.fetchCalls,1);
        assert.equal(disconnected.facts.length,1);
        assert.equal(wireRequests.length,beforeDisconnect+1);
        const [disconnectFact]=await migrator.unsafe(`SELECT kind,source_kind
          FROM ${g}.complete_text_result_facts_v366
          WHERE grant_id=$1::uuid`,[disconnected.facts[0].grantId]);
        assert.deepEqual(disconnectFact,{kind:'fetch_invoked',source_kind:'holder'});
        stage('disconnected-post-keeps-fetch-invoked-and-possible-send-without-usage');

        const beforePartial=wireRequests.length;
        const partial=await runObserved('partial-stream');
        assert.equal(partial.error,null);
        assert.equal(partial.response.status,200);
        await assert.rejects(partial.response.text());
        assert.equal(partial.fetchCalls,1);
        assert.equal(wireRequests.length,beforePartial+1);
        assert.equal(partial.facts.length,1);
        stage('partial-sse-body-failure-records-only-fetch-invoked');

        const [noBills]=await migrator.unsafe(`SELECT count(*)::integer AS n
          FROM ${g}.complete_text_result_facts_v366
          WHERE kind IN ('provider_usage','provider_zero_charge_observation','provider_bill')`);
        assert.equal(noBills.n,0);
        stage('no-provider-usage-zero-charge-bill-or-terminal-inferred');
      } finally {
        loopback.closeAllConnections();
        await new Promise((resolve,reject)=>loopback.close(error=>
          error?reject(error):resolve()));
      }

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
      report.sourceSha256.fixture=sha(await readFile(new URL(import.meta.url)));
      await writeFile(reportUrl,JSON.stringify(report,null,2)+'\n');
      process.stdout.write(`complete-text-observed-holder-v384-report=${reportUrl.pathname}\n`);
    }
    if(failure) throw failure;
    assert.equal(report.cleanup,'PASS');
  });
