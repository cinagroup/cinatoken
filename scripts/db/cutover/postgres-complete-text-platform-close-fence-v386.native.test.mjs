// Owned PostgreSQL 18.6 proof for the review-only platform close fence seam.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
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
const reportUrl=new URL('../../../docs/developers/architecture/implementation-evidence/C04-complete-text-platform-close-fence-v386-report.json',import.meta.url);
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
  recovery:'cinatoken_gateway_budget_recovery'};

function connection(cluster,name,password,label) {
  return postgres({host:'127.0.0.1',port:cluster.port,database:'postgres',
    username:name,password,ssl:false,max:1,prepare:false,fetch_types:false,
    connect_timeout:3,idle_timeout:0,max_lifetime:0,backoff:false,onnotice(){},
    connection:{application_name:`complete-text-close-fence-v386-${label}`}});
}
async function denied(work,code='42501',constraint) {
  await assert.rejects(work,error=>{
    const cause=error?.cause??error;
    assert.equal(cause?.code,code,String(error));
    if(constraint) assert.equal(cause?.constraint_name,constraint,String(error));
    return true;
  });
}

test('v386 platform close fence blocks later egress while preserving unknown holds',
  {timeout:300_000,skip:!process.env.GATEWAY_NATIVE_PG_BIN},async()=>{
    const cluster=await startNativePostgres();
    const report={status:'RUNNING',cleanup:'PENDING',binaryVersion:cluster.binaryVersion,
      sourceSha256:{},stages:[],limitations:[
      'Review-only local PG73 and proposals; no formal migration, deployed Worker, remote database, production credential or Provider changed.',
      'v386 is an egress closure fence, not a buyer terminal, bill decision, hold release, request log or typed economic event.',
      'Only the migrator inserts synthetic fences here. No runtime role can do so; the future platform closer and provider-source authentication are absent.',
      'The fixture shortens immutable grant deadlines and custody leases with owned cluster-superuser fault injection solely to exercise timing. Runtime roles do not receive this power.',
      'A bill appended after a fence is a protocol-shaped candidate, not proof of provider authorship, completeness, zero cost or buyer debit.',
      'The fixture does not install the v372/v376/v380 legacy buyer branch; separate native reports cover that branch.',
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
      const bill=connection(cluster,roles.bill,passwords.bill,'bill');
      const cap=connection(cluster,roles.cap,passwords.cap,'cap');
      const verifier=connection(cluster,roles.verifier,passwords.verifier,'verifier');
      const complete=connection(cluster,roles.complete,passwords.complete,'complete');
      clients.push(migrator,runtime,admission,recovery,buyer,renewer,
        granter,granterPeer,holder,holderPeer,
        cap,verifier,complete,resolver,resolverPeer,bill);
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
          [`complete-text-close-fence-v386-${label}`]);
          if(row.n===1)return;
          await new Promise(done=>setTimeout(done,20));
        }
        throw new Error(`expected advisory lock wait for ${label}`);
      };

      const fenceSql=await readFile(proposal(
        'complete-text-platform-close-fence-v386.sql'),'utf8');
      report.sourceSha256['complete-text-platform-close-fence-v386.sql']=sha(fenceSql);
      await assert.rejects(migrator.begin(tx=>tx.unsafe(fenceSql).simple()),
        /activation or dependency differs/u);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`SET LOCAL
          cinatoken.complete_text_platform_close_fence_v386_activation='reviewed-v1'`);
        await tx.unsafe(fenceSql).simple();
        throw new Error('rollback-v386-install');
      }),/rollback-v386-install/u);
      const [beforeFenceInstall]=await migrator.unsafe(`SELECT
        pg_catalog.to_regclass(
          '${g}.complete_text_platform_close_fences_v386') IS NULL AS absent`);
      assert.equal(beforeFenceInstall.absent,true);
      await migrator.begin(async tx=>{
        await tx.unsafe(`SET LOCAL
          cinatoken.complete_text_platform_close_fence_v386_activation='reviewed-v1'`);
        await tx.unsafe(fenceSql).simple();
      });
      const [fenceInstalled]=await migrator.unsafe(`SELECT
        count(*)::integer AS triggers FROM pg_catalog.pg_trigger
        WHERE NOT tgisinternal AND tgenabled='O'
          AND tgfoid='${g}.reject_complete_text_platform_close_fence_v386()'
            ::pg_catalog.regprocedure`);
      assert.equal(fenceInstalled.triggers,7);
      stage('v386-default-off-rollback-and-seven-atomic-fence-triggers');

      for(const [name,client] of [['runtime',runtime],['admission',admission],
        ['buyer',buyer],['granter',granter],['holder',holder],
        ['renewer',renewer],['bill',bill],['resolver',resolver]]){
        await denied(client.unsafe(`SELECT * FROM
          ${g}.complete_text_platform_close_fences_v386`));
        await denied(client.unsafe(`INSERT INTO
          ${g}.complete_text_platform_close_fences_v386
          (fence_id,request_id,grant_id,quote_id,grant_claim_sha256,
            fence_nonce,decision_digest_sha256,recorded_at,writer_xid)
          VALUES(pg_catalog.gen_random_uuid(),'fake',pg_catalog.gen_random_uuid(),
            pg_catalog.gen_random_uuid(),repeat('a',64),
            pg_catalog.gen_random_uuid(),repeat('b',64),now(),
            pg_catalog.pg_current_xact_id())`));
        const [acl]=await migrator.unsafe(`SELECT
          pg_catalog.has_table_privilege($1,
            '${g}.complete_text_platform_close_fences_v386',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS raw`,[roles[name]]);
        assert.equal(acl.raw,false);
      }
      stage('distinct-runtime-logins-have-no-close-fence-table-access');

      const migratorPeer=connection(cluster,roles.migrator,
        passwords.migrator,'migrator-peer');
      const renewerPeer=connection(cluster,roles.renewer,
        passwords.renewer,'renewer-peer');
      clients.push(migratorPeer,renewerPeer);
      const insertFence=async(grant,client=migrator,nonce=randomUUID())=>{
        const [row]=await client.unsafe(`INSERT INTO
          ${g}.complete_text_platform_close_fences_v386
          (fence_id,request_id,grant_id,quote_id,grant_claim_sha256,
            fence_nonce,decision_digest_sha256,recorded_at,writer_xid)
          VALUES($1::uuid,$2,$3::uuid,$4::uuid,$5,
            $6::uuid,$7,pg_catalog.clock_timestamp(),
            pg_catalog.pg_current_xact_id())
          RETURNING request_id,grant_id,quote_id,
            writer_xid::text AS writer_xid`,
        [randomUUID(),grant.quote.requestId,grant.result.grantId,
          grant.quote.quoteId,grant.result.claimSha256??sha(
            JSON.stringify(grant.grantClaim)),nonce,sha('synthetic-closure-decision')]);
        return row;
      };
      // The grant receipt omits its frozen claim digest; read that immutable
      // value instead of trusting a reconstruction of JSON canonicalization.
      const frozenClaim=async grantId=>{
        const [row]=await migrator.unsafe(`SELECT claim_sha256 FROM
          ${g}.complete_text_attempt_grants_v362 WHERE grant_id=$1::uuid`,
        [grantId]);
        return row.claim_sha256;
      };
      const fence=async(grant,client=migrator,nonce=randomUUID())=>{
        const frozen={...grant,result:{...grant.result,
          claimSha256:await frozenClaim(grant.result.grantId)}};
        return insertFence(frozen,client,nonce);
      };
      const count=async(table,requestId)=>{
        assert.ok(['complete_text_platform_close_fences_v386',
          'api_key_request_logs','complete_text_result_facts_v366'].includes(table));
        const [row]=await migrator.unsafe(`SELECT count(*)::integer AS n FROM
          ${g}.${table} WHERE ${table==='api_key_request_logs'?'id':'request_id'}=$1`,
        [requestId]);
        return row.n;
      };
      const digest=async evidence=>{
        const [row]=await migrator.unsafe(`SELECT pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to($1::jsonb::text,'UTF8')),
          'hex') AS value`,[migrator.json(evidence)]);
        return row.value;
      };
      const shortenCustody=async grantId=>cluster.admin.begin(async tx=>{
        await tx.unsafe(`SET LOCAL session_replication_role='replica'`);
        await tx.unsafe(`UPDATE ${g}.complete_text_send_custody_v365
          SET lease_until=GREATEST(claimed_at+INTERVAL '1 second',
            pg_catalog.clock_timestamp()+INTERVAL '2 seconds')
          WHERE grant_id=$1::uuid`,[grantId]);
      });
      const shortenRenewal=async grantId=>cluster.admin.begin(async tx=>{
        await tx.unsafe(`SET LOCAL session_replication_role='replica'`);
        await tx.unsafe(`UPDATE ${g}.complete_text_hold_renewals_v367 r
          SET prior_lease_until=c.lease_until,
            lease_until=GREATEST(c.lease_until+INTERVAL '1 second',
              pg_catalog.clock_timestamp()+INTERVAL '2 seconds')
          FROM ${g}.complete_text_send_custody_v365 c
          WHERE r.grant_id=$1::uuid AND c.grant_id=r.grant_id`,
        [grantId]);
      });
      const waitPastFenceLease=async grantId=>{
        for(let attempt=0;attempt<25;attempt++){
          const [row]=await migrator.unsafe(`SELECT
            GREATEST(g.send_expires_at,c.lease_until,
              (SELECT max(r.lease_until) FROM
                ${g}.complete_text_hold_renewals_v367 r
                WHERE r.grant_id=g.grant_id))
              <pg_catalog.clock_timestamp() AS past,
            GREATEST(0,CEIL(EXTRACT(EPOCH FROM
              (GREATEST(g.send_expires_at,c.lease_until,
                (SELECT max(r.lease_until) FROM
                  ${g}.complete_text_hold_renewals_v367 r
                  WHERE r.grant_id=g.grant_id))-
                  pg_catalog.clock_timestamp()))*1000))::integer
              AS milliseconds
            FROM ${g}.complete_text_attempt_grants_v362 g
            LEFT JOIN ${g}.complete_text_send_custody_v365 c
              USING(grant_id) WHERE g.grant_id=$1::uuid`,[grantId]);
          if(row?.past)return;
          await new Promise(done=>setTimeout(done,
            Math.max(100,Math.min(1000,Number(row.milliseconds)+100))));
        }
        throw new Error('grant/custody/renewal lease did not pass');
      };

      const unsent=await issueGranted();
      const unsentHolds=await holdSnapshot(unsent.quote.requestId);
      const unsentCounters=await counterSnapshot();
      await denied(()=>fence(unsent),'23514',
        'complete_text_close_fence_live_v386');
      await shorten(unsent.result.grantId,2);
      await waitPastDeadline(unsent.result.grantId);
      const resolution=await resolveNoFetch(unsent.result.grantId,randomUUID());
      assert.equal(resolution.status,'verified_no_fetch_recorded');
      const unsentFence=await fence(unsent);
      assert.equal(unsentFence.request_id,unsent.quote.requestId);
      assert.equal(await holdSnapshot(unsent.quote.requestId),unsentHolds);
      assert.equal(await counterSnapshot(),unsentCounters);
      assert.equal(await count('api_key_request_logs',unsent.quote.requestId),0);
      const [unsentState]=await migrator.unsafe(`SELECT obligation_state FROM
        ${g}.complete_text_attempt_grants_v362 WHERE grant_id=$1::uuid`,
      [unsent.result.grantId]);
      assert.equal(unsentState.obligation_state,'unknown');
      stage('expired-no-fetch-egress-fence-keeps-unknown-grant-and-four-holds');

      await denied(migrator.unsafe(`INSERT INTO
        ${g}.complete_text_send_custody_v365
        (grant_id,request_id,holder_run_id,lease_epoch,mode,claimed_at,lease_until)
        VALUES($1::uuid,$2,$3::uuid,1,'active',
          now(),now()+INTERVAL '1 minute')`,
      [unsent.result.grantId,unsent.quote.requestId,randomUUID()]),
      '23514','complete_text_egress_fenced_v386');
      await denied(migrator.unsafe(`INSERT INTO
        ${g}.complete_text_attempt_grants_v362
        SELECT (pg_catalog.jsonb_populate_record(NULL::
          ${g}.complete_text_attempt_grants_v362,
          pg_catalog.to_jsonb(t)||pg_catalog.jsonb_build_object(
            'grant_id',$2::uuid,'attempt_nonce',$3::uuid,
            'attempt_number',2))).*
        FROM ${g}.complete_text_attempt_grants_v362 t
        WHERE t.grant_id=$1::uuid`,
      [unsent.result.grantId,randomUUID(),randomUUID()]),
      '23514','complete_text_egress_fenced_v386');
      stage('fenced-request-cannot-gain-new-grant-or-custody');

      const prestart=await issueGranted();
      const prestartRun=randomUUID();
      assert.equal((await custody(prestart.result.grantId,prestartRun)).status,
        'custody_claim_recorded');
      const prestartHolds=await holdSnapshot(prestart.quote.requestId);
      await shorten(prestart.result.grantId,2);
      await shortenCustody(prestart.result.grantId);
      await waitPastFenceLease(prestart.result.grantId);
      await fence(prestart);
      await denied(migrator.unsafe(`INSERT INTO
        ${g}.complete_text_send_starts_v365
        (send_start_id,grant_id,request_id,holder_run_id,lease_epoch,
          outbound_body_sha256,recorded_at,send_expires_at)
        VALUES($1::uuid,$2::uuid,$3,$4::uuid,1,$5,
          pg_catalog.clock_timestamp(),
          pg_catalog.clock_timestamp()+INTERVAL '1 minute')`,
      [randomUUID(),prestart.result.grantId,prestart.quote.requestId,
        prestartRun,prestart.grantClaim.outboundBodySha256]),
      '23514','complete_text_egress_fenced_v386');
      assert.equal(await holdSnapshot(prestart.quote.requestId),prestartHolds);
      stage('prestart-fence-independently-rejects-late-direct-start');

      const raced=await issueGranted();
      const racedRun=randomUUID();
      assert.equal((await custody(raced.result.grantId,racedRun)).status,
        'custody_claim_recorded');
      await shorten(raced.result.grantId,3);
      let startEntered;
      const entered=new Promise(resolve=>{startEntered=resolve;});
      let releaseStart;
      const gate=new Promise(resolve=>{releaseStart=resolve;});
      const startTx=holderPeer.begin(async tx=>{
        const [row]=await tx.unsafe(`SELECT
          ${g}.record_complete_text_send_start_v365(
            $1::uuid,$2::uuid,1,$3) AS value`,
        [raced.result.grantId,racedRun,
          raced.grantClaim.outboundBodySha256]);
        assert.equal(row.value.status,'start_recorded');
        startEntered();
        await gate;
      });
      await entered;
      await waitPastDeadline(raced.result.grantId);
      const fencePending=fence(raced,migratorPeer).then(
        value=>({value}),error=>({error}));
      try {
        await waitForAdvisory('migrator-peer');
      } finally {
        releaseStart();
      }
      await startTx;
      const pendingResult=await fencePending;
      assert.equal(pendingResult.error?.code,'23514');
      assert.equal(pendingResult.error?.constraint_name,
        'complete_text_close_fence_live_v386');
      assert.equal(await count('complete_text_platform_close_fences_v386',
        raced.quote.requestId),0);
      stage('in-flight-start-commits-before-fence-and-live-lease-wins');

      const renewing=await issueGranted();
      const renewingRun=randomUUID();
      assert.equal((await custody(renewing.result.grantId,renewingRun)).status,
        'custody_claim_recorded');
      const renewingStart=await start(renewing.result.grantId,
        renewingRun,1,renewing.grantClaim.outboundBodySha256);
      assert.equal(renewingStart.status,'start_recorded');
      await shorten(renewing.result.grantId,3);
      let renewalEntered;
      const renewalStarted=new Promise(resolve=>{renewalEntered=resolve;});
      let releaseRenewal;
      const renewalGate=new Promise(resolve=>{releaseRenewal=resolve;});
      const renewalTx=renewerPeer.begin(async tx=>{
        const [row]=await tx.unsafe(`SELECT
          ${g}.renew_complete_text_holds_v367(
            $1::uuid,$2::uuid,$3::uuid,1) AS value`,
        [renewing.result.grantId,renewingRun,
          renewingStart.sendStartId]);
        assert.equal(row.value.status,'renewal_recorded');
        renewalEntered();
        await renewalGate;
      });
      await renewalStarted;
      await waitPastDeadline(renewing.result.grantId);
      const renewalFencePending=fence(renewing,migratorPeer).then(
        value=>({value}),error=>({error}));
      try {
        await waitForAdvisory('migrator-peer');
      } finally {
        releaseRenewal();
      }
      await renewalTx;
      const renewalFenceResult=await renewalFencePending;
      assert.equal(renewalFenceResult.error?.code,'23514');
      assert.equal(renewalFenceResult.error?.constraint_name,
        'complete_text_close_fence_live_v386');
      assert.equal(await count('complete_text_platform_close_fences_v386',
        renewing.quote.requestId),0);
      stage('in-flight-all-hold-renewal-commits-before-fence-and-live-epoch-wins');

      const sent=await issueGranted();
      const sentRun=randomUUID();
      assert.equal((await custody(sent.result.grantId,sentRun)).status,
        'custody_claim_recorded');
      const sentStart=await start(sent.result.grantId,sentRun,1,
        sent.grantClaim.outboundBodySha256);
      assert.equal(sentStart.status,'start_recorded');
      const [sentRenewal]=await renewer.unsafe(`SELECT
        ${g}.renew_complete_text_holds_v367(
          $1::uuid,$2::uuid,$3::uuid,1) AS value`,
      [sent.result.grantId,sentRun,sentStart.sendStartId]);
      assert.equal(sentRenewal.value.status,'renewal_recorded');
      assert.equal(sentRenewal.value.leaseEpoch,2);
      stage('real-v367-renewal-commits-epoch-two-before-egress-fence');
      const sentHolds=await holdSnapshot(sent.quote.requestId);
      const sentCounters=await counterSnapshot();
      await denied(()=>fence(sent),'23514',
        'complete_text_close_fence_live_v386');
      await shorten(sent.result.grantId,2);
      await shortenCustody(sent.result.grantId);
      await shortenRenewal(sent.result.grantId);
      await waitPastFenceLease(sent.result.grantId);
      await fence(sent);
      const invoked={observation:'fetch_invoked',
        uploadSha256:sent.grantClaim.outboundBodySha256};
      const holderNonce=randomUUID();
      const [lateHolder]=await holder.unsafe(`SELECT
        ${g}.append_complete_text_holder_fact_v366(
          $1::uuid,$2::uuid,2,$3::uuid,'fetch_invoked',$4::jsonb,$5)
          AS value`,
      [sent.result.grantId,sentRun,holderNonce,holder.json(invoked),
        await digest(invoked)]);
      assert.equal(lateHolder.value.status,'fact_recorded');
      const [lateHolderEpoch]=await migrator.unsafe(`SELECT lease_epoch
        FROM ${g}.complete_text_result_facts_v366
        WHERE fact_id=$1::uuid`,[lateHolder.value.factId]);
      assert.equal(Number(lateHolderEpoch.lease_epoch),2);
      const billEvidence={providerRequestRef:'fixture-protocol-only',
        providerEventId:`fixture-event-${randomUUID()}`,currency:'USD',
        amountMicros:111,billDocumentSha256:sha('fixture-document-no-auth')};
      const billNonce=randomUUID();
      const billCall=()=>bill.unsafe(`SELECT
        ${g}.append_complete_text_provider_bill_v366(
          $1::uuid,$2::uuid,$3::jsonb,$4) AS value`,
      [sent.result.grantId,billNonce,bill.json(billEvidence),
        digestValue]);
      const digestValue=await digest(billEvidence);
      const [billResult]=await billCall();
      assert.equal(billResult.value.status,'fact_recorded');
      const [billReplay]=await billCall();
      assert.equal(billReplay.value.status,'already_recorded');
      await denied(migrator.unsafe(`INSERT INTO
        ${g}.complete_text_hold_renewals_v367
        (grant_id,lease_epoch,request_id,holder_run_id,send_start_id,
          prior_lease_until,lease_until,recorded_at,writer_xid)
        SELECT c.grant_id,2,c.request_id,c.holder_run_id,s.send_start_id,
          c.lease_until,c.lease_until+INTERVAL '1 minute',now(),
          pg_catalog.pg_current_xact_id()
        FROM ${g}.complete_text_send_custody_v365 c
        JOIN ${g}.complete_text_send_starts_v365 s
          USING(grant_id)
        WHERE c.grant_id=$1::uuid`,[sent.result.grantId]),
      '23514','complete_text_egress_fenced_v386');
      assert.equal(await holdSnapshot(sent.quote.requestId),sentHolds);
      assert.equal(await counterSnapshot(),sentCounters);
      assert.equal(await count('api_key_request_logs',sent.quote.requestId),0);
      assert.equal(await count('complete_text_result_facts_v366',
        sent.quote.requestId),2);
      const [sentState]=await migrator.unsafe(`SELECT obligation_state FROM
        ${g}.complete_text_attempt_grants_v362 WHERE grant_id=$1::uuid`,
      [sent.result.grantId]);
      assert.equal(sentState.obligation_state,'unknown');
      stage('fenced-sent-run-keeps-late-epoch-two-holder-and-bill-evidence-but-blocks-renewal-without-close');

      await denied(migrator.unsafe(`UPDATE
        ${g}.complete_text_platform_close_fences_v386
        SET state='egress_fenced' WHERE request_id=$1`,
      [sent.quote.requestId]),'23514',
      'complete_text_close_fence_append_v386');
      await denied(migrator.unsafe(`DELETE FROM
        ${g}.complete_text_platform_close_fences_v386
        WHERE request_id=$1`,[sent.quote.requestId]),'23514',
      'complete_text_close_fence_append_v386');
      stage('close-fence-is-append-only-and-not-a-financial-terminal');

      report.sourceSha256.fixture=sha(await readFile(new URL(import.meta.url)));
      report.status='PASS';
    } catch(error) {
      failure=error;report.status='FAIL';
      report.failedAfterStage=report.stages.at(-1)?.name??null;
      const cause=error?.cause??error;
      report.failure={code:cause?.code??null,
        constraint:cause?.constraint_name??null,
        message:String(error?.stack??error).slice(0,5000)};
    } finally {
      await Promise.allSettled(clients.map(c=>c.end({timeout:1})));
      try {await cluster.cleanup();report.cleanup='PASS';}
      catch(error) {report.cleanup='FAIL';report.cleanupError=String(error).slice(0,1500);
        failure??=error;}
      await writeFile(reportUrl,JSON.stringify(report,null,2)+'\n');
      process.stdout.write(`complete-text-platform-close-fence-v386-report=${reportUrl.pathname}\n`);
    }
    if(failure) throw failure;
    assert.equal(report.cleanup,'PASS');
  });

