// Isolated PG18 proof for the review-only v359 freshness fence on v357 fragments.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import postgres from 'postgres';
import { computeRouteDataPolicySubjectFingerprintFromRows } from '../../../packages/core/src/route-data-policy.ts';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';

const gateway = 'cinatoken_gateway';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const capabilityProposal = new URL('../../../packages/core/migrations-proposals/postgres/authenticated-request-capability-login-v356.sql', import.meta.url);
const ceilingProposal = new URL('../../../packages/core/migrations-proposals/postgres/authenticated-text-route-ceiling-issuer-v357.sql', import.meta.url);
const fenceProposal = new URL('../../../packages/core/migrations-proposals/postgres/authenticated-text-route-source-fence-v359.sql', import.meta.url);
const reportUrl = new URL('../../../docs/developers/architecture/implementation-evidence/C04-authenticated-text-route-source-fence-v359-report.json', import.meta.url);
const digest = value => createHash('sha256').update(value).digest('hex');
const bearer = 'sk-local-route-source-v359-bearer';
const bodyHash = digest('synthetic-chat-body-v359');
const lookupHash = `sha256:${digest(bearer)}`;
const capRole = 'cinatoken_gateway_request_capability_issuer';
const claimRole = 'cinatoken_gateway_request_capability_claim';
const quoteRole = 'cinatoken_gateway_request_route_ceiling_issuer';
const verifierRole = 'cinatoken_gateway_route_source_verifier';

function connection(cluster, username, password, label) {
  return postgres({host:'127.0.0.1',port:cluster.port,database:'postgres',
    username,password,ssl:false,max:1,prepare:false,fetch_types:false,
    connect_timeout:3,idle_timeout:0,max_lifetime:0,backoff:false,onnotice() {},
    connection:{application_name:`route-source-v359-${label}`}});
}
async function expectDenied(promise) {
  await assert.rejects(promise,error => {
    assert.equal((error?.cause??error)?.code,'42501',String(error));
    return true;
  });
}
async function expectStaleQuote(promise) {
  await assert.rejects(promise,error => {
    const cause=error?.cause??error;
    assert.equal(cause.code,'23514',String(error));
    assert.equal(cause.constraint_name,'request_text_route_source_freshness_v359');
    return true;
  });
}

test('PG73 direct verifier invalidates and reattests v357 route sources across ABA mutations',
  {timeout:300_000,skip:!process.env.GATEWAY_NATIVE_PG_BIN},async () => {
    const cluster=await startNativePostgres();
    const report={status:'RUNNING',cleanup:'PENDING',binaryVersion:cluster.binaryVersion,
      sourceSha256:{},stages:[],limitations:[
        'Review-only PG73 overlay; no formal migration, deployment, remote DB, Worker binding, or production verifier exists.',
        'The separate verifier LOGIN is trusted to recompute the subject fingerprint from current decrypted provider configuration; SQL only checks its asserted fingerprint against the persisted link under source locks.',
        'This generation covers route, provider, pool, endpoint, and link rows used by a single v357 fragment; it is not a complete request fallback manifest or credential-class proof.',
        'An old fragment remains immutable. No budget hold or egress grant consumes its generation; a future grant must compare it against the live generation under lock.',
        'Concurrent multi-row source mutations can deadlock and abort; an abort never attests stale data.',
        'D1/MySQL parity, Linux CI, old-database lock duration and physical Worker/Hyperdrive behavior remain unproved.'
      ]};
    const stage=(name,detail={})=>report.stages.push({name,result:'PASS',...detail});
    const clients=[];
    let failure;
    try {
      assert.match(cluster.binaryVersion,/PostgreSQL\) 18\.6/u);
      const labels=['migrator','runtime','cap','claim','quote','verifier'];
      const passwords=Object.fromEntries(labels.map(x=>[x,randomBytes(24).toString('hex')]));
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${passwords.migrator}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${passwords.runtime}';
        CREATE ROLE ${capRole} LOGIN NOINHERIT PASSWORD '${passwords.cap}';
        CREATE ROLE ${claimRole} LOGIN NOINHERIT PASSWORD '${passwords.claim}';
        CREATE ROLE ${quoteRole} LOGIN NOINHERIT PASSWORD '${passwords.quote}';
        CREATE ROLE ${verifierRole} LOGIN NOINHERIT PASSWORD '${passwords.verifier}';
        CREATE SCHEMA ${gateway} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime,${capRole},${claimRole},${quoteRole},${verifierRole};
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator=connection(cluster,'cinatoken_gateway_migrator',passwords.migrator,'migrator');
      const runtime=connection(cluster,'cinatoken_gateway_runtime',passwords.runtime,'runtime');
      const cap=connection(cluster,capRole,passwords.cap,'cap');
      const quoteIssuer=connection(cluster,quoteRole,passwords.quote,'quote');
      const verifier=connection(cluster,verifierRole,passwords.verifier,'verifier');
      clients.push(migrator,runtime,cap,quoteIssuer,verifier);
      await migrator.unsafe(`CREATE TABLE ${gateway}.schema_migrations
        (version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`);
      const names=(await readdir(migrations)).filter(x=>x.endsWith('.sql')).sort();
      assert.equal(names.length,73);
      assert.equal(names.at(-1),'0073_recovery_api_key_workspace_lock.sql');
      const corpus=[];
      for(const name of names) {
        const body=await readFile(new URL(name,migrations),'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx=>{
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${gateway}.schema_migrations(version) VALUES($1)`,[name]);
        });
      }
      report.sourceSha256.formalMigrations=digest(corpus.join('\n'));
      report.sourceSha256.runtimeGrant=digest(await readFile(
        new URL('./grant-postgres-runtime.ts',import.meta.url)));
      const migratorUrl=`postgres://cinatoken_gateway_migrator:${passwords.migrator}`
        +`@127.0.0.1:${cluster.port}/postgres`;
      await grantPostgresRuntime({DATABASE_URL:migratorUrl});
      stage('formal-pg73-and-legacy-runtime-grants-installed');

      const capabilitySql=await readFile(capabilityProposal,'utf8');
      const ceilingSql=await readFile(ceilingProposal,'utf8');
      const fenceSql=await readFile(fenceProposal,'utf8');
      report.sourceSha256.capabilityProposal=digest(capabilitySql);
      report.sourceSha256.ceilingProposal=digest(ceilingSql);
      report.sourceSha256.fenceProposal=digest(fenceSql);
      report.sourceSha256.fixture=digest(await readFile(new URL(import.meta.url)));
      await migrator.begin(async tx=>{
        await tx.unsafe("SET LOCAL cinatoken.request_capability_login_activation = 'reviewed-v1'");
        await tx.unsafe(capabilitySql).simple();
      });
      await migrator.begin(async tx=>{
        await tx.unsafe("SET LOCAL cinatoken.request_route_ceiling_activation = 'reviewed-v1'");
        await tx.unsafe(ceilingSql).simple();
      });
      stage('v356-capability-and-v357-one-target-ceiling-installed');

      await migrator.unsafe(`INSERT INTO ${gateway}.users(id,email,budget_max)
        VALUES('v359-user','v359@example.invalid',1);
        INSERT INTO ${gateway}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,status)
        VALUES('v359-workspace','personal','v359-user','Route','v359','active');`).simple();
      await migrator.unsafe(`INSERT INTO ${gateway}.api_keys
        (id,key,key_hash,user_id,workspace_id,status)
        VALUES('v359-key',$1,$2,'v359-user','v359-workspace','active')`,
        [`hashref:${lookupHash}`,lookupHash]);
      await migrator.unsafe(`INSERT INTO ${gateway}.providers
        (id,name,api_key,status) VALUES('v359-provider','V359 Provider','enc:v2:fixture','active');
        INSERT INTO ${gateway}.models(id,vendor) VALUES('v359-model','other');
        INSERT INTO ${gateway}.route_pools
        (id,model_id,route_group,name,status)
        VALUES('v359-pool','v359-model','default','V359 pool','active');
        INSERT INTO ${gateway}.model_routes
        (id,model_id,provider_id,provider_model_name,route_pool_id,
          upstream_protocol,upstream_operation,adapter,status)
        VALUES('v359-target','v359-model','v359-provider','v359-upstream',
          'v359-pool','openai','chat','passthrough','active');
        INSERT INTO ${gateway}.model_endpoints
        (id,model_id,provider_id,provider_slug,tag,context_length,pricing,
          evidence_url,verified_by,verified_at,expires_at,status)
        VALUES('v359-endpoint','v359-model','v359-provider','v359-provider',
          'v359-provider/text',1000,
          '{"currency":"USD","prompt":"0.000002","completion":"0.000004","request":"0.01"}',
          'https://example.invalid/evidence','fixture',now()-interval '1 minute',
          now()+interval '5 minutes','verified');
        INSERT INTO ${gateway}.model_endpoint_routes(endpoint_id,route_target_id)
        VALUES('v359-endpoint','v359-target');`).simple();
      const readSubject=async(source=migrator)=>{
        const [route]=await source.unsafe(`SELECT provider_id,provider_model_name,
          custom_params,upstream_protocol,upstream_operation,adapter
          FROM ${gateway}.model_routes WHERE id='v359-target'`);
        const [provider]=await source.unsafe(`SELECT id,endpoints,api_key,
          shared_channel_type FROM ${gateway}.providers WHERE id='v359-provider'`);
        return computeRouteDataPolicySubjectFingerprintFromRows(route,provider);
      };
      const initialFingerprint=await readSubject();
      await migrator.unsafe(`UPDATE ${gateway}.model_endpoint_routes
        SET subject_fingerprint=$1 WHERE route_target_id='v359-target'`,
        [initialFingerprint]);
      stage('preexisting-valid-looking-link-is-still-unattested');

      await assert.rejects(migrator.begin(tx=>tx.unsafe(fenceSql).simple()),
        /activation or dependency differs/u);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`GRANT UPDATE ON ${gateway}.model_endpoints TO ${verifierRole}`);
        await tx.unsafe("SET LOCAL cinatoken.route_source_fence_activation = 'reviewed-v1'");
        await tx.unsafe(fenceSql).simple();
      }),/activation or dependency differs/u);
      await cluster.admin.unsafe(
        'GRANT cinatoken_gateway_migrator TO cinatoken_gateway_runtime');
      try {
        await assert.rejects(migrator.begin(async tx=>{
          await tx.unsafe("SET LOCAL cinatoken.route_source_fence_activation = 'reviewed-v1'");
          await tx.unsafe(fenceSql).simple();
        }),/activation or dependency differs/u);
      } finally {
        await cluster.admin.unsafe(
          'REVOKE cinatoken_gateway_migrator FROM cinatoken_gateway_runtime');
      }
      await cluster.admin.unsafe(
        `GRANT cinatoken_gateway_migrator TO ${quoteRole}`);
      try {
        await assert.rejects(migrator.begin(async tx=>{
          await tx.unsafe("SET LOCAL cinatoken.route_source_fence_activation = 'reviewed-v1'");
          await tx.unsafe(fenceSql).simple();
        }),/activation or dependency differs/u);
      } finally {
        await cluster.admin.unsafe(
          `REVOKE cinatoken_gateway_migrator FROM ${quoteRole}`);
      }
      await migrator.begin(async tx=>{
        await tx.unsafe("SET LOCAL cinatoken.route_source_fence_activation = 'reviewed-v1'");
        await tx.unsafe(fenceSql).simple();
      });
      stage('default-off-installation-rejects-role-contamination');

      const issueCap=requestId=>cap.unsafe(
        `SELECT ${gateway}.issue_request_capability_v356($1,$2,$3) AS value`,
        [requestId,bearer,bodyHash]).then(rows=>rows[0].value);
      const quote=issued=>quoteIssuer.unsafe(
        `SELECT ${gateway}.issue_request_text_route_ceiling_v357($1,$2,$3,$4) AS value`,
        [issued.requestId,issued.capability,bodyHash,'v359-target'])
        .then(rows=>rows[0].value);
      const attest=(generation,fingerprint)=>verifier.unsafe(
        `SELECT ${gateway}.attest_text_route_source_v359($1,$2,$3) AS value`,
        ['v359-target',generation,fingerprint]).then(rows=>rows[0].value);
      const current=()=>verifier.unsafe(`SELECT generation::text AS generation,
        verified_generation::text AS verified_generation,
        verified_subject_fingerprint AS fingerprint,
        attested_source_sha256 AS source_sha
        FROM ${gateway}.route_source_generations_v359
        WHERE route_target_id='v359-target'`).then(rows=>rows[0]);
      const attestCurrent=async ()=>{
        // The trusted verifier reads the generation before the source rows.
        const generation=Number((await current()).generation);
        const fingerprint=await readSubject(verifier);
        return attest(generation,fingerprint);
      };
      const pending=await issueCap(`pre-attest-${randomUUID()}`);
      assert.equal(pending.status,'issued');
      await expectStaleQuote(quote(pending));
      assert.equal((await current()).generation,'1');
      assert.equal((await current()).verified_generation,null);
      stage('preexisting-link-and-capability-cannot-quote-before-independent-attestation');

      await expectDenied(runtime.unsafe(`SELECT ${gateway}.attest_text_route_source_v359(
        'v359-target',1,$1)`,[initialFingerprint]));
      await expectDenied(runtime.unsafe(`UPDATE ${gateway}.route_source_generations_v359
        SET verified_generation=1 WHERE route_target_id='v359-target'`));
      await expectDenied(verifier.unsafe(`UPDATE ${gateway}.route_source_generations_v359
        SET verified_generation=1 WHERE route_target_id='v359-target'`));
      await expectDenied(quoteIssuer.unsafe(`SELECT * FROM ${gateway}.model_endpoints`));
      assert.equal((await readSubject(verifier)),initialFingerprint);
      await assert.rejects(migrator.unsafe(`TRUNCATE ${gateway}.model_endpoint_routes`),
        error => {
          assert.equal((error?.cause??error)?.constraint_name,'route_source_truncate_v359');
          return true;
        });
      await assert.rejects(migrator.unsafe(`TRUNCATE ${gateway}.models CASCADE`),
        error => {
          assert.equal((error?.cause??error)?.constraint_name,'route_source_truncate_v359');
          return true;
        });
      assert.equal((await attest(2,initialFingerprint)).status,'stale');
      assert.equal((await attest(1,'0'.repeat(64))).status,'stale');
      stage('runtime-cannot-attest-and-row-trigger-bypassing-truncate-is-rejected');

      const firstAttest=await attest(1,initialFingerprint);
      assert.equal(firstAttest.status,'attested');
      assert.match(firstAttest.sourceSha256,/^[0-9a-f]{64}$/u);
      const firstQuote=await quote(pending);
      assert.equal(firstQuote.status,'quoted_fragment');
      const [firstStored]=await migrator.unsafe(`SELECT source_generation_v359::text
        AS generation,attested_source_sha256_v359 AS source_sha
        FROM ${gateway}.request_text_route_ceilings_v357 WHERE request_id=$1`,
        [pending.requestId]);
      assert.deepEqual(firstStored,{generation:'1',source_sha:firstAttest.sourceSha256});
      stage('attested-generation-is-stamped-into-one-target-fragment');

      await runtime.unsafe(`UPDATE ${gateway}.providers
        SET endpoints='{"openai":"https://changed.example.invalid"}'
        WHERE id='v359-provider'`);
      assert.deepEqual(await current(),{generation:'2',verified_generation:null,
        fingerprint:null,source_sha:null});
      await expectStaleQuote(quote(await issueCap(`provider-${randomUUID()}`)));
      await runtime.unsafe(`UPDATE ${gateway}.providers SET endpoints=NULL
        WHERE id='v359-provider'`);
      assert.equal((await current()).generation,'3');
      await expectStaleQuote(quote(await issueCap(`provider-aba-${randomUUID()}`)));
      stage('runtime-provider-mutation-and-ABA-invalidate-even-identical-subject');

      const generation3=Number((await current()).generation);
      const sameFingerprint=await readSubject(verifier);
      assert.equal(sameFingerprint,initialFingerprint);
      assert.equal((await attest(1,sameFingerprint)).status,'stale');
      assert.equal((await attest(generation3,sameFingerprint)).status,'attested');
      const afterAba=await quote(await issueCap(`after-aba-${randomUUID()}`));
      assert.equal(afterAba.status,'quoted_fragment');
      stage('stale-generation-attestation-rejected-fresh-attestation-restores-quote');

      await runtime.unsafe(`UPDATE ${gateway}.model_endpoints
        SET pricing='{"currency":"USD","prompt":"0.000010","completion":"0.000004","request":"0.01"}'
        WHERE id='v359-endpoint'`);
      await expectStaleQuote(quote(await issueCap(`endpoint-${randomUUID()}`)));
      assert.equal((await attestCurrent()).status,'attested');
      const repriced=await quote(await issueCap(`repriced-${randomUUID()}`));
      assert.equal(repriced.status,'quoted_fragment');
      assert.ok(Number(repriced.perAttemptCeilingMicros)>Number(firstQuote.perAttemptCeilingMicros));
      stage('endpoint-price-edit-invalidates-and-requote-uses-new-db-price');

      await runtime.unsafe(`UPDATE ${gateway}.route_pools
        SET name=name WHERE id='v359-pool'`);
      await expectStaleQuote(quote(await issueCap(`pool-noop-${randomUUID()}`)));
      assert.equal((await attestCurrent()).status,'attested');
      await runtime.unsafe(`UPDATE ${gateway}.model_routes
        SET priority=priority WHERE id='v359-target'`);
      await expectStaleQuote(quote(await issueCap(`route-noop-${randomUUID()}`)));
      stage('route-and-pool-no-op-updates-also-invalidate');

      await runtime.unsafe(`UPDATE ${gateway}.model_endpoint_routes
        SET subject_fingerprint=$1 WHERE route_target_id='v359-target'`,
        ['f'.repeat(64)]);
      assert.equal((await attest(Number((await current()).generation),sameFingerprint)).status,
        'stale');
      await expectStaleQuote(quote(await issueCap(`link-${randomUUID()}`)));
      await runtime.unsafe(`UPDATE ${gateway}.model_endpoint_routes
        SET subject_fingerprint=$1 WHERE route_target_id='v359-target'`,
        [sameFingerprint]);
      assert.equal((await attestCurrent()).status,'attested');
      const finalQuote=await quote(await issueCap(`final-${randomUUID()}`));
      assert.equal(finalQuote.status,'quoted_fragment');
      stage('link-fingerprint-edit-invalidates-until-independent-value-restored');

      const [oldFreshness]=await migrator.unsafe(`SELECT
        q.source_generation_v359=f.generation AS old_quote_still_fresh
        FROM ${gateway}.request_text_route_ceilings_v357 q
        JOIN ${gateway}.route_source_generations_v359 f
          ON f.route_target_id=q.route_target_id
        WHERE q.request_id=$1`,[pending.requestId]);
      assert.equal(oldFreshness.old_quote_still_fresh,false);
      await assert.rejects(grantPostgresRuntime({DATABASE_URL:migratorUrl}),
        /Request capability v356 is installed/u);
      stage('old-immutable-fragment-remains-stale-and-broad-grant-rerun-blocked');

      const beforeReinsert=Number((await current()).generation);
      await migrator.unsafe(`DELETE FROM ${gateway}.model_routes
        WHERE id='v359-target'`);
      assert.ok(Number((await current()).generation)>beforeReinsert);
      await migrator.unsafe(`INSERT INTO ${gateway}.model_routes
        (id,model_id,provider_id,provider_model_name,route_pool_id,
          upstream_protocol,upstream_operation,adapter,status)
        VALUES('v359-target','v359-model','v359-provider','v359-upstream',
          'v359-pool','openai','chat','passthrough','active');
        INSERT INTO ${gateway}.model_endpoint_routes
          (endpoint_id,route_target_id,subject_fingerprint)
        VALUES('v359-endpoint','v359-target','${sameFingerprint}');`).simple();
      const afterReinsert=await current();
      assert.ok(Number(afterReinsert.generation)>beforeReinsert);
      assert.equal(afterReinsert.verified_generation,null);
      await expectStaleQuote(quote(await issueCap(`reinsert-${randomUUID()}`)));
      assert.equal((await attestCurrent()).status,'attested');
      assert.equal((await quote(await issueCap(`reinsert-attested-${randomUUID()}`))).status,
        'quoted_fragment');
      stage('route-delete-reinsert-keeps-generation-monotonic-and-requires-reattest');

      const beforeRace=Number((await current()).generation);
      const raceFingerprint=await readSubject(verifier);
      let signalWriterReady;
      const writerReady=new Promise(resolve=>{ signalWriterReady=resolve; });
      let releaseWriter;
      const writerRelease=new Promise(resolve=>{ releaseWriter=resolve; });
      const writer=runtime.begin(async tx=>{
        await tx.unsafe(`UPDATE ${gateway}.providers
          SET name=name WHERE id='v359-provider'`);
        signalWriterReady();
        await writerRelease;
      });
      await writerReady;
      const waitingAttest=attest(beforeRace,raceFingerprint);
      let observedSourceLockWait=false;
      try {
        for(let attempt=0;attempt<20;attempt++) {
          const waits=await cluster.admin.unsafe(`SELECT wait_event_type
            FROM pg_catalog.pg_stat_activity
            WHERE application_name='route-source-v359-verifier'
              AND state='active'`);
          if(waits.some(row=>row.wait_event_type==='Lock')) {
            observedSourceLockWait=true;
            break;
          }
          await delay(25);
        }
      } finally { releaseWriter(); }
      await writer;
      assert.equal(observedSourceLockWait,true);
      assert.equal((await waitingAttest).status,'stale');
      assert.equal((await current()).verified_generation,null);
      stage('attestation-waits-for-source-writer-then-rejects-old-generation');
      report.status='PASS';
    } catch(error) {
      failure=error;report.status='FAIL';
      const cause=error?.cause??error;
      report.failure={code:cause?.code??null,constraint:cause?.constraint_name??null,
        message:String(error?.stack??error).slice(0,4000)};
    } finally {
      await Promise.allSettled(clients.map(sql=>sql.end({timeout:1})));
      try { await cluster.cleanup();report.cleanup='PASS'; }
      catch(error) {
        report.cleanup='FAIL';
        report.cleanupError=String(error?.stack??error).slice(0,1500);
        failure??=error;
      }
      await writeFile(reportUrl,JSON.stringify(report,null,2)+'\n');
      process.stdout.write(`route-source-v359-report=${reportUrl.pathname}\n`);
    }
    if(failure) throw failure;
    assert.equal(report.cleanup,'PASS');
  });
