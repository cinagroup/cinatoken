// Owned PG18 proof of a review-only atomic complete flat-text quote subset.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { computeRouteDataPolicySubjectFingerprintFromRows } from '../../../packages/core/src/route-data-policy.ts';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';

const g='cinatoken_gateway';
const migrations=new URL('../../../packages/core/migrations-postgres/',import.meta.url);
const proposal=name=>new URL(`../../../packages/core/migrations-proposals/postgres/${name}`,import.meta.url);
const reportUrl=new URL('../../../docs/developers/architecture/implementation-evidence/C04-authenticated-complete-text-quote-v360-report.json',import.meta.url);
const digest=value=>createHash('sha256').update(value).digest('hex');
const bearer='sk-local-complete-text-v360-bearer';
const lookupHash=`sha256:${digest(bearer)}`;
const originalHash=digest('original-ingress-body');
const finalBody=JSON.stringify({model:'v360-alpha',models:['v360-alpha','v360-beta'],
  messages:[{role:'user',content:'hello'}],max_completion_tokens:300});
const roles={cap:'cinatoken_gateway_request_capability_issuer',
  claim:'cinatoken_gateway_request_capability_claim',
  fragment:'cinatoken_gateway_request_route_ceiling_issuer',
  verifier:'cinatoken_gateway_route_source_verifier',
  complete:'cinatoken_gateway_complete_text_quote_issuer'};

function connection(cluster,username,password,label) {
  return postgres({host:'127.0.0.1',port:cluster.port,database:'postgres',
    username,password,ssl:false,max:1,prepare:false,fetch_types:false,
    connect_timeout:3,idle_timeout:0,max_lifetime:0,backoff:false,onnotice() {},
    connection:{application_name:`complete-text-v360-${label}`}});
}
async function expectDenied(promise) {
  await assert.rejects(promise,error=>{
    assert.equal((error?.cause??error)?.code,'42501',String(error));return true;
  });
}

test('PG73 complete flat-text quote covers all candidate routes or rejects the whole request',
  {timeout:300_000,skip:!process.env.GATEWAY_NATIVE_PG_BIN},async()=>{
    const cluster=await startNativePostgres();
    const report={status:'RUNNING',cleanup:'PENDING',binaryVersion:cluster.binaryVersion,
      sourceSha256:{},stages:[],limitations:[
        'Review-only PG73 proposal; no formal migration, deployment, remote database, production verifier or Worker credential holder changed.',
        'Issuer covers a strict plain-text OpenAI Chat platform-credential class. Shared Keys, active private BYOK, nonzero Endpoint discounts, route overrides, service tiers, provider preferences, multimodal content and unsupported tariffs reject the entire request.',
        'Final UTF-8 body is capped at 1 MiB, below the 50 MiB ingress cap; larger Chat bodies intentionally fail closed for this quote subset.',
        'The v356 original-body digest and the v360 final-body bytes are supplied through different trust boundaries. The database does not prove preset or Guardrail transformations between them.',
        'The route-source verifier is trusted to compute the subject fingerprint from current decrypted source configuration. SQL checks the attested generation and persisted link.',
        'The table-level route and credential locks prove a complete current predicate snapshot in this review candidate but are too broad for production throughput.',
        'A matching surface with cross-model pool topology rejects the request; same-model surfaces are included by the all-active-route superset.',
        'The parent is a quote ceiling, not a financial reservation or upstream egress grant. Future admission and credential holder must check the committed quote, live generations and exact physical credential.',
        'D1/MySQL parity, Linux CI and real Worker/Hyperdrive behavior remain unproved.'
      ]};
    const stage=(name,detail={})=>report.stages.push({name,result:'PASS',...detail});
    const clients=[];let failure;
    try {
      assert.match(cluster.binaryVersion,/PostgreSQL\) 18\.6/u);
      const labels=['migrator','runtime',...Object.keys(roles)];
      const passwords=Object.fromEntries(labels.map(x=>[x,randomBytes(24).toString('hex')]));
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${passwords.migrator}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${passwords.runtime}';
        ${Object.entries(roles).map(([label,name])=>
          `CREATE ROLE ${name} LOGIN NOINHERIT PASSWORD '${passwords[label]}';`).join('\n')}
        CREATE SCHEMA ${g} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime,${Object.values(roles).join(',')};
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator=connection(cluster,'cinatoken_gateway_migrator',passwords.migrator,'migrator');
      const runtime=connection(cluster,'cinatoken_gateway_runtime',passwords.runtime,'runtime');
      const cap=connection(cluster,roles.cap,passwords.cap,'cap');
      const verifier=connection(cluster,roles.verifier,passwords.verifier,'verifier');
      const complete=connection(cluster,roles.complete,passwords.complete,'complete');
      clients.push(migrator,runtime,cap,verifier,complete);
      await migrator.unsafe(`CREATE TABLE ${g}.schema_migrations
        (version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`);
      const names=(await readdir(migrations)).filter(x=>x.endsWith('.sql')).sort();
      assert.equal(names.length,73);
      const corpus=[];
      for(const name of names) {
        const body=await readFile(new URL(name,migrations),'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx=>{
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${g}.schema_migrations(version) VALUES($1)`,[name]);
        });
      }
      report.sourceSha256.formalMigrations=digest(corpus.join('\n'));
      report.sourceSha256.runtimeGrant=digest(await readFile(
        new URL('./grant-postgres-runtime.ts',import.meta.url)));
      const migratorUrl=`postgres://cinatoken_gateway_migrator:${passwords.migrator}`
        +`@127.0.0.1:${cluster.port}/postgres`;
      await grantPostgresRuntime({DATABASE_URL:migratorUrl});
      stage('formal-pg73-and-current-runtime-grants-installed');

      const overlays=[
        ['authenticated-request-capability-login-v356.sql','cinatoken.request_capability_login_activation'],
        ['authenticated-text-route-ceiling-issuer-v357.sql','cinatoken.request_route_ceiling_activation'],
        ['authenticated-text-route-source-fence-v359.sql','cinatoken.route_source_fence_activation'],
        ['authenticated-complete-text-quote-v360.sql','cinatoken.complete_text_quote_activation']
      ];
      for(const [name,flag] of overlays) {
        const sql=await readFile(proposal(name),'utf8');
        report.sourceSha256[name]=digest(sql);
        if(name.endsWith('v360.sql')) {
          await assert.rejects(migrator.begin(tx=>tx.unsafe(sql).simple()),
            /activation or dependency differs/u);
        }
        await migrator.begin(async tx=>{
          await tx.unsafe(`SET LOCAL ${flag} = 'reviewed-v1'`);
          await tx.unsafe(sql).simple();
        });
      }
      report.sourceSha256.fixture=digest(await readFile(new URL(import.meta.url)));
      stage('default-off-v356-v357-v359-v360-chain-installed');

      await expectDenied(runtime.unsafe(`SELECT ${g}.issue_complete_flat_text_quote_v360('x','x','x','x')`));
      await expectDenied(complete.unsafe(`SELECT * FROM ${g}.complete_text_quotes_v360`));
      await expectDenied(complete.unsafe(`SELECT * FROM ${g}.model_endpoints`));
      const [acl]=await migrator.unsafe(`SELECT
        pg_catalog.has_function_privilege('${roles.complete}',
          '${g}.issue_complete_flat_text_quote_v360(text,text,text,text)','EXECUTE') AS execute,
        pg_catalog.has_table_privilege('${roles.complete}',
          '${g}.complete_text_quote_routes_v360','SELECT,INSERT,UPDATE,DELETE') AS direct_dml,
        pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
          '${g}.issue_complete_flat_text_quote_v360(text,text,text,text)','EXECUTE') AS runtime_execute`);
      assert.deepEqual(acl,{execute:true,direct_dml:false,runtime_execute:false});
      stage('separate-direct-login-has-only-execute-not-source-or-manifest-dml',{acl});

      await migrator.unsafe(`INSERT INTO ${g}.users(id,email,budget_max)
        VALUES('v360-user','v360@example.invalid',1);
        INSERT INTO ${g}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
        VALUES('v360-workspace','personal','v360-user','Quote','v360','active');`).simple();
      await migrator.unsafe(`INSERT INTO ${g}.api_keys
        (id,key,key_hash,user_id,workspace_id,status)
        VALUES('v360-key',$1,$2,'v360-user','v360-workspace','active')`,
        [`hashref:${lookupHash}`,lookupHash]);
      await migrator.unsafe(`INSERT INTO ${g}.providers(id,name,api_key,status)
        VALUES('v360-provider','V360 Provider','enc:v2:fixture','active');
        INSERT INTO ${g}.models(id,vendor)
        VALUES('v360-alpha','other'),('v360-beta','other');
        INSERT INTO ${g}.route_pools(id,model_id,route_group,name,status)
        VALUES('v360-pool-a','v360-alpha','default','A','active'),
          ('v360-pool-b','v360-beta','default','B','active');
        INSERT INTO ${g}.model_surfaces
          (id,model_id,route_group,request_protocol,request_operation,
            route_pool_id,status)
        VALUES('v360-surface-a','v360-alpha','default','openai','chat',
            'v360-pool-a','active'),
          ('v360-surface-b','v360-beta','default','openai','chat',
            'v360-pool-b','active');
        INSERT INTO ${g}.model_routes
          (id,model_id,provider_id,provider_model_name,route_pool_id,
            upstream_protocol,upstream_operation,adapter,status)
        VALUES('v360-a-cheap','v360-alpha','v360-provider','upstream-a',
            'v360-pool-a','openai','chat','passthrough','active'),
          ('v360-a-expensive','v360-alpha','v360-provider','upstream-a',
            'v360-pool-a','openai','chat','passthrough','active'),
          ('v360-b-middle','v360-beta','v360-provider','upstream-b',
            'v360-pool-b','openai','chat','passthrough','active');
        INSERT INTO ${g}.model_endpoints
          (id,model_id,provider_id,provider_slug,tag,context_length,pricing,
            evidence_url,verified_by,verified_at,expires_at,status)
        VALUES('v360-e-cheap','v360-alpha','v360-provider','v360-provider',
            'cheap',1000,'{"currency":"USD","prompt":"0.000002","completion":"0.000004"}',
            'https://example.invalid/cheap','fixture',now()-interval '1 minute',
            now()+interval '5 minutes','verified'),
          ('v360-e-expensive','v360-alpha','v360-provider','v360-provider',
            'expensive',1000,'{"currency":"USD","prompt":"0.000010","completion":"0.000020"}',
            'https://example.invalid/expensive','fixture',now()-interval '1 minute',
            now()+interval '5 minutes','verified'),
          ('v360-e-middle','v360-beta','v360-provider','v360-provider',
            'middle',1000,'{"currency":"USD","prompt":"0.000004","completion":"0.000008"}',
            'https://example.invalid/middle','fixture',now()-interval '1 minute',
            now()+interval '5 minutes','verified');
        INSERT INTO ${g}.model_endpoint_routes(endpoint_id,route_target_id)
        VALUES('v360-e-cheap','v360-a-cheap'),
          ('v360-e-expensive','v360-a-expensive'),
          ('v360-e-middle','v360-b-middle');`).simple();
      const readSubject=async target=>{
        const [route]=await migrator.unsafe(`SELECT provider_id,provider_model_name,
          custom_params,upstream_protocol,upstream_operation,adapter
          FROM ${g}.model_routes WHERE id=$1`,[target]);
        const [provider]=await migrator.unsafe(`SELECT id,endpoints,api_key,
          shared_channel_type FROM ${g}.providers WHERE id=$1`,[route.provider_id]);
        return computeRouteDataPolicySubjectFingerprintFromRows(route,provider);
      };
      const attest=async target=>{
        const fingerprint=await readSubject(target);
        await migrator.unsafe(`UPDATE ${g}.model_endpoint_routes
          SET subject_fingerprint=$1 WHERE route_target_id=$2`,[fingerprint,target]);
        const [row]=await verifier.unsafe(`SELECT generation::text AS generation
          FROM ${g}.route_source_generations_v359 WHERE route_target_id=$1`,[target]);
        const [result]=await verifier.unsafe(`SELECT ${g}.attest_text_route_source_v359($1,$2,$3) AS value`,
          [target,row.generation,fingerprint]);
        assert.equal(result.value.status,'attested');
      };
      for(const target of ['v360-a-cheap','v360-a-expensive','v360-b-middle'])
        await attest(target);
      stage('three-routes-across-two-models-independently-attested');

      const issueCap=async()=>{
        const id=`v360-${randomUUID()}`;
        const [row]=await cap.unsafe(`SELECT ${g}.issue_request_capability_v356($1,$2,$3) AS value`,
          [id,bearer,originalHash]);
        assert.equal(row.value.status,'issued');return row.value;
      };
      const quote=async(issued,body=finalBody,capability=issued.capability)=>{
        const [row]=await complete.unsafe(`SELECT ${g}.issue_complete_flat_text_quote_v360($1,$2,$3,$4) AS value`,
          [issued.requestId,capability,originalHash,body]);return row.value;
      };
      const unauth=await issueCap();
      assert.equal((await quote(unauth,finalBody,randomUUID()+randomUUID())).status,'unauthorized');
      assert.equal((await quote(unauth,JSON.stringify({...JSON.parse(finalBody),tools:[]}))).status,'unsupported');
      const withoutModels={...JSON.parse(finalBody)};
      delete withoutModels.models;
      assert.equal((await quote(unauth,JSON.stringify(withoutModels))).status,'unsupported');
      assert.equal((await quote(unauth,JSON.stringify({...JSON.parse(finalBody),
        messages:[{content:'hello'}]}))).status,'unsupported');
      assert.equal((await quote(unauth,JSON.stringify({...JSON.parse(finalBody),models:['v360-alpha','missing']}))).status,'unsupported');
      const [before]=await migrator.unsafe(`SELECT state FROM ${g}.authenticated_request_capabilities_v356
        WHERE request_id=$1`,[unauth.requestId]);
      assert.equal(before.state,'issued');
      stage('bad-capability-unsupported-body-and-missing-candidate-list-never-consume-capability');

      const issued=await issueCap();
      const result=await quote(issued);
      assert.equal(result.status,'quoted_complete_subset');
      assert.equal(result.finalBodySha256,digest(finalBody));
      assert.deepEqual(result.modelIds,['v360-alpha','v360-beta']);
      assert.equal(result.routeCount,3);
      assert.equal(Number(result.maxPerAttemptCeilingMicros),30001);
      assert.equal(Number(result.threeAttemptCeilingMicros),90003);
      const manifest=await migrator.unsafe(`SELECT candidate_index,model_id,route_target_id,
        credential_class,credential_id,source_generation::text AS source_generation,
        per_attempt_ceiling_micros::text AS ceiling
        FROM ${g}.complete_text_quote_routes_v360 ORDER BY candidate_index,route_target_id`);
      assert.deepEqual(manifest.map(row=>[row.candidate_index,row.route_target_id,row.ceiling]),
        [[0,'v360-a-cheap','6001'],[0,'v360-a-expensive','30001'],
          [1,'v360-b-middle','12001']]);
      assert.ok(manifest.every(row=>row.credential_class==='platform'
        && row.credential_id==='v360-provider' && BigInt(row.source_generation)>0n));
      assert.equal((await quote(issued)).status,'stale');
      const [claimed]=await migrator.unsafe(`SELECT state FROM ${g}.authenticated_request_capabilities_v356
        WHERE request_id=$1`,[issued.requestId]);
      assert.equal(claimed.state,'claimed');
      stage('one-transaction-parent-and-all-three-targets-have-checked-three-attempt-max',
        {routes:manifest.map(row=>row.route_target_id),ceiling:result.threeAttemptCeilingMicros});

      const largeOutput=await issueCap();
      const largeBody=JSON.stringify({...JSON.parse(finalBody),max_completion_tokens:2000});
      const largeQuote=await quote(largeOutput,largeBody);
      assert.equal(largeQuote.status,'quoted_complete_subset');
      assert.equal(Number(largeQuote.maxPerAttemptCeilingMicros),50001);
      assert.equal(Number(largeQuote.threeAttemptCeilingMicros),150003);
      stage('explicit-output-cap-above-endpoint-context-raises-every-route-ceiling');

      const crossModelSurface=await issueCap();
      await migrator.unsafe(`UPDATE ${g}.model_surfaces
        SET route_pool_id='v360-pool-b' WHERE id='v360-surface-a'`);
      assert.equal((await quote(crossModelSurface)).status,'unsupported');
      await migrator.unsafe(`UPDATE ${g}.model_surfaces
        SET route_pool_id='v360-pool-a' WHERE id='v360-surface-a'`);
      assert.equal((await quote(crossModelSurface)).status,'quoted_complete_subset');
      stage('cross-model-active-surface-is-rejected-instead-of-omitting-selectable-target');

      const withByok=await issueCap();
      await migrator.unsafe(`INSERT INTO ${g}.byok_keys
        (id,workspace_id,provider,api_key_encrypted,label,sort_order)
        VALUES('v360-private','v360-workspace','v360-provider',
          'enc:v2:fixture','private-key',1)`);
      assert.equal((await quote(withByok)).status,'unsupported');
      await migrator.unsafe(`DELETE FROM ${g}.byok_keys WHERE id='v360-private'`);
      assert.equal((await quote(withByok)).status,'quoted_complete_subset');
      stage('possible-private-credential-rejects-entire-request-until-removed');

      const shared=await issueCap();
      await migrator.unsafe(`UPDATE ${g}.providers SET shared_channel_type='openai'
        WHERE id='v360-provider'`);
      for(const target of ['v360-a-cheap','v360-a-expensive','v360-b-middle'])
        await attest(target);
      assert.equal((await quote(shared)).status,'unsupported');
      await migrator.unsafe(`UPDATE ${g}.providers SET shared_channel_type=NULL
        WHERE id='v360-provider'`);
      for(const target of ['v360-a-cheap','v360-a-expensive','v360-b-middle'])
        await attest(target);
      assert.equal((await quote(shared)).status,'quoted_complete_subset');
      stage('shared-channel-path-rejects-all-routes-and-provider-ABA-needs-reattest');

      const unpriced=await issueCap();
      await migrator.unsafe(`UPDATE ${g}.model_endpoints SET pricing='{}'
        WHERE id='v360-e-middle'`);
      await attest('v360-b-middle');
      assert.equal((await quote(unpriced)).status,'unsupported');
      const [stillIssued]=await migrator.unsafe(`SELECT state FROM ${g}.authenticated_request_capabilities_v356
        WHERE request_id=$1`,[unpriced.requestId]);
      assert.equal(stillIssued.state,'issued');
      const [noParent]=await migrator.unsafe(`SELECT count(*)::integer AS n
        FROM ${g}.complete_text_quotes_v360 WHERE request_id=$1`,[unpriced.requestId]);
      assert.equal(noParent.n,0);
      stage('one-unpriced-fallback-route-rejects-atomic-parent-and-preserves-capability');

      report.status='PASS';
    } catch(error) {
      failure=error;report.status='FAIL';const cause=error?.cause??error;
      report.failure={code:cause?.code??null,constraint:cause?.constraint_name??null,
        message:String(error?.stack??error).slice(0,5000)};
    } finally {
      await Promise.allSettled(clients.map(sql=>sql.end({timeout:1})));
      try {await cluster.cleanup();report.cleanup='PASS';}
      catch(error) {report.cleanup='FAIL';report.cleanupError=String(error?.stack??error).slice(0,1500);failure??=error;}
      await writeFile(reportUrl,JSON.stringify(report,null,2)+'\n');
      process.stdout.write(`complete-text-v360-report=${reportUrl.pathname}\n`);
    }
    if(failure) throw failure;
    assert.equal(report.cleanup,'PASS');
  });
