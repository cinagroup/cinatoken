// Owned PG18 proof of the review-only, one-target DB-derived ceiling fragment.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { computeRouteDataPolicySubjectFingerprintFromRows } from '../../../packages/core/src/route-data-policy.ts';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';

const gateway = 'cinatoken_gateway';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const capabilityProposal = new URL('../../../packages/core/migrations-proposals/postgres/authenticated-request-capability-login-v356.sql', import.meta.url);
const ceilingProposal = new URL('../../../packages/core/migrations-proposals/postgres/authenticated-text-route-ceiling-issuer-v357.sql', import.meta.url);
const reportUrl = new URL('../../../docs/developers/architecture/implementation-evidence/C04-authenticated-text-route-ceiling-v357-report.json', import.meta.url);
const digest = value => createHash('sha256').update(value).digest('hex');
const bearer = 'sk-local-text-route-v357-bearer';
const bodyHash = digest('synthetic-chat-body');
const lookupHash = `sha256:${digest(bearer)}`;
const quoteRole = 'cinatoken_gateway_request_route_ceiling_issuer';

function connection(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false,
    onnotice() {}, connection: { application_name: `route-ceiling-v357-${label}` } });
}
async function expectDenied(promise) {
  await assert.rejects(promise,error => {
    assert.equal((error?.cause??error)?.code,'42501',String(error));
    return true;
  });
}

test('PG73 direct quote issuer derives a one-target text ceiling from DB facts without a caller amount',
  { timeout: 300_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const report = { status:'RUNNING',cleanup:'PENDING',binaryVersion:cluster.binaryVersion,
      sourceSha256:{},stages:[],limitations:[
        'Review-only PG73 proposal; no formal migration, production credential, Worker binding or remote database changed.',
        'This quote fragment covers one simple text route only. It does not prove the complete eligible fallback plan, provider credential identity, selected route, or seller/upstream economics.',
        'No reserve, dispatch grant, buyer critical write, or physical egress check consumes this record.',
        'The v356 body digest is caller asserted; PostgreSQL does not reconstruct HTTP request bytes.',
        'The quoted source snapshot is immutable, but mutable live route and price sources need fresh validation at a future grant.',
        'A persisted route subject fingerprint is required but PostgreSQL does not recompute its freshness after provider or route mutation; no budget hold or dispatch grant may use this fragment.',
        'The ceiling assumes one text attempt uses at most the verified endpoint context for input and for output; other operations and pricing dimensions fail closed.',
        'Only personal Workspace and modern hashref Key rows are supported via the v356 capability.',
        'D1/MySQL parity, Linux CI and Worker/Hyperdrive behavior remain unproved.',
      ]};
    const stage=(name,detail={})=>report.stages.push({name,result:'PASS',...detail});
    const clients=[];
    let failure;
    try {
      assert.match(cluster.binaryVersion,/PostgreSQL\) 18\.6/u);
      const labels=['migrator','runtime','request_capability_issuer',
        'request_capability_claim','request_route_ceiling_issuer'];
      const passwords=Object.fromEntries(labels.map(label=>[label,randomBytes(24).toString('hex')]));
      const capIssuerRole='cinatoken_gateway_request_capability_issuer';
      const capClaimRole='cinatoken_gateway_request_capability_claim';
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${passwords.migrator}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${passwords.runtime}';
        CREATE ROLE ${capIssuerRole} LOGIN NOINHERIT PASSWORD '${passwords.request_capability_issuer}';
        CREATE ROLE ${capClaimRole} LOGIN NOINHERIT PASSWORD '${passwords.request_capability_claim}';
        CREATE ROLE ${quoteRole} LOGIN NOINHERIT PASSWORD '${passwords.request_route_ceiling_issuer}';
        CREATE SCHEMA ${gateway} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime,${capIssuerRole},${capClaimRole},${quoteRole};
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator=connection(cluster,'cinatoken_gateway_migrator',passwords.migrator,'migrator');
      const runtime=connection(cluster,'cinatoken_gateway_runtime',passwords.runtime,'runtime');
      const capIssuer=connection(cluster,capIssuerRole,passwords.request_capability_issuer,'cap-issuer');
      const capClaim=connection(cluster,capClaimRole,passwords.request_capability_claim,'cap-claim');
      const quoteIssuer=connection(cluster,quoteRole,passwords.request_route_ceiling_issuer,'quote-issuer');
      clients.push(migrator,runtime,capIssuer,capClaim,quoteIssuer);
      await migrator.unsafe(`CREATE TABLE ${gateway}.schema_migrations
        (version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`);
      const names=await listPg73Migrations();
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
      // Keep the original grant calls and exact rejection checks on the PG73 ledger.
      const grantPostgresRuntime = ({ DATABASE_URL }) =>
        grantPg73RuntimeFixture({ cluster, migrator, migratorUrl: DATABASE_URL });
      await grantPostgresRuntime({DATABASE_URL:migratorUrl});
      stage('formal-pg73-and-current-runtime-grants-installed');

      const capabilitySql=await readFile(capabilityProposal,'utf8');
      const ceilingSql=await readFile(ceilingProposal,'utf8');
      report.sourceSha256.capabilityProposal=digest(capabilitySql);
      report.sourceSha256.ceilingProposal=digest(ceilingSql);
      report.sourceSha256.fixture=digest(await readFile(new URL(import.meta.url)));
      await migrator.begin(async tx=>{
        await tx.unsafe("SET LOCAL cinatoken.request_capability_login_activation = 'reviewed-v1'");
        await tx.unsafe(capabilitySql).simple();
      });
      await assert.rejects(migrator.begin(tx=>tx.unsafe(ceilingSql).simple()),
        /activation or dependency differs/u);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`GRANT SELECT ON ${gateway}.model_endpoints TO ${quoteRole}`);
        await tx.unsafe("SET LOCAL cinatoken.request_route_ceiling_activation = 'reviewed-v1'");
        await tx.unsafe(ceilingSql).simple();
      }),/activation or dependency differs/u);
      await migrator.begin(async tx=>{
        await tx.unsafe("SET LOCAL cinatoken.request_route_ceiling_activation = 'reviewed-v1'");
        await tx.unsafe(ceilingSql).simple();
      });
      stage('default-off-installation-rejects-contaminated-role-and-installs-explicitly');

      const [acl]=await migrator.unsafe(`SELECT
        pg_catalog.has_function_privilege('${quoteRole}',
          '${gateway}.issue_request_text_route_ceiling_v357(text,text,text,text)','EXECUTE') AS quote_execute,
        pg_catalog.has_function_privilege('${capIssuerRole}',
          '${gateway}.issue_request_text_route_ceiling_v357(text,text,text,text)','EXECUTE') AS cap_issue_execute,
        pg_catalog.has_function_privilege('${capClaimRole}',
          '${gateway}.issue_request_text_route_ceiling_v357(text,text,text,text)','EXECUTE') AS cap_claim_execute,
        pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
          '${gateway}.issue_request_text_route_ceiling_v357(text,text,text,text)','EXECUTE') AS runtime_execute,
        pg_catalog.has_table_privilege('${quoteRole}',
          '${gateway}.request_text_route_ceilings_v357','SELECT,INSERT,UPDATE,DELETE') AS quote_table,
        pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
          '${gateway}.request_text_route_ceilings_v357','SELECT,INSERT,UPDATE,DELETE') AS runtime_table`);
      assert.deepEqual(acl,{quote_execute:true,cap_issue_execute:false,
        cap_claim_execute:false,runtime_execute:false,quote_table:false,
        runtime_table:false});
      await expectDenied(quoteIssuer.unsafe(`SELECT * FROM ${gateway}.model_endpoints`));
      await expectDenied(quoteIssuer.unsafe(`SELECT * FROM ${gateway}.request_text_route_ceilings_v357`));
      await expectDenied(runtime.unsafe(`SELECT ${gateway}.issue_request_text_route_ceiling_v357('x','x','x','x')`));
      stage('direct-quote-login-only-has-function-execute-no-source-or-quote-dml',{acl});

      await migrator.unsafe(`INSERT INTO ${gateway}.users(id,email,budget_max)
        VALUES('v357-user','v357@example.invalid',1);
        INSERT INTO ${gateway}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
        VALUES('v357-workspace','personal','v357-user','Route','v357','active');`).simple();
      await migrator.unsafe(`INSERT INTO ${gateway}.api_keys
        (id,key,key_hash,user_id,workspace_id,status)
        VALUES('v357-key',$1,$2,'v357-user','v357-workspace','active')`,
        [`hashref:${lookupHash}`,lookupHash]);
      await migrator.unsafe(`INSERT INTO ${gateway}.providers
        (id,name,api_key,status) VALUES('v357-provider','V357 Provider','enc:v2:fixture','active');
        INSERT INTO ${gateway}.models(id,vendor) VALUES('v357-model','other');
        INSERT INTO ${gateway}.route_pools
        (id,model_id,route_group,name,status)
        VALUES('v357-pool','v357-model','default','V357 pool','active');
        INSERT INTO ${gateway}.model_routes
        (id,model_id,provider_id,provider_model_name,route_pool_id,
          upstream_protocol,upstream_operation,adapter,status)
        VALUES('v357-target','v357-model','v357-provider','v357-upstream',
          'v357-pool','openai','chat','passthrough','active');
        INSERT INTO ${gateway}.model_endpoints
        (id,model_id,provider_id,provider_slug,tag,context_length,pricing,
          evidence_url,verified_by,verified_at,expires_at,status)
        VALUES('v357-endpoint','v357-model','v357-provider','v357-provider',
          'v357-provider/text',1000,
          '{"currency":"USD","prompt":"0.000002","completion":"0.000004",
            "input_cache_read":"0.000001","input_cache_write":"0.000003",
            "request":"0.01"}',
          'https://example.invalid/evidence','fixture',now()-interval '1 minute',
          now()+interval '5 minutes','verified');
        INSERT INTO ${gateway}.model_endpoint_routes(endpoint_id,route_target_id)
        VALUES('v357-endpoint','v357-target');`).simple();
      const issueCap=requestId=>capIssuer.unsafe(
        `SELECT ${gateway}.issue_request_capability_v356($1,$2,$3) AS value`,
        [requestId,bearer,bodyHash]).then(rows=>rows[0].value);
      const quote=(issued,target='v357-target',capability=issued.capability)=>quoteIssuer.unsafe(
        `SELECT ${gateway}.issue_request_text_route_ceiling_v357($1,$2,$3,$4) AS value`,
        [issued.requestId,capability,bodyHash,target]).then(rows=>rows[0].value);
      const issued=await issueCap(`v357-${randomUUID()}`);
      assert.equal(issued.status,'issued');
      assert.equal((await quote(issued,'v357-target',randomUUID()+randomUUID())).status,'unauthorized');
      assert.equal((await quoteIssuer.unsafe(
        `SELECT ${gateway}.issue_request_text_route_ceiling_v357($1,$2,$3,$4) AS value`,
        [issued.requestId,issued.capability,digest('other-body'),'v357-target']))[0].value.status,
        'unauthorized');
      assert.equal((await quote(issued,'missing-target')).status,'unsupported');
      assert.equal((await quote(issued)).status,'unsupported');
      const [routeSubject]=await migrator.unsafe(`SELECT provider_id,
        provider_model_name,custom_params,upstream_protocol,
        upstream_operation,adapter FROM ${gateway}.model_routes
        WHERE id='v357-target'`);
      const [providerSubject]=await migrator.unsafe(`SELECT id,endpoints,api_key,
        shared_channel_type FROM ${gateway}.providers WHERE id='v357-provider'`);
      const subjectFingerprint=await computeRouteDataPolicySubjectFingerprintFromRows(
        routeSubject,providerSubject);
      await migrator.unsafe(`UPDATE ${gateway}.model_endpoint_routes
        SET subject_fingerprint=$1 WHERE endpoint_id='v357-endpoint'
          AND route_target_id='v357-target'`,[subjectFingerprint]);
      stage('missing-route-subject-fingerprint-fails-closed-before-quote');
      const result=await quote(issued);
      assert.equal(result.status,'quoted_fragment');
      assert.equal(Number(result.perAttemptCeilingMicros),17001);
      assert.equal(Number(result.threeAttemptCeilingMicros),51003);
      assert.equal((await quote(issued)).status,'stale');
      const [stored]=await migrator.unsafe(`SELECT quote_id::text AS quote_id,
        per_attempt_ceiling_micros::text AS per_attempt,
        three_attempt_ceiling_micros::text AS three_attempt,
        source_snapshot,source_sha256
        FROM ${gateway}.request_text_route_ceilings_v357 WHERE request_id=$1`,
        [issued.requestId]);
      assert.equal(stored.quote_id,result.quoteId);
      assert.equal(stored.per_attempt,'17001');
      assert.equal(stored.three_attempt,'51003');
      assert.equal(stored.source_sha256,result.sourceSha256);
      assert.equal(stored.source_snapshot.pricing.input_cache_write,'0.000003');
      assert.equal(stored.source_snapshot.persistedRouteSubjectFingerprint,
        subjectFingerprint);
      assert.equal(JSON.stringify(stored.source_snapshot).includes(bearer),false);
      assert.equal((await capClaim.unsafe(`SELECT ${gateway}.claim_request_capability_v356($1,$2,$3) AS value`,
        [issued.requestId,issued.capability,bodyHash]))[0].value.status,'already_claimed');
      stage('one-shot-bearer-capability-binds-db-derived-17001-and-51003-micros');

      await migrator.unsafe(`UPDATE ${gateway}.model_endpoints
        SET max_prompt_tokens=1500,max_completion_tokens=2000
        WHERE id='v357-endpoint'`);
      const largerCapacities=await quote(await issueCap(`larger-capacities-${randomUUID()}`));
      assert.equal(largerCapacities.status,'quoted_fragment');
      assert.equal(Number(largerCapacities.perAttemptCeilingMicros),22501);
      assert.equal(Number(largerCapacities.threeAttemptCeilingMicros),67503);
      stage('declared-capacities-above-context-increase-db-derived-ceiling');

      await migrator.unsafe(`UPDATE ${gateway}.model_endpoints
        SET pricing='{"currency":"USD","prompt":"0.000010","completion":"0.000004"}'
        WHERE id='v357-endpoint'`);
      const [afterSourceMutation]=await migrator.unsafe(`SELECT
        source_snapshot->'pricing'->>'prompt' AS quoted_prompt,
        (SELECT pricing::jsonb->>'prompt' FROM ${gateway}.model_endpoints
          WHERE id='v357-endpoint') AS live_prompt
        FROM ${gateway}.request_text_route_ceilings_v357 WHERE request_id=$1`,[issued.requestId]);
      assert.equal(afterSourceMutation.quoted_prompt,'0.000002');
      assert.equal(afterSourceMutation.live_prompt,'0.000010');
      await assert.rejects(migrator.unsafe(`UPDATE ${gateway}.request_text_route_ceilings_v357
        SET per_attempt_ceiling_micros=1 WHERE request_id=$1`,[issued.requestId]),
        /insert-only/u);
      await assert.rejects(migrator.unsafe(`DELETE FROM ${gateway}.request_text_route_ceilings_v357
        WHERE request_id=$1`,[issued.requestId]),/insert-only/u);
      stage('source-change-does-not-rewrite-insert-only-quote-fragment');

      await migrator.unsafe(`UPDATE ${gateway}.users
        SET charged_cost_factors='{"v357-model":2}' WHERE id='v357-user'`);
      assert.equal((await quote(await issueCap(`factor-${randomUUID()}`))).status,'unsupported');
      await migrator.unsafe(`UPDATE ${gateway}.users
        SET charged_cost_factors=NULL WHERE id='v357-user'`);
      await migrator.unsafe(`UPDATE ${gateway}.model_routes
        SET price_override='{"charged_factor":2}' WHERE id='v357-target'`);
      assert.equal((await quote(await issueCap(`override-${randomUUID()}`))).status,'unsupported');
      await migrator.unsafe(`UPDATE ${gateway}.model_routes
        SET price_override=NULL WHERE id='v357-target'`);
      await migrator.unsafe(`UPDATE ${gateway}.model_endpoints
        SET pricing='{"currency":"USD","prompt":"0","completion":"0","image":"1"}'
        WHERE id='v357-endpoint'`);
      assert.equal((await quote(await issueCap(`image-${randomUUID()}`))).status,'unsupported');
      stage('user-factor-route-override-and-multimedia-price-fail-closed');

      await migrator.unsafe(`UPDATE ${gateway}.model_endpoints
        SET pricing='{"prompt":"0","completion":"0"}'
        WHERE id='v357-endpoint'`);
      assert.equal((await quote(await issueCap(`missing-currency-${randomUUID()}`))).status,
        'unsupported');
      await migrator.unsafe(`UPDATE ${gateway}.model_endpoints
        SET pricing='{"currency":null,"prompt":"0","completion":"0"}'
        WHERE id='v357-endpoint'`);
      assert.equal((await quote(await issueCap(`null-currency-${randomUUID()}`))).status,
        'unsupported');
      stage('missing-or-null-currency-cannot-produce-free-usd-fragment');

      await migrator.unsafe(`UPDATE ${gateway}.model_endpoints
        SET pricing='{"currency":"USD","prompt":"0","completion":"0"}'
        WHERE id='v357-endpoint'`);
      const free=await quote(await issueCap(`free-${randomUUID()}`));
      assert.equal(free.status,'quoted_fragment');
      assert.equal(Number(free.perAttemptCeilingMicros),0);
      assert.equal(Number(free.threeAttemptCeilingMicros),0);
      stage('zero-is-derived-only-from-zero-db-prices');

      const revokedIssued=await issueCap(`revoke-${randomUUID()}`);
      await migrator.unsafe(`UPDATE ${gateway}.api_keys SET status='revoked'
        WHERE id='v357-key'`);
      await migrator.unsafe(`UPDATE ${gateway}.api_keys SET status='active'
        WHERE id='v357-key'`);
      assert.equal((await quote(revokedIssued)).status,'stale');
      const [noRevokedQuote]=await migrator.unsafe(`SELECT count(*)::int AS n
        FROM ${gateway}.request_text_route_ceilings_v357 WHERE request_id=$1`,
        [revokedIssued.requestId]);
      assert.equal(noRevokedQuote.n,0);
      stage('key-revocation-reactivation-invalidates-unconsumed-quote-capability');

      await migrator.unsafe(`UPDATE ${gateway}.model_endpoints
        SET expires_at=now()-interval '1 second' WHERE id='v357-endpoint'`);
      assert.equal((await quote(await issueCap(`expired-${randomUUID()}`))).status,'stale');
      stage('expired-endpoint-evidence-cannot-produce-fragment');

      const [shape]=await migrator.unsafe(`SELECT
        (SELECT pronargs FROM pg_catalog.pg_proc WHERE oid=
          '${gateway}.issue_request_text_route_ceiling_v357(text,text,text,text)'::regprocedure) AS issue_args,
        (SELECT count(*)::int FROM pg_catalog.pg_attribute
          WHERE attrelid='${gateway}.request_text_route_ceilings_v357'::regclass
            AND attnum>0 AND NOT attisdropped AND attname LIKE '%ceiling_micros') AS derived_amount_columns`);
      assert.deepEqual(shape,{issue_args:4,derived_amount_columns:2});
      await assert.rejects(grantPostgresRuntime({DATABASE_URL:migratorUrl}),
        /Request capability v356 is installed/u);
      stage('no-numeric-function-arguments-and-legacy-broad-grant-remains-blocked',{shape});
      report.status='PASS';
    } catch(error) {
      failure=error;report.status='FAIL';
      const cause=error?.cause??error;
      report.failure={code:cause?.code??null,constraint:cause?.constraint_name??null,
        message:String(error?.stack??error).slice(0,4000)};
    } finally {
      await Promise.allSettled(clients.map(sql=>sql.end({timeout:1})));
      try { await cluster.cleanup();report.cleanup='PASS'; }
      catch(error) {report.cleanup='FAIL';report.cleanupError=String(error?.stack??error).slice(0,1500);failure??=error;}
      await writeFile(reportUrl,JSON.stringify(report,null,2)+'\n');
      process.stdout.write(`request-route-ceiling-v357-report=${reportUrl.pathname}\n`);
    }
    if(failure) throw failure;
    assert.equal(report.cleanup,'PASS');
  });
