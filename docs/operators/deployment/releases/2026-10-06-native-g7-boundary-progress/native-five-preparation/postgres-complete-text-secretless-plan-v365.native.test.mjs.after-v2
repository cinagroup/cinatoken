// Review-only PostgreSQL 18.6 proof of the v365 secretless ingress projection.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { computeRouteDataPolicySubjectFingerprintFromRows } from '../../../packages/core/src/route-data-policy.ts';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';

const g='cinatoken_gateway';
const migrations=new URL('../../../packages/core/migrations-postgres/',import.meta.url);
const proposal=name=>new URL(`../../../packages/core/migrations-proposals/postgres/${name}`,import.meta.url);
const reportUrl=new URL('../../../docs/developers/architecture/implementation-evidence/C04-complete-text-secretless-plan-v365-report.json',import.meta.url);
const sha=value=>createHash('sha256').update(value).digest('hex');
const bearer='sk-local-complete-text-v365-bearer';
const lookupHash=`sha256:${sha(bearer)}`;
const originalHash=sha('original-v365-ingress-body');
const finalBody=JSON.stringify({model:'v365-alpha',models:['v365-alpha','v365-beta'],
  messages:[{role:'user',content:'hello'}],max_completion_tokens:300});
const roles={cap:'cinatoken_gateway_request_capability_issuer',
  claim:'cinatoken_gateway_request_capability_claim',
  fragment:'cinatoken_gateway_request_route_ceiling_issuer',
  verifier:'cinatoken_gateway_route_source_verifier',
  complete:'cinatoken_gateway_complete_text_quote_issuer',
  planner:'cinatoken_gateway_complete_text_ingress_planner'};

function connection(cluster,username,password,label) {
  return postgres({host:'127.0.0.1',port:cluster.port,database:'postgres',
    username,password,ssl:false,max:1,prepare:false,fetch_types:false,
    connect_timeout:3,idle_timeout:0,max_lifetime:0,backoff:false,onnotice(){},
    connection:{application_name:`complete-plan-v365-${label}`}});
}
async function denied(promise,code='42501') {
  await assert.rejects(promise,error=>{
    assert.equal((error?.cause??error)?.code,code,String(error));return true;
  });
}

test('v365 direct ingress LOGIN sees only fresh committed quote route IDs',
  {timeout:300_000,skip:!process.env.GATEWAY_NATIVE_PG_BIN},async()=>{
    const cluster=await startNativePostgres();
    const report={status:'RUNNING',cleanup:'PENDING',binaryVersion:cluster.binaryVersion,
      sourceSha256:{},stages:[],limitations:[
        'Review-only PG73 proposal; no formal migration, deployment, remote database or production Worker role changed.',
        'The strict projection supports only committed v360 platform-credential flat-text quotes and does not reserve money or authorize physical send.',
        'The projection can become stale immediately after its transaction; v362 grant and an independent holder must recheck source and quote authority.',
        'The planner LOGIN is separate from the current Proxy runtime, which still owns the shared KEK and broad Provider SELECT. Actual ingress credential isolation requires a separate Worker and database identity.',
        'Table-level source locks are a review proof of a coherent route predicate and are not a production throughput design.',
        'The verifier is trusted to compute the subject fingerprint independently with its credential-aware source. This fixture attests synthetic provider data only.',
        'D1/MySQL parity, Linux CI and real Worker/Hyperdrive behavior are not established by this native local fixture.'
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
      const planner=connection(cluster,roles.planner,passwords.planner,'planner');
      clients.push(migrator,runtime,cap,verifier,complete,planner);
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
      report.sourceSha256.runtimeGrant=sha(await readFile(
        new URL('./grant-postgres-runtime.ts',import.meta.url)));
      const migratorUrl=`postgres://cinatoken_gateway_migrator:${passwords.migrator}`
        +`@127.0.0.1:${cluster.port}/postgres`;
      // Keep original grant calls and rejection checks on the owned PG73 ledger.
      const grantPostgresRuntime = ({ DATABASE_URL }) =>
        grantPg73RuntimeFixture({ cluster, migrator, migratorUrl: DATABASE_URL });
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
        report.sourceSha256[name]=sha(sql);
        await migrator.begin(async tx=>{
          await tx.unsafe(`SET LOCAL ${flag}='reviewed-v1'`);
          await tx.unsafe(sql).simple();
        });
      }
      const planSql=await readFile(proposal('complete-text-secretless-plan-v365.sql'),'utf8');
      report.sourceSha256['complete-text-secretless-plan-v365.sql']=sha(planSql);
      await denied(migrator.begin(tx=>tx.unsafe(planSql).simple()),'P0001');
      await denied(migrator.begin(async tx=>{
        await tx.unsafe(`GRANT SELECT ON ${g}.providers TO ${roles.planner}`);
        await tx.unsafe(`SET LOCAL cinatoken.complete_text_secretless_plan_activation='reviewed-v1'`);
        await tx.unsafe(planSql).simple();
      }),'P0001');
      await migrator.begin(async tx=>{
        await tx.unsafe(`SET LOCAL cinatoken.complete_text_secretless_plan_activation='reviewed-v1'`);
        await tx.unsafe(planSql).simple();
      });
      report.sourceSha256.fixture=sha(await readFile(new URL(import.meta.url)));
      stage('v365-default-off-and-planner-privilege-drift-fail-atomically');

      await denied(runtime.unsafe(`SELECT ${g}.plan_complete_flat_text_quote_v365('x',pg_catalog.gen_random_uuid())`));
      await denied(complete.unsafe(`SELECT ${g}.plan_complete_flat_text_quote_v365('x',pg_catalog.gen_random_uuid())`));
      await denied(planner.unsafe(`SELECT * FROM ${g}.providers`));
      await denied(planner.unsafe(`SELECT api_key FROM ${g}.providers`));
      await denied(planner.unsafe(`SELECT endpoints FROM ${g}.providers`));
      await denied(planner.unsafe(`SELECT provider_ciphertext_sha256
        FROM ${g}.complete_text_quote_routes_v360`));
      await denied(planner.unsafe(`SELECT * FROM ${g}.complete_text_quotes_v360`));
      await denied(planner.unsafe(`SET ROLE cinatoken_gateway_migrator`));
      await denied(planner.unsafe(`SET ROLE cinatoken_gateway_runtime`));
      const [acl]=await migrator.unsafe(`SELECT
        pg_catalog.has_function_privilege('${roles.planner}',
          '${g}.plan_complete_flat_text_quote_v365(text,uuid)','EXECUTE') AS plan_call,
        pg_catalog.has_table_privilege('${roles.planner}',
          '${g}.providers','SELECT') AS provider_select,
        pg_catalog.has_column_privilege('${roles.planner}',
          '${g}.providers','api_key','SELECT') AS api_key_select,
        pg_catalog.has_column_privilege('${roles.planner}',
          '${g}.providers','endpoints','SELECT') AS endpoints_select,
        pg_catalog.has_column_privilege('${roles.planner}',
          '${g}.complete_text_quote_routes_v360',
          'provider_ciphertext_sha256','SELECT') AS ciphertext_hash_select,
        pg_catalog.pg_has_role('${roles.planner}',
          'cinatoken_gateway_migrator','MEMBER') AS migrator_member`);
      assert.deepEqual(acl,{plan_call:true,provider_select:false,
        api_key_select:false,endpoints_select:false,
        ciphertext_hash_select:false,migrator_member:false});
      stage('effective-planner-acl-denies-base-tables-sensitive-columns-and-set-role',{acl});

      await migrator.unsafe(`INSERT INTO ${g}.users(id,email,budget_max)
        VALUES('v365-user','v365@example.invalid',1);
        INSERT INTO ${g}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
        VALUES('v365-workspace','personal','v365-user','Plan','v365','active');`).simple();
      await migrator.unsafe(`INSERT INTO ${g}.api_keys
        (id,key,key_hash,user_id,workspace_id,status)
        VALUES('v365-key',$1,$2,'v365-user','v365-workspace','active')`,
        [`hashref:${lookupHash}`,lookupHash]);
      await migrator.unsafe(`INSERT INTO ${g}.providers(id,name,api_key,endpoints,status)
        VALUES('v365-provider','V365 Provider','enc:v2:provider-secret-sentinel',
          '{"openai":{"chat":{"url":"https://secret.invalid/chat?key=url-secret-sentinel"}}}',
          'active');
        INSERT INTO ${g}.models(id,vendor)
        VALUES('v365-alpha','other'),('v365-beta','other');
        INSERT INTO ${g}.route_pools(id,model_id,route_group,name,status)
        VALUES('v365-pool-a','v365-alpha','default','A','active'),
          ('v365-pool-b','v365-beta','default','B','active');
        INSERT INTO ${g}.model_surfaces
          (id,model_id,route_group,request_protocol,request_operation,
            route_pool_id,status)
        VALUES('v365-surface-a','v365-alpha','default','openai','chat',
            'v365-pool-a','active'),
          ('v365-surface-b','v365-beta','default','openai','chat',
            'v365-pool-b','active');
        INSERT INTO ${g}.model_routes
          (id,model_id,provider_id,provider_model_name,route_pool_id,
            upstream_protocol,upstream_operation,adapter,status)
        VALUES('v365-route-a','v365-alpha','v365-provider','upstream-a',
            'v365-pool-a','openai','chat','passthrough','active'),
          ('v365-route-b','v365-beta','v365-provider','upstream-b',
            'v365-pool-b','openai','chat','passthrough','active');
        INSERT INTO ${g}.model_endpoints
          (id,model_id,provider_id,provider_slug,tag,context_length,pricing,
            evidence_url,verified_by,verified_at,expires_at,status)
        VALUES('v365-endpoint-a','v365-alpha','v365-provider','v365-provider',
            'a',1000,'{"currency":"USD","prompt":"0.000002","completion":"0.000004"}',
            'https://evidence-secret.invalid/a','fixture',now()-interval '1 minute',
            now()+interval '5 minutes','verified'),
          ('v365-endpoint-b','v365-beta','v365-provider','v365-provider',
            'b',1000,'{"currency":"USD","prompt":"0.000004","completion":"0.000008"}',
            'https://evidence-secret.invalid/b','fixture',now()-interval '1 minute',
            now()+interval '5 minutes','verified');
        INSERT INTO ${g}.model_endpoint_routes(endpoint_id,route_target_id)
        VALUES('v365-endpoint-a','v365-route-a'),
          ('v365-endpoint-b','v365-route-b');`).simple();
      const attest=async target=>{
        const [route]=await migrator.unsafe(`SELECT provider_id,provider_model_name,
          custom_params,upstream_protocol,upstream_operation,adapter
          FROM ${g}.model_routes WHERE id=$1`,[target]);
        const [provider]=await migrator.unsafe(`SELECT id,endpoints,api_key,
          shared_channel_type FROM ${g}.providers WHERE id=$1`,[route.provider_id]);
        const fingerprint=await computeRouteDataPolicySubjectFingerprintFromRows(route,provider);
        await migrator.unsafe(`UPDATE ${g}.model_endpoint_routes
          SET subject_fingerprint=$1 WHERE route_target_id=$2`,[fingerprint,target]);
        const [row]=await verifier.unsafe(`SELECT generation::text AS generation
          FROM ${g}.route_source_generations_v359 WHERE route_target_id=$1`,[target]);
        const [result]=await verifier.unsafe(`SELECT ${g}.attest_text_route_source_v359($1,$2,$3) AS value`,
          [target,row.generation,fingerprint]);
        assert.equal(result.value.status,'attested');
      };
      for(const target of ['v365-route-a','v365-route-b']) await attest(target);
      const requestId=`v365-${randomUUID()}`;
      const [issuedRow]=await cap.unsafe(`SELECT ${g}.issue_request_capability_v356($1,$2,$3) AS value`,
        [requestId,bearer,originalHash]);
      assert.equal(issuedRow.value.status,'issued');
      const [quotedRow]=await complete.unsafe(`SELECT ${g}.issue_complete_flat_text_quote_v360($1,$2,$3,$4) AS value`,
        [requestId,issuedRow.value.capability,originalHash,finalBody]);
      assert.equal(quotedRow.value.status,'quoted_complete_subset');
      assert.equal(quotedRow.value.routeCount,2);
      stage('genuine-v360-issuer-committed-two-candidate-quote-and-attestations');

      const quoteId=quotedRow.value.quoteId;
      const plan=async(id=requestId,qid=quoteId)=>{
        const [row]=await planner.unsafe(`SELECT ${g}.plan_complete_flat_text_quote_v365($1,$2) AS value`,
          [id,qid]);return row.value;
      };
      assert.equal((await plan('wrong-request')).status,'not_found');
      assert.equal((await plan(requestId,randomUUID())).status,'not_found');
      const planned=await plan();
      assert.deepEqual(Object.keys(planned).sort(),[
        'candidateCount','expiresAt','finalBodySha256','orderedModelIds',
        'quoteId','requestId','routeCount','routes','status'].sort());
      assert.equal(planned.status,'planned_complete_subset');
      assert.equal(planned.requestId,requestId);
      assert.equal(planned.quoteId,quoteId);
      assert.deepEqual(planned.orderedModelIds,['v365-alpha','v365-beta']);
      assert.equal(planned.candidateCount,2);
      assert.equal(planned.routeCount,2);
      assert.deepEqual(planned.routes.map(r=>[r.candidateIndex,r.modelId,r.routeTargetId]),
        [[0,'v365-alpha','v365-route-a'],[1,'v365-beta','v365-route-b']]);
      assert.ok(planned.routes.every(r=>
        Object.keys(r).sort().join(',')===
        'attestedSourceSha256,candidateIndex,modelId,routeTargetId,sourceGeneration'
        && /^[0-9a-f]{64}$/u.test(r.attestedSourceSha256)
        && /^\d+$/u.test(r.sourceGeneration)));
      const publicJson=JSON.stringify(planned);
      for(const forbidden of ['provider-secret-sentinel','url-secret-sentinel',
        'secret.invalid','evidence-secret.invalid','enc:v2:',
        'providerCiphertextSha256','sourceSnapshot','endpointId','providerId'])
        assert.equal(publicJson.includes(forbidden),false,forbidden);
      stage('bounded-explicit-output-contains-no-provider-secret-url-or-ciphertext');

      // The quote row is insert-only; use transaction-local disabled triggers
      // under the fixture's trusted migrator to prove bounds fail closed.
      await migrator.begin(async tx=>{
        await tx.unsafe(`ALTER TABLE ${g}.complete_text_quote_routes_v360
          DISABLE TRIGGER complete_text_quote_routes_v360_no_mutation`);
        await tx.unsafe(`UPDATE ${g}.complete_text_quote_routes_v360
          SET candidate_index=7 WHERE route_target_id='v365-route-b'`);
        await tx.unsafe(`ALTER TABLE ${g}.complete_text_quote_routes_v360
          ENABLE TRIGGER complete_text_quote_routes_v360_no_mutation`);
      });
      assert.equal((await plan()).status,'stale_manifest');
      await migrator.begin(async tx=>{
        await tx.unsafe(`ALTER TABLE ${g}.complete_text_quote_routes_v360
          DISABLE TRIGGER complete_text_quote_routes_v360_no_mutation`);
        await tx.unsafe(`UPDATE ${g}.complete_text_quote_routes_v360
          SET candidate_index=1 WHERE route_target_id='v365-route-b'`);
        await tx.unsafe(`ALTER TABLE ${g}.complete_text_quote_routes_v360
          ENABLE TRIGGER complete_text_quote_routes_v360_no_mutation`);
      });
      stage('out-of-range-candidate-fails-closed');

      await migrator.unsafe(`INSERT INTO ${g}.byok_keys
        (id,workspace_id,provider,api_key_encrypted,label,sort_order)
        VALUES('v365-private','v365-workspace','v365-provider',
          'enc:v2:private-sentinel','private-key',1)`);
      assert.equal((await plan()).status,'stale');
      await migrator.unsafe(`DELETE FROM ${g}.byok_keys WHERE id='v365-private'`);
      assert.equal((await plan()).status,'planned_complete_subset');
      stage('new-active-private-key-fails-strict-platform-plan-closed');

      await migrator.unsafe(`UPDATE ${g}.providers
        SET api_key='enc:v2:changed-provider-secret' WHERE id='v365-provider'`);
      assert.equal((await plan()).status,'stale_manifest');
      stage('provider-change-invalidates-attested-generation-and-plan');
      await migrator.unsafe(`UPDATE ${g}.providers
        SET api_key='enc:v2:provider-secret-sentinel' WHERE id='v365-provider'`);
      for(const target of ['v365-route-a','v365-route-b']) await attest(target);
      assert.equal((await plan()).status,'stale_manifest');
      stage('provider-ABA-reattest-still-cannot-resurrect-old-quote-generation');

      await migrator.begin(async tx=>{
        await tx.unsafe(`ALTER TABLE ${g}.complete_text_quotes_v360
          DISABLE TRIGGER complete_text_quotes_v360_no_mutation`);
        await tx.unsafe(`UPDATE ${g}.complete_text_quotes_v360
          SET issued_at=now()-interval '2 seconds',
            expires_at=now()-interval '1 second' WHERE quote_id=$1`,[quoteId]);
        await tx.unsafe(`ALTER TABLE ${g}.complete_text_quotes_v360
          ENABLE TRIGGER complete_text_quotes_v360_no_mutation`);
      });
      assert.equal((await plan()).status,'stale');
      stage('expired-quote-rejects-planning-before-source-projection');

      // The broad legacy reconciler must refuse to reopen access after v356.
      await assert.rejects(grantPostgresRuntime({DATABASE_URL:migratorUrl}),
        /Request capability v356 is installed/u);
      const [afterRerun]=await migrator.unsafe(`SELECT
        pg_catalog.has_function_privilege('${roles.planner}',
          '${g}.plan_complete_flat_text_quote_v365(text,uuid)','EXECUTE') AS execute,
        pg_catalog.has_column_privilege('${roles.planner}',
          '${g}.providers','api_key','SELECT') AS key_read,
        pg_catalog.has_column_privilege('${roles.planner}',
          '${g}.providers','endpoints','SELECT') AS url_read`);
      assert.deepEqual(afterRerun,{execute:true,key_read:false,url_read:false});
      stage('runtime-grant-rerun-fails-closed-and-planner-acl-remains-narrow',
        {afterRerun});
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
      process.stdout.write(`complete-text-v365-report=${reportUrl.pathname}\n`);
    }
    if(failure) throw failure;
    assert.equal(report.cleanup,'PASS');
  });
