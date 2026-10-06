// Owned PostgreSQL 18.6 proof of durable v362 text grant/unknown obligation.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { computeRouteDataPolicySubjectFingerprintFromRows } from '../../../packages/core/src/route-data-policy.ts';
import { grantPostgresCompleteTextAttemptV362 } from '../../../packages/proxy/src/services/postgres-complete-text-attempt-grant-v362.ts';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';
import { activatePostgresBuyerSplitV348 } from './activate-postgres-buyer-split-v348.ts';
import { grantPostgresBuyerSplitV348 } from './grant-postgres-buyer-split-v348.ts';
import { activatePostgresBuyerGuardrailSplitV349 } from './activate-postgres-buyer-guardrail-split-v349.ts';
import { grantPostgresBuyerGuardrailSplitV349 } from './grant-postgres-buyer-guardrail-split-v349.ts';

const g='cinatoken_gateway';
const migrationDir=new URL('../../../packages/core/migrations-postgres/',import.meta.url);
const proposal=name=>new URL(`../../../packages/core/migrations-proposals/postgres/${name}`,import.meta.url);
const reportUrl=new URL('../../../docs/developers/architecture/implementation-evidence/C04-complete-text-attempt-grant-v362-report.json',import.meta.url);
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
  granter:'cinatoken_gateway_complete_text_attempt_granter'};

function connection(cluster,name,password,label) {
  return postgres({host:'127.0.0.1',port:cluster.port,database:'postgres',
    username:name,password,ssl:false,max:1,prepare:false,fetch_types:false,
    connect_timeout:3,idle_timeout:0,max_lifetime:0,backoff:false,onnotice(){},
    connection:{application_name:`complete-grant-v362-${label}`}});
}
async function denied(work,code='42501') {
  await assert.rejects(work,error=>{
    assert.equal((error?.cause??error)?.code,code,String(error));return true;
  });
}

test('v362 grant durably binds manifest, holds and unknown obligation',
  {timeout:300_000,skip:!process.env.GATEWAY_NATIVE_PG_BIN},async()=>{
    const cluster=await startNativePostgres();
    const report={status:'RUNNING',cleanup:'PENDING',binaryVersion:cluster.binaryVersion,
      sourceSha256:{},stages:[],limitations:[
        'Review-only PG73 proposal; no formal migration, deployed Worker, remote database or production credentials changed.',
        'v361 revokes amount-taking reserve calls; v362 also revokes direct dispatch-mark calls from admission LOGIN. Existing opt-in Worker adapters fail closed until a coordinated cutover.',
        'Only the strict v360 flat-text platform-credential quote subset is admitted; shared Key, active BYOK, routing preferences and unsupported tariffs remain outside this proof.',
        'The SQL grant_recorded response is not a COMMIT/connection-close acknowledgement. A separate broker and secret holder must verify a committed receipt, physical URL, actual decrypted bearer and upload before fetch.',
        'The canonical outbound digest is an opaque caller commitment; this database does not prove the final-body-to-outbound transformation.',
        'Every committed grant remains an unresolved unknown obligation. There is no authorized result writer or retry resolution, so this version can grant only attempt 1; unknown ACK must not be replayed as a send right.',
        'The dispatched hold recovery lease is 15 minutes. Long SSE renewals, post-send billing/settlement and unknown reconciliation are not implemented.',
        'Broad source/config table locks are a review proof of no phantoms, not a production throughput design.',
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
      const cap=connection(cluster,roles.cap,passwords.cap,'cap');
      const verifier=connection(cluster,roles.verifier,passwords.verifier,'verifier');
      const complete=connection(cluster,roles.complete,passwords.complete,'complete');
      clients.push(migrator,runtime,admission,granter,granterPeer,
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
      // Keep the original grant calls and exact rejection checks on the PG73 ledger.
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

      const qWithoutAdmission=await issueQuote();
      const cWithoutAdmission=await claimFor(qWithoutAdmission);
      assert.equal((await grant(cWithoutAdmission)).status,'admission_required');
      await migrator.unsafe(`INSERT INTO ${g}.user_budget_reservations
        (request_id,user_id,api_key_id,budget_epoch,limit_micros,
          reserved_micros,expires_at,created_at,updated_at)
        VALUES($1,'v361-user','v361-key',0,10000000,90003,
          now()+interval '1 minute',now(),now())`,[qWithoutAdmission.requestId]);
      assert.equal((await grant(cWithoutAdmission)).status,'admission_required');
      await migrator.unsafe(`DELETE FROM ${g}.user_budget_reservations
        WHERE request_id=$1`,[qWithoutAdmission.requestId]);
      stage('preexisting-ordinary-row-cannot-substitute-for-v361-admission');

      const q1=await issueQuote();
      assert.equal(Number(q1.threeAttemptCeilingMicros),90003);
      assert.equal((await admit(q1,[])).status,'missing_guardrail_intents');
      assert.equal((await admit(q1,intents().slice(1))).status,'conflict');
      const [before]=await migrator.unsafe(`SELECT count(*)::integer AS n
        FROM ${g}.user_budget_reservations WHERE request_id=$1`,[q1.requestId]);
      assert.equal(before.n,0);
      stage('zero-or-omitted-guardrail-intents-cannot-bypass-configured-budgets');

      const admitted=await admit(q1);
      assert.equal(admitted.status,'admitted');
      assert.equal(Number(admitted.reservedMicros),90003);
      assert.equal(admitted.finalBodySha256,sha(finalBody));
      assert.equal(admitted.ordinary,'reserved');
      assert.equal(admitted.guardrailCount,3);
      const [ordinaryHold]=await migrator.unsafe(`SELECT reserved_micros::text AS amount,state
        FROM ${g}.user_budget_reservations WHERE request_id=$1`,[q1.requestId]);
      assert.deepEqual(ordinaryHold,{amount:'90003',state:'reserved'});
      const guardrailHolds=await migrator.unsafe(`SELECT reserved_micros::text AS amount,state
        FROM ${g}.guardrail_budget_reservations WHERE request_id=$1`,[q1.requestId]);
      assert.equal(guardrailHolds.length,3);
      assert.ok(guardrailHolds.every(x=>x.amount==='90003'&&x.state==='reserved'));
      stage('committed-v360-max-times-three-drives-one-ordinary-and-three-guardrail-holds',
        {reservedMicros:admitted.reservedMicros});

      const qClient=await issueQuote();
      assert.equal((await admit(qClient)).status,'admitted');
      const clientClaim=await claimFor(qClient);
      const clientGrant=await grantPostgresCompleteTextAttemptV362({
        granterConnectionString:`postgres://${roles.granter}:${passwords.granter}`
          +`@127.0.0.1:${cluster.port}/postgres?sslmode=disable`,
        attemptNonce:randomUUID(),claim:clientClaim,
      });
      assert.equal(clientGrant.status,'committed');
      assert.equal(clientGrant.commitAcknowledged,true);
      assert.equal(clientGrant.attemptNumber,1);
      assert.equal(clientGrant.requestId,qClient.requestId);
      assert.equal((await migrator.unsafe(`SELECT count(*)::integer AS n
        FROM ${g}.complete_text_attempt_grants_v362
        WHERE request_id=$1 AND obligation_state='unknown'`,
        [qClient.requestId]))[0].n,1);
      stage('direct-client-returns-only-after-native-postgres-grant-commit-and-close-ack');

      // Simulate lost admission ACK: the committed response is ignored and
      // the same request/quote/intent tuple is retried.
      const replay=await admit(q1);
      assert.equal(replay.status,'idempotent');
      assert.equal(replay.ordinary,'reserved');
      assert.equal(Number(replay.reservedMicros),90003);
      assert.equal((await migrator.unsafe(`SELECT count(*)::integer AS n
        FROM ${g}.complete_text_admissions_v361 WHERE request_id=$1`,
        [q1.requestId]))[0].n,1);
      assert.equal((await admit(q1,intents().slice(1))).status,'conflict');
      stage('unknown-ack-retry-is-idempotent-and-does-not-create-a-second-hold');

      const claim1=await claimFor(q1);
      const nonce1=randomUUID();
      const granted1=await grant(claim1,nonce1);
      assert.equal(granted1.status,'grant_recorded');
      assert.equal(granted1.attemptNumber,1);
      assert.equal(granted1.outboundBodyCanonicalSha256,
        claim1.outboundBodyCanonicalSha256);
      assert.equal(granted1.providerCiphertextSha256,
        claim1.providerCiphertextSha256);
      assert.ok(Date.parse(granted1.expiresAt)<=Date.parse(admitted.expiresAt));
      assert.ok(Date.parse(granted1.expiresAt)<=Date.parse(q1.expiresAt));
      assert.ok(Date.parse(granted1.holdRecoveryExpiresAt)>
        Date.parse(granted1.expiresAt));
      const [persisted1]=await migrator.unsafe(`SELECT obligation_state,
        attempt_number,claim_sha256,send_expires_at,
        hold_recovery_expires_at,outbound_body_canonical_sha256
        FROM ${g}.complete_text_attempt_grants_v362
        WHERE request_id=$1`,[q1.requestId]);
      assert.equal(persisted1.obligation_state,'unknown');
      assert.equal(persisted1.attempt_number,1);
      assert.equal(persisted1.outbound_body_canonical_sha256,
        claim1.outboundBodyCanonicalSha256);
      const [ordinaryDispatched]=await migrator.unsafe(`SELECT state,expires_at
        FROM ${g}.user_budget_reservations WHERE request_id=$1`,[q1.requestId]);
      const guardrailDispatched=await migrator.unsafe(`SELECT state,expires_at
        FROM ${g}.guardrail_budget_reservations WHERE request_id=$1`,[q1.requestId]);
      assert.equal(ordinaryDispatched.state,'dispatched');
      assert.ok(guardrailDispatched.length===3&&
        guardrailDispatched.every(x=>x.state==='dispatched'));
      const [leaseCoverage]=await migrator.unsafe(`SELECT
        (SELECT count(*)::integer FROM ${g}.user_budget_reservations
          WHERE request_id=$1 AND expires_at >= $2::timestamptz) AS ordinary,
        (SELECT count(*)::integer FROM ${g}.guardrail_budget_reservations
          WHERE request_id=$1 AND expires_at >= $2::timestamptz) AS guardrail`,
        [q1.requestId,granted1.holdRecoveryExpiresAt]);
      assert.deepEqual(leaseCoverage,{ordinary:1,guardrail:3});
      stage('atomic-first-grant-marks-all-holds-dispatched-and-records-unknown',
        {grantId:granted1.grantId,attemptNumber:granted1.attemptNumber});

      const lostAck=await grant(claim1,nonce1);
      assert.equal(lostAck.status,'already_recorded_unknown');
      assert.equal(lostAck.grantId,granted1.grantId);
      assert.equal((await grant(claim1,randomUUID())).status,'pending_unknown');
      assert.equal((await migrator.unsafe(`SELECT count(*)::integer AS n
        FROM ${g}.complete_text_attempt_grants_v362
        WHERE request_id=$1`,[q1.requestId]))[0].n,1);
      assert.equal((await grant({...claim1,upstreamUrlSha256:sha('changed')},
        nonce1)).status,'nonce_conflict');
      await denied(migrator.unsafe(`UPDATE ${g}.complete_text_attempt_grants_v362
        SET obligation_state='unknown' WHERE request_id=$1`,[q1.requestId]),
        'P0001');
      const [ordinaryRelease]=await admission.unsafe(`SELECT
        ${g}.release_user_budget_v350($1,now(),'cancelled') AS n`,
        [q1.requestId]);
      const [guardrailRelease]=await admission.unsafe(`SELECT
        ${g}.release_guardrail_budgets_v351($1,now(),'cancelled') AS n`,
        [q1.requestId]);
      assert.equal(ordinaryRelease.n,0);
      assert.equal(guardrailRelease.n,0);
      stage('lost-commit-ack-and-new-nonce-cannot-yield-a-second-send-right');

      const qConcurrent=await issueQuote();
      await admit(qConcurrent);
      const claimConcurrent=await claimFor(qConcurrent);
      const contenders=await Promise.all([
        grant(claimConcurrent,randomUUID(),granter),
        grant(claimConcurrent,randomUUID(),granterPeer)]);
      assert.deepEqual(contenders.map(x=>x.status).sort(),
        ['grant_recorded','pending_unknown']);
      assert.equal((await migrator.unsafe(`SELECT count(*)::integer AS n
        FROM ${g}.complete_text_attempt_grants_v362
        WHERE request_id=$1`,[qConcurrent.requestId]))[0].n,1);
      stage('parallel-direct-login-claims-serialize-to-one-unknown-slot');

      const qReleased=await issueQuote();
      await admit(qReleased);
      const [released]=await admission.unsafe(`SELECT
        ${g}.release_guardrail_budgets_v351($1,now(),'cancelled') AS n`,
        [qReleased.requestId]);
      assert.equal(released.n,3);
      assert.equal((await grant(await claimFor(qReleased))).status,'missing_hold');
      assert.equal((await migrator.unsafe(`SELECT count(*)::integer AS n
        FROM ${g}.complete_text_attempt_grants_v362
        WHERE request_id=$1`,[qReleased.requestId]))[0].n,0);
      stage('released-guardrail-hold-cannot-acquire-a-grant');

      const qTamper=await issueQuote();
      await admit(qTamper);
      const claimTamper=await claimFor(qTamper);
      assert.equal((await grant({...claimTamper,routeTargetId:'not-in-manifest'})).status,
        'target_not_in_manifest');
      assert.equal((await grant({...claimTamper,
        providerCiphertextSha256:sha('substitution')})).status,
        'target_not_in_manifest');
      await denied(()=>grant({...claimTamper,method:'GET'}),'23514');
      await denied(()=>grant({...claimTamper,
        outboundBodyCanonicalSha256:'bad'}),'23514');
      assert.equal((await migrator.unsafe(`SELECT count(*)::integer AS n
        FROM ${g}.complete_text_attempt_grants_v362
        WHERE request_id=$1`,[qTamper.requestId]))[0].n,0);
      stage('target-ciphertext-method-and-canonical-claim-substitution-reject');

      const qRollback=await issueQuote();
      await admit(qRollback);
      const claimRollback=await claimFor(qRollback);
      await assert.rejects(granter.begin(async tx=>{
        const [row]=await tx.unsafe(`SELECT
          ${g}.grant_complete_flat_text_attempt_v362($1::uuid,$2::jsonb) AS value`,
          [randomUUID(),tx.json(claimRollback)]);
        assert.equal(row.value.status,'grant_recorded');
        throw new Error('force grant transaction rollback');
      }),/force grant transaction rollback/u);
      assert.equal((await migrator.unsafe(`SELECT count(*)::integer AS n
        FROM ${g}.complete_text_attempt_grants_v362
        WHERE request_id=$1`,[qRollback.requestId]))[0].n,0);
      const [rolledHold]=await migrator.unsafe(`SELECT state FROM
        ${g}.user_budget_reservations WHERE request_id=$1`,[qRollback.requestId]);
      assert.equal(rolledHold.state,'reserved');
      stage('rollback-removes-grant-obligation-and-dispatch-transition-together');

      const qDrift=await issueQuote();
      await admit(qDrift);
      const claimDrift=await claimFor(qDrift);
      const q2=await issueQuote();
      assert.equal((await admit(q2,intents(),q1.requestId,q2.quoteId)).status,
        'missing_quote');
      assert.equal((await admit(q2,intents(),q2.requestId,randomUUID())).status,
        'missing_quote');
      await migrator.unsafe(`UPDATE ${g}.providers SET shared_channel_type='openai'
        WHERE id='v361-provider'`);
      assert.equal((await admit(q2)).status,'stale_manifest');
      assert.equal((await grant(claimDrift)).status,'stale_manifest');
      assert.equal((await migrator.unsafe(`SELECT count(*)::integer AS n
        FROM ${g}.complete_text_attempt_grants_v362
        WHERE request_id=$1`,[qDrift.requestId]))[0].n,0);
      const [driftHold]=await migrator.unsafe(`SELECT state FROM
        ${g}.user_budget_reservations WHERE request_id=$1`,[qDrift.requestId]);
      assert.equal(driftHold.state,'reserved');
      assert.equal((await migrator.unsafe(`SELECT count(*)::integer AS n
        FROM ${g}.user_budget_reservations WHERE request_id=$1`,[q2.requestId]))[0].n,0);
      await migrator.unsafe(`UPDATE ${g}.providers SET shared_channel_type=NULL
        WHERE id='v361-provider'`);
      await attest();
      stage('wrong-quote-identity-and-changed-platform-credential-basis-reject');

      const q3=await issueQuote();
      await migrator.unsafe(`INSERT INTO ${g}.byok_keys
        (id,workspace_id,provider,api_key_encrypted,label,sort_order)
        VALUES('v361-private','v361-workspace','v361-provider',
          'enc:v2:fixture','private',1)`);
      assert.equal((await admit(q3)).status,'stale');
      await migrator.unsafe(`DELETE FROM ${g}.byok_keys WHERE id='v361-private'`);
      await migrator.unsafe(`INSERT INTO ${g}.model_routes
        (id,model_id,provider_id,provider_model_name,route_pool_id,
          upstream_protocol,upstream_operation,adapter,status)
        VALUES('v361-new-route','v361-model','v361-provider','new',
          'v361-pool','openai','chat','passthrough','active')`);
      assert.equal((await admit(q3)).status,'stale_manifest');
      await migrator.unsafe(`DELETE FROM ${g}.model_routes WHERE id='v361-new-route'`);
      stage('new-BYOK-or-route-after-quote-cannot-use-incomplete-manifest');

      const unlimitedBearer='sk-local-v362-unlimited';
      const unlimitedHash=`sha256:${sha(unlimitedBearer)}`;
      await migrator.unsafe(`INSERT INTO ${g}.users(id,email)
        VALUES('v362-unlimited-user','v362-unlimited@example.invalid');
        INSERT INTO ${g}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,status)
        VALUES('v362-unlimited-space','personal','v362-unlimited-user',
          'Unlimited','v362-unlimited','active');`).simple();
      await migrator.unsafe(`INSERT INTO ${g}.api_keys
        (id,key,key_hash,user_id,workspace_id,status)
        VALUES('v362-unlimited-key',$1,$2,'v362-unlimited-user',
          'v362-unlimited-space','active')`,
        [`hashref:${unlimitedHash}`,unlimitedHash]);
      const qUnlimited=await issueQuote(unlimitedBearer);
      const admissionUnlimited=await admit(qUnlimited,[]);
      assert.equal(admissionUnlimited.status,'admitted');
      assert.equal(admissionUnlimited.ordinary,'unlimited');
      assert.equal(admissionUnlimited.guardrailCount,0);
      const unlimitedGrant=await grant(await claimFor(qUnlimited));
      assert.equal(unlimitedGrant.status,'grant_recorded');
      assert.equal((await migrator.unsafe(`SELECT count(*)::integer AS n
        FROM ${g}.user_budget_reservations WHERE request_id=$1`,
        [qUnlimited.requestId]))[0].n,0);
      assert.equal((await migrator.unsafe(`SELECT count(*)::integer AS n
        FROM ${g}.guardrail_budget_reservations WHERE request_id=$1`,
        [qUnlimited.requestId]))[0].n,0);
      stage('source-proven-unlimited-and-zero-intent-admission-can-record-grant');

      const q4=await issueQuote();
      await admit(q4);
      const claimExpired=await claimFor(q4);
      await migrator.unsafe(`UPDATE ${g}.api_keys SET expires_at=now()-interval '1 second'
        WHERE id='v361-key'`);
      assert.equal((await admit(q4)).status,'stale');
      assert.equal((await grant(claimExpired)).status,'stale');
      stage('expired-key-rejected-by-server-clock-after-quote');

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
      process.stdout.write(`complete-text-attempt-grant-v362-report=${reportUrl.pathname}\n`);
    }
    if(failure) throw failure;
    assert.equal(report.cleanup,'PASS');
  });
