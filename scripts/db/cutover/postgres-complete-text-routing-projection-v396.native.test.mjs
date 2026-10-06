// Owned PG18.6 proof of v396 projection, real send fences, and v398 sticky routing.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import postgres from 'postgres';
import { encryptSharedKeySecret } from '@octafuse/core';
import { computeRouteDataPolicySubjectFingerprintFromRows } from '../../../packages/core/src/route-data-policy.ts';
import { createFinalChatQuoteInput, originalChatBodySha256 } from '../../../packages/proxy/src/services/chat-final-quote-input.ts';
import { parseOpenAiModelFallbacks } from '../../../packages/proxy/src/services/model-fallbacks.ts';
import { createCompleteChatHolderDispatchV385 } from '../../../packages/proxy/src/services/complete-chat-holder-dispatch-v385.ts';
import { createCompleteTextHolderWorkerV390 } from '../../../packages/proxy/src/runtime/complete-text-holder-worker-v390.ts';
import { createObservedPrivateCompleteTextHolderV384 } from '../../../packages/proxy/src/services/private-complete-text-observed-holder-v384.ts';
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

import { attestCompleteTextRoutingV396 } from './attest-complete-text-routing-v396.ts';
import { readPostgresCompleteTextRoutingProjectionV396 } from '../../../packages/proxy/src/services/postgres-complete-text-routing-projection-v396.ts';
import { issuePostgresCompleteChatQuoteV360 } from '../../../packages/proxy/src/services/postgres-complete-chat-quote-v360.ts';
import { createPostgresStorageContext } from '../../../packages/core/src/storage/context.ts';
import { resolveRoutesForSurface } from '../../../packages/proxy/src/services/model-router.ts';
import { exerciseCompleteTextRoutingV396 } from './exercise-complete-text-routing-v396.mjs';
import { exerciseCompleteTextStickyBeforeSendV398,exerciseCompleteTextStickyAfterObservationV398 } from './exercise-complete-text-sticky-routing-v398.ts';
import { exerciseCompleteTextRoutePreparationV398 } from './exercise-complete-text-route-preparation-v398.ts';
import { buildModelFallbackPlan } from '../../../packages/proxy/src/services/model-fallback-plan.ts';

const g='cinatoken_gateway';
const migrationDir=new URL('../../../packages/core/migrations-postgres/',import.meta.url);
const proposal=name=>new URL(`../../../packages/core/migrations-proposals/postgres/${name}`,import.meta.url);
const reportUrl=new URL('../../../docs/developers/architecture/implementation-evidence/C04-complete-text-routing-projection-v396-report.json',import.meta.url);
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
  recovery:'cinatoken_gateway_budget_recovery',observer:'cinatoken_gateway_complete_text_response_observer',projector:'cinatoken_gateway_complete_text_routing_projector',sticky:'cinatoken_gateway_complete_text_sticky_router'};

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
 'scripts/db/cutover/attest-complete-text-routing-v396.ts',
 'scripts/db/cutover/exercise-complete-text-routing-v396.mjs',
 'scripts/db/cutover/exercise-complete-text-sticky-routing-v398.ts',
 'scripts/db/cutover/exercise-complete-text-route-preparation-v398.ts',
 'packages/proxy/src/services/postgres-complete-text-sticky-routing-v398.ts',
 'packages/proxy/src/services/postgres-complete-text-sticky-routing-v398.test.mjs',
 'packages/proxy/src/services/postgres-complete-text-routing-projection-v396.test.ts',
 'packages/proxy/src/services/credential-free-route-attempts-v398.ts',
 'packages/proxy/src/services/credential-free-route-attempts-v398.test.ts',
 'packages/proxy/src/services/route-attempt-planner.ts',
 ...['index','types','hash-affinity','weighted-random','weight-priority','weighted-round-robin','route-affinity-hash'].map(name=>`packages/proxy/src/services/route-strategies/${name}.ts`),
 'packages/proxy/src/services/provider-default-load-balancing.ts',
 'packages/proxy/src/services/provider-sticky-routing.ts',
 'packages/proxy/src/services/provider-circuit-breaker.ts',
 'packages/proxy/src/services/openrouter-session-routing.ts',
 'packages/proxy/src/services/route-strategies/route-strategies.test.ts',
 'packages/proxy/src/services/provider-sticky-routing.test.ts',
 'packages/proxy/src/services/provider-routing-preferences.test.ts',
 'scripts/db/cutover/postgres-complete-text-routing-projection-v396.tsconfig.json',
 'packages/proxy/src/services/postgres-complete-text-routing-projection-v396.ts',
 'packages/proxy/src/services/provider-routing-preferences.ts',
 'packages/proxy/src/services/model-router.ts',
 'packages/proxy/src/services/model-fallback-plan.ts',
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

async function coreCorpus(){
 const paths=[];async function walk(relative){for(const entry of await readdir(new URL('../../../'+relative+'/',import.meta.url),{withFileTypes:true})){
  const next=relative+'/'+entry.name;if(entry.isDirectory())await walk(next);else if(entry.isFile()&&/\.tsx?$/u.test(entry.name))paths.push(next);}}
 await walk('packages/core/src');paths.sort();const bodies=await Promise.all(paths.map(async path=>`${path}\n${await readFile(new URL('../../../'+path,import.meta.url),'utf8')}`));
 return {files:paths.length,sha256:sha(bodies.join('\n'))};
}

test('v396 coherent credential-free routing and send fences through actual PostgreSQL roles',
  {timeout:300_000,skip:!process.env.GATEWAY_NATIVE_PG_BIN},async()=>{
    assert.equal(process.env.TSX_TSCONFIG_PATH?.replaceAll('\\','/'),
      'scripts/db/cutover/postgres-complete-text-routing-projection-v396.tsconfig.json',
      'native oracle must resolve @octafuse/core to the actual source corpus');
    const loadedFixtureSha256=sha(await readFile(new URL(import.meta.url)));
    const initialCore=await coreCorpus();
    const runtimeSourcePins=Object.fromEntries(await Promise.all(runtimeSources.map(async path=>[path,sha(await readFile(new URL(`../../../${path}`,import.meta.url)))])));
    const cluster=await startNativePostgres();
    const report={status:'RUNNING',cleanup:'PENDING',binaryVersion:cluster.binaryVersion,coreCorpus:initialCore,
      unitReportReference:'C04-credential-free-route-attempts-sticky-v398-unit-report.json',
      sourceSha256:{},stages:[],limitations:[
        'Installation branch is v370 renewed holder facts followed by v392 before extra v388/v389 triggers. Combined no-fetch closer/recovery coexistence is not established.',
        'Owned PG18.6 + loopback HTTP only; no paid Provider, remote SQL, deployment, Hyperdrive or actual Cloudflare Binding was used.',
        'Actual v394 Worker and v385 dispatch run in Node with real default role clients. Prepared HTTPS fixture URL is rewritten only by the injected physical fetch to owned HTTP loopback.',
        'Raw digest covers fetch-readable bytes after HTTP decoding, not TLS/compressed wire. Observation trusts the isolated holder, not a Provider signature.',
        'Usage observations do not establish supplier cost, zero bill, buyer settlement, terminal or release. Grants stay unknown and all four holds stay dispatched.',
        'SSE DONE and the complete bounded JSON body are released only after observation COMMIT and connection close acknowledge.',
        'No durable response spool exists before observation COMMIT. Stable same-start nonce and independent reader recover committed observations without a second POST.',
        'COMMIT proxy observes backend CommandComplete(COMMIT), suppresses it and closes the client; it does not prove remote pooler or close-ACK behavior.',
        'The successful v385 response fixture retains its request-local plan construction; actual multi-model repository/planner equivalence is exercised separately. The public Chat handler is not wired to this successor.',
        'The policy/source fence is retained through send-start COMMIT. Configuration may change before the physical POST after that COMMIT.',
        'Trusted eligibility publication expires within 60 seconds and uses current database global strategy rather than the legacy process cache.',
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
      await migrator.begin(async tx=>{await tx.unsafe("SET LOCAL cinatoken.complete_text_response_observation_v392_activation='reviewed-v1'");await tx.unsafe(observationSql).simple();});
      const observer=connection(cluster,roles.observer,passwords.observer,'observer');clients.push(observer);
      await denied(observer.unsafe('SELECT * FROM cinatoken_response_observation.observations_v392'));
      await denied(holder.unsafe('SELECT * FROM cinatoken_response_observation.observations_v392'));
      stage('v392-default-off-atomic-install-and-independent-reader-without-raw-access');

      const routingSql=await readFile(proposal('complete-text-routing-projection-v396.sql'),'utf8');
      report.sourceSha256['complete-text-routing-projection-v396.sql']=sha(routingSql);
      await assert.rejects(migrator.begin(tx=>tx.unsafe(routingSql).simple()),/activation or dependency differs/);
      for(const [name,mutation] of [
        ['projector-provider-column',`GRANT SELECT(api_key) ON ${g}.providers TO ${roles.projector}`],
        ['default-grant-option',`ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO ${roles.runtime} WITH GRANT OPTION`],
        ['disabled-custody-immutable',`ALTER TABLE ${g}.complete_text_send_custody_v365 DISABLE TRIGGER complete_text_send_custody_v365_no_mutation`],
        ['same-name-start-body',`CREATE OR REPLACE FUNCTION ${g}.reject_complete_text_send_start_mutation_v365() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,pg_temp AS 'BEGIN RETURN NEW; END;'`],
        ...['models','model_surfaces','system_config','model_routes','providers','route_pools','model_endpoints','model_endpoint_routes','route_source_generations_v359'].map(table=>[
         `source-${table}-forced-RLS`,`ALTER TABLE ${g}.${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${g}.${table} FORCE ROW LEVEL SECURITY`]),
        ['source-rewrite-rule',`CREATE RULE v396_unreviewed AS ON UPDATE TO ${g}.models DO ALSO NOTIFY v396_unreviewed`],
        ['source-extra-trigger',`CREATE TRIGGER v396_unreviewed BEFORE INSERT ON ${g}.models FOR EACH ROW EXECUTE FUNCTION ${g}.reject_route_source_truncate_v359()`],
      ]) {
        await assert.rejects(migrator.begin(async tx=>{await tx.unsafe(mutation).simple();await tx.unsafe("SET LOCAL cinatoken.complete_text_routing_projection_activation='reviewed-v1'");await tx.unsafe(routingSql).simple();}));
        const [absent]=await migrator.unsafe("SELECT to_regclass('cinatoken_gateway.routing_policy_epoch_v396') AS value");assert.equal(absent.value,null);
        stage(`v396-rejects-${name}-atomically`);
      }
      await migrator.begin(async tx=>{await tx.unsafe("SET LOCAL cinatoken.complete_text_routing_projection_activation='reviewed-v1'");await tx.unsafe(routingSql).simple();});
      const projector=connection(cluster,roles.projector,passwords.projector,'projector');clients.push(projector);
      await denied(projector.unsafe(`SELECT api_key,endpoints FROM ${g}.providers`));
      await denied(projector.unsafe(`SELECT * FROM ${g}.complete_text_routing_facts_v396`));
      await denied(projector.unsafe(`SELECT ${g}.require_current_routing_projection_v396(gen_random_uuid(),1,0,true)`));
      stage('v396-trusted-verifier-and-secretless-projector-installed-with-three-send-fences');
      const catalog={};
      catalog.functions=await migrator.unsafe(`SELECT p.oid::regprocedure::text AS signature,n.nspname AS schema,p.proname AS name,md5(replace(p.prosrc,E'\\r\\n',E'\\n')) AS body_md5,
       r.rolname AS owner,p.proconfig,p.prosecdef,p.provolatile,p.prorettype::regtype::text AS result_type,
       (SELECT lanname FROM pg_language WHERE oid=p.prolang) AS language,p.prokind,p.proretset,p.proparallel,p.proisstrict,p.proleakproof,
       (SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE (SELECT rolname FROM pg_roles WHERE oid=a.grantee) END,
        'grantor',(SELECT rolname FROM pg_roles WHERE oid=a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a) AS acl
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname LIKE 'cinatoken_%' ORDER BY signature`);
      const catalogTables=(await migrator.unsafe(`SELECT c.oid::regclass::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'cinatoken_%' AND c.relkind IN('r','p') ORDER BY name`)).map(row=>row.name);
      catalog.tables=[];catalog.triggers=[];
      for(const table of catalogTables){
       catalog.tables.push(...await migrator.unsafe(`SELECT c.oid::regclass::text AS name,(SELECT nspname FROM pg_namespace WHERE oid=c.relnamespace) AS schema,r.rolname AS owner,c.relkind,c.relrowsecurity,c.relforcerowsecurity,
        (SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE (SELECT rolname FROM pg_roles WHERE oid=a.grantee) END,
         'grantor',(SELECT rolname FROM pg_roles WHERE oid=a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee,a.privilege_type) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a) AS acl,
        (SELECT jsonb_agg(jsonb_build_object('column',attname,'acl',attacl::text) ORDER BY attnum) FROM pg_attribute WHERE attrelid=c.oid AND attacl IS NOT NULL) AS column_acl
        FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid=$1::regclass`,[table]));
       catalog.triggers.push(...await migrator.unsafe(`SELECT tgrelid::regclass::text AS table_name,tgname,tgfoid::regprocedure::text AS function_name,tgenabled,tgtype,
        tgqual::text,tgattr::text,tgnargs,tgdeferrable,tginitdeferred,tgoldtable,tgnewtable,encode(tgargs,'hex') AS args_hex,
        tgconstraint::text,tgconstrrelid::text,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal ORDER BY tgname`,[table]));
      }
      await writeFile(new URL('../../../.wrangler/staging/v396-catalog-pre398.json',import.meta.url),JSON.stringify(catalog,null,2)+'\n');
      {
       const stickySql=await readFile(proposal('complete-text-sticky-routing-v398.sql'),'utf8');report.sourceSha256['complete-text-sticky-routing-v398.sql']=sha(stickySql);
       await assert.rejects(migrator.begin(async tx=>tx.unsafe(stickySql).simple()),error=>error?.code==='P0001');
       stage('v398-default-off-atomic-install');
       for(const [name,mutation] of [
        ['proof-function-extraEXEC',`GRANT EXECUTE ON FUNCTION ${g}.require_current_routing_projection_v396(uuid,bigint,integer,boolean) TO ${roles.runtime}`],
        ['proof-table-columnACL',`GRANT SELECT(projection) ON ${g}.complete_text_routing_projections_v396 TO ${roles.runtime}`],
        ['extra-trigger',`CREATE TRIGGER v398_unreviewed BEFORE INSERT ON ${g}.complete_text_routing_projections_v396 FOR EACH ROW EXECUTE FUNCTION ${g}.reject_routing_projection_mutation_v396()`],
        ['proof-rewrite-rule',`CREATE RULE v398_unreviewed AS ON UPDATE TO ${g}.complete_text_routing_projections_v396 DO ALSO NOTIFY v398_unreviewed`],
       ]){
        await assert.rejects(migrator.begin(async tx=>{await tx.unsafe(mutation).simple();await tx.unsafe("SET LOCAL cinatoken.complete_text_sticky_routing_v398_activation='reviewed-v1'");await tx.unsafe(stickySql).simple();}),error=>error?.code==='P0001');
        const [absent]=await migrator.unsafe("SELECT count(*)::integer AS n FROM pg_proc WHERE pronamespace='cinatoken_gateway'::regnamespace AND proname='complete_text_sticky_action_v398'");assert.equal(absent.n,0);
        stage(`v398-rejects-${name}-atomically`);
       }
       await migrator.begin(async tx=>{await tx.unsafe("SET LOCAL cinatoken.complete_text_sticky_routing_v398_activation='reviewed-v1'");await tx.unsafe(stickySql).simple();});
       stage('v398-quote-bound-sticky-wrapper-installed');
      }


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
      await migrator.unsafe(`UPDATE ${g}.model_endpoints SET endpoint_class='standard',max_completion_tokens=1000 WHERE id='v361-endpoint'`);
      await attest();
      stage('authoritative-route-and-three-budget-source-fixture-ready');

      const urls=Object.fromEntries(Object.entries(roles).map(([name,role])=>[
        name,`postgres://${role}:${passwords[name]}@127.0.0.1:${cluster.port}/postgres?sslmode=disable`]));
      const wireRequests=[];
      const closedPaths=[];
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
      const makeInput=async(stream=false,includeEmptyCandidate=false)=>{
        // Owned flat-text input at the production helper's post-transformation boundary.
        // This fixture does not execute production preset or Guardrail middleware.
        const raw='{"model":"v361-model","messages":[{"role":"user","content":"hello"}],"max_completion_tokens":300}';
        const currentBody=JSON.parse(raw);
        currentBody.messages.unshift({role:'system',content:'Use concise answers.'});
        currentBody.max_completion_tokens=250;
        if(includeEmptyCandidate)currentBody.models=['v361-model','v396-empty-model'];
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
        if(includeEmptyCandidate)plan.candidates.push({requestedModelId:'v396-empty-model',baseModelId:'v396-empty-model',
         upstreamBody:parsed.upstreamBody,routes:[{...selectedRoute,targetId:'v396-empty-route',providerModelName:'empty-pool-route',
          gatewayCandidateIndex:1,gatewayModelId:'v396-empty-model',endpoint:{id:'v396-empty-endpoint'}}]});
        const bytes=new TextEncoder().encode(raw);
        const finalQuoteInput=await createFinalChatQuoteInput({
          requestId:`v390-${randomUUID()}`,
          originalBodySha256:await originalChatBodySha256(bytes.buffer),
          finalBody:currentBody,parsed,plan});
        assert.notEqual(finalQuoteInput.originalBodySha256,finalQuoteInput.finalBodySha256);
        assert.deepEqual(JSON.parse(finalQuoteInput.finalBodyUtf8),{
          ...currentBody,models:includeEmptyCandidate?['v361-model','v396-empty-model']:['v361-model']});
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
      const retained=[];const projected=[];let stickyBeforeDone=false;
      const newWorker=(path='/json',options={})=>createCompleteTextResponseHolderWorkerV394({
        ...options,fetchUpstream:(url,init)=>{
          assert.equal(String(url),'https://v367-local.invalid/v1/chat/completions');
          assert.equal(init.redirect,'error');
          return fetch(`http://127.0.0.1:${address.port}${path}`,init);
        }});
      const invoke=async(input,worker,env=holderEnv)=>{
        const tasks=[];
        const ctx={waitUntil(task){tasks.push(task);}};
        let privateResponse;
        const dispatch=createCompleteChatHolderDispatchV385({...input,
          holderBinding:{async fetch(request){
            const copy=request.clone();
            retained.push(await copy.json());
            privateResponse=await worker.fetch(request,env,ctx);return privateResponse;
          }}},{issueQuote:async params=>{const quote=await issuePostgresCompleteChatQuoteV360(params);await attestCompleteTextRoutingV396({verifierConnectionString:urls.verifier,modelIds:quote.modelIds});const projection=await readPostgresCompleteTextRoutingProjectionV396({projectorConnectionString:urls.projector,quote,finalQuoteInput:params.finalQuoteInput});projected.push(projection);if(!stickyBeforeDone){await exerciseCompleteTextStickyBeforeSendV398({stickyConnectionString:urls.sticky,projection,candidateIndex:0,selectedTargetId:'v361-route',auditor:migrator,stage});stickyBeforeDone=true;}return quote;}});
        let response=null,error=null;
        try{response=await dispatch.run();}catch(cause){error=cause;}
        return {response,error,tasks,privateResponse};
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
          if(path==='/json'){
           await exerciseCompleteTextRoutePreparationV398({projection:projected.at(-1),finalQuoteInput:input.finalQuoteInput,runtimeConnectionString:urls.runtime,stickyConnectionString:urls.sticky,auditor:migrator,stage,label:'actual-json-observation',observedTargetId:'v361-route'});
           await exerciseCompleteTextStickyAfterObservationV398({stickyConnectionString:urls.sticky,projection:projected.at(-1),candidateIndex:0,selectedTargetId:'v361-route',auditor:migrator,stage,getFreshProjection:async()=>{const fresh=await makeInput(false),quote=await issuePostgresCompleteChatQuoteV360(fresh);await attestCompleteTextRoutingV396({verifierConnectionString:urls.verifier,modelIds:quote.modelIds});return readPostgresCompleteTextRoutingProjectionV396({projectorConnectionString:urls.projector,quote,finalQuoteInput:fresh.finalQuoteInput});}});
          }
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
        for(const phase of ['grant','custody','start']){
          const count=wireRequests.length;let mutated=false;const input=await makeInput();
          const mutate=async()=>{mutated=true;await migrator.unsafe(`UPDATE ${g}.models SET route_policy=route_policy WHERE id='v361-model'`);};
          const worker=createCompleteTextHolderWorkerV390({fetchUpstream:()=>{throw new Error('Policy drift must prevent POST');}},
           {createHolder(ports){return createObservedPrivateCompleteTextHolderV384({...ports,
            async grantAttempt(...args){if(phase==='grant')await mutate();return ports.grantAttempt(...args);},
            async claimSendCustody(...args){if(phase==='custody')await mutate();return ports.claimSendCustody(...args);},
            async recordSendStart(...args){if(phase==='start')await mutate();return ports.recordSendStart(...args);}});}});
          const run=await invoke(input,worker);assert.equal(mutated,true);assert.equal(run.error?.name,'CompleteChatHolderDispatchRejectedV385');assert.ok(run.privateResponse.status>=400);await drain(run.tasks);
          assert.equal(wireRequests.length,count);
          const [rows]=await migrator.unsafe(`SELECT (SELECT count(*)::integer FROM ${g}.complete_text_attempt_grants_v362 WHERE request_id=$1) AS grants,
           (SELECT count(*)::integer FROM ${g}.complete_text_send_custody_v365 WHERE request_id=$1) AS custody,
           (SELECT count(*)::integer FROM ${g}.complete_text_send_starts_v365 WHERE request_id=$1) AS starts`,[input.finalQuoteInput.requestId]);
          assert.deepEqual(rows,phase==='grant'?{grants:0,custody:0,starts:0}:phase==='custody'?{grants:1,custody:0,starts:0}:{grants:1,custody:1,starts:0});
          stage(`v396-real-${phase}-call-rejects-policy-epoch-drift-before-physical-send`,{addedPosts:0,rows});
        }
        {
          // Native-only gate stops the actual v365 INSERT after its relation SHARE locks,
          // making the reported two-transaction lock cycle deterministic.
          const controller=connection(cluster,roles.migrator,passwords.migrator,'v396-cycle-controller');
          const writer=connection(cluster,roles.migrator,passwords.migrator,'v396-cycle-writer');clients.push(controller,writer);
          await migrator.unsafe(`CREATE FUNCTION ${g}.native_pause_send_fence_v396() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,pg_temp AS
           'BEGIN PERFORM pg_catalog.pg_advisory_xact_lock(746923597); RETURN NEW; END';
           REVOKE ALL ON FUNCTION ${g}.native_pause_send_fence_v396() FROM PUBLIC,${roles.runtime};
           CREATE TRIGGER aaa_native_pause_send_fence_v396 BEFORE INSERT ON ${g}.complete_text_send_starts_v365 FOR EACH ROW EXECUTE FUNCTION ${g}.native_pause_send_fence_v396();`).simple();
          let runPromise,writerPromise,writerError,actualCode;
          const input=await makeInput(),count=wireRequests.length;
          const worker=createCompleteTextHolderWorkerV390({fetchUpstream:()=>{throw new Error('Busy routing writer must prevent POST');}},
           {createHolder(ports){return createObservedPrivateCompleteTextHolderV384({...ports,async recordSendStart(...args){
            try{return await ports.recordSendStart(...args);}catch(error){actualCode=(error?.cause??error)?.code;throw error;}}});}});
          const awaitLock=async(predicate)=>{
           const deadline=Date.now()+1500;
           for(;;){const [row]=await migrator.unsafe(`SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE ${predicate}) AS ready`);
            if(row.ready)return;assert.ok(Date.now()<deadline,'native lock barrier timed out');await new Promise(resolve=>setTimeout(resolve,10));}
          };
          try{
           await controller.begin(async tx=>{
            await tx.unsafe('SELECT pg_advisory_xact_lock(746923597)');runPromise=invoke(input,worker);
            await awaitLock(`a.usename='${roles.holder}' AND l.locktype='advisory' AND l.objid=746923597 AND NOT l.granted`);
            const [share]=await migrator.unsafe(`SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
             WHERE a.usename=$1 AND l.relation=$2::regclass AND l.mode='ShareLock' AND l.granted) AS held`,[roles.holder,`${g}.model_routes`]);assert.equal(share.held,true);
            writerPromise=writer.begin(async other=>{
             await other.unsafe("SET LOCAL lock_timeout='5s'");
             await other.unsafe(`UPDATE ${g}.models SET route_policy=route_policy WHERE id='v361-model'`);
             await other.unsafe(`UPDATE ${g}.model_routes SET priority=priority WHERE id='v361-route'`);
            }).catch(error=>{writerError=error;});
            await awaitLock(`a.application_name='complete-text-worker-v390-v396-cycle-writer' AND l.relation='${g}.model_routes'::regclass AND l.mode='RowExclusiveLock' AND NOT l.granted`);
           });
           const run=await runPromise;await writerPromise;
           assert.equal(actualCode,'55P03');assert.equal(writerError,undefined);assert.equal(run.error?.name,'CompleteChatHolderDispatchRejectedV385');
           assert.ok(run.privateResponse.status>=400);await drain(run.tasks);assert.equal(wireRequests.length,count);
           const [rows]=await migrator.unsafe(`SELECT count(*)::integer AS n FROM ${g}.complete_text_send_starts_v365 WHERE request_id=$1`,[input.finalQuoteInput.requestId]);assert.equal(rows.n,0);
           stage('v396-two-transaction-source-SHARE-exclusive-policy-cycle-fails-fast-55P03-writer-COMMIT-zero-POST',{addedPosts:0,sendStarts:0,sqlstate:actualCode});
          }finally{
           await Promise.allSettled([runPromise,writerPromise].filter(Boolean));
           await migrator.unsafe(`DROP TRIGGER aaa_native_pause_send_fence_v396 ON ${g}.complete_text_send_starts_v365; DROP FUNCTION ${g}.native_pause_send_fence_v396();`).simple();
          }
        }
        for(const kind of ['default-endpoint','capacity']){
          await migrator.unsafe(`UPDATE ${g}.model_endpoints SET endpoint_class=$1,max_completion_tokens=$2 WHERE id='v361-endpoint'`,[kind==='default-endpoint'?null:'standard',kind==='capacity'?200:1000]);await attest();
          const count=wireRequests.length,input=await makeInput(),run=await invoke(input,newWorker('/json'));
          assert.equal(run.error?.name,'CompleteChatHolderDispatchRejectedV385');assert.ok(run.privateResponse.status>=400);await drain(run.tasks);assert.equal(wireRequests.length,count);
          const [rows]=await migrator.unsafe(`SELECT count(*)::integer AS n FROM ${g}.complete_text_attempt_grants_v362 WHERE request_id=$1`,[input.finalQuoteInput.requestId]);assert.equal(rows.n,0);
          stage(`v396-grant-SQL-independently-rejects-${kind}-without-POST`);
        }
        await migrator.unsafe(`UPDATE ${g}.model_endpoints SET endpoint_class='standard',max_completion_tokens=1000 WHERE id='v361-endpoint'`);await attest();
        {
         await migrator.unsafe(`INSERT INTO ${g}.models(id,vendor) VALUES('v396-empty-model','other');
          INSERT INTO ${g}.route_pools(id,model_id,name,status) VALUES('v396-empty-legacy','v396-empty-model','Manifest superset','active'),('v396-empty-surface','v396-empty-model','Empty actual surface','active');
          INSERT INTO ${g}.model_surfaces(id,model_id,request_protocol,request_operation,route_pool_id,status) VALUES('v396-empty-selected','v396-empty-model','openai','chat','v396-empty-surface','active');
          INSERT INTO ${g}.model_routes(id,model_id,provider_id,provider_model_name,route_pool_id,upstream_protocol,upstream_operation,adapter,status,priority,weight) VALUES
           ('v396-empty-route','v396-empty-model','v361-provider','empty-pool-route','v396-empty-legacy','openai','chat','passthrough','active',1,1);
          INSERT INTO ${g}.model_endpoints(id,model_id,provider_id,provider_slug,tag,endpoint_class,context_length,max_completion_tokens,pricing,
           supports_implicit_caching,supports_voice_cloning,supports_tool_choice,evidence_url,verified_by,verified_at,expires_at,status)
          VALUES('v396-empty-endpoint','v396-empty-model','v361-provider','v361-provider','empty','standard',1000,1000,
           '{"currency":"USD","prompt":"0.000002","completion":"0.000004"}',false,false,
           '{"auto":false,"function":false,"none":false,"required":false}','https://evidence.invalid/v396','fixture',now()-interval '1 minute',now()+interval '5 minutes','verified');
          INSERT INTO ${g}.model_endpoint_routes(endpoint_id,route_target_id) VALUES('v396-empty-endpoint','v396-empty-route');`).simple();
         const [route]=await migrator.unsafe(`SELECT * FROM ${g}.model_routes WHERE id='v396-empty-route'`);
         const [provider]=await migrator.unsafe(`SELECT * FROM ${g}.providers WHERE id='v361-provider'`);
         const fingerprint=await computeRouteDataPolicySubjectFingerprintFromRows(route,provider);
         await migrator.unsafe(`UPDATE ${g}.model_endpoint_routes SET subject_fingerprint=$1 WHERE route_target_id='v396-empty-route'`,[fingerprint]);
         const [fence]=await verifier.unsafe(`SELECT generation::text AS generation FROM ${g}.route_source_generations_v359 WHERE route_target_id='v396-empty-route'`);
         const [verified]=await verifier.unsafe(`SELECT ${g}.attest_text_route_source_v359('v396-empty-route',$1,$2) AS value`,[fence.generation,fingerprint]);assert.equal(verified.value.status,'attested');
         const count=wireRequests.length,input=await makeInput(false,true),run=await invoke(input,newWorker('/json'));
         assert.equal(run.error?.name,'CompleteChatHolderDispatchRejectedV385');assert.ok(run.privateResponse.status>=400);await drain(run.tasks);assert.equal(wireRequests.length,count);
         const projection=projected.at(-1);assert.equal(projection.candidates[0].routes.some(r=>r.defaultEndpointEligible),true);assert.equal(projection.candidates[1].routes.length,0);
         const [rows]=await migrator.unsafe(`SELECT count(*)::integer AS n FROM ${g}.complete_text_attempt_grants_v362 WHERE request_id=$1`,[input.finalQuoteInput.requestId]);assert.equal(rows.n,0);
         stage('v396-real-grant-gate-requires-eligible-witness-for-every-ordered-candidate',{addedPosts:0,selectedCandidateEligible:true,otherCandidateRoutes:0});
        }
        await exerciseCompleteTextRoutingV396({migrator,verifier,cap,complete,urls,cluster,bearer,stage,clients});
        const [bill]=await migrator.unsafe(`SELECT count(*)::integer AS n FROM ${g}.complete_text_result_facts_v366 WHERE kind IN ('provider_bill','provider_zero_charge_observation')`);assert.equal(bill.n,0);
        const [logs]=await migrator.unsafe(`SELECT count(*)::integer AS n FROM ${g}.api_key_request_logs`);assert.equal(logs.n,0);
        stage('no-bill-zero-charge-buyer-log-release-or-terminal-inferred',{physicalPosts:wireRequests.length});
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
      const finalCore=await coreCorpus();if(JSON.stringify(finalCore)!==JSON.stringify(initialCore)){failure??=new Error('Core source changed during v396 native execution');report.status='FAIL';}
      await writeFile(reportUrl,JSON.stringify(report,null,2)+'\n');
      process.stdout.write(`complete-text-routing-projection-v396-report=${reportUrl.pathname}\n`);
    }
    if(failure)throw failure;
    assert.equal(report.cleanup,'PASS');
  });
