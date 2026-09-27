// Owned PostgreSQL 18.6 proof of review-only v367 all-hold renewal.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { computeRouteDataPolicySubjectFingerprintFromRows } from '../../../packages/core/src/route-data-policy.ts';
import { grantPostgresCompleteTextAttemptV362 } from '../../../packages/proxy/src/services/postgres-complete-text-attempt-grant-v362.ts';
import { claimPostgresCompleteTextCustodyV365,
  recordPostgresCompleteTextSendStartV365,
  PostgresCompleteTextSendStartRejectedError,
} from '../../../packages/proxy/src/services/postgres-complete-text-send-start-v365.ts';
import { renewPostgresCompleteTextHoldsV367 } from
  '../../../packages/proxy/src/services/postgres-complete-text-hold-renewal-v369.ts';
import { appendPostgresCompleteTextHolderFactV367,
  appendPostgresCompleteTextProviderBillFactV367,
} from '../../../packages/proxy/src/services/postgres-complete-text-result-facts-v367.ts';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';
import { activatePostgresBuyerSplitV348 } from './activate-postgres-buyer-split-v348.ts';
import { grantPostgresBuyerSplitV348 } from './grant-postgres-buyer-split-v348.ts';
import { activatePostgresBuyerGuardrailSplitV349 } from './activate-postgres-buyer-guardrail-split-v349.ts';
import { grantPostgresBuyerGuardrailSplitV349 } from './grant-postgres-buyer-guardrail-split-v349.ts';

const g='cinatoken_gateway';
const migrationDir=new URL('../../../packages/core/migrations-postgres/',import.meta.url);
const proposal=name=>new URL(`../../../packages/core/migrations-proposals/postgres/${name}`,import.meta.url);
const reportUrl=new URL('../../../docs/developers/architecture/implementation-evidence/C04-complete-text-all-hold-renewal-v367-report.json',import.meta.url);
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

test('v367 renews exactly all dispatched text holds under isolated custody',
  {timeout:300_000,skip:!process.env.GATEWAY_NATIVE_PG_BIN},async()=>{
    const cluster=await startNativePostgres();
    const report={status:'RUNNING',cleanup:'PENDING',binaryVersion:cluster.binaryVersion,
      sourceSha256:{},stages:[],limitations:[
        'Review-only PG73 proposal; no formal migration, deployed Worker, remote database or production credential changed.',
        'NON-ACTIVATABLE: buyer settlement retains direct UPDATE of user budget counters and Guardrail windows; its legacy reservation-before-account lock order also conflicts with renewal. A request-scoped writer/grant-policy cutover and atomic result closer remain required.',
        'v367 replaces the v366 trigger only for exact same-transaction expires_at renewals. Result closure requires a further atomic trigger successor.',
        'The fixture uses privileged timestamp and state fault injection for expiry and pre-grant dispatched legacy rows. It never grants those privileges to a runtime caller.',
        'The native direct-renewer call proves a local SQL COMMIT and dedicated connection-close ACK; it does not prove provider send, billing, stream cancellation, lost network ACK, or a fleet cutover.',
        'The v370 successor records committed renewal epochs as holder observations, but PostgreSQL cannot prove the holder received a renewal ACK. The local stream holder is not a deployed Worker or result closer.',
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
      const bill=connection(cluster,roles.bill,passwords.bill,'bill');
      const renewer=connection(cluster,roles.renewer,passwords.renewer,'renewer');
      const renewerPeer=connection(cluster,roles.renewer,passwords.renewer,'renewer-peer');
      const buyer=connection(cluster,roles.buyer,passwords.buyer,'buyer');
      const recovery=connection(cluster,roles.recovery,passwords.recovery,'recovery');
      const holderPeer=connection(cluster,roles.holder,passwords.holder,'holder-peer');
      const cap=connection(cluster,roles.cap,passwords.cap,'cap');
      const verifier=connection(cluster,roles.verifier,passwords.verifier,'verifier');
      const complete=connection(cluster,roles.complete,passwords.complete,'complete');
      clients.push(migrator,runtime,admission,granter,granterPeer,holder,holderPeer,bill,
        renewer,renewerPeer,cap,verifier,complete,recovery,buyer);
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
      report.sourceSha256['postgres-complete-text-hold-renewal-v369.ts']=sha(
        await readFile(new URL('../../../packages/proxy/src/services/postgres-complete-text-hold-renewal-v369.ts',import.meta.url)));
      report.sourceSha256['postgres-complete-text-hold-renewal-v369.test.ts']=sha(
        await readFile(new URL('../../../packages/proxy/src/services/postgres-complete-text-hold-renewal-v369.test.ts',import.meta.url)));
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

      const renewalSql=await readFile(proposal(
        'complete-text-all-hold-renewal-v367.sql'),'utf8');
      report.sourceSha256['complete-text-all-hold-renewal-v367.sql']=sha(renewalSql);
      const installRenewal=async()=>migrator.begin(async tx=>{
        await tx.unsafe(`SET LOCAL
          cinatoken.complete_text_all_hold_renewal_v367_activation='reviewed-v1'`);
        await tx.unsafe(renewalSql).simple();
      });
      await assert.rejects(migrator.begin(tx=>tx.unsafe(renewalSql).simple()),
        /activation or role differs/u);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`GRANT UPDATE (expires_at) ON
          ${g}.user_budget_reservations TO ${roles.renewer}`);
        await tx.unsafe(`SET LOCAL
          cinatoken.complete_text_all_hold_renewal_v367_activation='reviewed-v1'`);
        await tx.unsafe(renewalSql).simple();
      }),/activation or role differs/u);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`SET LOCAL
          cinatoken.complete_text_all_hold_renewal_v367_activation='reviewed-v1'`);
        await tx.unsafe(renewalSql).simple();
        throw new Error('rollback-after-renewal-install');
      }),/rollback-after-renewal-install/u);
      const [beforeRenewal]=await migrator.unsafe(`SELECT
        pg_catalog.to_regclass('${g}.complete_text_hold_renewals_v367') IS NULL
          AS no_table,
        pg_catalog.pg_get_functiondef(
          '${g}.reject_complete_text_enrolled_hold_mutation_v366()'
            ::pg_catalog.regprocedure) NOT LIKE '%hold_renewals_v367%'
          AS old_fence`);
      assert.deepEqual(beforeRenewal,{no_table:true,old_fence:true});
      await installRenewal();
      stage('renewal-default-off-direct-role-drift-and-rollback-atomic');

      const [renewAcl]=await migrator.unsafe(`SELECT
        pg_catalog.has_function_privilege('${roles.renewer}',
          '${g}.renew_complete_text_holds_v367(uuid,uuid,uuid,bigint)',
          'EXECUTE') AS wrapper,
        pg_catalog.has_function_privilege('${roles.renewer}',
          '${g}.record_complete_text_send_start_v365(uuid,uuid,bigint,text)',
          'EXECUTE') AS send_start,
        pg_catalog.has_function_privilege('${roles.renewer}',
          '${g}.grant_complete_flat_text_attempt_v362(uuid,jsonb)',
          'EXECUTE') AS grant_attempt,
        pg_catalog.has_table_privilege('${roles.renewer}',
          '${g}.user_budget_reservations','UPDATE') AS ordinary_dml,
        pg_catalog.has_table_privilege('${roles.renewer}',
          '${g}.guardrail_budget_reservations','UPDATE') AS guardrail_dml,
        pg_catalog.has_table_privilege('${roles.renewer}',
          '${g}.complete_text_hold_renewals_v367','INSERT') AS epoch_insert`);
      assert.deepEqual(renewAcl,{wrapper:true,send_start:false,
        grant_attempt:false,ordinary_dml:false,guardrail_dml:false,
        epoch_insert:false});
      await denied(holder.unsafe(`SELECT ${g}.renew_complete_text_holds_v367(
        pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid(),
        pg_catalog.gen_random_uuid(),1)`));
      await denied(buyer.unsafe(`SELECT ${g}.renew_complete_text_holds_v367(
        pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid(),
        pg_catalog.gen_random_uuid(),1)`));
      await denied(renewer.unsafe(`SELECT * FROM
        ${g}.complete_text_hold_renewals_v367`));
      await denied(renewer.unsafe(`UPDATE ${g}.user_budget_reservations
        SET expires_at=now() WHERE request_id='x'`));
      await denied(renewer.unsafe(`SELECT ${g}.forfeit_guardrail_budgets_v353(
        'x','unknown_provider_outcome')`));
      stage('isolated-renewal-login-has-wrapper-only-and-no-raw-or-old-authority',
        {renewAcl});

      const renew=async(grantId,runId,startId,epoch,client=renewer)=>{
        const [row]=await client.unsafe(`SELECT
          ${g}.renew_complete_text_holds_v367(
            $1::uuid,$2::uuid,$3::uuid,$4::bigint) AS value`,
          [grantId,runId,startId,epoch]);
        return row.value;
      };
      const issueStarted=async(id,items=intents())=>{
        const quote=await issueQuote(bearer,id);
        assert.equal((await admit(quote,items)).status,'admitted');
        const grantClaim=await claimFor(quote);
        const result=await grant(grantClaim);
        assert.equal(result.status,'grant_recorded');
        const runId=randomUUID();
        assert.equal((await custody(result.grantId,runId)).status,
          'custody_claim_recorded');
        const startResult=await start(result.grantId,runId,1,
          grantClaim.outboundBodySha256);
        assert.equal(startResult.status,'start_recorded');
        return {quote,grantClaim,result,runId,startResult};
      };
      const renewalRows=async(requestId)=>{
        const [ordinary]=await migrator.unsafe(`SELECT expires_at::text AS deadline
          FROM ${g}.user_budget_reservations WHERE request_id=$1`,[requestId]);
        const guardrails=await migrator.unsafe(`SELECT assignment_id,
          expires_at::text AS deadline FROM ${g}.guardrail_budget_reservations
          WHERE request_id=$1 ORDER BY assignment_id`,[requestId]);
        return {ordinary:ordinary?.deadline??null,guardrails};
      };
      const renewalCount=async(grantId)=>{
        const [row]=await migrator.unsafe(`SELECT count(*)::integer AS n FROM
          ${g}.complete_text_hold_renewals_v367 WHERE grant_id=$1::uuid`,
          [grantId]);
        return row.n;
      };

      const combined=await issueStarted('v367-00-combined');
      const original=await renewalRows(combined.quote.requestId);
      assert.equal(original.guardrails.length,3);
      assert.ok(original.guardrails.every(x=>x.deadline===original.ordinary));
      const firstRenewal=await renew(combined.result.grantId,combined.runId,
        combined.startResult.sendStartId,1);
      assert.equal(firstRenewal.status,'renewal_recorded');
      assert.equal(firstRenewal.leaseEpoch,2);
      const firstRows=await renewalRows(combined.quote.requestId);
      assert.equal(new Date(firstRows.ordinary).getTime(),
        new Date(firstRenewal.leaseUntil).getTime());
      assert.ok(firstRows.guardrails.every(x=>x.deadline===firstRows.ordinary));
      const [firstEpoch]=await migrator.unsafe(`SELECT lease_epoch::integer AS epoch,
        prior_lease_until,lease_until,recorded_at FROM
        ${g}.complete_text_hold_renewals_v367
        WHERE grant_id=$1::uuid`,[combined.result.grantId]);
      assert.equal(firstEpoch.epoch,2);
      assert.equal(new Date(firstEpoch.prior_lease_until).getTime(),
        new Date(original.ordinary).getTime());
      assert.ok(new Date(firstEpoch.lease_until).getTime()
        <=new Date(firstEpoch.recorded_at).getTime()+900_000);
      const secondRenewal=await renew(combined.result.grantId,combined.runId,
        combined.startResult.sendStartId,2);
      assert.equal(secondRenewal.status,'renewal_recorded');
      assert.equal(secondRenewal.leaseEpoch,3);
      assert.equal(await renewalCount(combined.result.grantId),2);
      stage('combined-ordinary-and-three-Guardrails-extend-exactly-together-with-append-epochs');

      const replay=await renew(combined.result.grantId,combined.runId,
        combined.startResult.sendStartId,1);
      assert.deepEqual(replay,{status:'already_recorded'});
      assert.equal((await renew(combined.result.grantId,randomUUID(),
        combined.startResult.sendStartId,2)).status,'holder_binding_differs');
      assert.equal((await renew(combined.result.grantId,combined.runId,
        randomUUID(),2)).status,'holder_binding_differs');
      assert.equal((await renew(combined.result.grantId,combined.runId,
        combined.startResult.sendStartId,4)).status,'stale_epoch');
      assert.equal(await renewalCount(combined.result.grantId),2);
      const [unchangedOriginal]=await migrator.unsafe(`SELECT
        obligation_state,hold_recovery_expires_at FROM
        ${g}.complete_text_attempt_grants_v362 WHERE grant_id=$1::uuid`,
        [combined.result.grantId]);
      assert.equal(unchangedOriginal.obligation_state,'unknown');
      assert.equal(new Date(unchangedOriginal.hold_recovery_expires_at).getTime(),
        new Date(original.ordinary).getTime());
      stage('lost-ack-replay-never-returns-a-new-deadline-or-physical-send-right');

      const injected=await issueStarted('v367-01-counter-mismatch');
      const beforeMismatch=await renewalRows(injected.quote.requestId);
      await cluster.admin.unsafe(`UPDATE ${g}.guardrail_budget_windows SET
        reserved_micros=reserved_micros+1
        WHERE scope_type='user' AND scope_id='v361-user'
          AND period_start=(SELECT period_start FROM
            ${g}.guardrail_budget_reservations
            WHERE request_id=$1 AND assignment_id='v361-assignment')`,
        [injected.quote.requestId]);
      assert.equal((await renew(injected.result.grantId,injected.runId,
        injected.startResult.sendStartId,1)).status,'guardrail_counter_differs');
      assert.equal(await renewalCount(injected.result.grantId),0);
      assert.deepEqual(await renewalRows(injected.quote.requestId),beforeMismatch);
      await cluster.admin.unsafe(`UPDATE ${g}.guardrail_budget_windows SET
        reserved_micros=reserved_micros-1
        WHERE scope_type='user' AND scope_id='v361-user'
          AND period_start=(SELECT period_start FROM
            ${g}.guardrail_budget_reservations
            WHERE request_id=$1 AND assignment_id='v361-assignment')`,
        [injected.quote.requestId]);
      stage('one-Guardrail-counter-mismatch-rolls-back-every-hold-and-epoch');

      const changed=await issueStarted('v367-01b-changed-Guardrail-identity');
      const beforeChanged=await renewalRows(changed.quote.requestId);
      await cluster.admin.begin(async tx=>{
        await tx.unsafe(`SET LOCAL session_replication_role='replica'`);
        await tx.unsafe(`UPDATE ${g}.guardrail_budget_reservations
          SET guardrail_version=2
          WHERE request_id=$1 AND assignment_id='v361-assignment'`,
          [changed.quote.requestId]);
      });
      assert.equal((await renew(changed.result.grantId,changed.runId,
        changed.startResult.sendStartId,1)).status,'guardrail_hold_differs');
      assert.equal(await renewalCount(changed.result.grantId),0);
      assert.deepEqual(await renewalRows(changed.quote.requestId),beforeChanged);
      await cluster.admin.begin(async tx=>{
        await tx.unsafe(`SET LOCAL session_replication_role='replica'`);
        await tx.unsafe(`UPDATE ${g}.guardrail_budget_reservations
          SET guardrail_version=1
          WHERE request_id=$1 AND assignment_id='v361-assignment'`,
          [changed.quote.requestId]);
      });
      stage('one-changed-Guardrail-identity-rejects-without-any-hold-extension');

      const broken=await issueStarted('v367-02-missing-Guardrail');
      const beforeBroken=await renewalRows(broken.quote.requestId);
      await cluster.admin.begin(async tx=>{
        await tx.unsafe(`SET LOCAL session_replication_role='replica'`);
        await tx.unsafe(`CREATE TEMP TABLE fixture_v367_deleted_guardrail AS
          SELECT * FROM ${g}.guardrail_budget_reservations
          WHERE request_id=$1 AND assignment_id='v361-assignment'`,
          [broken.quote.requestId]);
        await tx.unsafe(`DELETE FROM ${g}.guardrail_budget_reservations
          WHERE request_id=$1 AND assignment_id='v361-assignment'`,
          [broken.quote.requestId]);
      });
      assert.equal((await renew(broken.result.grantId,broken.runId,
        broken.startResult.sendStartId,1)).status,'guardrail_hold_differs');
      assert.equal(await renewalCount(broken.result.grantId),0);
      assert.equal((await renewalRows(broken.quote.requestId)).ordinary,
        beforeBroken.ordinary);
      await cluster.admin.begin(async tx=>{
        await tx.unsafe(`SET LOCAL session_replication_role='replica'`);
        await tx.unsafe(`INSERT INTO ${g}.guardrail_budget_reservations
          SELECT * FROM fixture_v367_deleted_guardrail`);
        await tx.unsafe(`DROP TABLE fixture_v367_deleted_guardrail`);
      });
      stage('missing-admitted-Guardrail-rejects-without-ordinary-extension');

      const terminal=await issueStarted('v367-03-terminal-ordinary');
      const beforeTerminal=await renewalRows(terminal.quote.requestId);
      await cluster.admin.begin(async tx=>{
        await tx.unsafe(`SET LOCAL session_replication_role='replica'`);
        await tx.unsafe(`UPDATE ${g}.user_budget_reservations
          SET state='settled',terminal_at=now(),terminal_reason='test'
          WHERE request_id=$1`,[terminal.quote.requestId]);
      });
      assert.equal((await renew(terminal.result.grantId,terminal.runId,
        terminal.startResult.sendStartId,1)).status,'ordinary_hold_differs');
      assert.equal(await renewalCount(terminal.result.grantId),0);
      assert.deepEqual(await renewalRows(terminal.quote.requestId),
        beforeTerminal);
      await cluster.admin.begin(async tx=>{
        await tx.unsafe(`SET LOCAL session_replication_role='replica'`);
        await tx.unsafe(`UPDATE ${g}.user_budget_reservations SET
          state='dispatched',terminal_at=NULL,terminal_reason=NULL
          WHERE request_id=$1`,[terminal.quote.requestId]);
      });
      stage('terminal-ordinary-hold-rejects-without-Guardrail-extension');

      const rollback=await issueStarted('v367-04-transaction-rollback');
      const beforeRollback=await renewalRows(rollback.quote.requestId);
      await assert.rejects(renewer.begin(async tx=>{
        const [row]=await tx.unsafe(`SELECT ${g}.renew_complete_text_holds_v367(
          $1::uuid,$2::uuid,$3::uuid,1) AS value`,
          [rollback.result.grantId,rollback.runId,
            rollback.startResult.sendStartId]);
        assert.equal(row.value.status,'renewal_recorded');
        throw new Error('lost-commit-before-commit');
      }),/lost-commit-before-commit/u);
      assert.equal(await renewalCount(rollback.result.grantId),0);
      assert.deepEqual(await renewalRows(rollback.quote.requestId),beforeRollback);
      stage('aborted-renewal-transaction-leaves-no-partial-hold-or-epoch');

      // Remove all three configured Guardrail sources for a source-proven
      // zero-intent admission. Keep the ordinary budget finite first.
      await migrator.unsafe(`UPDATE ${g}.guardrails SET status='archived'
        WHERE id='v361-guardrail';
        DELETE FROM ${g}.workspace_budgets WHERE id='v361-budget';
        UPDATE ${g}.api_keys SET limit_micros=NULL
        WHERE id='v361-key'`).simple();
      const ordinaryOnly=await issueStarted('v367-05-ordinary-only',[]);
      const ordinaryBefore=await renewalRows(ordinaryOnly.quote.requestId);
      assert.ok(ordinaryBefore.ordinary);
      assert.equal(ordinaryBefore.guardrails.length,0);
      assert.equal((await renew(ordinaryOnly.result.grantId,ordinaryOnly.runId,
        ordinaryOnly.startResult.sendStartId,1)).status,'renewal_recorded');
      assert.equal(await renewalCount(ordinaryOnly.result.grantId),1);
      assert.ok(new Date((await renewalRows(ordinaryOnly.quote.requestId)).ordinary)
        .getTime()>new Date(ordinaryBefore.ordinary).getTime());
      stage('ordinary-only-zero-Guardrail-intent-renews-its-exact-single-hold');

      await migrator.unsafe(`UPDATE ${g}.users SET budget_max=NULL
        WHERE id='v361-user'`);
      const unlimitedZero=await issueStarted('v367-06-unlimited-zero-intents',[]);
      const unlimitedBefore=await renewalRows(unlimitedZero.quote.requestId);
      assert.equal(unlimitedBefore.ordinary,null);
      assert.equal(unlimitedBefore.guardrails.length,0);
      assert.equal((await renew(unlimitedZero.result.grantId,unlimitedZero.runId,
        unlimitedZero.startResult.sendStartId,1)).status,'renewal_recorded');
      assert.equal(await renewalCount(unlimitedZero.result.grantId),1);
      assert.deepEqual(await renewalRows(unlimitedZero.quote.requestId),
        unlimitedBefore);
      stage('source-proven-unlimited-zero-hold-shape-retains-unknown-grant-epoch');

      await migrator.unsafe(`UPDATE ${g}.guardrails SET status='active'
        WHERE id='v361-guardrail';
        INSERT INTO ${g}.workspace_budgets
          (id,workspace_id,reset_interval,limit_micros)
          VALUES('v361-budget','v361-workspace','daily',2000000);
        UPDATE ${g}.api_keys SET limit_micros=2000000
          WHERE id='v361-key'`).simple();
      const guardrailOnly=await issueStarted('v367-07-Guardrail-only');
      const guardrailBefore=await renewalRows(guardrailOnly.quote.requestId);
      assert.equal(guardrailBefore.ordinary,null);
      assert.equal(guardrailBefore.guardrails.length,3);
      const guardrailRenewal=await renew(guardrailOnly.result.grantId,
        guardrailOnly.runId,guardrailOnly.startResult.sendStartId,1);
      assert.equal(guardrailRenewal.status,'renewal_recorded');
      assert.equal(await renewalCount(guardrailOnly.result.grantId),1);
      assert.equal((await renewalRows(guardrailOnly.quote.requestId)).ordinary,null);
      assert.ok((await renewalRows(guardrailOnly.quote.requestId)).guardrails
        .every(x=>new Date(x.deadline).getTime()
          ===new Date(guardrailRenewal.leaseUntil).getTime()));
      stage('Guardrail-only-source-proven-unlimited-extends-every-window-hold');

      const concurrent=await issueStarted('v367-08-concurrent-epoch');
      const concurrentResults=await Promise.all([
        renew(concurrent.result.grantId,concurrent.runId,
          concurrent.startResult.sendStartId,1,renewer),
        renew(concurrent.result.grantId,concurrent.runId,
          concurrent.startResult.sendStartId,1,renewerPeer)]);
      assert.deepEqual(concurrentResults.map(x=>x.status).sort(),
        ['already_recorded','renewal_recorded']);
      assert.equal(await renewalCount(concurrent.result.grantId),1);
      stage('same-request-renewal-race-commits-one-epoch-and-one-replay');

      const late=await issueStarted('v367-09-expiry-after-wait');
      await cluster.admin.begin(async tx=>{
        await tx.unsafe(`SET LOCAL session_replication_role='replica'`);
        await tx.unsafe(`DO $clock$
          DECLARE deadline timestamptz:=pg_catalog.clock_timestamp()
            + INTERVAL '1300 milliseconds';
          BEGIN
            UPDATE ${g}.complete_text_attempt_grants_v362 SET
              send_expires_at=pg_catalog.clock_timestamp()
                + INTERVAL '300 milliseconds',
              hold_recovery_expires_at=deadline
              WHERE grant_id='${late.result.grantId}';
            UPDATE ${g}.complete_text_send_custody_v365
              SET lease_until=deadline
              WHERE grant_id='${late.result.grantId}';
            UPDATE ${g}.user_budget_reservations SET expires_at=deadline
              WHERE request_id='${late.quote.requestId}';
            UPDATE ${g}.guardrail_budget_reservations SET expires_at=deadline
              WHERE request_id='${late.quote.requestId}';
          END $clock$`);
      });
      let releaseLate,readyLateResolve,readyLateReject;
      const lateGate=new Promise(resolve=>{releaseLate=resolve;});
      const lateReady=new Promise((resolve,reject)=>{
        readyLateResolve=resolve;readyLateReject=reject;
      });
      const heldAccount=migrator.begin(async tx=>{
        try{
          await tx.unsafe(`SELECT id FROM ${g}.users
            WHERE id='v361-user' FOR UPDATE`);
          readyLateResolve();
          await lateGate;
        }catch(error){readyLateReject(error);throw error;}
      });
      await lateReady;
      const lateRenewal=Promise.resolve(renew(late.result.grantId,late.runId,
        late.startResult.sendStartId,1));
      try {
        await waitForLock('renewer');
        await new Promise(resolve=>setTimeout(resolve,1400));
      } finally {releaseLate();}
      const [,lateResult]=await Promise.all([heldAccount,lateRenewal]);
      assert.equal(lateResult.status,'lease_expired');
      assert.equal(await renewalCount(late.result.grantId),0);
      stage('database-clock-after-account-lock-wait-rejects-expired-prior-lease');

      for(const table of ['user_budget_reservations',
        'guardrail_budget_reservations']){
        await assert.rejects(buyer.unsafe(`UPDATE ${g}.${table}
          SET expires_at=now()+interval '30 minutes'
          WHERE request_id=$1`,[combined.quote.requestId]),error=>{
          assert.ok(['42501','23514'].includes((error?.cause??error)?.code),
            String(error));return true;
        });
      }
      stage('successor-fence-and-acl-still-deny-buyer-reservation-dml');

      await migrator.unsafe(`UPDATE ${g}.users SET budget_max=10
        WHERE id='v361-user'`);
      const direct=await issueStarted('v369-00-direct-renewer-client');
      const directBefore=await renewalRows(direct.quote.requestId);
      const directUrl=`postgres://${roles.renewer}:${passwords.renewer}`
        +`@127.0.0.1:${cluster.port}/postgres?sslmode=disable`;
      const directReceipt=await renewPostgresCompleteTextHoldsV367({
        renewerConnectionString:directUrl,
        grantId:direct.result.grantId,holderRunId:direct.runId,
        sendStartId:direct.startResult.sendStartId,expectedEpoch:1,
      },(url,options)=>postgres(url,{...options,prepare:false,
        fetch_types:false,connect_timeout:3,idle_timeout:0,max_lifetime:0,
        backoff:false,onnotice(){},
        connection:{application_name:'complete-renew-v369-direct'}}));
      assert.equal(directReceipt.status,'renewal_recorded');
      assert.equal(directReceipt.commitAcknowledged,true);
      assert.equal(directReceipt.closeAcknowledged,true);
      assert.equal(directReceipt.leaseEpoch,2);
      assert.ok(new Date(directReceipt.leaseUntil).getTime()
        >new Date(directBefore.ordinary).getTime());
      const [visible]=await migrator.unsafe(`WITH renewal AS (
        SELECT lease_until FROM ${g}.complete_text_hold_renewals_v367
        WHERE grant_id=$1::uuid AND lease_epoch=2)
        SELECT
        (SELECT count(*)::integer FROM renewal) AS epoch_count,
        (SELECT lease_until FROM renewal) AS committed_deadline,
        (SELECT count(*)::integer FROM ${g}.user_budget_reservations
          WHERE request_id=$2 AND expires_at=(SELECT lease_until FROM renewal))
          AS ordinary_count,
        (SELECT count(*)::integer FROM ${g}.guardrail_budget_reservations
          WHERE request_id=$2 AND expires_at=(SELECT lease_until FROM renewal))
          AS guardrail_count`,
        [direct.result.grantId,direct.quote.requestId]);
      assert.equal(visible.epoch_count,1);
      assert.equal(new Date(visible.committed_deadline).getTime(),
        new Date(directReceipt.leaseUntil).getTime());
      assert.equal(visible.ordinary_count,1);
      assert.equal(visible.guardrail_count,3);
      const [closedDirect]=await cluster.admin.unsafe(`SELECT count(*)::integer AS n
        FROM pg_catalog.pg_stat_activity
        WHERE application_name='complete-renew-v369-direct'`);
      assert.equal(closedDirect.n,0);
      stage('real-direct-renewer-login-commit-and-close-acks-publish-one-visible-epoch');

      const factSql=await readFile(proposal('complete-text-result-facts-v366.sql'),'utf8');
      report.sourceSha256['complete-text-result-facts-v366.sql']=sha(factSql);
      await migrator.begin(async tx=>{
        await tx.unsafe("SET LOCAL cinatoken.complete_text_result_facts_activation='reviewed-v1'");
        await tx.unsafe(factSql).simple();
      });
      const renewedFactSql=await readFile(
        proposal('complete-text-renewed-holder-facts-v370.sql'),'utf8');
      report.sourceSha256['complete-text-renewed-holder-facts-v370.sql']=
        sha(renewedFactSql);
      await assert.rejects(migrator.begin(tx=>tx.unsafe(renewedFactSql).simple()),
        /renewed facts v370 dependency differs/u);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(
          "SET LOCAL cinatoken.complete_text_renewed_facts_v370_activation='reviewed-v1'");
        await tx.unsafe(renewedFactSql).simple();
        throw new Error('rollback-renewed-facts-v370');
      }),/rollback-renewed-facts-v370/u);
      const [rolledFactInstall]=await migrator.unsafe(
        "SELECT pg_catalog.to_regclass("
        +"'cinatoken_gateway.complete_text_result_epoch_conflicts_v370')"
        +" IS NULL AS no_epoch_conflict_table");
      assert.equal(rolledFactInstall.no_epoch_conflict_table,true);
      await migrator.begin(async tx=>{
        await tx.unsafe(
          "SET LOCAL cinatoken.complete_text_renewed_facts_v370_activation='reviewed-v1'");
        await tx.unsafe(renewedFactSql).simple();
      });
      const [epochAuditAcl]=await migrator.unsafe(`SELECT
        pg_catalog.has_table_privilege('${roles.holder}',
          '${g}.complete_text_result_epoch_conflicts_v370',
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS holder_raw,
        pg_catalog.has_table_privilege('${roles.bill}',
          '${g}.complete_text_result_epoch_conflicts_v370',
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS bill_raw,
        pg_catalog.has_table_privilege('${roles.runtime}',
          '${g}.complete_text_result_epoch_conflicts_v370',
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS runtime_raw,
        (SELECT count(*)::integer FROM pg_catalog.pg_trigger
          WHERE tgrelid=
            '${g}.complete_text_result_epoch_conflicts_v370'::pg_catalog.regclass
            AND NOT tgisinternal AND tgenabled='O') AS immutable_triggers`);
      assert.deepEqual(epochAuditAcl,{holder_raw:false,bill_raw:false,
        runtime_raw:false,immutable_triggers:2});
      await denied(holder.unsafe(`SELECT *
        FROM ${g}.complete_text_result_epoch_conflicts_v370`));
      await denied(bill.unsafe(`SELECT *
        FROM ${g}.complete_text_result_epoch_conflicts_v370`));
      stage('renewed-holder-fact-successor-default-off-rollback-and-private-audit-acl',
        {epochAuditAcl});

      const holderUrl='postgres://'+roles.holder+':'+passwords.holder
        +'@127.0.0.1:'+cluster.port+'/postgres?sslmode=disable';
      const billUrl='postgres://'+roles.bill+':'+passwords.bill
        +'@127.0.0.1:'+cluster.port+'/postgres?sslmode=disable';
      const directFactFactory=(url,options)=>postgres(url,{
        ...options,prepare:false,fetch_types:false,connect_timeout:3,
        idle_timeout:0,max_lifetime:0,backoff:false,onnotice(){},
        connection:{application_name:'complete-renewed-fact-v370-direct'}});
      const epochThreeNonce=randomUUID();
      const epochThreeEvidence={kind:'fetch_invoked',
        observation:'fetch_invoked',
        uploadSha256:combined.grantClaim.outboundBodySha256};
      const epochThreeFact=await appendPostgresCompleteTextHolderFactV367({
        holderConnectionString:holderUrl,grantId:combined.result.grantId,
        holderRunId:combined.runId,expectedEpoch:3,
        evidenceNonce:epochThreeNonce,evidence:epochThreeEvidence,
      },directFactFactory);
      assert.equal(epochThreeFact.status,'fact_recorded');
      assert.equal(epochThreeFact.commitAcknowledged,true);
      const [storedEpochThree]=await migrator.unsafe(
        'SELECT lease_epoch::integer AS epoch,send_start_id,source_kind,kind FROM '
        +g+'.complete_text_result_facts_v366 WHERE fact_id=$1::uuid',
        [epochThreeFact.factId]);
      assert.deepEqual(storedEpochThree,{epoch:3,
        send_start_id:combined.startResult.sendStartId,
        source_kind:'holder',kind:'fetch_invoked'});
      const epochThreeReplay=await appendPostgresCompleteTextHolderFactV367({
        holderConnectionString:holderUrl,grantId:combined.result.grantId,
        holderRunId:combined.runId,expectedEpoch:3,
        evidenceNonce:epochThreeNonce,evidence:epochThreeEvidence,
      },directFactFactory);
      assert.equal(epochThreeReplay.status,'already_recorded');
      assert.equal(epochThreeReplay.factId,epochThreeFact.factId);
      stage('direct-holder-fact-commit-close-ack-binds-committed-epoch-three');

      await assert.rejects(appendPostgresCompleteTextHolderFactV367({
        holderConnectionString:holderUrl,grantId:combined.result.grantId,
        holderRunId:combined.runId,expectedEpoch:4,
        evidenceNonce:randomUUID(),
        evidence:{kind:'transport_unknown',observation:'transport_unknown',
          phase:'headers'},
      },directFactFactory),/renewal_epoch_required/u);
      await assert.rejects(appendPostgresCompleteTextHolderFactV367({
        holderConnectionString:holderUrl,grantId:combined.result.grantId,
        holderRunId:randomUUID(),expectedEpoch:3,evidenceNonce:randomUUID(),
        evidence:{kind:'transport_unknown',observation:'transport_unknown',
          phase:'headers'},
      },directFactFactory),/holder_run_conflict/u);
      const olderEpochFact=await appendPostgresCompleteTextHolderFactV367({
        holderConnectionString:holderUrl,grantId:combined.result.grantId,
        holderRunId:combined.runId,expectedEpoch:2,evidenceNonce:randomUUID(),
        evidence:{kind:'transport_unknown',observation:'transport_unknown',
          phase:'headers'},
      },directFactFactory);
      const [storedOlder]=await migrator.unsafe(
        'SELECT lease_epoch::integer AS epoch FROM '
        +g+'.complete_text_result_facts_v366 WHERE fact_id=$1::uuid',
        [olderEpochFact.factId]);
      assert.equal(storedOlder.epoch,2);
      await assert.rejects(appendPostgresCompleteTextHolderFactV367({
        holderConnectionString:holderUrl,grantId:combined.result.grantId,
        holderRunId:combined.runId,expectedEpoch:2,
        evidenceNonce:epochThreeNonce,evidence:epochThreeEvidence,
      },directFactFactory),/evidence_nonce_conflict/u);
      const [conflictingEpoch]=await migrator.unsafe(
        'SELECT count(*)::integer AS n FROM '
        +g+'.complete_text_result_fact_conflicts_v366 '
        +'WHERE grant_id=$1::uuid AND evidence_nonce=$2::uuid',
        [combined.result.grantId,epochThreeNonce]);
      assert.equal(conflictingEpoch.n,1);
      const [epochThreeConflict]=await migrator.unsafe(
        'SELECT recorded_lease_epoch::integer AS recorded_epoch,'
        +'attempted_lease_epoch::integer AS attempted_epoch,'
        +'recorded_fact_id,recorded_kind,attempted_kind,'
        +'recorded_evidence_sha256,attempted_evidence_sha256 '
        +'FROM '+g+'.complete_text_result_epoch_conflicts_v370 '
        +'WHERE grant_id=$1::uuid AND evidence_nonce=$2::uuid',
        [combined.result.grantId,epochThreeNonce]);
      assert.deepEqual(epochThreeConflict,{
        recorded_epoch:3,attempted_epoch:2,
        recorded_fact_id:epochThreeFact.factId,
        recorded_kind:'fetch_invoked',attempted_kind:'fetch_invoked',
        recorded_evidence_sha256:epochThreeFact.evidenceSha256,
        attempted_evidence_sha256:epochThreeFact.evidenceSha256});
      stage('missing-or-wrong-run-epoch-rejected-but-late-committed-evidence-retained');

      const epochOneNonce=randomUUID();
      const epochOneFact=await appendPostgresCompleteTextHolderFactV367({
        holderConnectionString:holderUrl,grantId:combined.result.grantId,
        holderRunId:combined.runId,expectedEpoch:1,
        evidenceNonce:epochOneNonce,evidence:epochThreeEvidence,
      },directFactFactory);
      assert.equal(epochOneFact.status,'fact_recorded');
      for(const attemptedEpoch of [2,3,2]){
        await assert.rejects(appendPostgresCompleteTextHolderFactV367({
          holderConnectionString:holderUrl,grantId:combined.result.grantId,
          holderRunId:combined.runId,expectedEpoch:attemptedEpoch,
          evidenceNonce:epochOneNonce,evidence:epochThreeEvidence,
        },directFactFactory),/evidence_nonce_conflict/u);
      }
      const attemptedEpochRows=await migrator.unsafe(
        'SELECT recorded_lease_epoch::integer AS recorded_epoch,'
        +'attempted_lease_epoch::integer AS attempted_epoch,'
        +'recorded_fact_id,recorded_source_kind,attempted_source_kind,'
        +'recorded_kind,attempted_kind,recorded_evidence_sha256,'
        +'attempted_evidence_sha256 FROM '
        +g+'.complete_text_result_epoch_conflicts_v370 '
        +'WHERE grant_id=$1::uuid AND evidence_nonce=$2::uuid '
        +'ORDER BY attempted_lease_epoch',
        [combined.result.grantId,epochOneNonce]);
      assert.deepEqual([...attemptedEpochRows],[2,3].map(attempted_epoch=>({
        recorded_epoch:1,attempted_epoch,
        recorded_fact_id:epochOneFact.factId,
        recorded_source_kind:'holder',attempted_source_kind:'holder',
        recorded_kind:'fetch_invoked',attempted_kind:'fetch_invoked',
        recorded_evidence_sha256:epochOneFact.evidenceSha256,
        attempted_evidence_sha256:epochOneFact.evidenceSha256})));
      const [legacyConflictCount]=await migrator.unsafe(
        'SELECT count(*)::integer AS n FROM '
        +g+'.complete_text_result_fact_conflicts_v366 '
        +'WHERE grant_id=$1::uuid AND evidence_nonce=$2::uuid',
        [combined.result.grantId,epochOneNonce]);
      assert.equal(legacyConflictCount.n,1);
      await denied(migrator.unsafe(`UPDATE
        ${g}.complete_text_result_epoch_conflicts_v370
        SET attempted_lease_epoch=attempted_lease_epoch
        WHERE grant_id=$1::uuid`,[combined.result.grantId]),'23514');
      await denied(migrator.unsafe(`DELETE FROM
        ${g}.complete_text_result_epoch_conflicts_v370
        WHERE grant_id=$1::uuid`,[combined.result.grantId]),'23514');
      await denied(migrator.unsafe(`TRUNCATE
        ${g}.complete_text_result_epoch_conflicts_v370`),'23514');
      stage('same-nonce-digest-conflicts-at-epochs-two-and-three-are-distinct-and-immutable');

      const billFact=await appendPostgresCompleteTextProviderBillFactV367({
        billConnectionString:billUrl,grantId:combined.result.grantId,
        evidenceNonce:randomUUID(),
        evidence:{providerRequestRef:'local-renewed-fact',
          providerEventId:'local-renewed-bill',currency:'USD',
          amountMicros:'0',billDocumentSha256:sha('local-synthetic-bill')},
      },directFactFactory);
      const [storedBill]=await migrator.unsafe(
        'SELECT lease_epoch::integer AS epoch,source_kind,kind FROM '
        +g+'.complete_text_result_facts_v366 WHERE fact_id=$1::uuid',
        [billFact.factId]);
      assert.deepEqual(storedBill,{epoch:1,source_kind:'provider_bill',
        kind:'provider_bill'});
      const [factClientClosed]=await cluster.admin.unsafe(
        "SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity "
        +"WHERE application_name='complete-renewed-fact-v370-direct'");
      assert.equal(factClientClosed.n,0);
      stage('independent-bill-fact-keeps-send-epoch-one-without-renewal-authority');

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
      process.stdout.write(`complete-text-all-hold-renewal-v367-report=${reportUrl.pathname}\n`);
    }
    if(failure) throw failure;
    assert.equal(report.cleanup,'PASS');
  });
