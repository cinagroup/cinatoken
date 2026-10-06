// Owned PG18.6 proof of the v390 private Worker through real role clients.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import postgres from 'postgres';
import { encryptSharedKeySecret } from '@octafuse/core';
import { computeRouteDataPolicySubjectFingerprintFromRows } from '../../../packages/core/src/route-data-policy.ts';
import { createFinalChatQuoteInput, originalChatBodySha256 } from '../../../packages/proxy/src/services/chat-final-quote-input.ts';
import { parseOpenAiModelFallbacks } from '../../../packages/proxy/src/services/model-fallbacks.ts';
import { createCompleteChatHolderDispatchV385 } from '../../../packages/proxy/src/services/complete-chat-holder-dispatch-v385.ts';
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
const reportUrl=new URL('../../../docs/developers/architecture/implementation-evidence/C04-complete-text-holder-worker-v390-report.json',import.meta.url);
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
  recovery:'cinatoken_gateway_budget_recovery'};

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

test('v390 independent private Worker composes default LOGIN clients and owns stream lifetime',
  {timeout:300_000,skip:!process.env.GATEWAY_NATIVE_PG_BIN},async()=>{
    const loadedFixtureSha256=sha(await readFile(new URL(import.meta.url)));
    const cluster=await startNativePostgres();
    const report={status:'RUNNING',cleanup:'PENDING',binaryVersion:cluster.binaryVersion,
      sourceSha256:{},stages:[],limitations:[
        'Review-only PG73 proposal; no formal migration, deployed Worker, remote database or production credentials changed.',
        'The v385 seam uses its default v360 quote and v361 no-amount admission clients. All SQL and role checks are real direct LOGIN connections to one owned PG18.6 cluster; no quote, admission or pending_unknown result is fabricated.',
        'The actual FinalChatQuoteInput helper captures an owned flat-text body after fixture transformations. The production Chat route, preset and Guardrail middleware are not executed; the selected public plan is fixture data and the private route is reloaded by v366.',
        'The physical POST goes to one owned 127.0.0.1 HTTP server. The counter and received upload bytes observe only that server; they do not observe a Provider.',
        'The in-process Binding stand-in invokes the actual v390 Worker fetch handler, which performs real v366 reads. fetchUpstream rewrites the prepared HTTPS fixture URL to an owned HTTP loopback while preserving body and authorization. This does not establish quoted-URL socket transmission, Cloudflare Service Binding transport or a deployed Worker.',
        'fetch_invoked means the holder called fetch, not that the Provider received every upload byte, accepted the request, or billed it. A committed send-start remains possible-send after all errors.',
        'No provider_usage, zero-charge observation, provider_bill, buyer settlement or terminal closer is called. Streaming result parsing and renewed epoch 2+ result facts are outside this proof.',
        'The v370 renewed fact successor is reviewed but not installed in this fixture; all appended facts bind initial custody/send-start epoch 1.',
        'The actual v390 Worker fetch handler is invoked in Node. Its default role clients use trusted binding transport adapters and direct local PostgreSQL role URLs. No Cloudflare Hyperdrive transport or origin-session behavior is exercised.',
        'The renewal ACK negative uses a cleartext PostgreSQL v3 proxy that forwards the original COMMIT, observes backend CommandComplete(COMMIT), suppresses that response and closes the client socket. A committed renewal does not extend stream authority without the client acknowledgement.',
        'Local tests shorten the entry and unrenewed stream bounds to exercise cancellation and renewal. The default entry starts its own 300-second bound and cannot recover time already spent in the public Gateway.',
        'The configured Hyperdrive IDs are placeholders and activation is disabled. No configured deployment, provider-source bill, production Chat route or financial closer is enabled.',
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
      const wireRequests=[];
      const closedPaths=[];
      const loopback=createServer(async(request,response)=>{
        const chunks=[];
        for await(const chunk of request) chunks.push(chunk);
        wireRequests.push({method:request.method,url:request.url,
          authorization:request.headers.authorization,body:Buffer.concat(chunks)});
        response.once('close',()=>closedPaths.push(request.url));
        if(request.url!=='/v1/chat/completions'){
          response.writeHead(request.url==='/rejected'?503:200,{
            'Content-Type':'text/event-stream','Set-Cookie':'private=secret',
            'X-Private-Provider-Header':'never-forward'});
          response.write('data: {"owned":"partial"}\n\n');
          if(request.url==='/eof')response.end('data: [DONE]\n\n');
          if(request.url==='/error')setTimeout(()=>response.destroy(),100);
          return;
        }
        response.writeHead(200,{'Content-Type':'application/json',
          'X-Private-Provider-Header':'must-not-cross-gateway'});
        response.end('{"ok":true}');
      });
      loopback.listen(0,'127.0.0.1');
      await once(loopback,'listening');
      const address=loopback.address();
      assert.ok(address && typeof address==='object');
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
      const makeInput=async(stream=false)=>{
        // Owned flat-text input at the production helper's post-transformation boundary.
        // This fixture does not execute production preset or Guardrail middleware.
        const raw='{"model":"v361-model","messages":[{"role":"user","content":"hello"}],"max_completion_tokens":300}';
        const currentBody=JSON.parse(raw);
        currentBody.messages.unshift({role:'system',content:'Use concise answers.'});
        currentBody.max_completion_tokens=250;
        if(stream) currentBody.stream=true;
        const result=parseOpenAiModelFallbacks(currentBody);
        assert.equal(result.ok,true);
        const parsed=result.value;
        const selectedRoute={targetId:'v361-route',providerId:'v361-provider',
          providerKeyId:'v361-provider',providerModelName:'upstream-v361',
          gatewayCandidateIndex:0,gatewayModelId:'v361-model',
          upstreamProtocol:'openai',upstreamOperation:'chat',adapter:'passthrough',
          providerEndpoints:{openai:{base:'https://v367-local.invalid/v1'}},
          providerApiKey:ciphertext,providerSharedChannelType:null,
          priceOverrideRaw:null,customParams:null,endpoint:{id:'v361-endpoint'}};
        const plan={ok:true,candidates:[{requestedModelId:'v361-model',
          baseModelId:'v361-model',upstreamBody:parsed.upstreamBody,routes:[selectedRoute]}],
          endpointPartition:'model',globalRoutes:[]};
        const bytes=new TextEncoder().encode(raw);
        const finalQuoteInput=await createFinalChatQuoteInput({
          requestId:`v390-${randomUUID()}`,
          originalBodySha256:await originalChatBodySha256(bytes.buffer),
          finalBody:currentBody,parsed,plan});
        assert.notEqual(finalQuoteInput.originalBodySha256,finalQuoteInput.finalBodySha256);
        assert.deepEqual(JSON.parse(finalQuoteInput.finalBodyUtf8),{
          ...currentBody,models:['v361-model']});
        return {finalQuoteInput,currentBody,parsed,plan,selectedRoute,
          guardrailIntents:intents(),bearer,
          identity:{apiKeyId:'v361-key',userId:'v361-user',
            workspaceId:'v361-workspace',budgetEpoch:0,keyLimitEpoch:0},
          runtimeClient:{driver:'postgres',raw:runtime},
          runtimeConnectionString:urls.runtime,capabilityConnectionString:urls.cap,
          quoteConnectionString:urls.complete,admissionConnectionString:urls.admission,
          signal:new AbortController().signal};
      };

      const holderEnv={COMPLETE_TEXT_HOLDER_ENABLED:'reviewed-v1',
        PROVIDER_KEY_ENCRYPTION_SECRET:providerSecret,
        COMPLETE_TEXT_READER:{connectionString:urls.reader},
        COMPLETE_TEXT_GRANTER:{connectionString:urls.granter},
        COMPLETE_TEXT_HOLDER:{connectionString:urls.holder},
        COMPLETE_TEXT_RENEWER:{connectionString:urls.renewer}};
      const retained=[];
      const newWorker=(path='/v1/chat/completions',options={})=>createCompleteTextHolderWorkerV390({
        ...options,fetchUpstream:(url,init)=>{
          assert.equal(String(url),'https://v367-local.invalid/v1/chat/completions');
          assert.equal(init.redirect,'error');
          return fetch(`http://127.0.0.1:${address.port}${path}`,init);
        }});
      const invoke=async(input,worker,env=holderEnv)=>{
        const tasks=[];
        const ctx={waitUntil(task){tasks.push(task);}};
        const dispatch=createCompleteChatHolderDispatchV385({...input,
          holderBinding:{async fetch(request){
            const copy=request.clone();
            retained.push(await copy.json());
            return worker.fetch(request,env,ctx);
          }}});
        let response=null,error=null;
        try{response=await dispatch.run();}catch(cause){error=cause;}
        return {response,error,tasks};
      };
      const drain=async(tasks)=>{
        let timer;
        try{await Promise.race([Promise.all(tasks),new Promise((_,reject)=>{
          timer=setTimeout(()=>reject(new Error('Worker resource completion did not drain')),5000);
        })]);}finally{clearTimeout(timer);}
      };
      const waitFor=async(predicate)=>{
        const deadline=Date.now()+5000;
        while(!await predicate()){
          if(Date.now()>deadline)throw new Error('Owned observation did not arrive');
          await new Promise(resolve=>setTimeout(resolve,20));
        }
      };
      const durable=async(requestId)=>{
        const [row]=await migrator.unsafe(`SELECT
          (SELECT count(*)::integer FROM ${g}.complete_text_attempt_grants_v362 WHERE request_id=$1) AS grants,
          (SELECT count(*)::integer FROM ${g}.complete_text_send_starts_v365 WHERE request_id=$1) AS starts,
          (SELECT count(*)::integer FROM ${g}.complete_text_result_facts_v366 WHERE request_id=$1) AS facts,
          (SELECT count(*)::integer FROM ${g}.complete_text_hold_renewals_v367 WHERE request_id=$1) AS renewals,
          (SELECT state FROM ${g}.user_budget_reservations WHERE request_id=$1) AS ordinary_state,
          (SELECT count(*)::integer FROM ${g}.guardrail_budget_reservations WHERE request_id=$1 AND state='dispatched') AS guardrails,
          (SELECT count(*)::integer FROM ${g}.complete_text_attempt_grants_v362 WHERE request_id=$1 AND obligation_state='unknown') AS unknown_grants`,[requestId]);
        return row;
      };
      const sent={grants:1,starts:1,facts:1,renewals:0,ordinary_state:'dispatched',guardrails:3,unknown_grants:1};
      try{
        const sharedWorker=newWorker();
        const positive=await makeInput();
        const positiveRun=await invoke(positive,sharedWorker);
        assert.equal(positiveRun.error,null);assert.equal(positiveRun.response.status,200);
        assert.deepEqual(await positiveRun.response.json(),{ok:true});
        await drain(positiveRun.tasks);
        assert.equal(positiveRun.response.headers.get('X-Private-Provider-Header'),null);
        assert.equal(wireRequests.length,1);
        assert.equal(wireRequests[0].authorization,`Bearer ${providerBearer}`);
        assert.deepEqual(JSON.parse(wireRequests[0].body),{...positive.currentBody,model:'upstream-v361'});
        const [identity]=await migrator.unsafe(`SELECT a.grant_id,a.outbound_body_sha256,
          a.upstream_url_sha256,s.send_start_id,s.holder_run_id,
          s.outbound_body_sha256 AS start_sha,f.fact_id,f.kind,f.source_kind,
          f.send_start_id AS fact_start_id,f.holder_run_id AS fact_run_id,
          f.outbound_body_sha256 AS fact_sha,f.evidence->>'uploadSha256' AS evidence_sha
          FROM ${g}.complete_text_attempt_grants_v362 a
          JOIN ${g}.complete_text_send_starts_v365 s USING(grant_id)
          JOIN ${g}.complete_text_result_facts_v366 f USING(grant_id)
          WHERE a.request_id=$1`,[positive.finalQuoteInput.requestId]);
        assert.equal(identity.kind,'fetch_invoked');assert.equal(identity.source_kind,'holder');
        assert.equal(identity.fact_start_id,identity.send_start_id);
        assert.equal(identity.fact_run_id,identity.holder_run_id);
        for(const digest of [identity.outbound_body_sha256,identity.start_sha,identity.fact_sha,identity.evidence_sha])
          assert.equal(digest,sha(wireRequests[0].body));
        assert.equal(identity.upstream_url_sha256,sha('https://v367-local.invalid/v1/chat/completions'));
        assert.deepEqual(await durable(positive.finalQuoteInput.requestId),sent);
        stage('real-worker-default-login-chain-one-owned-post-and-bound-invocation-fact',{
          requestId:positive.finalQuoteInput.requestId,grantId:identity.grant_id,
          sendStartId:identity.send_start_id,factId:identity.fact_id,physicalPosts:1,
          uploadBytes:wireRequests[0].body.length,outboundBodySha256:identity.outbound_body_sha256});

        const replayTasks=[];
        const replay=await sharedWorker.fetch(new Request('https://holder.service.invalid/complete-text-attempt',{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({...retained[0],attemptNonce:randomUUID()})}),holderEnv,
          {waitUntil(task){replayTasks.push(task);}});
        assert.equal(replay.status,502);await drain(replayTasks);
        assert.equal(wireRequests.length,1);
        const second=await makeInput();const secondRun=await invoke(second,sharedWorker);
        assert.equal(secondRun.error,null);await secondRun.response.text();await drain(secondRun.tasks);
        assert.equal(wireRequests.length,2);
        assert.deepEqual(await durable(second.finalQuoteInput.requestId),sent);
        stage('same-worker-object-creates-new-holder-per-request-and-replay-cannot-resend',{
          freshRequestPosts:1,replayAddedPosts:0});

        for(const mode of ['eof','error','cancel','caller','deadline','rejected']){
          const input=await makeInput(true);const abort=new AbortController();input.signal=abort.signal;
          const prior=wireRequests.length;
          const run=await invoke(input,newWorker(`/${mode}`,{maxRequestMs:mode==='deadline'?2000:10000}));
          if(mode==='rejected')assert.ok(run.error);
          else{
            assert.equal(run.error,null);assert.equal(run.response.headers.get('Set-Cookie'),null);
            assert.equal(run.response.headers.get('X-Private-Provider-Header'),null);
            if(mode==='eof')assert.match(await run.response.text(),/\[DONE\]/u);
            else if(mode==='cancel')await run.response.body.cancel();
            else if(mode==='caller'){abort.abort();await assert.rejects(run.response.text());}
            else await assert.rejects(run.response.text());
          }
          await drain(run.tasks);
          await waitFor(()=>closedPaths.includes(`/${mode}`));
          assert.equal(wireRequests.length,prior+1);
          const wireBody=JSON.parse(wireRequests.at(-1).body);
          assert.equal(wireBody.stream,true);
          assert.deepEqual(wireBody.stream_options,{include_usage:true});
          assert.deepEqual(await durable(input.finalQuoteInput.requestId),sent);
          stage(`worker-stream-${mode}-stops-owned-response-and-keeps-economic-unknown`,{
            physicalPosts:1,drainedWaitUntil:true});
        }

        const renewed=await makeInput(true);const renewedAbort=new AbortController();renewed.signal=renewedAbort.signal;
        const renewedRun=await invoke(renewed,newWorker('/renew',{maxRequestMs:10000,maxUnrenewedStreamMs:3000}));
        assert.equal(renewedRun.error,null);
        await waitFor(async()=> (await durable(renewed.finalQuoteInput.requestId)).renewals>0);
        renewedAbort.abort();await assert.rejects(renewedRun.response.text());await drain(renewedRun.tasks);
        await waitFor(()=>closedPaths.includes('/renew'));
        const renewedState=await durable(renewed.finalQuoteInput.requestId);
        assert.ok(renewedState.renewals>=1);assert.equal(renewedState.unknown_grants,1);
        const [lease]=await migrator.unsafe(`SELECT count(*)::integer AS n FROM (
          SELECT expires_at FROM ${g}.user_budget_reservations WHERE request_id=$1
          UNION ALL SELECT expires_at FROM ${g}.guardrail_budget_reservations WHERE request_id=$1
        ) h WHERE expires_at=(SELECT max(lease_until) FROM ${g}.complete_text_hold_renewals_v367 WHERE request_id=$1)`,
          [renewed.finalQuoteInput.requestId]);
        assert.equal(lease.n,4);
        stage('actual-v369-renewal-commit-extends-all-four-holds-before-stream-cancel',{
          renewals:renewedState.renewals,matchingHoldLeases:4});

        const proxy=await startJournalCommitAckDropProxyV381({upstreamHost:'127.0.0.1',upstreamPort:cluster.port});
        try{
          const proxyUrl=new URL(urls.renewer);proxyUrl.port=String(proxy.port);
          const loss=await makeInput(true);
          const lossRun=await invoke(loss,newWorker('/renew-ack-loss',{maxRequestMs:10000,maxUnrenewedStreamMs:3000}),{
            ...holderEnv,COMPLETE_TEXT_RENEWER:{connectionString:proxyUrl.href}});
          assert.equal(lossRun.error,null);
          await proxy.waitForDrop();
          await assert.rejects(lossRun.response.text());await drain(lossRun.tasks);
          await waitFor(()=>closedPaths.includes('/renew-ack-loss'));
          const state=await durable(loss.finalQuoteInput.requestId);
          assert.equal(state.renewals,1);assert.equal(state.unknown_grants,1);
          assert.equal(proxy.facts.commitCommands,1);assert.equal(proxy.facts.backendCommitCompletes,1);
          assert.equal(proxy.facts.droppedCommitAcks,1);
          stage('real-renewal-commit-response-loss-never-extends-worker-stream-authority',{
            proxyFacts:{...proxy.facts},renewals:state.renewals,drainedWaitUntil:true});
        }finally{await proxy.close();}

        const [noBilling]=await migrator.unsafe(`SELECT
          (SELECT count(*)::integer FROM ${g}.api_key_request_logs) AS logs,
          (SELECT count(*)::integer FROM ${g}.complete_text_result_facts_v366
            WHERE kind<>'fetch_invoked') AS other_facts`);
        assert.deepEqual(noBilling,{logs:0,other_facts:0});
        stage('no-provider-usage-bill-financial-log-or-terminal-created',{totalPhysicalPosts:wireRequests.length});
        assert.equal(sha(await readFile(new URL(import.meta.url))),loadedFixtureSha256,
          'Native fixture changed while it was executing');
        report.status='PASS';
      }finally{
        loopback.closeAllConnections();
        await new Promise((resolve,reject)=>loopback.close(error=>error?reject(error):resolve()));
      }
    }catch(error){failure=error;report.status='FAIL';report.failure={message:String(error?.stack??error).slice(0,7000)};}
    finally{
      await Promise.allSettled(clients.map(client=>client.end({timeout:1})));
      try{await cluster.cleanup();report.cleanup='PASS';}
      catch(error){report.cleanup='FAIL';report.cleanupError=String(error);failure??=error;}
      report.sourceSha256.fixture=sha(await readFile(new URL(import.meta.url)));
      for(const path of [
        'packages/proxy/src/runtime/complete-text-holder-worker-v390.ts',
        'packages/proxy/src/runtime/complete-text-holder-worker-v390.test.mjs',
        'packages/proxy/src/services/private-complete-text-holder-v365.test.ts',
        'packages/proxy/src/runtime/complete-text-holder-v390-env.d.ts',
        'packages/proxy/wrangler.complete-text-holder-v390.jsonc',
        ...['chat-final-quote-input.ts','model-fallbacks.ts','complete-chat-holder-dispatch-v385.ts',
          'postgres-complete-chat-quote-v360.ts','postgres-complete-chat-admission-v361.ts',
          'chat-text-holder-request-v363.ts','postgres-private-complete-text-reader-v366.ts',
          'postgres-complete-text-attempt-grant-v362.ts','postgres-complete-text-send-start-v365.ts',
          'postgres-complete-text-hold-renewal-v369.ts','hyperdrive-dedicated-role-transport-v390.ts'].map(name=>`packages/proxy/src/services/${name}`),
        'packages/core/src/test-support/postgres-journal-commit-ack-proxy-v381.mjs'])
        report.sourceSha256[path]=sha(await readFile(new URL(`../../../${path}`,import.meta.url)));
      await writeFile(reportUrl,JSON.stringify(report,null,2)+'\n');
      process.stdout.write(`complete-text-holder-worker-v390-report=${reportUrl.pathname}\n`);
    }
    if(failure)throw failure;
    assert.equal(report.cleanup,'PASS');
  });
