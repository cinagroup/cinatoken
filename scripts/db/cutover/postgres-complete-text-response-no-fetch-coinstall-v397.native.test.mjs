// Owned PG18.6 proof of the v390 private Worker through real role clients.
import assert from 'node:assert/strict';
import { runPostgresCompleteTextNoFetchRecoveryV389 } from '../../../packages/proxy/src/services/postgres-complete-text-no-fetch-recovery-v389.ts';
import { confirmPostgresCompleteTextNoFetchV370 } from '../../../packages/proxy/src/services/postgres-complete-text-no-fetch-v372.ts';
import { grantPostgresCompleteTextAttemptV362 } from '../../../packages/proxy/src/services/postgres-complete-text-attempt-grant-v362.ts';
import { renewPostgresCompleteTextHoldsV367 } from '../../../packages/proxy/src/services/postgres-complete-text-hold-renewal-v369.ts';
import { issuePostgresCompleteChatQuoteV360 } from '../../../packages/proxy/src/services/postgres-complete-chat-quote-v360.ts';
import { admitPostgresCompleteChatQuoteV361 } from '../../../packages/proxy/src/services/postgres-complete-chat-admission-v361.ts';
import { closePostgresCompleteTextNoFetchV388 } from '../../../packages/proxy/src/services/postgres-complete-text-no-fetch-close-v388.ts';
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
import { createCompleteTextResponseHolderWorkerV394 } from '../../../packages/proxy/src/runtime/complete-text-response-holder-worker-v394.ts';
import { appendPostgresCompleteTextResponseObservationV392 } from '../../../packages/proxy/src/services/postgres-complete-text-response-observation-v392.ts';
import { createConnection, createServer as createTcpServer } from 'node:net';
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
const reportUrl=new URL('../../../docs/developers/architecture/implementation-evidence/C04-complete-text-response-no-fetch-coinstall-v397-report.json',import.meta.url);
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
const noFetchPrerequisites=[
  ['complete-text-no-fetch-fence-v370.sql','complete_text_no_fetch_fence_v370_activation'],
  ['complete-text-legacy-buyer-held-writer-v368.sql','legacy_buyer_held_writer_v368_activation'],
  ['buyer-split-counter-grant-policy-v368.sql','buyer_counter_grant_policy_v368_activation'],
  ['complete-text-legacy-buyer-window-accountant-v371.sql','legacy_buyer_window_accountant_v371_activation'],
  ['complete-text-legacy-buyer-window-acl-v372.sql','legacy_buyer_window_acl_v372_activation'],
  ['complete-text-legacy-buyer-admission-fence-v380.sql','complete_text_legacy_buyer_admission_fence_v380_activation'],
  ['complete-text-platform-close-fence-v386.sql','complete_text_platform_close_fence_v386_activation'],
  ['complete-text-no-fetch-platform-close-v388.sql','complete_text_no_fetch_close_v388_activation'],
  ['complete-text-no-fetch-recovery-v389.sql','complete_text_no_fetch_recovery_v389_activation'],
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
  recovery:'cinatoken_gateway_budget_recovery',observer:'cinatoken_gateway_complete_text_response_observer',
  resolver:'cinatoken_gateway_complete_text_no_fetch_resolver',closer:'cinatoken_gateway_complete_text_platform_closer',
  nfworker:'cinatoken_gateway_complete_text_recovery_worker',nfobserver:'cinatoken_gateway_complete_text_recovery_observer',nfoperator:'cinatoken_gateway_complete_text_recovery_operator'};

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

const runtimeSources=[
        'packages/proxy/src/runtime/complete-text-holder-worker-v390.ts',
        'packages/proxy/src/runtime/complete-text-response-holder-worker-v394.ts',
        'packages/proxy/src/runtime/complete-text-response-holder-v394-env.d.ts',
        'packages/proxy/wrangler.complete-text-response-holder-v394.jsonc',
        'packages/proxy/src/services/complete-text-response-observation-v392.ts',
        'packages/proxy/src/services/complete-text-response-observation-v392.test.ts',
        'packages/proxy/src/services/private-complete-text-response-holder-v392.ts',
        'packages/proxy/src/services/postgres-complete-text-response-observation-v392.ts',
        'packages/proxy/src/services/postgres-complete-text-response-observation-v392.test.ts',
        'packages/proxy/src/runtime/complete-text-response-holder-worker-v394.test.mjs',
        'packages/proxy/src/runtime/complete-text-holder-worker-v390.test.mjs',
        'packages/proxy/src/services/private-complete-text-holder-v365.test.ts',
        'packages/proxy/src/runtime/complete-text-holder-v390-env.d.ts',
        'packages/proxy/wrangler.complete-text-holder-v390.jsonc',
        ...['chat-final-quote-input.ts','model-fallbacks.ts','complete-chat-holder-dispatch-v385.ts',
          'postgres-complete-chat-quote-v360.ts','postgres-complete-chat-admission-v361.ts',
          'chat-text-holder-request-v363.ts','postgres-private-complete-text-reader-v366.ts',
          'postgres-complete-text-attempt-grant-v362.ts','postgres-complete-text-send-start-v365.ts',
          'postgres-complete-text-hold-renewal-v369.ts','hyperdrive-dedicated-role-transport-v390.ts'].map(name=>`packages/proxy/src/services/${name}`),
        'packages/core/src/test-support/postgres-journal-commit-ack-proxy-v381.mjs'];
runtimeSources.push('packages/proxy/src/services/postgres-complete-text-no-fetch-recovery-v389.ts',
  'packages/proxy/src/services/postgres-complete-text-no-fetch-v372.ts',
  'packages/proxy/src/services/postgres-complete-text-no-fetch-close-v388.ts',
  'packages/core/src/test-support/postgres-native-cluster.mjs',
  'scripts/db/cutover/grant-postgres-runtime.ts',
  'scripts/db/cutover/activate-postgres-buyer-split-v348.ts',
  'scripts/db/cutover/grant-postgres-buyer-split-v348.ts',
  'scripts/db/cutover/activate-postgres-buyer-guardrail-split-v349.ts',
  'scripts/db/cutover/grant-postgres-buyer-guardrail-split-v349.ts');

test('v397 response observation and no-fetch recovery coexist under the reviewed installation order',
  {timeout:300_000,skip:!process.env.GATEWAY_NATIVE_PG_BIN},async()=>{
    const loadedFixtureSha256=sha(await readFile(new URL(import.meta.url)));
    const runtimeSourcePins=Object.fromEntries(await Promise.all(runtimeSources.map(async path=>[path,sha(await readFile(new URL(`../../../${path}`,import.meta.url)))])));
    const cluster=await startNativePostgres();
    const report={status:'RUNNING',cleanup:'PENDING',binaryVersion:cluster.binaryVersion,
      sourceSha256:{},stages:[],limitations:[
        'Joint installation uses one reviewed order: v370 renewed facts, v392, v370 no-fetch, v368/v371/v372/v380/v386, v388 and v389. Arbitrary installation orders remain unsupported.',
        'Owned PG18.6 + loopback HTTP only; no paid Provider, remote SQL, deployment, Hyperdrive or actual Cloudflare Binding was used.',
        'Actual v394 Worker and v385 dispatch run in Node with real default role clients. Prepared HTTPS fixture URL is rewritten only by the injected physical fetch to owned HTTP loopback.',
        'Raw digest covers fetch-readable bytes after HTTP decoding, not TLS/compressed wire. Observation trusts the isolated holder, not a Provider signature.',
        'Usage observations do not establish supplier cost, zero bill, buyer settlement, terminal or release. Sent grants stay unknown and all four holds stay dispatched; independently verified never-started grants can close through the no-fetch authority.',
        'SSE DONE and the complete bounded JSON body are released only after observation COMMIT and connection close acknowledge.',
        'No durable response spool exists before observation COMMIT. Stable same-start nonce and independent reader recover committed observations without a second POST.',
        'COMMIT proxy observes backend CommandComplete(COMMIT), suppresses it and closes the client; it does not prove remote pooler or close-ACK behavior.',
        'Scoped owned-cluster administrator time shortening keeps send_expires_at later than granted_at. Temporary privileged probe wrappers deliberately insert a malformed cross-grant observation to test the new insert fences independently of existing wrapper validation; the forged row and wrappers are removed before normal recovery.',
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

      const renewedSql=await readFile(proposal('complete-text-renewed-holder-facts-v370.sql'),'utf8');
      await migrator.begin(async tx=>{await tx.unsafe("SET LOCAL cinatoken.complete_text_renewed_facts_v370_activation='reviewed-v1'");await tx.unsafe(renewedSql).simple();});
      const observationSql=await readFile(proposal('complete-text-response-observation-v392.sql'),'utf8');
      report.sourceSha256['complete-text-response-observation-v392.sql']=sha(observationSql);
      await assert.rejects(migrator.begin(tx=>tx.unsafe(observationSql).simple()),error=>{
        assert.equal(error.code,'P0001',JSON.stringify({message:error.message,position:error.position,internalPosition:error.internal_position,internalQuery:error.internal_query,where:error.where}));
        assert.match(error.message,/activation or dependency differs/u);return true;
      });
      for(const [name,mutation] of [
        ['observer-provider-column',`GRANT SELECT(api_key) ON ${g}.providers TO ${roles.observer}`],
        ['observer-holder-wrapper',`GRANT EXECUTE ON FUNCTION ${g}.append_complete_text_holder_fact_v366(uuid,uuid,bigint,uuid,text,jsonb,text) TO ${roles.observer}`],
        ['global-function-grant-option',`ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO ${roles.runtime} WITH GRANT OPTION`],
        ['global-observer-table-default',`ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO ${roles.observer}`],
        ['disabled-fact-immutable-trigger',`ALTER TABLE ${g}.complete_text_result_facts_v366 DISABLE TRIGGER complete_text_result_facts_v366_no_mutation`],
        ['same-name-noop-fact-immutable-function',`CREATE OR REPLACE FUNCTION ${g}.reject_complete_text_result_fact_mutation_v366() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,pg_temp AS 'BEGIN RETURN NEW; END;'`],
        ['PG73-equal-count-version-drift',`UPDATE ${g}.schema_migrations SET version=version||'-drift' WHERE version=(SELECT min(version) FROM ${g}.schema_migrations)`],
        ['runtime-fact-truncate',`GRANT TRUNCATE ON ${g}.complete_text_result_facts_v366 TO ${roles.runtime}`],
        ['missing-epoch-conflict-no-truncate',`DROP TRIGGER complete_text_result_epoch_conflicts_v370_no_truncate ON ${g}.complete_text_result_epoch_conflicts_v370`],
      ]) {
        await assert.rejects(migrator.begin(async tx=>{
          await tx.unsafe(mutation).simple();
          await tx.unsafe("SET LOCAL cinatoken.complete_text_response_observation_v392_activation='reviewed-v1'");
          await tx.unsafe(observationSql).simple();
        }), error=>{assert.equal(error.code,'P0001',`${name}: ${error.message}; ${error.where??''}`);return true;});
        const [absent]=await migrator.unsafe("SELECT to_regnamespace('cinatoken_response_observation') AS value");assert.equal(absent.value,null);
        stage(`preflight-rejects-${name}-before-atomic-install`);
      }
      await assert.rejects(migrator.begin(async tx=>{
        for(const [name,setting] of noFetchPrerequisites){const body=await readFile(proposal(name),'utf8');await tx.unsafe(`SET LOCAL cinatoken.${setting}='reviewed-v1'`);await tx.unsafe(body).simple();}
        await tx.unsafe("SET LOCAL cinatoken.complete_text_response_observation_v392_activation='reviewed-v1'");await tx.unsafe(observationSql).simple();
      }),error=>error.code==='P0001'&&/response observation v392 .*dependency differs/u.test(error.message));
      const [reverseRolledBack]=await migrator.unsafe("SELECT to_regnamespace('cinatoken_response_observation') IS NULL AND to_regclass('cinatoken_gateway.complete_text_platform_terminals_v388') IS NULL AND to_regnamespace('cinatoken_text_no_fetch_recovery') IS NULL AS clean");assert.equal(reverseRolledBack.clean,true);
      stage('reverse-first-install-no-fetch-terminal-recovery-before-frozen-v392-refused-and-rolled-back');
      await migrator.begin(async tx=>{await tx.unsafe("SET LOCAL cinatoken.complete_text_response_observation_v392_activation='reviewed-v1'");await tx.unsafe(observationSql).simple();});
      const observer=connection(cluster,roles.observer,passwords.observer,'observer');clients.push(observer);
      await denied(observer.unsafe('SELECT * FROM cinatoken_response_observation.observations_v392'));
      await denied(holder.unsafe('SELECT * FROM cinatoken_response_observation.observations_v392'));
      stage('v392-default-off-atomic-install-and-independent-reader-without-raw-access');

      for(const [name,setting] of noFetchPrerequisites) {
        const body=await readFile(proposal(name),'utf8');report.sourceSha256[name]=sha(body);
        await migrator.begin(async tx=>{await tx.unsafe(`SET LOCAL cinatoken.${setting}='reviewed-v1'`);await tx.unsafe(body).simple();});
      }
      stage('frozen-v392-first-then-v370-no-fetch-v368-v371-v372-v380-v386-v388-v389-install-on-one-database');
      await assert.rejects(migrator.begin(async tx=>{await tx.unsafe("SET LOCAL cinatoken.complete_text_response_observation_v392_activation='reviewed-v1'");await tx.unsafe(observationSql).simple();}),/activation or dependency differs/u);
      stage('reverse-reinstall-of-frozen-v392-refused-without-relaxing-exact-baseline');
      const relevantTables=['complete_text_attempt_grants_v362','complete_text_send_custody_v365','complete_text_send_starts_v365','complete_text_result_facts_v366','complete_text_result_fact_conflicts_v366','complete_text_hold_renewals_v367','complete_text_result_epoch_conflicts_v370','complete_text_no_fetch_resolutions_v370','complete_text_platform_close_fences_v386','complete_text_platform_terminals_v388','complete_text_platform_outbox_v388','complete_text_admissions_v361','api_key_request_logs','user_budget_reservations','guardrail_budget_reservations','users','guardrail_budget_windows'];
      const catalog=await migrator.unsafe(`SELECT n.nspname AS schema,c.relname AS table_name,t.tgname AS name,pn.nspname||'.'||p.proname||'('||pg_catalog.pg_get_function_identity_arguments(p.oid)||')' AS function_name,
        t.tgtype::integer AS type,t.tgdeferrable AS deferrable,t.tginitdeferred AS initially_deferred
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace
        WHERE NOT t.tgisinternal AND ((n.nspname='cinatoken_gateway' AND c.relname IN (SELECT jsonb_array_elements_text($1::text::jsonb))) OR n.nspname IN ('cinatoken_response_observation','cinatoken_text_no_fetch_recovery')) ORDER BY n.nspname,c.relname,t.tgname`,[JSON.stringify(relevantTables)]);
      await writeFile(new URL('../../../.wrangler/staging/v397-trigger-catalog.json',import.meta.url),JSON.stringify(catalog,null,2));
      const financialAcl=await migrator.unsafe(`SELECT c.relname AS name,COALESCE(jsonb_agg(jsonb_build_object('role',r.rolname,'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY r.rolname,a.privilege_type) FILTER(WHERE a.grantee<>c.relowner),'[]'::jsonb) AS acl,
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('column',col.attname,'role',gr.rolname,'privilege',ca.privilege_type,'grantable',ca.is_grantable) ORDER BY col.attname,gr.rolname,ca.privilege_type) FILTER(WHERE ca.grantee<>c.relowner),'[]'::jsonb)
          FROM pg_attribute col CROSS JOIN LATERAL aclexplode(col.attacl) ca LEFT JOIN pg_roles gr ON gr.oid=ca.grantee WHERE col.attrelid=c.oid) AS "columnAcl"
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a LEFT JOIN pg_roles r ON r.oid=a.grantee
        WHERE n.nspname='cinatoken_gateway' AND c.relname IN ('api_key_request_logs','user_budget_reservations','guardrail_budget_reservations','users','guardrail_budget_windows') GROUP BY c.relname,c.oid,c.relowner`);
      await writeFile(new URL('../../../.wrangler/staging/v397-financial-acl.json',import.meta.url),JSON.stringify(financialAcl,null,2));
      const functionCatalog=await migrator.unsafe(`SELECT DISTINCT pn.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS signature,md5(replace(p.prosrc,E'\\r\\n',E'\\n')) AS digest,
        p.prorettype::regtype::text AS "returnType",p.provolatile::text AS volatility,to_jsonb(p.proconfig) AS config,p.prosecdef AS "securityDefiner",
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('role',COALESCE(r.rolname,'PUBLIC'),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY COALESCE(r.rolname,'PUBLIC'),a.privilege_type) FILTER(WHERE a.grantee<>p.proowner),'[]'::jsonb)
          FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a LEFT JOIN pg_roles r ON r.oid=a.grantee) AS "executeAcl"
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace
        WHERE NOT t.tgisinternal AND ((n.nspname='cinatoken_gateway' AND c.relname IN (SELECT jsonb_array_elements_text($1::text::jsonb))) OR n.nspname IN ('cinatoken_response_observation','cinatoken_text_no_fetch_recovery'))`,[JSON.stringify(relevantTables)]);
      await writeFile(new URL('../../../.wrangler/staging/v397-function-catalog.json',import.meta.url),JSON.stringify(functionCatalog,null,2));
      const jointSql=await readFile(proposal('complete-text-response-no-fetch-coinstall-v397.sql'),'utf8');
      report.sourceSha256['complete-text-response-no-fetch-coinstall-v397.sql']=sha(jointSql);
      const rejectedInstall=async(name,action=async()=>{},activate=true)=>{
        await assert.rejects(migrator.begin(async tx=>{
          if(activate)await tx.unsafe("SET LOCAL cinatoken.complete_text_coinstall_v397_activation='reviewed-v1'");
          await action(tx);await tx.unsafe(jointSql).simple();
        }),error=>error.code==='P0001');
        const [row]=await migrator.unsafe("SELECT to_regprocedure('cinatoken_response_observation.reject_no_fetch_overlap_v397()') IS NULL AS absent");assert.equal(row.absent,true);
        stage(`joint-preflight-${name}-rejects-atomic-install`);
      };
      await rejectedInstall('disabled',undefined,false);
      await rejectedInstall('extra-holder-wrapper',tx=>tx.unsafe('GRANT EXECUTE ON FUNCTION cinatoken_gateway.append_complete_text_provider_bill_v366(uuid,uuid,jsonb,text) TO cinatoken_gateway_complete_text_send_holder'));
      await rejectedInstall('unlisted-function-grantee',tx=>tx.unsafe('GRANT EXECUTE ON FUNCTION cinatoken_text_no_fetch_recovery.inspect_v389(uuid) TO cinatoken_gateway_request_capability_issuer'));
      await rejectedInstall('unlisted-financial-writer',tx=>tx.unsafe('GRANT UPDATE ON cinatoken_gateway.user_budget_reservations TO cinatoken_gateway_request_capability_issuer'));
      await rejectedInstall('observer-secret-column',tx=>tx.unsafe('GRANT SELECT(api_key) ON cinatoken_gateway.providers TO cinatoken_gateway_complete_text_response_observer'));
      await rejectedInstall('disabled-joint-trigger',tx=>tx.unsafe('ALTER TABLE cinatoken_gateway.complete_text_platform_terminals_v388 DISABLE TRIGGER platform_terminal_complete_v388'));
      await rejectedInstall('extra-default-execute',tx=>tx.unsafe('ALTER DEFAULT PRIVILEGES IN SCHEMA cinatoken_response_observation GRANT EXECUTE ON FUNCTIONS TO cinatoken_gateway_complete_text_response_observer WITH GRANT OPTION'));
      const [body]=await migrator.unsafe("SELECT pg_get_functiondef('cinatoken_text_no_fetch_recovery.inspect_v389(uuid)'::regprocedure) AS definition,prosrc AS source FROM pg_proc WHERE oid='cinatoken_text_no_fetch_recovery.inspect_v389(uuid)'::regprocedure");
      await rejectedInstall('changed-observer-body',tx=>tx.unsafe(body.definition.replace(body.source,body.source+'\n-- changed dependency\n')).simple());
      await migrator.begin(async tx=>{await tx.unsafe("SET LOCAL cinatoken.complete_text_coinstall_v397_activation='reviewed-v1'");await tx.unsafe(jointSql).simple();});
      stage('strict-joint-owner-function-body-trigger-role-acl-contract-installed',{dependencyFunctions:JSON.parse(jointSql.split('function_pins:=$pins$')[1].split('$pins$')[0]).length,dependencyTriggers:catalog.length});

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
      const pendingResponses=new Map();
      const reportedUsage={prompt_tokens:9,completion_tokens:3,total_tokens:12,
        prompt_tokens_details:{cached_tokens:2,cache_write_tokens:0,audio_tokens:0,image_tokens:0,text_tokens:9},
        completion_tokens_details:{reasoning_tokens:1,accepted_prediction_tokens:0,rejected_prediction_tokens:0,audio_tokens:0,text_tokens:3}};
      const jsonBody=JSON.stringify({id:'chatcmpl-local',object:'chat.completion',model:'upstream-v361',service_tier:'default',
        choices:[{index:0,message:{role:'assistant',content:'hello'},finish_reason:'stop'}],usage:reportedUsage});
      const chunk=(choices,usage=null)=>JSON.stringify({id:'chatcmpl-local',object:'chat.completion.chunk',model:'upstream-v361',service_tier:'default',choices,usage});
      const ssePrefix=`data: ${chunk([{index:0,delta:{content:'hello'},finish_reason:null}])}\r\n\r\n`;
      const sseTail=`data: ${chunk([{index:0,delta:{},finish_reason:'stop'}])}\r\n\r\ndata: ${chunk([],reportedUsage)}\r\n\r\ndata: [DONE]\r\n\r\n`;
      const loopback=createServer(async(request,response)=>{
        const chunks=[];for await(const chunk of request)chunks.push(chunk);
        wireRequests.push({method:request.method,url:request.url,authorization:request.headers.authorization,body:Buffer.concat(chunks)});
        response.once('close',()=>closedPaths.push(request.url));
        response.writeHead(200,{'Content-Type':request.url==='/json'?'application/json':'text/event-stream','x-request-id':'req-local','X-Private-Provider-Header':'private'});
        if(request.url==='/json'){response.end(jsonBody);return;}
        response.write(ssePrefix);
        if(request.url==='/cancel')return;
        if(request.url==='/truncated'){response.end();return;}
        if(request.url==='/renewed'){setTimeout(()=>response.end(sseTail),1700);return;}
        if(request.url.startsWith('/joint-')){pendingResponses.set(request.url,response);return;}
        if(request.url==='/duplicate'){response.end(sseTail.replace('data: [DONE]',`data: ${chunk([],reportedUsage)}\n\ndata: [DONE]`));return;}
        response.end(sseTail);
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
      const newWorker=(path='/json',options={})=>createCompleteTextResponseHolderWorkerV394({
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
      const sent={grants:1,starts:1,facts:2,renewals:0,ordinary_state:'dispatched',guardrails:3,unknown_grants:1};
      const observationFor=async(requestId)=>{const [row]=await migrator.unsafe('SELECT * FROM cinatoken_response_observation.observations_v392 WHERE request_id=$1',[requestId]);return row;};
      const observe=async(grantId)=>{const [row]=await observer.unsafe('SELECT cinatoken_gateway.read_complete_text_response_observation_v392($1::uuid) AS value',[grantId]);return row.value;};
      const replayInput=row=>({holderConnectionString:urls.holder,grantId:row.grant_id,holderRunId:row.holder_run_id,
        sendStartId:row.send_start_id,expectedEpoch:1,evidenceNonce:row.evidence_nonce,observation:row.observation});
      const resolver=connection(cluster,roles.resolver,passwords.resolver,'joint-resolver');
      const closer=connection(cluster,roles.closer,passwords.closer,'joint-closer');
      const renewer=connection(cluster,roles.renewer,passwords.renewer,'joint-renewer');
      clients.push(resolver,closer,renewer);
      const recoveryConnections={workerConnectionString:urls.nfworker,observerConnectionString:urls.nfobserver,
        resolverConnectionString:urls.resolver,closerConnectionString:urls.closer};
      // Owned fixture time shortening changes only the selected grant/job. It
      // bypasses triggers as the cluster administrator, never as a runtime LOGIN.
      const pastDeadline=async grantId=>cluster.admin.begin(async tx=>{
        await tx.unsafe("SET LOCAL session_replication_role='replica'");
        await tx.unsafe(`UPDATE ${g}.complete_text_attempt_grants_v362 SET send_expires_at=LEAST(send_expires_at,GREATEST(granted_at+interval '1 millisecond',clock_timestamp()-interval '1 millisecond')) WHERE grant_id=$1`,[grantId]);
        await tx.unsafe('UPDATE cinatoken_text_no_fetch_recovery.jobs_v389 SET available_at=clock_timestamp()-interval \'1 second\' WHERE grant_id=$1',[grantId]);
      });
      const grantWithoutStart=async()=>{
        const input=await makeInput();const quote=await issuePostgresCompleteChatQuoteV360(input);
        await admitPostgresCompleteChatQuoteV361({...input,quote});
        const [route]=await migrator.unsafe(`SELECT * FROM ${g}.complete_text_quote_routes_v360 WHERE quote_id=$1 ORDER BY candidate_index,route_target_id LIMIT 1`,[quote.quoteId]);
        const claim={requestId:quote.requestId,quoteId:quote.quoteId,finalBodySha256:quote.finalBodySha256,
          candidateIndex:route.candidate_index,modelId:route.model_id,routeTargetId:route.route_target_id,
          providerId:route.provider_id,endpointId:route.endpoint_id,credentialClass:route.credential_class,
          credentialId:route.credential_id,providerCiphertextSha256:route.provider_ciphertext_sha256,
          preparedRouteSourceSha256:sha('owned-v397-never-sent-prepared-route'),method:'POST',
          upstreamUrlSha256:sha('https://v367-local.invalid/v1/chat/completions'),outboundBodySha256:sha(quote.finalBodyUtf8??input.finalQuoteInput.finalBodyUtf8),
          outboundBodyCanonicalSha256:sha(JSON.stringify(JSON.parse(input.finalQuoteInput.finalBodyUtf8))),
          outboundBodyBytes:Buffer.byteLength(input.finalQuoteInput.finalBodyUtf8),credentialFingerprintSha256:sha(providerBearer)};
        const receipt=await grantPostgresCompleteTextAttemptV362({granterConnectionString:urls.granter,attemptNonce:randomUUID(),claim});
        return {input,quote,receipt};
      };
      const waiting=async(login,label=null)=>{
        const [row]=await cluster.admin.unsafe("SELECT count(*)::integer AS n FROM pg_stat_activity WHERE usename=$1 AND wait_event='advisory' AND ($2::text IS NULL OR application_name=$2)",[login,label]);return row.n>0;
      };
      const eagerSql=pending=>{const promise=Promise.resolve(pending);void promise.catch(()=>{});return promise;};
      try{
        for(const path of ['/json','/sse']){
          const input=await makeInput(path!=='/json'),run=await invoke(input,newWorker(path));
          assert.equal(run.error,null);assert.equal(run.response.status,200);
          assert.equal(await run.response.text(),path==='/json'?jsonBody:ssePrefix+sseTail);await drain(run.tasks);
          assert.equal(run.response.headers.get('X-Private-Provider-Header'),null);
          const row=await observationFor(input.finalQuoteInput.requestId);assert.ok(row);
          const proof=await observe(row.grant_id);assert.equal(proof.status,'observed');assert.equal(proof.supplierCostStatus,'not_asserted');
          assert.equal(proof.observation.rawResponseSha256,sha(path==='/json'?jsonBody:ssePrefix+sseTail));
          assert.equal(proof.observation.rawResponseBytes,Buffer.byteLength(path==='/json'?jsonBody:ssePrefix+sseTail));
          assert.equal(proof.observation.cacheReadTokens,2);assert.equal(proof.observation.serviceTier,'default');assert.equal(proof.observation.audioInputTokens,0);
          assert.deepEqual(await durable(input.finalQuoteInput.requestId),sent);
          const [fact]=await migrator.unsafe(`SELECT * FROM ${g}.complete_text_result_facts_v366 WHERE fact_id=$1`,[row.fact_id]);
          assert.equal(fact.kind,'provider_usage');assert.equal(fact.send_start_id,row.send_start_id);assert.equal(fact.source_kind,'holder');assert.equal(fact.outbound_body_sha256,sha(wireRequests.at(-1).body));
          const replay=await appendPostgresCompleteTextResponseObservationV392(replayInput(row));assert.equal(replay.status,'already_recorded');assert.equal(replay.factId,row.fact_id);
          await assert.rejects(appendPostgresCompleteTextResponseObservationV392({...replayInput(row),observation:{...row.observation,rawResponseSha256:'a'.repeat(64)}}),/observation conflict/u);
          await assert.rejects(migrator.unsafe('UPDATE cinatoken_response_observation.observations_v392 SET request_id=request_id WHERE grant_id=$1',[row.grant_id]),/immutable/u);
          stage(`${path.slice(1)}-actual-worker-one-post-durable-usage-raw-hash-independent-read-same-nonce-replay`,{grantId:row.grant_id,observationId:row.observation_id,factId:row.fact_id});
        }
        const doneInput=await makeInput(true),doneRun=await invoke(doneInput,newWorker('/sse')),doneReader=doneRun.response.body.getReader();let delivered='';
        while(!delivered.includes('[DONE]')){const part=await doneReader.read();assert.equal(part.done,false);delivered+=new TextDecoder().decode(part.value);}
        assert.ok(await observationFor(doneInput.finalQuoteInput.requestId));await doneReader.cancel();doneReader.releaseLock();await drain(doneRun.tasks);stage('DONE-driven-client-cancel-sees-already-committed-observation');
        for(const path of ['/truncated','/duplicate','/cancel']){
          const input=await makeInput(true),run=await invoke(input,newWorker(path));assert.equal(run.error,null);
          if(path==='/cancel'){const reader=run.response.body.getReader();await reader.read();await reader.cancel();reader.releaseLock();}else await assert.rejects(run.response.text());
          await drain(run.tasks);assert.equal(await observationFor(input.finalQuoteInput.requestId),undefined);assert.deepEqual(await durable(input.finalQuoteInput.requestId),{...sent,facts:1});
          stage(`${path.slice(1)}-keeps-invocation-and-four-holds-without-complete-observation`);
        }
        const renewInput=await makeInput(true),renewRun=await invoke(renewInput,newWorker('/renewed',{maxRequestMs:10000,maxUnrenewedStreamMs:3000}));
        assert.equal(await renewRun.response.text(),ssePrefix+sseTail);await drain(renewRun.tasks);
        const renewed=await durable(renewInput.finalQuoteInput.requestId);assert.equal(renewed.renewals,1);assert.equal(renewed.facts,2);
        assert.equal((await observe((await observationFor(renewInput.finalQuoteInput.requestId)).grant_id)).status,'observed');
        stage('response-after-real-renewal-preserves-physical-start-epoch-one-and-fact-identity');
        await migrator.unsafe(`CREATE FUNCTION cinatoken_response_observation.inject_failed_commit_v392() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''v392 fixture failed COMMIT''; END;';
          CREATE CONSTRAINT TRIGGER injected_failed_commit_v392 AFTER INSERT ON cinatoken_response_observation.observations_v392 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cinatoken_response_observation.inject_failed_commit_v392();`).simple();
        try {
          const input=await makeInput(),run=await invoke(input,newWorker('/json'));
          assert.equal(run.error,null);const reader=run.response.body.getReader();await assert.rejects(reader.read());reader.releaseLock();await drain(run.tasks);
          assert.equal(await observationFor(input.finalQuoteInput.requestId),undefined);
          assert.deepEqual(await durable(input.finalQuoteInput.requestId),{...sent,facts:1});
          stage('failed-COMMIT-rolls-back-observation-and-usage-fact-together-before-any-JSON-bytes');
        } finally {
          await migrator.unsafe('DROP TRIGGER injected_failed_commit_v392 ON cinatoken_response_observation.observations_v392; DROP FUNCTION cinatoken_response_observation.inject_failed_commit_v392();').simple();
        }
        const proxy=await startJournalCommitAckDropProxyV381({upstreamPort:cluster.port});const sockets=new Set();let connections=0;
        const selector=createTcpServer(front=>{const back=createConnection({host:'127.0.0.1',port:++connections===4?proxy.port:cluster.port});
          for(const socket of [front,back]){sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});}
          front.pipe(back);back.pipe(front);front.on('close',()=>back.destroy());back.on('close',()=>front.destroy());});
        selector.listen(0,'127.0.0.1');await once(selector,'listening');
        try{
          const connection=new URL(urls.holder);connection.port=String(selector.address().port);
          const input=await makeInput(true),run=await invoke(input,newWorker('/sse'),{...holderEnv,COMPLETE_TEXT_HOLDER:{connectionString:connection.href}});
          assert.equal(run.error,null);const reader=run.response.body.getReader();let received='';
          await assert.rejects(async()=>{for(;;){const part=await reader.read();if(part.done)break;received+=new TextDecoder().decode(part.value);}});reader.releaseLock();
          assert.equal(received.includes('[DONE]'),false);await proxy.waitForDrop();await drain(run.tasks);
          assert.equal(connections,4);assert.equal(proxy.facts.droppedCommitAcks,1);const row=await observationFor(input.finalQuoteInput.requestId);assert.ok(row);
          assert.equal((await observe(row.grant_id)).status,'observed');const before=wireRequests.length;
          const replay=await appendPostgresCompleteTextResponseObservationV392(replayInput(row));assert.equal(replay.status,'already_recorded');assert.equal(wireRequests.length,before);
          assert.deepEqual(await durable(input.finalQuoteInput.requestId),sent);
          stage('actual-worker-lost-observation-COMMIT-ACK-withholds-DONE-independent-reader-same-nonce-recover-no-second-POST',{proxyFacts:{...proxy.facts}});
        }finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>selector.close(resolve));await proxy.close();}
        const [bill]=await migrator.unsafe(`SELECT count(*)::integer AS n FROM ${g}.complete_text_result_facts_v366 WHERE kind IN ('provider_bill','provider_zero_charge_observation')`);assert.equal(bill.n,0);
        const [logs]=await migrator.unsafe(`SELECT count(*)::integer AS n FROM ${g}.api_key_request_logs`);assert.equal(logs.n,0);
        stage('no-bill-zero-charge-buyer-log-release-or-terminal-inferred',{physicalPosts:wireRequests.length});
        // Exercise both orderings with the actual Worker observation transaction
        // and the direct resolver LOGIN, proving that both use the same request
        // lock even after the send deadline. A physical start makes no-fetch
        // legally unavailable in either ordering.
        for(const first of ['response','resolver']){
          const path=`/joint-${first}`,input=await makeInput(true),run=await invoke(input,newWorker(path,{maxUnrenewedStreamMs:10000,maxRequestMs:20000}));
          assert.equal(run.error,null);await waitFor(()=>pendingResponses.has(path));
          const [start]=await migrator.unsafe(`SELECT * FROM ${g}.complete_text_send_starts_v365 WHERE request_id=$1`,[input.finalQuoteInput.requestId]);assert.ok(start);
          await pastDeadline(start.grant_id);
          let release;const gate=new Promise(resolve=>{release=resolve;});let entered;const ready=new Promise(resolve=>{entered=resolve;});
          try{
          if(first==='response'){
            const blocking=migrator.begin(async tx=>{await tx.unsafe('SELECT pg_advisory_xact_lock(348,hashtext($1))',[input.finalQuoteInput.requestId]);entered();await gate;});await ready;
            const bytes=run.response.text();pendingResponses.get(path).end(sseTail);await waitFor(()=>waiting(roles.holder));
            const resolving=eagerSql(resolver.unsafe(`SELECT ${g}.resolve_complete_text_no_fetch_v370($1,$2) AS value`,[start.grant_id,randomUUID()]));
            await waitFor(()=>waiting(roles.resolver,'complete-text-worker-v390-joint-resolver'));release();await blocking;
            assert.equal(await bytes,ssePrefix+sseTail);assert.equal((await resolving)[0].value.status,'possible_send_unknown');
          }else{
            let resolveValue;
            const resolving=resolver.begin(async tx=>{const [row]=await tx.unsafe(`SELECT ${g}.resolve_complete_text_no_fetch_v370($1,$2) AS value`,[start.grant_id,randomUUID()]);resolveValue=row.value;entered();await gate;});await ready;
            assert.equal(resolveValue.status,'possible_send_unknown');const bytes=run.response.text();pendingResponses.get(path).end(sseTail);await waitFor(()=>waiting(roles.holder));
            release();await resolving;assert.equal(await bytes,ssePrefix+sseTail);
          }
          }finally{release();}
          await drain(run.tasks);assert.ok(await observationFor(input.finalQuoteInput.requestId));assert.deepEqual(await durable(input.finalQuoteInput.requestId),sent);
          stage(`actual-${first}-commits-first-other-login-waits-same-348-request-lock-sent-remains-unknown`);
        }
        for(const first of ['response','renewal']){
          const path=`/joint-${first}-renewal`,input=await makeInput(true),run=await invoke(input,newWorker(path,{maxUnrenewedStreamMs:10000,maxRequestMs:20000}));
          assert.equal(run.error,null);await waitFor(()=>pendingResponses.has(path));
          const [start]=await migrator.unsafe(`SELECT * FROM ${g}.complete_text_send_starts_v365 WHERE request_id=$1`,[input.finalQuoteInput.requestId]);assert.ok(start);
          const params=[start.grant_id,start.holder_run_id,start.send_start_id,1];
          let release;const gate=new Promise(resolve=>{release=resolve;});let entered;const ready=new Promise(resolve=>{entered=resolve;});
          try{
            if(first==='response'){
              const blocking=migrator.begin(async tx=>{await tx.unsafe('SELECT pg_advisory_xact_lock(348,hashtext($1))',[input.finalQuoteInput.requestId]);entered();await gate;});await ready;
              const bytes=run.response.text();pendingResponses.get(path).end(sseTail);await waitFor(()=>waiting(roles.holder));
              const renewing=eagerSql(renewer.unsafe(`SELECT ${g}.renew_complete_text_holds_v367($1,$2,$3,$4) AS value`,params));
              await waitFor(()=>waiting(roles.renewer,'complete-text-worker-v390-joint-renewer'));release();await blocking;
              assert.equal(await bytes,ssePrefix+sseTail);assert.equal((await renewing)[0].value.status,'renewal_recorded');
            }else{
              let renewed;
              const renewing=renewer.begin(async tx=>{const [row]=await tx.unsafe(`SELECT ${g}.renew_complete_text_holds_v367($1,$2,$3,$4) AS value`,params);renewed=row.value;entered();await gate;});await ready;
              assert.equal(renewed.status,'renewal_recorded');const bytes=run.response.text();pendingResponses.get(path).end(sseTail);await waitFor(()=>waiting(roles.holder));release();await renewing;
              assert.equal(await bytes,ssePrefix+sseTail);
            }
          }finally{release();}
          await drain(run.tasks);const row=await observationFor(input.finalQuoteInput.requestId);assert.ok(row);
          assert.equal((await observe(row.grant_id)).status,'observed');assert.deepEqual(await durable(input.finalQuoteInput.requestId),{...sent,renewals:1});
          stage(`actual-${first}-first-response-renewal-serialize-on-348-lock-preserve-observation-start-epoch-and-four-holds`);
        }
        const closedFirst=await grantWithoutStart();await pastDeadline(closedFirst.receipt.grantId);
        const [closeJob]=await migrator.unsafe('SELECT * FROM cinatoken_text_no_fetch_recovery.jobs_v389 WHERE grant_id=$1',[closedFirst.receipt.grantId]);
        const closedResolution=await confirmPostgresCompleteTextNoFetchV370({resolverConnectionString:urls.resolver,grantId:closedFirst.receipt.grantId,resolutionNonce:closeJob.resolution_nonce});
        let releaseClose;const closeGate=new Promise(resolve=>{releaseClose=resolve;});let closeEntered;const closeReady=new Promise(resolve=>{closeEntered=resolve;});
        let closeResult;
        const closing=closer.begin(async tx=>{const [row]=await tx.unsafe(`SELECT ${g}.close_complete_text_no_fetch_v388($1,$2,$3) AS value`,[closedFirst.receipt.grantId,closedResolution.resolutionId,closeJob.decision_nonce]);closeResult=row.value;closeEntered();await closeGate;});
        try{
          await closeReady;assert.equal(closeResult.status,'closed_no_fetch');
          const renewing=eagerSql(renewer.unsafe(`SELECT ${g}.renew_complete_text_holds_v367($1,$2,$3,1) AS value`,[closedFirst.receipt.grantId,randomUUID(),randomUUID()]));
          await waitFor(()=>waiting(roles.renewer,'complete-text-worker-v390-joint-renewer'));releaseClose();await closing;
          assert.equal((await renewing)[0].value.status,'holder_binding_differs');
        }finally{releaseClose();}
        stage('actual-platform-close-commits-before-blocked-renewer-no-start-has-no-renewal-authority');
        // Privileged local probes deliberately give a temporary wrapper raw
        // insertion authority. They prove the new insert triggers independently
        // of old wrapper checks; forged rows are removed before normal recovery.
        const probe=await grantWithoutStart();await pastDeadline(probe.receipt.grantId);
        const [sourceFact]=await migrator.unsafe(`SELECT f.fact_id FROM ${g}.complete_text_result_facts_v366 f WHERE f.kind='fetch_invoked' AND NOT EXISTS(SELECT 1 FROM cinatoken_response_observation.observations_v392 o WHERE o.fact_id=f.fact_id) LIMIT 1`);
        await migrator.unsafe(`CREATE FUNCTION ${g}.fixture_insert_response_v397(target uuid,source uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $probe$
          DECLARE new_id uuid:=gen_random_uuid(); BEGIN
          INSERT INTO cinatoken_response_observation.observations_v392(observation_id,grant_id,request_id,holder_run_id,send_start_id,evidence_nonce,fact_id,observation,observation_sha256)
          SELECT new_id,r.grant_id,r.request_id,f.holder_run_id,f.send_start_id,gen_random_uuid(),f.fact_id,o.observation,o.observation_sha256
          FROM ${g}.complete_text_attempt_grants_v362 r CROSS JOIN ${g}.complete_text_result_facts_v366 f CROSS JOIN LATERAL(SELECT observation,observation_sha256 FROM cinatoken_response_observation.observations_v392 LIMIT 1) o
          WHERE r.grant_id=target AND f.fact_id=source; RETURN new_id; END;$probe$;
          REVOKE ALL ON FUNCTION ${g}.fixture_insert_response_v397(uuid,uuid) FROM PUBLIC;
          GRANT EXECUTE ON FUNCTION ${g}.fixture_insert_response_v397(uuid,uuid) TO ${roles.holder};
          CREATE FUNCTION ${g}.fixture_insert_terminal_v397(target uuid,source uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $probe$
          BEGIN INSERT INTO ${g}.complete_text_platform_terminals_v388 SELECT(jsonb_populate_record(NULL::${g}.complete_text_platform_terminals_v388,
            to_jsonb(t)||jsonb_build_object('terminal_id',gen_random_uuid(),'grant_id',r.grant_id,'request_id',r.request_id,'writer_xid',pg_current_xact_id()))).*
            FROM ${g}.complete_text_attempt_grants_v362 r CROSS JOIN ${g}.complete_text_platform_terminals_v388 t WHERE r.grant_id=target AND t.terminal_id=source; END;$probe$;
          REVOKE ALL ON FUNCTION ${g}.fixture_insert_terminal_v397(uuid,uuid) FROM PUBLIC;
          GRANT EXECUTE ON FUNCTION ${g}.fixture_insert_terminal_v397(uuid,uuid) TO ${roles.closer};`).simple();
        let forgedId;
        try{
          let release;const gate=new Promise(resolve=>{release=resolve;});let entered;const ready=new Promise(resolve=>{entered=resolve;});
          const inserting=holder.begin(async tx=>{const [row]=await tx.unsafe(`SELECT ${g}.fixture_insert_response_v397($1,$2) AS id`,[probe.receipt.grantId,sourceFact.fact_id]);forgedId=row.id;entered();await gate;});
          try{
            await ready;const resolving=resolver.unsafe(`SELECT ${g}.resolve_complete_text_no_fetch_v370($1,$2) AS value`,[probe.receipt.grantId,randomUUID()]);
            // Attach the rejection handler before releasing the winner.
            const refused=assert.rejects(resolving,error=>error.code==='23514'&&error.constraint_name==='response_no_fetch_overlap_v397');
            await waitFor(()=>waiting(roles.resolver,'complete-text-worker-v390-joint-resolver'));release();await inserting;await refused;
          }finally{release();}
          await assert.rejects(closer.unsafe(`SELECT ${g}.fixture_insert_terminal_v397($1,$2)`,[probe.receipt.grantId,closeResult.terminalId]),error=>error.code==='23514'&&error.constraint_name==='response_no_fetch_overlap_v397');
          const [none]=await migrator.unsafe(`SELECT count(*)::integer AS n FROM ${g}.complete_text_no_fetch_resolutions_v370 WHERE grant_id=$1`,[probe.receipt.grantId]);assert.equal(none.n,0);
          stage('holder-observation-insert-COMMIT-first-fences-real-resolver-and-terminal-insert-without-any-release');
          await cluster.admin.begin(async tx=>{await tx.unsafe("SET LOCAL session_replication_role='replica'");await tx.unsafe('DELETE FROM cinatoken_response_observation.observations_v392 WHERE observation_id=$1',[forgedId]);});forgedId=null;
          const [job]=await migrator.unsafe('SELECT * FROM cinatoken_text_no_fetch_recovery.jobs_v389 WHERE grant_id=$1',[probe.receipt.grantId]);
          await confirmPostgresCompleteTextNoFetchV370({resolverConnectionString:urls.resolver,grantId:probe.receipt.grantId,resolutionNonce:job.resolution_nonce});
          await assert.rejects(holder.unsafe(`SELECT ${g}.fixture_insert_response_v397($1,$2)`,[probe.receipt.grantId,sourceFact.fact_id]),error=>error.code==='23514'&&error.constraint_name==='response_no_fetch_overlap_v397');
          await assert.rejects(holder.unsafe(`SELECT ${g}.fixture_insert_response_v397($1,$2)`,[closedFirst.receipt.grantId,sourceFact.fact_id]),error=>error.code==='23514'&&error.constraint_name==='response_no_fetch_overlap_v397');
          stage('real-no-fetch-resolution-and-terminal-COMMIT-first-fence-holder-insert-reverse-order');
        }finally{
          if(forgedId)await cluster.admin.begin(async tx=>{await tx.unsafe("SET LOCAL session_replication_role='replica'");await tx.unsafe('DELETE FROM cinatoken_response_observation.observations_v392 WHERE observation_id=$1',[forgedId]);});
          await migrator.unsafe(`DROP FUNCTION ${g}.fixture_insert_response_v397(uuid,uuid); DROP FUNCTION ${g}.fixture_insert_terminal_v397(uuid,uuid);`).simple();
        }
        const failedClose=await grantWithoutStart();await pastDeadline(failedClose.receipt.grantId);
        const [failedJob]=await migrator.unsafe('SELECT * FROM cinatoken_text_no_fetch_recovery.jobs_v389 WHERE grant_id=$1',[failedClose.receipt.grantId]);
        const failedResolution=await confirmPostgresCompleteTextNoFetchV370({resolverConnectionString:urls.resolver,grantId:failedClose.receipt.grantId,resolutionNonce:failedJob.resolution_nonce});
        const beforeFailed=await durable(failedClose.input.finalQuoteInput.requestId);
        await migrator.unsafe(`CREATE FUNCTION ${g}.fixture_failed_no_fetch_commit_v397() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''v397 fixture no-fetch failed COMMIT''; END;';
          CREATE CONSTRAINT TRIGGER fixture_failed_no_fetch_commit_v397 AFTER INSERT ON ${g}.complete_text_platform_terminals_v388 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${g}.fixture_failed_no_fetch_commit_v397();`).simple();
        try{
          await assert.rejects(closePostgresCompleteTextNoFetchV388({closerConnectionString:urls.closer,requestId:failedClose.input.finalQuoteInput.requestId,grantId:failedClose.receipt.grantId,resolutionId:failedResolution.resolutionId,decisionNonce:failedJob.decision_nonce}),error=>String(error.cause??error).includes('v397 fixture no-fetch failed COMMIT'));
          assert.deepEqual(await durable(failedClose.input.finalQuoteInput.requestId),beforeFailed);
          const [none]=await migrator.unsafe(`SELECT (SELECT count(*) FROM ${g}.complete_text_platform_terminals_v388 WHERE request_id=$1)+(SELECT count(*) FROM ${g}.complete_text_platform_outbox_v388 WHERE request_id=$1)+(SELECT count(*) FROM ${g}.api_key_request_logs WHERE id=$1) AS n`,[failedClose.input.finalQuoteInput.requestId]);assert.equal(Number(none.n),0);
          stage('joint-failed-no-fetch-COMMIT-atomically-rolls-back-terminal-event-log-and-all-financial-holds');
        }finally{await migrator.unsafe(`DROP TRIGGER fixture_failed_no_fetch_commit_v397 ON ${g}.complete_text_platform_terminals_v388; DROP FUNCTION ${g}.fixture_failed_no_fetch_commit_v397();`).simple();}
        const uncertain=await grantWithoutStart();await pastDeadline(uncertain.receipt.grantId);
        const [uncertainJob]=await migrator.unsafe('SELECT * FROM cinatoken_text_no_fetch_recovery.jobs_v389 WHERE grant_id=$1',[uncertain.receipt.grantId]);
        const nfProxy=await startJournalCommitAckDropProxyV381({upstreamPort:cluster.port});
        try{
          const address=new URL(urls.resolver);address.port=String(nfProxy.port);
          await assert.rejects(confirmPostgresCompleteTextNoFetchV370({resolverConnectionString:address.href,grantId:uncertain.receipt.grantId,resolutionNonce:uncertainJob.resolution_nonce}));await nfProxy.waitForDrop();
          const [persisted]=await migrator.unsafe(`SELECT count(*)::integer AS n FROM ${g}.complete_text_no_fetch_resolutions_v370 WHERE grant_id=$1`,[uncertain.receipt.grantId]);assert.equal(persisted.n,1);
          assert.deepEqual(await durable(uncertain.input.finalQuoteInput.requestId),{...sent,starts:0,facts:0});
          stage('joint-lost-resolver-COMMIT-ACK-leaves-one-durable-resolution-and-four-holds-for-fresh-runner',{proxyFacts:{...nfProxy.facts}});
        }finally{await nfProxy.close();}
        const neverSent=await grantWithoutStart();await pastDeadline(neverSent.receipt.grantId);
        // Mark every expired sent job due so the same real runner must quarantine
        // them while closing only the never-started grant.
        await cluster.admin.begin(async tx=>{await tx.unsafe("SET LOCAL session_replication_role='replica'");await tx.unsafe('UPDATE cinatoken_text_no_fetch_recovery.jobs_v389 SET available_at=clock_timestamp()-interval \'1 second\'');});
        const recovery=await runPostgresCompleteTextNoFetchRecoveryV389(recoveryConnections,{scanLimit:50,maxItems:50,admissionBudgetMs:25000,leaseSeconds:300});
        assert.equal(recovery.completed,5);assert.ok(recovery.quarantined>=2);
        const [terminal]=await migrator.unsafe(`SELECT * FROM ${g}.complete_text_platform_terminals_v388 WHERE request_id=$1`,[neverSent.input.finalQuoteInput.requestId]);assert.ok(terminal);
        const [closed]=await migrator.unsafe(`SELECT state FROM ${g}.user_budget_reservations WHERE request_id=$1`,[neverSent.input.finalQuoteInput.requestId]);assert.equal(closed.state,'settled');
        const [overlap]=await migrator.unsafe(`SELECT count(*)::integer AS n FROM cinatoken_response_observation.observations_v392 o JOIN ${g}.complete_text_platform_terminals_v388 t USING(request_id)`);assert.equal(overlap.n,0);
        const [sentClosed]=await migrator.unsafe(`SELECT count(*)::integer AS n FROM ${g}.complete_text_send_starts_v365 s JOIN ${g}.complete_text_platform_terminals_v388 t USING(request_id)`);assert.equal(sentClosed.n,0);
        stage('actual-no-fetch-runner-closes-only-never-started-grant-quarantines-sent-response-jobs-no-overlap',{...recovery});
        const [probeGone]=await migrator.unsafe(`SELECT to_regprocedure('${g}.fixture_insert_response_v397(uuid,uuid)') IS NULL AND to_regprocedure('${g}.fixture_insert_terminal_v397(uuid,uuid)') IS NULL AS clean`);assert.equal(probeGone.clean,true);
        const [billsAfter]=await migrator.unsafe(`SELECT count(*)::integer AS n FROM ${g}.complete_text_result_facts_v366 WHERE kind IN ('provider_bill','provider_zero_charge_observation')`);assert.equal(billsAfter.n,0);
        const [terminalsAfter]=await migrator.unsafe(`SELECT count(*)::integer AS n FROM ${g}.complete_text_platform_terminals_v388`);assert.equal(terminalsAfter.n,5);
        stage('temporary-probe-authority-removed-exactly-five-verified-no-fetch-terminals-and-no-supplier-bill',{physicalPosts:wireRequests.length});
        assert.equal(sha(await readFile(new URL(import.meta.url))),loadedFixtureSha256,'fixture changed during run');report.status='PASS';
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
      for(const path of runtimeSources) {
        const current=sha(await readFile(new URL(`../../../${path}`,import.meta.url)));
        report.sourceSha256[path]=runtimeSourcePins[path];
        if(current!==runtimeSourcePins[path]){failure??=new Error(`Source changed during run: ${path}`);report.status='FAIL';}
      }
      for(const [path,digest] of Object.entries(report.sourceSha256)) {
        if(path.endsWith('.sql') && !path.includes('/')) {
          const current=sha(await readFile(proposal(path)));
          if(current!==digest){failure??=new Error(`Proposal changed during run: ${path}`);report.status='FAIL';}
        }
      }
      const finalMigrationNames=await listPg73Migrations();
      const finalCorpus=await Promise.all(finalMigrationNames.map(async name=>`${name}\n${await readFile(new URL(name,migrationDir),'utf8')}`));
      if(finalMigrationNames.length!==73 || sha(finalCorpus.join('\n'))!==report.sourceSha256.formalMigrations){failure??=new Error('Formal PG73 source changed during run');report.status='FAIL';}
      await writeFile(reportUrl,JSON.stringify(report,null,2)+'\n');
      process.stdout.write(`complete-text-response-no-fetch-coinstall-v397-report=${reportUrl.pathname}\n`);
    }
    if(failure)throw failure;
    assert.equal(report.cleanup,'PASS');
  });
