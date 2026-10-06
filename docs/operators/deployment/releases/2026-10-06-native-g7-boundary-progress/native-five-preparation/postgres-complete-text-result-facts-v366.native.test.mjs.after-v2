// Owned PostgreSQL 18.6 proof of role-separated v366 result facts after v365.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { computeRouteDataPolicySubjectFingerprintFromRows } from '../../../packages/core/src/route-data-policy.ts';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';
import { activatePostgresBuyerSplitV348 } from './activate-postgres-buyer-split-v348.ts';
import { grantPostgresBuyerSplitV348 } from './grant-postgres-buyer-split-v348.ts';
import { activatePostgresBuyerGuardrailSplitV349 } from './activate-postgres-buyer-guardrail-split-v349.ts';
import { grantPostgresBuyerGuardrailSplitV349 } from './grant-postgres-buyer-guardrail-split-v349.ts';
import {
  appendPostgresCompleteTextHolderFactV367,
  appendPostgresCompleteTextProviderBillFactV367,
} from '../../../packages/proxy/src/services/postgres-complete-text-result-facts-v367.ts';

const g='cinatoken_gateway';
const migrationDir=new URL('../../../packages/core/migrations-postgres/',import.meta.url);
const proposal=name=>new URL(`../../../packages/core/migrations-proposals/postgres/${name}`,import.meta.url);
const reportUrl=new URL('../../../docs/developers/architecture/implementation-evidence/C04-complete-text-result-facts-v366-report.json',import.meta.url);
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
  bill:'cinatoken_gateway_complete_text_provider_bill'};

function connection(cluster,name,password,label) {
  return postgres({host:'127.0.0.1',port:cluster.port,database:'postgres',
    username:name,password,ssl:false,max:1,prepare:false,fetch_types:false,
    connect_timeout:3,idle_timeout:0,max_lifetime:0,backoff:false,onnotice(){},
    connection:{application_name:`complete-result-facts-v366-${label}`}});
}
async function denied(work,code='42501') {
  await assert.rejects(work,error=>{
    assert.equal((error?.cause??error)?.code,code,String(error));return true;
  });
}

test('v366 appends role-separated result facts to a v365 send start',
  {timeout:300_000,skip:!process.env.GATEWAY_NATIVE_PG_BIN},async()=>{
    const cluster=await startNativePostgres();
    const report={status:'RUNNING',cleanup:'PENDING',binaryVersion:cluster.binaryVersion,
      sourceSha256:{},stages:[],limitations:[
        'Review-only PG73 proposal; no formal migration, deployed Worker, remote database or production credentials changed.',
        'The test installs actual v360-v366 proposals and writes facts through separate direct holder and provider-bill LOGINs, including v367 client calls with normal COMMIT and close ACK. It does not prove external actor identity, evidence provenance, physical fetch or lost-ACK behavior against a real database.',
        'A pre-start no-fetch report is an unverified holder observation. It does not fence the holder, prevent a later start, resolve the grant or allow another attempt.',
        'A holder provider_zero_charge_observation is not authenticated provider billing. A zero-amount bill fact is independently role-gated, but source event authenticity is still an adapter responsibility.',
        'The SQL bounds evidence keys, size and digest. It does not prove that a providerRequestRef, bill document hash, event ID or reported usage came from the provider.',
        'The provider-scoped event unique index rejects same-provider duplicates, including a concurrent cross-request duplicate through a uniqueness error; it does not reconcile a late bill or an event lacking a send-start record.',
        'No resolution, all-hold lease renewal/recovery fence, buyer settlement, economic outbox, retry unlock, late-bill adjustment, fleet cutover or D1/MySQL parity exists in this layer.',
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
      const bill=connection(cluster,roles.bill,passwords.bill,'bill');
      const cap=connection(cluster,roles.cap,passwords.cap,'cap');
      const verifier=connection(cluster,roles.verifier,passwords.verifier,'verifier');
      const complete=connection(cluster,roles.complete,passwords.complete,'complete');
      clients.push(migrator,runtime,admission,granter,granterPeer,holder,holderPeer,bill,
        cap,verifier,complete);
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
      const attest=async(routeTargetId='v361-route')=>{
        const [route]=await migrator.unsafe(`SELECT provider_id,provider_model_name,
          custom_params,upstream_protocol,upstream_operation,adapter
          FROM ${g}.model_routes WHERE id=$1`,[routeTargetId]);
        const [provider]=await migrator.unsafe(`SELECT id,endpoints,api_key,
          shared_channel_type FROM ${g}.providers WHERE id=$1`,[route.provider_id]);
        const fingerprint=await computeRouteDataPolicySubjectFingerprintFromRows(route,provider);
        await migrator.unsafe(`UPDATE ${g}.model_endpoint_routes
          SET subject_fingerprint=$1 WHERE route_target_id=$2`,
          [fingerprint,routeTargetId]);
        const [generation]=await verifier.unsafe(`SELECT generation::text AS generation
          FROM ${g}.route_source_generations_v359 WHERE route_target_id=$1`,
          [routeTargetId]);
        const [row]=await verifier.unsafe(`SELECT ${g}.attest_text_route_source_v359(
          $1,$2,$3) AS value`,[routeTargetId,generation.generation,fingerprint]);
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
      const factSql=await readFile(proposal('complete-text-result-facts-v366.sql'),'utf8');
      report.sourceSha256['complete-text-result-facts-v366.sql']=sha(factSql);
      report.sourceSha256['postgres-complete-text-result-facts-v367.ts']=sha(
        await readFile(new URL('../../../packages/proxy/src/services/postgres-complete-text-result-facts-v367.ts',import.meta.url)));
      await assert.rejects(migrator.begin(tx=>tx.unsafe(factSql).simple()),
        /activation or dependency differs/u);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`GRANT SELECT ON ${g}.complete_text_send_starts_v365
          TO ${roles.bill}`);
        await tx.unsafe(`SET LOCAL cinatoken.complete_text_result_facts_activation='reviewed-v1'`);
        await tx.unsafe(factSql).simple();
      }),/activation or dependency differs/u);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`GRANT USAGE ON SCHEMA cinatoken_economic_outbox
          TO ${roles.holder}`);
        await tx.unsafe(`SET LOCAL cinatoken.complete_text_result_facts_activation='reviewed-v1'`);
        await tx.unsafe(factSql).simple();
      }),/activation or dependency differs/u);
      await migrator.begin(async tx=>{
        await tx.unsafe(`SET LOCAL cinatoken.complete_text_result_facts_activation='reviewed-v1'`);
        await tx.unsafe(factSql).simple();
      });
      stage('v366-default-off-and-bill-role-drift-fail-before-atomic-install');

      const [acl366]=await migrator.unsafe(`SELECT
        pg_catalog.has_function_privilege('${roles.holder}',
          '${g}.append_complete_text_holder_fact_v366(uuid,uuid,bigint,uuid,text,jsonb,text)',
          'EXECUTE') AS holder_call,
        pg_catalog.has_function_privilege('${roles.bill}',
          '${g}.append_complete_text_provider_bill_v366(uuid,uuid,jsonb,text)',
          'EXECUTE') AS bill_call,
        pg_catalog.has_function_privilege('${roles.holder}',
          '${g}.append_complete_text_provider_bill_v366(uuid,uuid,jsonb,text)',
          'EXECUTE') AS holder_bill_call,
        pg_catalog.has_function_privilege('${roles.bill}',
          '${g}.append_complete_text_holder_fact_v366(uuid,uuid,bigint,uuid,text,jsonb,text)',
          'EXECUTE') AS bill_holder_call,
        pg_catalog.has_table_privilege('${roles.holder}',
          '${g}.complete_text_result_facts_v366','SELECT,INSERT,UPDATE,DELETE')
          AS holder_table,
        pg_catalog.has_table_privilege('${roles.bill}',
          '${g}.complete_text_result_facts_v366','SELECT,INSERT,UPDATE,DELETE')
          AS bill_table`);
      assert.deepEqual(acl366,{holder_call:true,bill_call:true,
        holder_bill_call:false,bill_holder_call:false,
        holder_table:false,bill_table:false});
      await denied(holder.unsafe(`SELECT * FROM ${g}.complete_text_result_facts_v366`));
      await denied(bill.unsafe(`SELECT * FROM ${g}.complete_text_result_facts_v366`));
      await denied(holder.unsafe(`INSERT INTO ${g}.complete_text_result_facts_v366
        (fact_id) VALUES (pg_catalog.gen_random_uuid())`));
      await denied(bill.unsafe(`INSERT INTO ${g}.complete_text_result_facts_v366
        (fact_id) VALUES (pg_catalog.gen_random_uuid())`));
      stage('direct-holder-and-independent-bill-login-have-disjoint-functions-and-no-table-access',
        {acl366});

      const digest=async(evidence)=>{
        const [row]=await migrator.unsafe(`SELECT pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to($1::jsonb::text,'UTF8')),
          'hex') AS value`,[migrator.json(evidence)]);
        return row.value;
      };
      const holderFact=async(grantId,runId,epoch,nonce,kind,evidence,
        client=holder,digestOverride)=>{
        const [row]=await client.unsafe(`SELECT
          ${g}.append_complete_text_holder_fact_v366(
            $1::uuid,$2::uuid,$3::bigint,$4::uuid,$5,$6::jsonb,$7) AS value`,
          [grantId,runId,epoch,nonce,kind,client.json(evidence),
            digestOverride??await digest(evidence)]);
        return row.value;
      };
      const billFact=async(grantId,nonce,evidence,client=bill,
        digestOverride)=>{
        const [row]=await client.unsafe(`SELECT
          ${g}.append_complete_text_provider_bill_v366(
            $1::uuid,$2::uuid,$3::jsonb,$4) AS value`,
          [grantId,nonce,client.json(evidence),
            digestOverride??await digest(evidence)]);
        return row.value;
      };
      const count=async(table,grantId)=>{
        assert.ok(['complete_text_result_facts_v366',
          'complete_text_result_fact_conflicts_v366'].includes(table));
        const [row]=await migrator.unsafe(`SELECT count(*)::integer AS n
          FROM ${g}.${table} WHERE grant_id=$1::uuid`,[grantId]);
        return row.n;
      };

      const first=await issueGranted();
      const run=randomUUID(), upload=first.grantClaim.outboundBodySha256;
      assert.equal((await custody(first.result.grantId,run)).status,
        'custody_claim_recorded');
      const invoked={observation:'fetch_invoked',uploadSha256:upload};
      const preBill={providerRequestRef:'p-1',providerEventId:'evt-1',
        currency:'USD',amountMicros:120,billDocumentSha256:sha('bill-1')};
      assert.equal((await holderFact(first.result.grantId,run,1,randomUUID(),
        'fetch_invoked',invoked)).status,'send_start_required');
      assert.equal((await billFact(first.result.grantId,randomUUID(),preBill)).status,
        'send_start_required');
      assert.equal((await holderFact(first.result.grantId,randomUUID(),1,
        randomUUID(),'no_fetch_attestation',
        {observation:'fetch_not_called'})).status,'holder_run_conflict');
      assert.equal((await holderFact(first.result.grantId,run,2,randomUUID(),
        'no_fetch_attestation',
        {observation:'fetch_not_called'})).status,'holder_run_conflict');
      assert.equal(await count('complete_text_result_facts_v366',
        first.result.grantId),0);
      stage('wrong-holder-run-epoch-and-missing-start-cannot-record-sent-or-billed-fact');

      const noFetchNonce=randomUUID();
      const noFetch={observation:'fetch_not_called'};
      const noFetchResult=await holderFact(first.result.grantId,run,1,
        noFetchNonce,'no_fetch_attestation',noFetch);
      assert.equal(noFetchResult.status,'fact_recorded');
      assert.equal((await holderFact(first.result.grantId,run,1,
        noFetchNonce,'no_fetch_attestation',noFetch)).status,'already_recorded');
      const [beforeStart]=await migrator.unsafe(`SELECT obligation_state
        FROM ${g}.complete_text_attempt_grants_v362
        WHERE grant_id=$1::uuid`,[first.result.grantId]);
      assert.equal(beforeStart.obligation_state,'unknown');
      assert.equal((await start(first.result.grantId,run,1,upload)).status,
        'start_recorded');
      stage('pre-start-no-fetch-is-only-an-observation-and-does-not-unlock-or-close-grant');

      const clientHolderUrl=`postgres://${roles.holder}:${passwords.holder}`
        +`@127.0.0.1:${cluster.port}/postgres?sslmode=disable`;
      const clientBillUrl=`postgres://${roles.bill}:${passwords.bill}`
        +`@127.0.0.1:${cluster.port}/postgres?sslmode=disable`;
      const clientHolderNonce=randomUUID(),clientBillNonce=randomUUID();
      const clientHolder=await appendPostgresCompleteTextHolderFactV367({
        holderConnectionString:clientHolderUrl,grantId:first.result.grantId,
        holderRunId:run,expectedEpoch:1,evidenceNonce:clientHolderNonce,
        evidence:{kind:'fetch_invoked',observation:'fetch_invoked',
          uploadSha256:upload},
      });
      const clientBill=await appendPostgresCompleteTextProviderBillFactV367({
        billConnectionString:clientBillUrl,grantId:first.result.grantId,
        evidenceNonce:clientBillNonce,evidence:{providerRequestRef:'p-client',
          providerEventId:'evt-client-v367',currency:'USD',
          amountMicros:'999999999999999999',billDocumentSha256:sha('client-bill')},
      });
      assert.equal(clientHolder.commitAcknowledged,true);
      assert.equal(clientHolder.status,'fact_recorded');
      assert.equal(clientBill.commitAcknowledged,true);
      assert.equal(clientBill.status,'fact_recorded');
      const [clientRows]=await migrator.unsafe(`SELECT
        count(*)::integer AS n,
        count(*) FILTER (WHERE f.send_start_id=s.send_start_id
          AND f.holder_run_id=$2::uuid AND f.lease_epoch=1
          AND f.request_id=g.request_id AND f.quote_id=g.quote_id
          AND f.grant_id=g.grant_id)::integer AS bound_n,
        max(f.evidence->>'amountMicros') FILTER
          (WHERE f.kind='provider_bill') AS bill_amount
        FROM ${g}.complete_text_result_facts_v366 f
        JOIN ${g}.complete_text_attempt_grants_v362 g USING(grant_id)
        JOIN ${g}.complete_text_send_starts_v365 s USING(grant_id)
        WHERE f.fact_id IN ($1::uuid,$3::uuid)`,
        [clientHolder.factId,run,clientBill.factId]);
      assert.deepEqual(clientRows,{n:2,bound_n:2,
        bill_amount:'999999999999999999'});
      const clientBillReplay=await appendPostgresCompleteTextProviderBillFactV367({
        billConnectionString:clientBillUrl,grantId:first.result.grantId,
        evidenceNonce:clientBillNonce,evidence:{providerRequestRef:'p-client',
          providerEventId:'evt-client-v367',currency:'USD',
          amountMicros:'999999999999999999',billDocumentSha256:sha('client-bill')},
      });
      assert.equal(clientBillReplay.status,'already_recorded');
      assert.equal(clientBillReplay.factId,clientBill.factId);
      stage('v367-direct-clients-write-bound-holder-and-full-precision-bill-facts-after-commit-and-close',
        {clientRows});

      await denied(()=>holderFact(first.result.grantId,run,1,randomUUID(),
        'fetch_invoked',invoked,bill));
      await denied(()=>billFact(first.result.grantId,randomUUID(),preBill,holder));
      await denied(()=>holderFact(first.result.grantId,run,1,randomUUID(),
        'fetch_invoked',invoked,runtime));
      await denied(()=>holderFact(first.result.grantId,run,1,randomUUID(),
        'provider_bill',preBill,holder),'23514');
      await denied(()=>holderFact(first.result.grantId,run,1,randomUUID(),
        'fetch_invoked',invoked,holder,sha('wrong')),'23514');
      await denied(()=>holderFact(first.result.grantId,run,1,randomUUID(),
        'fetch_invoked',{...invoked,authorization:'secret'},holder),'23514');
      await denied(()=>billFact(first.result.grantId,randomUUID(),
        {...preBill,providerRequestRef:'p'.repeat(129)},bill),'23514');
      await denied(()=>billFact(first.result.grantId,randomUUID(),
        {...preBill,amountMicros:'120'},bill),'23514');
      assert.equal((await holderFact(first.result.grantId,run,1,randomUUID(),
        'fetch_invoked',{observation:'fetch_invoked',
          uploadSha256:sha('wrong')})).status,'grant_upload_differs');
      stage('role-shape-digest-and-frozen-upload-negative-cases-reject');

      const nonce=randomUUID();
      const recorded=await holderFact(first.result.grantId,run,1,nonce,
        'fetch_invoked',invoked);
      assert.equal(recorded.status,'fact_recorded');
      assert.equal((await holderFact(first.result.grantId,run,1,nonce,
        'fetch_invoked',invoked)).status,'already_recorded');
      assert.equal((await holderFact(first.result.grantId,run,1,nonce,
        'transport_unknown',{observation:'transport_unknown',phase:'headers'}))
        .status,'evidence_nonce_conflict');
      assert.equal(await count('complete_text_result_fact_conflicts_v366',
        first.result.grantId),1);
      assert.equal((await holderFact(first.result.grantId,run,1,nonce,
        'transport_unknown',{observation:'transport_unknown',phase:'headers'}))
        .status,'evidence_nonce_conflict');
      assert.equal(await count('complete_text_result_fact_conflicts_v366',
        first.result.grantId),1);
      stage('same-nonce-replay-is-idempotent-and-conflicting-nonce-is-audited-once');

      const billNonce=randomUUID();
      const billRecorded=await billFact(first.result.grantId,billNonce,preBill);
      assert.equal(billRecorded.status,'fact_recorded');
      assert.equal((await billFact(first.result.grantId,billNonce,preBill)).status,
        'already_recorded');
      const zeroObservation={providerRequestRef:'p-1',reportedChargeMicros:0,
        signalSha256:sha('local-zero-signal')};
      assert.equal((await holderFact(first.result.grantId,run,1,randomUUID(),
        'provider_zero_charge_observation',zeroObservation)).status,'fact_recorded');
      const [stored]=await migrator.unsafe(`SELECT f.source_kind,f.kind,
        f.request_id,f.quote_id,f.holder_run_id,f.lease_epoch,
        f.send_start_id,f.evidence_sha256,f.grant_claim_sha256,
        f.final_body_sha256,f.route_target_id,f.provider_id,f.endpoint_id,
        f.credential_class,f.credential_id,f.provider_ciphertext_sha256,
        f.credential_fingerprint_sha256,f.outbound_body_sha256,
        f.upstream_url_sha256,f.received_at,
        g.obligation_state,g.claim_sha256 AS grant_claim,
        s.send_start_id AS original_start
        FROM ${g}.complete_text_result_facts_v366 f
        JOIN ${g}.complete_text_attempt_grants_v362 g USING(grant_id)
        JOIN ${g}.complete_text_send_starts_v365 s USING(grant_id)
        WHERE f.fact_id=$1::uuid`,[billRecorded.factId]);
      assert.equal(stored.source_kind,'provider_bill');
      assert.equal(stored.kind,'provider_bill');
      assert.equal(stored.holder_run_id,run);
      assert.equal(Number(stored.lease_epoch),1);
      assert.equal(stored.send_start_id,stored.original_start);
      assert.equal(stored.grant_claim_sha256,stored.grant_claim);
      assert.equal(stored.final_body_sha256,first.grantClaim.finalBodySha256);
      assert.equal(stored.route_target_id,first.grantClaim.routeTargetId);
      assert.equal(stored.provider_id,first.grantClaim.providerId);
      assert.equal(stored.endpoint_id,first.grantClaim.endpointId);
      assert.equal(stored.credential_id,first.grantClaim.credentialId);
      assert.equal(stored.provider_ciphertext_sha256,
        first.grantClaim.providerCiphertextSha256);
      assert.equal(stored.outbound_body_sha256,upload);
      assert.equal(stored.upstream_url_sha256,first.grantClaim.upstreamUrlSha256);
      assert.equal(stored.obligation_state,'unknown');
      assert.ok(Date.parse(stored.received_at) <= Date.now());
      assert.ok(Date.parse(stored.received_at) >=
        Date.parse(first.result.expiresAt)-60_000);
      stage('independent-bill-fact-copies-frozen-grant-and-start-identity-without-settling');

      const rolled=await issueGranted();
      const rolledRun=randomUUID();
      await custody(rolled.result.grantId,rolledRun);
      await start(rolled.result.grantId,rolledRun,1,
        rolled.grantClaim.outboundBodySha256);
      const rolledNonce=randomUUID();
      await assert.rejects(holder.begin(async tx=>{
        assert.equal((await holderFact(rolled.result.grantId,rolledRun,1,
          rolledNonce,'transport_unknown',
          {observation:'transport_unknown',phase:'body'},tx)).status,
          'fact_recorded');
        throw new Error('force fact rollback');
      }),/force fact rollback/u);
      assert.equal(await count('complete_text_result_facts_v366',
        rolled.result.grantId),0);
      assert.equal((await holderFact(rolled.result.grantId,rolledRun,1,
        rolledNonce,'transport_unknown',
        {observation:'transport_unknown',phase:'body'})).status,'fact_recorded');
      assert.equal((await billFact(rolled.result.grantId,randomUUID(),
        {...preBill,providerRequestRef:'p-2'})).status,'provider_event_conflict');
      stage('uncommitted-result-rolls-back-and-same-provider-cross-grant-event-reuse-rejects');

      await migrator.unsafe(`INSERT INTO ${g}.providers(id,name,api_key,status)
          VALUES('v361-provider-b','V361 Provider B','enc:v2:fixture-b','active');
        INSERT INTO ${g}.model_routes
          (id,model_id,provider_id,provider_model_name,route_pool_id,
            upstream_protocol,upstream_operation,adapter,status)
          VALUES('v361-route-b','v361-model','v361-provider-b',
            'upstream-v361-b','v361-pool','openai','chat','passthrough','active');
        INSERT INTO ${g}.model_endpoints
          (id,model_id,provider_id,provider_slug,tag,context_length,pricing,
            evidence_url,verified_by,verified_at,expires_at,status)
          VALUES('v361-endpoint-b','v361-model','v361-provider-b',
            'v361-provider-b','default',1000,
            '{"currency":"USD","prompt":"0.000010","completion":"0.000020"}',
            'https://example.invalid/v361-b','fixture',
            now()-interval '1 minute',now()+interval '5 minutes','verified');
        INSERT INTO ${g}.model_endpoint_routes(endpoint_id,route_target_id)
          VALUES('v361-endpoint-b','v361-route-b');`).simple();
      await attest('v361-route-b');
      await migrator.unsafe(`UPDATE ${g}.model_routes
        SET status='inactive' WHERE id='v361-route'`);
      const otherProvider=await issueGranted();
      assert.equal(otherProvider.grantClaim.providerId,'v361-provider-b');
      const otherRun=randomUUID();
      await custody(otherProvider.result.grantId,otherRun);
      await start(otherProvider.result.grantId,otherRun,1,
        otherProvider.grantClaim.outboundBodySha256);
      assert.equal((await billFact(otherProvider.result.grantId,randomUUID(),
        {...preBill,providerRequestRef:'p-b'})).status,'fact_recorded');
      const [scopedEvents]=await migrator.unsafe(`SELECT
        count(*)::integer AS n,count(DISTINCT provider_id)::integer AS providers
        FROM ${g}.complete_text_result_facts_v366
        WHERE kind='provider_bill' AND provider_event_id='evt-1'`);
      assert.deepEqual(scopedEvents,{n:2,providers:2});
      stage('same-event-id-from-two-frozen-providers-is-accepted-once-per-provider',
        {scopedEvents});

      await denied(migrator.unsafe(`UPDATE ${g}.complete_text_result_facts_v366
        SET kind='transport_unknown' WHERE fact_id=$1::uuid`,
        [recorded.factId]),'P0001');
      await denied(migrator.unsafe(`DELETE FROM ${g}.complete_text_result_facts_v366
        WHERE fact_id=$1::uuid`,[recorded.factId]),'P0001');
      await denied(migrator.unsafe(`DELETE FROM
        ${g}.complete_text_result_fact_conflicts_v366
        WHERE grant_id=$1::uuid`,[first.result.grantId]),'P0001');
      stage('fact-and-conflict-rows-are-append-only');
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
      process.stdout.write(`complete-text-result-facts-v366-report=${reportUrl.pathname}\n`);
    }
    if(failure) throw failure;
    assert.equal(report.cleanup,'PASS');
  });
