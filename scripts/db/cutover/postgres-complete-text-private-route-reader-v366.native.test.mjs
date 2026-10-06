// Owned PostgreSQL 18.6 proof of holder-only selected route and ciphertext read.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { computeRouteDataPolicySubjectFingerprintFromRows } from '../../../packages/core/src/route-data-policy.ts';
import {
  readPostgresPrivateCompleteTextRouteV366,
  createPostgresPrivateCompleteTextReadPortsV366,
} from '../../../packages/proxy/src/services/postgres-private-complete-text-reader-v366.ts';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';

const g='cinatoken_gateway';
const migrations=new URL('../../../packages/core/migrations-postgres/',import.meta.url);
const proposal=name=>new URL(`../../../packages/core/migrations-proposals/postgres/${name}`,import.meta.url);
const reportUrl=new URL('../../../docs/developers/architecture/implementation-evidence/C04-complete-text-private-route-reader-v366-report.json',import.meta.url);
const sha=value=>createHash('sha256').update(value).digest('hex');
const bearer='sk-local-complete-text-v366-reader-bearer';
const keyHash=`sha256:${sha(bearer)}`;
const originalHash=sha('original-v366-private-reader-body');
const finalBody=JSON.stringify({model:'v366-model',models:['v366-model'],
  messages:[{role:'user',content:'hello'}],max_completion_tokens:300});
const roles={migrator:'cinatoken_gateway_migrator',
  runtime:'cinatoken_gateway_runtime',
  cap:'cinatoken_gateway_request_capability_issuer',
  claim:'cinatoken_gateway_request_capability_claim',
  fragment:'cinatoken_gateway_request_route_ceiling_issuer',
  verifier:'cinatoken_gateway_route_source_verifier',
  complete:'cinatoken_gateway_complete_text_quote_issuer',
  planner:'cinatoken_gateway_complete_text_ingress_planner',
  reader:'cinatoken_gateway_complete_text_private_reader'};

function connection(cluster,name,password,label) {
  return postgres({host:'127.0.0.1',port:cluster.port,database:'postgres',
    username:name,password,ssl:false,max:1,prepare:false,fetch_types:false,
    connect_timeout:3,idle_timeout:0,max_lifetime:0,backoff:false,onnotice(){},
    connection:{application_name:`complete-reader-v366-${label}`}});
}
async function denied(work,code='42501') {
  await assert.rejects(work,error=>{
    assert.equal((error?.cause??error)?.code,code,String(error));return true;
  });
}

test('v366 private reader returns only a fresh selected v360 route under its direct LOGIN',
  {timeout:300_000,skip:!process.env.GATEWAY_NATIVE_PG_BIN},async()=>{
    const cluster=await startNativePostgres();
    const report={status:'RUNNING',cleanup:'PENDING',binaryVersion:cluster.binaryVersion,
      sourceSha256:{},stages:[],limitations:[
        'Review-only PG73 proposal; no formal migration, remote database, production role or Worker changed.',
        'The private read precedes the v362 grant and is not send permission. The v362 grant must recheck the entire manifest and current state after this read.',
        'This local fixture uses a synthetic stored enc:v2: marker. It does not prove a separate Provider KEK, live unwrap, Worker binding, network boundary or real upstream fetch.',
        'The selected-source table lock is coherent only until reader transaction end; it is not a production throughput or cross-transaction source lease.',
        'The current public gateway still has the shared KEK, broad Provider SELECT and its own fetch path. Credential isolation requires a distinct ingress Worker and Provider key domain.',
        'D1/MySQL parity, Linux CI and real Worker/Hyperdrive behavior remain unverified.'
      ]};
    const stage=(name,detail={})=>report.stages.push({name,result:'PASS',...detail});
    const clients=[];let failure;
    try {
      assert.match(cluster.binaryVersion,/PostgreSQL\) 18\.6/u);
      const passwords=Object.fromEntries(Object.keys(roles).map(x=>[
        x,randomBytes(24).toString('hex')]));
      await cluster.admin.unsafe(`${Object.entries(roles).map(([label,name])=>
        `CREATE ROLE ${name} LOGIN ${label==='migrator'||label==='runtime'?'':'NOINHERIT'} PASSWORD '${passwords[label]}';`).join('\n')}
        CREATE SCHEMA ${g} AUTHORIZATION ${roles.migrator};
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO ${Object.values(roles).join(',')};
        GRANT CREATE ON DATABASE postgres TO ${roles.migrator};`).simple();
      const migrator=connection(cluster,roles.migrator,passwords.migrator,'migrator');
      const runtime=connection(cluster,roles.runtime,passwords.runtime,'runtime');
      const cap=connection(cluster,roles.cap,passwords.cap,'cap');
      const verifier=connection(cluster,roles.verifier,passwords.verifier,'verifier');
      const complete=connection(cluster,roles.complete,passwords.complete,'complete');
      const planner=connection(cluster,roles.planner,passwords.planner,'planner');
      const reader=connection(cluster,roles.reader,passwords.reader,'reader');
      clients.push(migrator,runtime,cap,verifier,complete,planner,reader);
      await migrator.unsafe(`CREATE TABLE ${g}.schema_migrations
        (version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`);
      const names=await listPg73Migrations();
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
      report.sourceSha256.formalMigrations=sha(corpus.join('\n'));
      const migratorUrl=`postgres://${roles.migrator}:${passwords.migrator}`
        +`@127.0.0.1:${cluster.port}/postgres`;
      // Keep original grant calls and rejection checks on the owned PG73 ledger.
      const grantPostgresRuntime = ({ DATABASE_URL }) =>
        grantPg73RuntimeFixture({ cluster, migrator, migratorUrl: DATABASE_URL });
      await grantPostgresRuntime({DATABASE_URL:migratorUrl});
      stage('formal-pg73-and-legacy-runtime-grants-installed');

      const overlays=[
        ['authenticated-request-capability-login-v356.sql','request_capability_login_activation'],
        ['authenticated-text-route-ceiling-issuer-v357.sql','request_route_ceiling_activation'],
        ['authenticated-text-route-source-fence-v359.sql','route_source_fence_activation'],
        ['authenticated-complete-text-quote-v360.sql','complete_text_quote_activation'],
        ['complete-text-secretless-plan-v365.sql','complete_text_secretless_plan_activation']
      ];
      for(const [name,flag] of overlays) {
        const sql=await readFile(proposal(name),'utf8');
        report.sourceSha256[name]=sha(sql);
        await migrator.begin(async tx=>{
          await tx.unsafe(`SET LOCAL cinatoken.${flag}='reviewed-v1'`);
          await tx.unsafe(sql).simple();
        });
      }
      const sql=await readFile(proposal('complete-text-private-route-reader-v366.sql'),'utf8');
      report.sourceSha256['complete-text-private-route-reader-v366.sql']=sha(sql);
      await denied(migrator.begin(tx=>tx.unsafe(sql).simple()),'P0001');
      await denied(migrator.begin(async tx=>{
        await tx.unsafe(`GRANT SELECT ON ${g}.providers TO ${roles.reader}`);
        await tx.unsafe(`SET LOCAL cinatoken.complete_text_private_route_reader_activation='reviewed-v1'`);
        await tx.unsafe(sql).simple();
      }),'P0001');
      await migrator.begin(async tx=>{
        await tx.unsafe(`SET LOCAL cinatoken.complete_text_private_route_reader_activation='reviewed-v1'`);
        await tx.unsafe(sql).simple();
      });
      report.sourceSha256.fixture=sha(await readFile(new URL(import.meta.url)));
      stage('default-off-and-reader-privilege-drift-fail-atomically');

      const fn=`${g}.read_private_complete_text_route_v366`;
      const badArgs=['missing',randomUUID(),0,'v366-route'];
      await denied(runtime.unsafe(`SELECT ${fn}($1,$2,$3,$4)`,badArgs));
      await denied(planner.unsafe(`SELECT ${fn}($1,$2,$3,$4)`,badArgs));
      await denied(reader.unsafe(`SELECT * FROM ${g}.providers`));
      await denied(reader.unsafe(`SELECT api_key,endpoints FROM ${g}.providers`));
      await denied(reader.unsafe(`SELECT * FROM ${g}.complete_text_quotes_v360`));
      await denied(reader.unsafe(`SELECT * FROM ${g}.complete_text_quote_routes_v360`));
      await denied(reader.unsafe(`SET ROLE ${roles.migrator}`));
      await denied(reader.unsafe(`SET ROLE ${roles.runtime}`));
      await denied(reader.unsafe(`SELECT ${g}.plan_complete_flat_text_quote_v365($1,$2)`,
        ['missing',randomUUID()]));
      const [acl]=await migrator.unsafe(`SELECT
        pg_catalog.has_function_privilege('${roles.reader}',
          '${fn}(text,uuid,integer,text)','EXECUTE') AS reader_call,
        pg_catalog.has_function_privilege('${roles.runtime}',
          '${fn}(text,uuid,integer,text)','EXECUTE') AS runtime_call,
        pg_catalog.has_function_privilege('${roles.planner}',
          '${fn}(text,uuid,integer,text)','EXECUTE') AS planner_call,
        pg_catalog.has_table_privilege('${roles.reader}',
          '${g}.providers','SELECT') AS provider_select,
        pg_catalog.has_column_privilege('${roles.reader}',
          '${g}.providers','api_key','SELECT') AS key_select,
        pg_catalog.has_column_privilege('${roles.reader}',
          '${g}.providers','endpoints','SELECT') AS endpoint_select,
        pg_catalog.pg_has_role('${roles.reader}',
          '${roles.migrator}','MEMBER') AS migrator_member`);
      assert.deepEqual(acl,{reader_call:true,runtime_call:false,
        planner_call:false,provider_select:false,key_select:false,
        endpoint_select:false,migrator_member:false});
      stage('reader-only-function-acl-and-direct-table-set-role-denials',{acl});

      await migrator.unsafe(`INSERT INTO ${g}.users(id,email,budget_max)
        VALUES('v366-user','v366@example.invalid',1);
        INSERT INTO ${g}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
        VALUES('v366-workspace','personal','v366-user','Reader','v366','active');`).simple();
      await migrator.unsafe(`INSERT INTO ${g}.api_keys
        (id,key,key_hash,user_id,workspace_id,status)
        VALUES('v366-key',$1,$2,'v366-user','v366-workspace','active')`,
        [`hashref:${keyHash}`,keyHash]);
      const providerCiphertext='enc:v2:holder-secret-sentinel';
      const endpoints={openai:{base:'https://private-openai.invalid/v1'},
        anthropic:{base:'https://unneeded-secret.invalid'}};
      await migrator.unsafe(`INSERT INTO ${g}.providers(id,name,api_key,endpoints,status)
        VALUES('v366-provider','V366 Provider',$1,$2,'active')`,
        [providerCiphertext,JSON.stringify(endpoints)]);
      await migrator.unsafe(`INSERT INTO ${g}.models(id,vendor)
        VALUES('v366-model','other');
        INSERT INTO ${g}.route_pools(id,model_id,route_group,name,status)
        VALUES('v366-pool','v366-model','default','Primary','active');
        INSERT INTO ${g}.model_surfaces
          (id,model_id,route_group,request_protocol,request_operation,
            route_pool_id,status)
        VALUES('v366-surface','v366-model','default','openai','chat',
          'v366-pool','active');
        INSERT INTO ${g}.model_routes
          (id,model_id,provider_id,provider_model_name,route_pool_id,
            upstream_protocol,upstream_operation,adapter,status)
        VALUES('v366-route','v366-model','v366-provider','upstream-v366',
          'v366-pool','openai','chat','passthrough','active');
        INSERT INTO ${g}.model_endpoints
          (id,model_id,provider_id,provider_slug,tag,context_length,pricing,
            supports_tool_choice,supports_implicit_caching,supports_voice_cloning,
            evidence_url,verified_by,verified_at,expires_at,status)
        VALUES('v366-endpoint','v366-model','v366-provider','v366-provider',
          'primary',1000,'{"currency":"USD","prompt":"0.000002","completion":"0.000004"}',
          '{"auto":true,"function":false,"none":true,"required":false}',false,false,
          'https://evidence-private.invalid/primary','fixture',now()-interval '1 minute',
          now()+interval '5 minutes','verified');
        INSERT INTO ${g}.model_endpoint_routes(endpoint_id,route_target_id)
        VALUES('v366-endpoint','v366-route');`).simple();
      const attest=async()=>{
        const [route]=await migrator.unsafe(`SELECT provider_id,provider_model_name,
          custom_params,upstream_protocol,upstream_operation,adapter
          FROM ${g}.model_routes WHERE id='v366-route'`);
        const [provider]=await migrator.unsafe(`SELECT id,endpoints,api_key,
          shared_channel_type FROM ${g}.providers WHERE id=$1`,[route.provider_id]);
        const fingerprint=await computeRouteDataPolicySubjectFingerprintFromRows(route,provider);
        await migrator.unsafe(`UPDATE ${g}.model_endpoint_routes
          SET subject_fingerprint=$1 WHERE route_target_id='v366-route'`,[fingerprint]);
        const [row]=await verifier.unsafe(`SELECT generation::text AS generation
          FROM ${g}.route_source_generations_v359 WHERE route_target_id='v366-route'`);
        const [value]=await verifier.unsafe(`SELECT ${g}.attest_text_route_source_v359(
          'v366-route',$1,$2) AS value`,[row.generation,fingerprint]);
        assert.equal(value.value.status,'attested');
      };
      await attest();
      const requestId=`v366-${randomUUID()}`;
      const [issued]=await cap.unsafe(`SELECT ${g}.issue_request_capability_v356(
        $1,$2,$3) AS value`,[requestId,bearer,originalHash]);
      assert.equal(issued.value.status,'issued');
      const [quoted]=await complete.unsafe(`SELECT ${g}.issue_complete_flat_text_quote_v360(
        $1,$2,$3,$4) AS value`,
        [requestId,issued.value.capability,originalHash,finalBody]);
      assert.equal(quoted.value.status,'quoted_complete_subset');
      stage('genuine-v360-issuer-committed-a-fenced-selected-route');

      const quoteId=quoted.value.quoteId;
      const read=async(id=requestId,qid=quoteId,candidate=0,target='v366-route')=>{
        const [row]=await reader.unsafe(`SELECT ${fn}($1,$2::uuid,$3,$4) AS value`,
          [id,qid,candidate,target]);return row.value;
      };
      assert.equal((await read('wrong-request')).status,'not_found');
      assert.equal((await read(requestId,randomUUID())).status,'not_found');
      assert.equal((await read(requestId,quoteId,1)).status,'target_not_in_manifest');
      assert.equal((await read(requestId,quoteId,0,'wrong-route')).status,
        'target_not_in_manifest');
      await denied(read(requestId,quoteId,null),'23514');
      const loaded=await read();
      assert.equal(loaded.status,'private_route_loaded');
      assert.deepEqual(Object.keys(loaded).sort(),['quote','selected','status']);
      assert.deepEqual(loaded.quote.modelIds,['v366-model']);
      assert.equal(loaded.quote.requestId,requestId);
      assert.equal(loaded.quote.quoteId,quoteId);
      assert.equal(loaded.quote.finalBodySha256,sha(finalBody));
      assert.equal(loaded.selected.candidateIndex,0);
      assert.equal(loaded.selected.routeTargetId,'v366-route');
      assert.equal(loaded.selected.providerCiphertext,providerCiphertext);
      assert.equal(loaded.selected.providerCiphertextSha256,sha(providerCiphertext));
      assert.deepEqual(loaded.selected.providerEndpoints,{openai:endpoints.openai});
      assert.equal(loaded.selected.endpointRow.id,'v366-endpoint');
      assert.ok(/^\d+$/u.test(loaded.selected.sourceGeneration));
      assert.equal(JSON.stringify(loaded).includes('unneeded-secret.invalid'),false);
      stage('selected-private-route-projection-is-exact-and-bounded');

      const request={requestId,quoteId,attemptNonce:randomUUID(),
        candidateIndex:0,routeTargetId:'v366-route',finalBodyUtf8:finalBody};
      const readerConnectionString=`postgres://${roles.reader}:${passwords.reader}`
        +`@127.0.0.1:${cluster.port}/postgres`;
      const clientSnapshot=await readPostgresPrivateCompleteTextRouteV366({
        readerConnectionString,request,
      });
      assert.equal(clientSnapshot.quote.quoteId,quoteId);
      assert.equal(clientSnapshot.route.targetId,'v366-route');
      assert.equal(clientSnapshot.route.providerApiKey,providerCiphertext);
      assert.equal(clientSnapshot.providerCiphertext,providerCiphertext);
      assert.equal(clientSnapshot.route.endpoint.id,'v366-endpoint');
      const ports=createPostgresPrivateCompleteTextReadPortsV366({
        readerConnectionString,request,
      });
      assert.equal((await ports.loadQuote(quoteId)).quoteId,quoteId);
      assert.equal((await ports.loadRoute({quoteId,candidateIndex:0,
        routeTargetId:'v366-route'})).targetId,'v366-route');
      assert.equal(await ports.loadProviderCiphertext('v366-provider'),providerCiphertext);
      assert.equal(await ports.loadProviderCiphertext('wrong-provider'),null);
      assert.equal(await ports.loadQuote(randomUUID()),null);
      assert.equal(await ports.loadRoute({quoteId,candidateIndex:0,
        routeTargetId:'wrong-route'}),null);
      await assert.rejects(readPostgresPrivateCompleteTextRouteV366({
        readerConnectionString:`postgres://${roles.runtime}:${passwords.runtime}`
          +`@127.0.0.1:${cluster.port}/postgres`,request,
      }),/direct LOGIN mismatch/u);
      stage('direct-login-client-maps-one-committed-snapshot-to-holder-read-ports');

      await migrator.unsafe(`UPDATE ${g}.providers
        SET api_key='enc:v2:changed-secret' WHERE id='v366-provider'`);
      assert.equal((await read()).status,'stale_source');
      stage('provider-ciphertext-and-generation-drift-reject');
      await migrator.unsafe(`UPDATE ${g}.providers SET api_key=$1
        WHERE id='v366-provider'`,[providerCiphertext]);
      await attest();
      assert.equal((await read()).status,'stale_source');
      stage('provider-ABA-reattest-cannot-resurrect-old-quote');
      // Issue a fresh quote after the ABA change so endpoint drift is tested
      // independently of the old quote's permanently stale generation.
      const request2=`v366-${randomUUID()}`;
      const [issued2]=await cap.unsafe(`SELECT ${g}.issue_request_capability_v356(
        $1,$2,$3) AS value`,[request2,bearer,originalHash]);
      const [quoted2]=await complete.unsafe(`SELECT ${g}.issue_complete_flat_text_quote_v360(
        $1,$2,$3,$4) AS value`,
        [request2,issued2.value.capability,originalHash,finalBody]);
      assert.equal(quoted2.value.status,'quoted_complete_subset');
      assert.equal((await read(request2,quoted2.value.quoteId)).status,
        'private_route_loaded');
      await migrator.unsafe(`UPDATE ${g}.model_endpoints
        SET evidence_url='https://changed-evidence.invalid/primary'
        WHERE id='v366-endpoint'`);
      assert.equal((await read(request2,quoted2.value.quoteId)).status,'stale_source');
      stage('endpoint-evidence-source-drift-rejects');

      await assert.rejects(grantPostgresRuntime({DATABASE_URL:migratorUrl}),
        /Request capability v356 is installed/u);
      const [after]=await migrator.unsafe(`SELECT
        pg_catalog.has_function_privilege('${roles.reader}',
          '${fn}(text,uuid,integer,text)','EXECUTE') AS reader_call,
        pg_catalog.has_column_privilege('${roles.reader}',
          '${g}.providers','api_key','SELECT') AS key_read`);
      assert.deepEqual(after,{reader_call:true,key_read:false});
      stage('legacy-broad-grant-rerun-fails-and-reader-acl-stays-narrow',{after});
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
      process.stdout.write(`complete-text-v366-reader-report=${reportUrl.pathname}\n`);
    }
    if(failure) throw failure;
    assert.equal(report.cleanup,'PASS');
  });
