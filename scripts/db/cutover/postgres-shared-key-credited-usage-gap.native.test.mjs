// Review-only C04.7 gap fixture. Owns a fresh loopback PostgreSQL cluster.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { listPg73Migrations } from './pg73-native-fixture.mjs';

const root = new URL('../../../', import.meta.url);
const migrations = new URL('packages/core/migrations-postgres/', root);
const paths = {
  quote: new URL('packages/core/migrations-proposals/postgres/shared-key-quote-versions.sql', root),
  dispatch: new URL('packages/core/migrations-proposals/postgres/shared-key-dispatch-quote-attempts.sql', root),
  outbox: new URL('packages/core/migrations-proposals/postgres/shared-key-economic-outbox.sql', root),
  consumer: new URL('packages/core/migrations-proposals/postgres/shared-key-snapshot-earning-consumer.sql', root),
  audit: new URL('packages/core/migrations-proposals/postgres/shared-key-credited-usage-gap-audit.sql', root),
  legacyRebuild: new URL('packages/core/src/db/postgres/portal-marketplace.impl.ts', root),
  native: new URL(import.meta.url),
};
const resultPath = new URL('docs/developers/architecture/implementation-evidence/C04-postgres-credited-usage-gap-v342-results.json', root);
const sha = value => createHash('sha256').update(value).digest('hex');
const failureInfo = error => ({code:error?.code??null,constraint:error?.constraint_name??null,
  message:String(error?.message??error).slice(0,400)});
function client(cluster, username, password, label) {
  return postgres({host:'127.0.0.1',port:cluster.port,database:'postgres',username,password,
    ssl:false,max:1,prepare:false,fetch_types:false,connect_timeout:3,
    idle_timeout:0,max_lifetime:0,backoff:false,onnotice(){},
    connection:{application_name:`cinatoken-credited-usage-gap-v342-${label}`}});
}
async function insertObject(sql, table, row) {
  const names=Object.keys(row);
  await sql.unsafe(`INSERT INTO ${table} (${names.join(',')}) VALUES
    (${names.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));
}
async function insertLog(tx,id) {
  await tx.unsafe(`INSERT INTO cinatoken_gateway.api_key_request_logs
    (id,user_id,api_key_id,workspace_id,charged_cost,budget_charged_micros,
      input_tokens,output_tokens,cache_read_tokens,cache_write_tokens)
    VALUES ($1,'gap-buyer','gap-api-key','gap-workspace',10,10000000,
      1000000,2000000,0,0)`,[id]);
}
function event(id, certainty='confirmed') {
  return {event_id:id,request_log_id:id,event_type:'shared_key_usage_settled',
    event_version:1,buyer_user_id:'gap-buyer',buyer_api_key_id:'gap-api-key',
    workspace_id:'gap-workspace',buyer_charge_basis:'actual',
    buyer_usage_certainty:'actual',buyer_charged_cost:'10.000000',
    buyer_budget_charged_micros:10000000,buyer_input_tokens:1000000,
    buyer_output_tokens:2000000,buyer_cache_read_tokens:0,
    buyer_cache_write_tokens:0,attempt_count:1,event_certainty:certainty};
}
function outcome(id,claim, uncertain=false) {
  return {event_id:id,request_log_id:id,attempt_id:claim.attempt_id,
    attempt_index:claim.attempt_index,shared_key_id:claim.shared_key_id,
    transition_id:claim.transition_id,quote_version_id:claim.quote_version_id,
    usage_certainty:uncertain?'unknown':'actual',
    input_tokens:uncertain?null:1000000,output_tokens:uncertain?null:2000000,
    cache_read_tokens:uncertain?null:0,cache_write_tokens:uncertain?null:0,
    provider_cost_certainty:uncertain?'unknown':'actual',
    provider_cost_micros:uncertain?null:2000000,
    evidence_kind:uncertain?'timeout':'provider_usage',
    evidence_sha256:uncertain?null:'b'.repeat(64),
    observed_at:new Date().toISOString()};
}

test('native PG18 C04.7 audit proves economic seller credit can outlive stale legacy-only stats',
  {timeout:300_000,skip:!process.env.GATEWAY_NATIVE_PG_BIN},async()=>{
    const cluster=await startNativePostgres();
    const report={status:'RUNNING',cleanup:'PENDING',binaryVersion:cluster.binaryVersion,
      scope:'owned loopback PG18.6, exact PG73 plus v338/v339/v340 review proposals',
      sourceSha256:{},stages:[],limitations:[
        'Read-only audit only; no canonical projection, worker, reader cutover, or production activation.',
        'The audit scans one key history inside a read-only snapshot. Large-history keyset backfill and incremental repair need a separately reviewed write-side contract.',
        'The legacy-only rebuild is reproduced with its exact SQL aggregate, not invoked through the TypeScript repository runtime.',
      ]};
    const stage=(name,detail={})=>report.stages.push({name,result:'PASS',...detail});
    const clients=[];
    let failure;
    try {
      assert.match(cluster.binaryVersion,/PostgreSQL\) 18\.6/);
      const migratorPassword=randomBytes(24).toString('hex');
      const runtimePassword=randomBytes(24).toString('hex');
      const producerPassword=randomBytes(24).toString('hex');
      const consumerPassword=randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${migratorPassword}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}';
        CREATE ROLE cinatoken_gateway_shared_quote_attempt_producer LOGIN PASSWORD '${producerPassword}';
        CREATE ROLE cinatoken_gateway_shared_earning_consumer LOGIN PASSWORD '${consumerPassword}';
        CREATE SCHEMA cinatoken_gateway AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime,cinatoken_gateway_shared_quote_attempt_producer,
          cinatoken_gateway_shared_earning_consumer;
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator=client(cluster,'cinatoken_gateway_migrator',migratorPassword,'migrator');
      const runtime=client(cluster,'cinatoken_gateway_runtime',runtimePassword,'runtime');
      const producer=client(cluster,'cinatoken_gateway_shared_quote_attempt_producer',producerPassword,'producer');
      const consumerA=client(cluster,'cinatoken_gateway_shared_earning_consumer',consumerPassword,'consumer-a');
      const consumerB=client(cluster,'cinatoken_gateway_shared_earning_consumer',consumerPassword,'consumer-b');
      clients.push(migrator,runtime,producer,consumerA,consumerB);
      await migrator.unsafe(`CREATE TABLE cinatoken_gateway.schema_migrations
        (version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`);
      const files = await listPg73Migrations();
      assert.equal(files.length,73);
      const corpus=[];
      for(const name of files) {
        const body=await readFile(new URL(name,migrations),'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx=>{
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO cinatoken_gateway.schema_migrations(version)
            VALUES ($1)`,[name]);
        });
      }
      stage('formal-pg73-installed');
      const bodies={};
      for(const [name,path] of Object.entries(paths)) bodies[name]=await readFile(path,'utf8');
      report.sourceSha256={formalMigrationCorpus:sha(corpus.join('\n')),
        quoteProposal:sha(bodies.quote),dispatchProposal:sha(bodies.dispatch),
        outboxProposal:sha(bodies.outbox),consumerProposal:sha(bodies.consumer),
        auditSql:sha(bodies.audit),legacyRebuildSource:sha(bodies.legacyRebuild),
        nativeFixture:sha(bodies.native)};
      assert.match(bodies.legacyRebuild,/FROM cinatoken_gateway\.shared_key_earnings WHERE shared_key_id = \$1/);
      assert.doesNotMatch(bodies.legacyRebuild.slice(
        bodies.legacyRebuild.indexOf('async rebuildSharedKeyUsageFromEarnings('),
        bodies.legacyRebuild.indexOf('async creditEarningBalance(')),
        /shared_key_attempt_consumptions/);
      stage('legacy-rebuild-source-pinned-to-earnings-only');
      for(const [name,flag] of [
        ['quote','cinatoken.shared_key_quote_versions_activation'],
        ['dispatch','cinatoken.shared_quote_attempt_activation'],
        ['outbox','cinatoken.shared_key_economic_outbox_activation'],
        ['consumer','cinatoken.shared_key_snapshot_consumer_activation']]) {
        await migrator.begin(async tx=>{
          await tx.unsafe(`SET LOCAL ${flag} = '${name==='quote'?'reviewed-v2':'reviewed-v1'}'`);
          await tx.unsafe(bodies[name]).simple();
        });
      }
      stage('review-proposals-installed-with-exact-activation');
      await migrator.unsafe(`INSERT INTO cinatoken_gateway.users(id,email) VALUES
          ('gap-seller','gap-seller@example.invalid'),
          ('gap-buyer','gap-buyer@example.invalid');
        INSERT INTO cinatoken_gateway.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,is_default,default_scope_key)
          VALUES ('gap-workspace','personal','gap-buyer','Default','default',
            true,'personal:gap-buyer');
        INSERT INTO cinatoken_gateway.api_keys(id,key,user_id,workspace_id)
          VALUES ('gap-api-key','synthetic-api-key','gap-buyer','gap-workspace');
        INSERT INTO cinatoken_gateway.shared_keys
          (id,seller_user_id,channel_type,api_key,key_fingerprint,status)
          VALUES ('gap-key','gap-seller','openai','synthetic-upstream-key',
            'gap-fingerprint','active');`).simple();
      await insertObject(migrator,'cinatoken_economic_quotes.shared_key_quote_versions',{
        version_id:'gap-q1',shared_key_id:'gap-key',seller_user_id:'gap-seller',
        input_price_per_million:'1.250000',output_price_per_million:'2.500000',
        cache_read_price_per_million:'0.100000',cache_write_price_per_million:'0.200000',
        commission_rate:'0.100000',currency:'USD',price_unit:'per_million_tokens',
        billing_mode:'shared_seller_key',entitlement_version:'synthetic-entitlement-v1'});
      await migrator.unsafe(`INSERT INTO cinatoken_economic_quotes.shared_key_quote_transitions
        (transition_id,shared_key_id,supersedes_transition_id,transition_kind,
          quote_version_id,seller_user_id)
        VALUES ('gap-t1','gap-key',NULL,'activate','gap-q1','gap-seller')`);
      await migrator.unsafe(`INSERT INTO cinatoken_gateway.user_earnings(user_id)
        VALUES ('gap-seller')`);
      stage('seller-buyer-and-quote-seeded');

      await migrator.begin(async tx=>{
        await insertLog(tx,'gap-legacy');
        await tx.unsafe(`INSERT INTO cinatoken_gateway.shared_key_earnings
          (id,request_log_id,shared_key_id,seller_user_id,
            input_tokens,output_tokens,gross_amount,platform_fee,net_amount,
            created_at)
          VALUES ('gap-legacy-earning','gap-legacy','gap-key','gap-seller',
            10,20,2,0,2,'2026-09-24T00:00:00Z')`);
      });
      const claim=async id=>(await producer.unsafe(`SELECT * FROM
        cinatoken_economic_quotes.claim_shared_key_dispatch_quote_attempt(
          $1,$2,1,'gap-key','synthetic-target')`,[randomUUID(),id]))[0];
      const settle=async(id,uncertain=false)=>{
        const c=await claim(id);
        await migrator.begin(async tx=>{
          await insertLog(tx,id);
          await insertObject(tx,'cinatoken_economic_outbox.shared_key_economic_events',
            event(id,uncertain?'unresolved':'confirmed'));
          await insertObject(tx,'cinatoken_economic_outbox.shared_key_economic_event_attempts',
            outcome(id,c,uncertain));
        });
        return c;
      };
      await settle('gap-economic');
      const credit=(await consumerA.unsafe(`SELECT * FROM
        cinatoken_economic_consumer.consume_shared_key_economic_event('gap-economic')`))[0];
      assert.equal(credit.out_net_micros,'5625000');
      await settle('gap-pending',true);
      const pending=(await consumerA.unsafe(`SELECT * FROM
        cinatoken_economic_consumer.consume_shared_key_economic_event('gap-pending')`))[0];
      assert.equal(pending.out_decision,'pending_manual');
      stage('legacy-credit-economic-credit-and-pending-manual-committed');

      const audit=async()=>migrator.begin(async tx=>{
        await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await tx.unsafe(`SET LOCAL cinatoken.shared_key_stats_audit_key_id = 'gap-key'`);
        return (await tx.unsafe(bodies.audit))[0];
      });
      const first=await audit();
      assert.equal(first.legacy_credited_rows,'1');
      assert.equal(first.economic_credited_attempts,'1');
      assert.equal(first.pending_manual_attempts,'1');
      assert.equal(first.cross_source_request_log_conflicts,'0');
      assert.equal(first.credited_input_tokens,'1000010');
      assert.equal(first.credited_output_tokens,'2000020');
      assert.equal(first.credited_earned_total,'7.625000');
      assert.equal(first.projected_earned_total,'0.000000');
      assert.equal(first.projection_differs_from_credited_details,true);
      stage('read-only-audit-detects-committed-economic-credit-missing-from-key',{
        projected:first.projected_earned_total,credited:first.credited_earned_total});

      // Exact aggregate and field assignment used by the pinned legacy TS path.
      await migrator.unsafe(`UPDATE cinatoken_gateway.shared_keys AS sk
        SET served_input_tokens = totals.input_tokens,
          served_output_tokens = totals.output_tokens,
          earned_total = totals.net_amount,
          last_used_at = totals.last_used_at,
          updated_at = pg_catalog.clock_timestamp()
        FROM (SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(net_amount), 0) AS net_amount,
          MAX(created_at) AS last_used_at
          FROM cinatoken_gateway.shared_key_earnings WHERE shared_key_id = 'gap-key'
        ) AS totals WHERE sk.id = 'gap-key'`);
      const afterRebuild=await audit();
      assert.equal(afterRebuild.projected_earned_total,'2.000000');
      assert.equal(afterRebuild.credited_earned_total,'7.625000');
      assert.equal(afterRebuild.projection_differs_from_credited_details,true);
      stage('legacy-only-rebuild-still-omits-economic-credit');

      await settle('gap-economic-2');
      await settle('gap-economic-3');
      const [credit2,credit3]=await Promise.all([
        consumerA.unsafe(`SELECT * FROM cinatoken_economic_consumer.
          consume_shared_key_economic_event('gap-economic-2')`),
        consumerB.unsafe(`SELECT * FROM cinatoken_economic_consumer.
          consume_shared_key_economic_event('gap-economic-3')`),
      ]);
      assert.equal(credit2[0].out_net_micros,'5625000');
      assert.equal(credit3[0].out_net_micros,'5625000');
      const afterConcurrent=await audit();
      assert.equal(afterConcurrent.economic_credited_attempts,'3');
      assert.equal(afterConcurrent.credited_earned_total,'18.875000');
      assert.equal(afterConcurrent.projected_earned_total,'2.000000');
      const balance=(await migrator.unsafe(`SELECT balance_micros::text AS n
        FROM cinatoken_gateway.user_earnings WHERE user_id='gap-seller'`))[0].n;
      assert.equal(balance,'18875000');
      stage('concurrent-economic-credits-remain-durable-while-projection-stays-stale');

      await migrator.unsafe(`INSERT INTO cinatoken_gateway.users(id,email)
        VALUES ('gap-new-seller','gap-new-seller@example.invalid')`);
      await migrator.begin(async tx=>{
        await tx.unsafe(`UPDATE cinatoken_gateway.shared_keys
          SET seller_user_id='gap-new-seller' WHERE id='gap-key'`);
        await insertObject(tx,'cinatoken_economic_quotes.shared_key_quote_versions',{
          version_id:'gap-q2',shared_key_id:'gap-key',seller_user_id:'gap-new-seller',
          input_price_per_million:'1.250000',output_price_per_million:'2.500000',
          cache_read_price_per_million:'0.100000',
          cache_write_price_per_million:'0.200000',
          commission_rate:'0.100000',currency:'USD',
          price_unit:'per_million_tokens',billing_mode:'shared_seller_key',
          entitlement_version:'synthetic-entitlement-v2'});
        await tx.unsafe(`INSERT INTO cinatoken_economic_quotes.shared_key_quote_transitions
          (transition_id,shared_key_id,supersedes_transition_id,transition_kind,
            quote_version_id,seller_user_id)
          VALUES ('gap-t2','gap-key','gap-t1','activate','gap-q2','gap-new-seller')`);
      });
      const afterTransfer=await audit();
      assert.equal(afterTransfer.current_seller_user_id,'gap-new-seller');
      assert.equal(afterTransfer.credited_rows_for_other_sellers,'4');
      assert.equal(afterTransfer.credited_earned_total,'18.875000');
      stage('owner-transfer-audit-keeps-historic-seller-snapshots');

      const auditObjects=await migrator.unsafe(`SELECT
        pg_catalog.to_regclass('cinatoken_gateway.shared_key_stats_contributions') IS NULL
          AS no_contribution_store,
        pg_catalog.to_regprocedure('cinatoken_gateway.rebuild_shared_key_credited_usage(text)') IS NULL
          AS no_rebuild_entrypoint`);
      assert.deepEqual(auditObjects[0],{no_contribution_store:true,no_rebuild_entrypoint:true});
      await assert.rejects(runtime.unsafe(`SELECT * FROM
        cinatoken_economic_consumer.shared_key_attempt_consumptions`),
        error=>error?.code==='42501');
      stage('audit-installs-no-write-object-and-runtime-cannot-read-private-details');
      report.status='PASS';
    } catch(error) {
      failure=error;report.status='FAIL';report.error=failureInfo(error);
    } finally {
      await Promise.allSettled(clients.map(sql=>sql.end({timeout:1})));
      try {await cluster.cleanup();report.cleanup='PASS';}
      catch(error) {report.cleanup='FAIL';report.cleanupError=failureInfo(error);failure??=error;}
      await writeFile(resultPath,JSON.stringify(report,null,2)+'\n');
    }
    if(failure) throw failure;
  });
