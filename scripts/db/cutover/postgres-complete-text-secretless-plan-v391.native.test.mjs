// Owned PG18.6 proof of actual auth, committed quote and secretless planner boundary.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import postgres from 'postgres';
import { encryptSharedKeySecret } from '@octafuse/core';
import { computeRouteDataPolicySubjectFingerprintFromRows } from '../../../packages/core/src/route-data-policy.ts';
import { createFinalChatQuoteSnapshot, originalChatBodySha256 } from '../../../packages/proxy/src/services/chat-final-quote-input.ts';
import { parseOpenAiModelFallbacks } from '../../../packages/proxy/src/services/model-fallbacks.ts';
import { issuePostgresCompleteChatQuoteV360 } from '../../../packages/proxy/src/services/postgres-complete-chat-quote-v360.ts';
import { admitPostgresCompleteChatQuoteV361 } from '../../../packages/proxy/src/services/postgres-complete-chat-admission-v361.ts';
import { createChatTextHolderRequestV363 } from '../../../packages/proxy/src/services/chat-text-holder-request-v363.ts';
import { readPostgresCompleteTextSecretlessPlanV391, selectCompleteTextPlanRouteV391 } from '../../../packages/proxy/src/services/postgres-complete-text-secretless-plan-v391.ts';
import { createHyperdriveDedicatedRoleTransportV390 } from '../../../packages/proxy/src/services/hyperdrive-dedicated-role-transport-v390.ts';
import { authenticateApiKey } from '../../../packages/proxy/src/services/api-key-auth.ts';
import { createPostgresDatabaseClient } from '../../../packages/core/src/storage/database-client.ts';
import { createPostgresRepositories } from '../../../packages/core/src/storage/repositories-postgres.ts';
import { createCompleteTextHolderWorkerV390 } from '../../../packages/proxy/src/runtime/complete-text-holder-worker-v390.ts';
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
const reportUrl=new URL('../../../docs/developers/architecture/implementation-evidence/C04-complete-text-secretless-plan-v391-report.json',import.meta.url);
const sha=value=>createHash('sha256').update(value).digest('hex');
const providerSecret='v367-local-provider-kek-with-no-production-use';
const providerBearer='v367-local-provider-bearer';
const bearer='sk-local-complete-text-admission-v361-bearer';
const keyHash=`sha256:${sha(bearer)}`;
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
  bill:'cinatoken_gateway_complete_text_provider_bill',
  renewer:'cinatoken_gateway_complete_text_hold_renewer',
  recovery:'cinatoken_gateway_budget_recovery',planner:'cinatoken_gateway_complete_text_ingress_planner'};

function connection(cluster,name,password,label) {
  return postgres({host:'127.0.0.1',port:cluster.port,database:'postgres',
    username:name,password,ssl:false,max:1,prepare:false,fetch_types:false,
    connect_timeout:3,idle_timeout:0,max_lifetime:0,backoff:false,onnotice(){},
    connection:{application_name:`complete-text-worker-v390-${label}`}});
}
async function denied(work,code='42501') {
  await assert.rejects(work,error=>{
    assert.equal((error?.cause??error)?.code,code,String(error));return true;
  });
}

test('v391 actual authentication and committed quote feed the real secretless planner',
  {timeout:300_000,skip:!process.env.GATEWAY_NATIVE_PG_BIN},async()=>{
    const loadedFixtureSha256=sha(await readFile(new URL(import.meta.url)));
    const cluster=await startNativePostgres();
    const report={status:'RUNNING',cleanup:'PENDING',binaryVersion:cluster.binaryVersion,
      sourceSha256:{},stages:[],limitations:[
        'Local review-only PostgreSQL 18.6 with 73 formal migrations and reviewed proposal prerequisites. No deployment, production DB or paid provider call.',
        'Existing authenticateApiKey and real PostgreSQL repositories resolve the bearer identity. Owned seed data supplies credentials and configuration; fixture identity does not replace authentication.',
        'The no-plan FinalChatQuoteSnapshot captures owned final flat text; production preset and Guardrail middleware are not executed. Guardrail intents are owned fixture declarations checked by real admission SQL.',
        'v365 planner output is the complete quoted safe manifest superset, not current Chat surface/routing priority, weighting, sticky policy or provider preference selection. The fixture explicitly chooses its known single route ID.',
        'All planner/capability/quote/admission clients use trusted transport adapters and direct local role URLs. This is not a Cloudflare Hyperdrive transport or origin-session proof.',
        'The real Worker handler executes in Node through an in-process call. Its code-only network override rewrites the quoted HTTPS fixture URL to owned HTTP loopback, preserving upload/auth; quoted-URL socket transmission and Service Binding cancellation are not established.',
        'Planner COMMIT-loss uses a real PostgreSQL protocol proxy observing backend CommandComplete(COMMIT) before suppressing the response. No plan is returned without acknowledged transaction and close.',
        'The planner LOGIN intentionally cannot run legacy authentication, raw source reads or lazy budget reset. Runtime authentication write branches are exercised to document current permission boundaries, not silently delegated to planner.',
        'fetch_invoked and sent unknown remain nonterminal. No usage, provider bill, buyer settlement, zero-charge outcome or financial closer is synthesized.'
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
      stage('distinct-direct-holder-login-has-custody-start-access-and-no-raw-access',
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

      for(const [name,setting] of [
        ['guardrail-budget-lifecycle-login-v353.sql','guardrail_budget_lifecycle_v353_activation'],
        ['ordinary-budget-recovery-login-v354.sql','ordinary_budget_recovery_v354_activation'],
        ['complete-text-legacy-reaper-fence-v366.sql','complete_text_legacy_reaper_fence_v366_activation']]){
        const body=await readFile(proposal(name),'utf8');report.sourceSha256[name]=sha(body);
        await migrator.begin(async tx=>{
          await tx.unsafe(`SET LOCAL cinatoken.${setting}='reviewed-v1'`);
          await tx.unsafe(body).simple();
        });
      }
      const renewalSql=await readFile(proposal('complete-text-all-hold-renewal-v367.sql'),'utf8');
      report.sourceSha256['complete-text-all-hold-renewal-v367.sql']=sha(renewalSql);
      await migrator.begin(async tx=>{
        await tx.unsafe(`SET LOCAL cinatoken.complete_text_all_hold_renewal_v367_activation='reviewed-v1'`);
        await tx.unsafe(renewalSql).simple();
      });
      stage('v367-renewal-installed-for-isolated-direct-renewer-login');

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

      const urls=Object.fromEntries(Object.entries(roles).map(([name,role])=>[
        name,`postgres://${role}:${passwords[name]}@127.0.0.1:${cluster.port}/postgres?sslmode=disable`]));
      const planSql=await readFile(proposal('complete-text-secretless-plan-v365.sql'),'utf8');
      report.sourceSha256['complete-text-secretless-plan-v365.sql']=sha(planSql);
      await denied(()=>migrator.begin(tx=>tx.unsafe(planSql).simple()),'P0001');
      await migrator.begin(async tx=>{
        await tx.unsafe("SET LOCAL cinatoken.complete_text_secretless_plan_activation='reviewed-v1'");
        await tx.unsafe(planSql).simple();
      });
      stage('planner-default-off-and-reviewed-wrapper-installed');
      const planner=connection(cluster,roles.planner,passwords.planner,'planner');clients.push(planner);
      for(const query of [
        `SELECT api_key FROM ${g}.providers`,
        `SELECT endpoints FROM ${g}.providers`,
        `SELECT * FROM ${g}.complete_text_quote_routes_v360`,
        `SELECT * FROM ${g}.api_keys`,
        `SELECT * FROM ${g}.users`,
      ])await denied(()=>planner.unsafe(query));
      await denied(()=>runtime.unsafe(`SELECT ${g}.plan_complete_flat_text_quote_v365('missing',$1)`,[randomUUID()]));
      const [plannerAcl]=await migrator.unsafe(`SELECT
        (SELECT count(*)::integer FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='cinatoken_gateway' AND pg_catalog.has_function_privilege($1,p.oid,'EXECUTE')) AS wrappers,
        (SELECT count(*)::integer FROM pg_catalog.pg_auth_members WHERE member=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$1)) AS memberships`,[roles.planner]);
      assert.deepEqual(plannerAcl,{wrappers:1,memberships:0});
      stage('planner-has-one-wrapper-and-no-auth-provider-quote-source-raw-access',plannerAcl);

      const authClient=await createPostgresDatabaseClient(urls.runtime,{max:1,prepare:false,fetch_types:false,connect_timeout:3,idle_timeout:0,max_lifetime:0,backoff:false});
      clients.push(authClient.raw);
      const repositories=createPostgresRepositories(authClient);
      const auth=await authenticateApiKey(repositories,bearer);
      assert.ok(auth);assert.equal(auth.keyId,'v361-key');assert.equal(auth.userId,'v361-user');
      assert.equal(auth.workspaceId,'v361-workspace');assert.equal(auth.budgetEpoch,0);
      assert.equal(await authenticateApiKey(repositories,'sk-unrecognized-key-v391'),null);
      stage('actual-existing-auth-reads-hashed-bearer-and-resolves-personal-identity');

      const legacyBearer='sk-local-legacy-auth-boundary-v391';
      await migrator.unsafe(`INSERT INTO ${g}.api_keys(id,key,user_id,workspace_id,status)
        VALUES('v391-legacy-key',$1,'v361-user','v361-workspace','active')`,[legacyBearer]);
      const legacyAuthenticated=await authenticateApiKey(repositories,legacyBearer);
      assert.ok(legacyAuthenticated);assert.equal(legacyAuthenticated.keyId,'v391-legacy-key');
      const [legacyAfter]=await migrator.unsafe(`SELECT key,key_hash FROM ${g}.api_keys WHERE id='v391-legacy-key'`);
      assert.equal(legacyAfter.key,`hashref:sha256:${sha(legacyBearer)}`);
      assert.equal(legacyAfter.key_hash,`sha256:${sha(legacyBearer)}`);
      stage('actual-existing-auth-legacy-key-migration-needs-write-permission',{outcome:'actual_hash_migration_committed'});
      await migrator.unsafe(`UPDATE ${g}.users SET budget_period='daily',budget_reset_at=now()-interval '1 day',
        budget_spent=1,budget_base=100 WHERE id='v361-user'`);
      await assert.rejects(authenticateApiKey(repositories,bearer),error=>{
        assert.equal((error.cause??error).code,'42501');return true;
      });
      const [resetAfter]=await migrator.unsafe(`SELECT budget_epoch,budget_spent FROM ${g}.users WHERE id='v361-user'`);
      assert.equal(Number(resetAfter.budget_epoch),0);assert.equal(Number(resetAfter.budget_spent),1);
      stage('actual-existing-auth-overdue-lazy-budget-reset-rejected-by-buyer-split',{sqlstate:'42501',budgetEpoch:0});
      await migrator.unsafe(`UPDATE ${g}.users SET budget_period='none',budget_reset_at=NULL,budget_spent=0 WHERE id='v361-user'`);

      const transports=Object.fromEntries(['planner','cap','complete','admission'].map(name=>[
        name,createHyperdriveDedicatedRoleTransportV390({connectionString:urls[name]},roles[name])]));
      const makeQuote=async()=>{
        const authenticated=await authenticateApiKey(repositories,bearer);assert.ok(authenticated);
        const raw='{"model":"v361-model","messages":[{"role":"user","content":"hello"}],"max_completion_tokens":250}';
        const body=JSON.parse(raw);const parsed=parseOpenAiModelFallbacks(body);assert.equal(parsed.ok,true);
        const bytes=new TextEncoder().encode(raw);
        const finalQuoteInput=await createFinalChatQuoteSnapshot({requestId:`v391-${randomUUID()}`,
          originalBodySha256:await originalChatBodySha256(bytes.buffer),finalBody:body,parsed:parsed.value});
        const quote=await issuePostgresCompleteChatQuoteV360({runtimeClient:authClient,
          runtimeConnectionString:urls.runtime,capabilityConnectionString:transports.cap.roleConnectionString,
          quoteConnectionString:transports.complete.roleConnectionString,bearer,
          identity:{apiKeyId:authenticated.keyId,userId:authenticated.userId,workspaceId:authenticated.workspaceId,budgetEpoch:authenticated.budgetEpoch},
          finalQuoteInput},{capability:transports.cap.createSql,quote:transports.complete.createSql});
        return {quote,finalQuoteInput};
      };
      const readPlan=input=>readPostgresCompleteTextSecretlessPlanV391({
        ...input,plannerConnectionString:transports.planner.roleConnectionString},transports.planner.createSql);
      const input=await makeQuote();const plan=await readPlan(input);
      const [manifest]=await migrator.unsafe(`SELECT source_generation::text AS generation,attested_source_sha256
        FROM ${g}.complete_text_quote_routes_v360 WHERE quote_id=$1`,[input.quote.quoteId]);
      assert.equal(plan.routes.length,1);assert.equal(plan.routes[0].sourceGeneration,manifest.generation);
      assert.equal(plan.routes[0].attestedSourceSha256,manifest.attested_source_sha256);
      assert.deepEqual(Object.keys(plan.routes[0]).sort(),['attestedSourceSha256','candidateIndex','modelId','routeTargetId','sourceGeneration']);
      for(const secret of [providerBearer,providerSecret,ciphertext,'https://v367-local.invalid',roles.planner])
        assert.equal(JSON.stringify(plan).includes(secret),false);
      stage('actual-auth-snapshot-quote-planner-chain-returns-only-current-manifest',{routeCount:plan.routeCount,sourceGeneration:manifest.generation});

      const wrong=createHyperdriveDedicatedRoleTransportV390({connectionString:urls.runtime},roles.planner);
      await assert.rejects(readPostgresCompleteTextSecretlessPlanV391({...input,
        plannerConnectionString:wrong.roleConnectionString},wrong.createSql),TypeError);
      stage('role-alias-never-substitutes-for-real-server-current-and-session-login');

      let posts=0;let upload;let authorization;
      const loopback=createServer(async(request,response)=>{
        posts++;const chunks=[];for await(const chunk of request)chunks.push(chunk);
        upload=Buffer.concat(chunks);authorization=request.headers.authorization;
        response.writeHead(200,{'Content-Type':'application/json'});response.end('{"ok":true}');
      });
      loopback.listen(0,'127.0.0.1');await once(loopback,'listening');
      const address=loopback.address();assert.ok(address&&typeof address==='object');
      try{
        const at=new Date();const start=new Date(Date.UTC(at.getUTCFullYear(),at.getUTCMonth(),at.getUTCDate()));
        const common={workspaceId:auth.workspaceId,guardrailVersion:1,period:'daily',periodStart:start.toISOString(),
          periodEnd:new Date(start.getTime()+86400000).toISOString(),limitMicros:100000000};
        const intents=[{...common,assignmentId:'v361-assignment',guardrailId:'v361-guardrail',scopeType:'user',scopeId:auth.userId},
          {...common,assignmentId:'workspace-budget:v361-budget',guardrailId:'workspace-budget:v361-budget',scopeType:'workspace',scopeId:auth.workspaceId},
          {...common,assignmentId:'gateway-key-limit:v361-key',guardrailId:'gateway-key-limit:v361-key',scopeType:'api_key',scopeId:auth.keyId}];
        const admission=await admitPostgresCompleteChatQuoteV361({runtimeClient:authClient,runtimeConnectionString:urls.runtime,
          admissionConnectionString:transports.admission.roleConnectionString,quote:input.quote,guardrailIntents:intents},
          transports.admission.createSql);assert.equal(admission.status,'admitted');
        const selectedRoute=selectCompleteTextPlanRouteV391(plan,{candidateIndex:0,routeTargetId:'v361-route'});
        const envelope=createChatTextHolderRequestV363({...input,selectedRoute,attemptNonce:randomUUID()});
        const worker=createCompleteTextHolderWorkerV390({fetchUpstream:(url,init)=>{
          assert.equal(String(url),'https://v367-local.invalid/v1/chat/completions');
          return fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`,init);
        }});
        const tasks=[];const response=await worker.fetch(new Request('https://holder.service.invalid/complete-text-attempt',{
          method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(envelope)}),{
          COMPLETE_TEXT_HOLDER_ENABLED:'reviewed-v1',PROVIDER_KEY_ENCRYPTION_SECRET:providerSecret,
          COMPLETE_TEXT_READER:{connectionString:urls.reader},COMPLETE_TEXT_GRANTER:{connectionString:urls.granter},
          COMPLETE_TEXT_HOLDER:{connectionString:urls.holder},COMPLETE_TEXT_RENEWER:{connectionString:urls.renewer}},
          {waitUntil(task){tasks.push(task);}});
        assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});await Promise.all(tasks);
        assert.equal(posts,1);assert.equal(authorization,`Bearer ${providerBearer}`);
        assert.deepEqual(JSON.parse(upload),{model:'upstream-v361',messages:[{role:'user',content:'hello'}],max_completion_tokens:250});
        const [sent]=await migrator.unsafe(`SELECT a.obligation_state,s.outbound_body_sha256,
          f.kind,f.evidence->>'uploadSha256' AS fact_sha FROM ${g}.complete_text_attempt_grants_v362 a
          JOIN ${g}.complete_text_send_starts_v365 s USING(grant_id)
          JOIN ${g}.complete_text_result_facts_v366 f USING(grant_id) WHERE a.request_id=$1`,[input.quote.requestId]);
        assert.equal(sent.obligation_state,'unknown');assert.equal(sent.kind,'fetch_invoked');
        assert.equal(sent.outbound_body_sha256,sha(upload));assert.equal(sent.fact_sha,sha(upload));
        stage('manifest-identifiers-feed-real-admission-envelope-worker-and-one-exact-owned-post',{physicalPosts:1});

        const checkStale=async(name,mutate,restore,status='stale')=>{
          const current=await makeQuote();await mutate();
          try{await assert.rejects(readPlan(current),error=>error.status===status);}
          finally{await restore();}
          assert.equal(posts,1);stage(name,{status,addedPosts:0});
        };
        await checkStale('revoked-authenticated-key-invalidates-manifest',
          ()=>migrator.unsafe(`UPDATE ${g}.api_keys SET status='revoked' WHERE id='v361-key'`),
          ()=>migrator.unsafe(`UPDATE ${g}.api_keys SET status='active' WHERE id='v361-key'`));
        await checkStale('current-personal-workspace-status-invalidates-manifest',
          ()=>migrator.unsafe(`UPDATE ${g}.workspaces SET status='archived' WHERE id='v361-workspace'`),
          ()=>migrator.unsafe(`UPDATE ${g}.workspaces SET status='active' WHERE id='v361-workspace'`));
        await checkStale('source-generation-drift-invalidates-manifest',
          ()=>migrator.unsafe(`UPDATE ${g}.model_routes SET provider_model_name='changed-v391' WHERE id='v361-route'`),
          async()=>{await migrator.unsafe(`UPDATE ${g}.model_routes SET provider_model_name='upstream-v361' WHERE id='v361-route'`);await attest();},'stale_manifest');

        const current=await makeQuote();
        const proxy=await startJournalCommitAckDropProxyV381({upstreamHost:'127.0.0.1',upstreamPort:cluster.port});
        try{
          const proxyUrl=new URL(urls.planner);proxyUrl.port=String(proxy.port);
          const transport=createHyperdriveDedicatedRoleTransportV390({connectionString:proxyUrl.href},roles.planner);
          const lost=readPostgresCompleteTextSecretlessPlanV391({...current,plannerConnectionString:transport.roleConnectionString},transport.createSql);
          const rejected=assert.rejects(lost);
          await proxy.waitForDrop();await rejected;
          assert.equal(proxy.facts.backendCommitCompletes,1);assert.equal(proxy.facts.droppedCommitAcks,1);
          assert.equal(posts,1);stage('actual-planner-commit-response-loss-releases-no-plan-and-no-added-post',{proxyFacts:{...proxy.facts},addedPosts:0});
        }finally{await proxy.close();}
      }finally{loopback.closeAllConnections();await new Promise((resolve,reject)=>loopback.close(error=>error?reject(error):resolve()));}
      assert.equal(sha(await readFile(new URL(import.meta.url))),loadedFixtureSha256,'Native fixture changed while executing');
      report.status='PASS';
    }catch(error){failure=error;report.status='FAIL';report.failure={message:String(error?.stack??error).slice(0,7000)};}
    finally{
      await Promise.allSettled(clients.map(client=>client.end({timeout:1})));
      try{await cluster.cleanup();report.cleanup='PASS';}catch(error){report.cleanup='FAIL';failure??=error;}
      report.sourceSha256.fixture=sha(await readFile(new URL(import.meta.url)));
      for(const path of [
        'packages/proxy/src/services/postgres-complete-text-secretless-plan-v391.ts',
        'packages/proxy/src/services/postgres-complete-text-secretless-plan-v391.test.mjs',
        'packages/proxy/src/services/chat-final-quote-input.ts',
        'packages/proxy/src/services/postgres-complete-chat-quote-v360.ts',
        'packages/proxy/src/services/postgres-complete-chat-admission-v361.ts',
        'packages/proxy/src/services/chat-text-holder-request-v363.ts',
        'packages/proxy/src/services/hyperdrive-dedicated-role-transport-v390.ts',
        'packages/proxy/src/services/api-key-auth.ts',
        'packages/core/src/db/postgres/api-keys.impl.ts',
        'packages/core/src/services/user-service.ts',
        'packages/core/src/storage/repositories-postgres.ts',
        'packages/core/src/storage/database-client.ts',
        'packages/core/src/storage/drizzle/client-postgres.ts',
        'packages/core/src/storage/drizzle/schema.pg.ts',
        'packages/core/src/storage/critical-write-paths.ts',
        'packages/core/src/db/postgres/critical-writes.impl.ts',
        'packages/proxy/src/runtime/complete-text-holder-worker-v390.ts',
        'packages/proxy/src/services/postgres-private-complete-text-reader-v366.ts',
        'packages/proxy/src/services/postgres-complete-text-attempt-grant-v362.ts',
        'packages/proxy/src/services/postgres-complete-text-send-start-v365.ts',
        'packages/proxy/src/services/postgres-complete-text-hold-renewal-v369.ts',
        'packages/core/src/test-support/postgres-journal-commit-ack-proxy-v381.mjs',
      ])report.sourceSha256[path]=sha(await readFile(new URL(`../../../${path}`,import.meta.url)));
      await writeFile(reportUrl,JSON.stringify(report,null,2)+'\n');
      process.stdout.write(`complete-text-secretless-plan-v391-report=${reportUrl.pathname}\n`);
    }
    if(failure)throw failure;assert.equal(report.cleanup,'PASS');
  });
