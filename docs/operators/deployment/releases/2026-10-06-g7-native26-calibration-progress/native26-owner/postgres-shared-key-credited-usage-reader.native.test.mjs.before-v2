// Review-only reader cutover fixture. Uses a fresh, owned loopback PG cluster.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';

const root = new URL('../../../', import.meta.url);
const migrationDir = new URL('packages/core/migrations-postgres/', root);
const namedProposals = {
  quote: 'shared-key-quote-versions.sql',
  dispatch: 'shared-key-dispatch-quote-attempts.sql',
  outbox: 'shared-key-economic-outbox.sql',
  consumer: 'shared-key-snapshot-earning-consumer.sql',
  guard: 'shared-key-earnings-history-guard.sql',
  store: 'shared-key-credited-usage-store.sql',
  reader: 'shared-key-credited-usage-reader.sql',
};
const resultPath = new URL('docs/developers/architecture/implementation-evidence/C04-postgres-credited-usage-reader-v344-results.json',root);
const digest = body => createHash('sha256').update(body).digest('hex');
const errorInfo = error => ({code:error?.code??null,constraint:error?.constraint_name??null,
  message:String(error?.message??error).slice(0,450)});
function connect(cluster,username,password,label) {
  return postgres({host:'127.0.0.1',port:cluster.port,database:'postgres',username,password,
    ssl:false,max:1,prepare:false,fetch_types:false,connect_timeout:3,
    idle_timeout:0,max_lifetime:0,backoff:false,onnotice(){},
    connection:{application_name:`cinatoken-credited-usage-reader-v344-${label}`}});
}
async function apply(sql,body,flag,value='reviewed-v1') {
  await sql.begin(async tx=>{
    await tx.unsafe(`SET LOCAL ${flag} = '${value}'`);
    await tx.unsafe(body).simple();
  });
}
async function insertLog(tx,id) {
  await tx.unsafe(`INSERT INTO cinatoken_gateway.api_key_request_logs
    (id,user_id,api_key_id,workspace_id,charged_cost,budget_charged_micros,
      input_tokens,output_tokens,cache_read_tokens,cache_write_tokens)
    VALUES ($1,'reader-buyer','reader-api-key','reader-workspace',10,10000000,
      1000000,2000000,0,0)`,[id]);
}
async function economicEvent(migrator,producer,consumer,id,transition,quote,pending=false) {
  const claim=(await producer.unsafe(`SELECT * FROM
    cinatoken_economic_quotes.claim_shared_key_dispatch_quote_attempt(
      $1,$2,1,'reader-key','synthetic-target')`,[randomUUID(),id]))[0];
  assert.equal(claim.transition_id,transition);
  assert.equal(claim.quote_version_id,quote);
  await migrator.begin(async tx=>{
    await insertLog(tx,id);
    await tx.unsafe(`INSERT INTO cinatoken_economic_outbox.shared_key_economic_events
      (event_id,request_log_id,event_type,event_version,buyer_user_id,
        buyer_api_key_id,workspace_id,buyer_charge_basis,buyer_usage_certainty,
        buyer_charged_cost,buyer_budget_charged_micros,buyer_input_tokens,
        buyer_output_tokens,buyer_cache_read_tokens,buyer_cache_write_tokens,
        attempt_count,event_certainty)
      VALUES ($1,$1,'shared_key_usage_settled',1,'reader-buyer','reader-api-key',
        'reader-workspace','actual','actual',10,10000000,1000000,2000000,0,0,
        1,$2)`,[id,pending?'unresolved':'confirmed']);
    await tx.unsafe(`INSERT INTO cinatoken_economic_outbox.shared_key_economic_event_attempts
      (event_id,request_log_id,attempt_id,attempt_index,shared_key_id,
        transition_id,quote_version_id,usage_certainty,input_tokens,
        output_tokens,cache_read_tokens,cache_write_tokens,
        provider_cost_certainty,provider_cost_micros,evidence_kind,
        evidence_sha256,observed_at)
      VALUES ($1,$1,$2,$3,'reader-key',$4,$5,$6,$7,$8,$9,$10,$11,
        $12,$13,$14,pg_catalog.clock_timestamp())`,
      [id,claim.attempt_id,claim.attempt_index,
        claim.transition_id,claim.quote_version_id,
        pending?'unknown':'actual',pending?null:1000000,
        pending?null:2000000,pending?null:0,pending?null:0,
        pending?'unknown':'actual',pending?null:2000000,
        pending?'timeout':'provider_usage',pending?null:'b'.repeat(64)]);
  });
  return (await consumer.unsafe(`SELECT * FROM
    cinatoken_economic_consumer.consume_shared_key_economic_event($1)`,[id]))[0];
}

test('native PG18 C04.7 audited reader gate and current-owner response boundary',
  {timeout:300_000,skip:!process.env.GATEWAY_NATIVE_PG_BIN},async()=>{
    const cluster=await startNativePostgres();
    const report={status:'RUNNING',cleanup:'PENDING',binaryVersion:cluster.binaryVersion,
      scope:'owned loopback PG18.6, exact PG73 plus v338/v339/v340 and review-only credited-usage proposals',
      sourceSha256:{},stages:[],limitations:[
        'Review-only SQL and default-off application reader; no formal migration or production activation.',
        'Full-history readiness audit is tested on a small fixture, not benchmarked for production data volume.',
        'The DB read function is migrator-only. The shared runtime LOGIN cannot prove an end-user seller identity; its EXECUTE grant remains blocked.',
        'The API adapter enforces seller principal scope but exact opt-in still fails closed without a reviewed per-request DB authorization contract.'
      ]};
    const stage=(name,detail={})=>report.stages.push({name,result:'PASS',...detail});
    const clients=[];
    let failure;
    try {
      assert.match(cluster.binaryVersion,/PostgreSQL\) 18\.6/);
      const passwords=Object.fromEntries(['migrator','runtime','producer','consumer']
        .map(name=>[name,randomBytes(24).toString('hex')]));
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${passwords.migrator}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${passwords.runtime}';
        CREATE ROLE cinatoken_gateway_shared_quote_attempt_producer LOGIN PASSWORD '${passwords.producer}';
        CREATE ROLE cinatoken_gateway_shared_earning_consumer LOGIN PASSWORD '${passwords.consumer}';
        CREATE SCHEMA cinatoken_gateway AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime,cinatoken_gateway_shared_quote_attempt_producer,
          cinatoken_gateway_shared_earning_consumer;
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator=connect(cluster,'cinatoken_gateway_migrator',passwords.migrator,'migrator');
      const runtime=connect(cluster,'cinatoken_gateway_runtime',passwords.runtime,'runtime');
      const producer=connect(cluster,'cinatoken_gateway_shared_quote_attempt_producer',passwords.producer,'producer');
      const consumer=connect(cluster,'cinatoken_gateway_shared_earning_consumer',passwords.consumer,'consumer');
      clients.push(migrator,runtime,producer,consumer);
      await migrator.unsafe(`CREATE TABLE cinatoken_gateway.schema_migrations
        (version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`);
      const files=(await readdir(migrationDir)).filter(name=>name.endsWith('.sql')).sort();
      assert.equal(files.length,73);
      const corpus=[];
      for(const name of files) {
        const body=await readFile(new URL(name,migrationDir),'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx=>{
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO cinatoken_gateway.schema_migrations(version) VALUES ($1)`,[name]);
        });
      }
      stage('formal-pg73-installed');
      const bodies={};
      for(const [name,file] of Object.entries(namedProposals)) {
        bodies[name]=await readFile(new URL(`packages/core/migrations-proposals/postgres/${file}`,root),'utf8');
      }
      report.sourceSha256={formalMigrationCorpus:digest(corpus.join('\n')),
        ...Object.fromEntries(Object.entries(bodies).map(([name,body])=>[`${name}Proposal`,digest(body)])),
        nativeFixture:digest(await readFile(new URL(import.meta.url),'utf8'))};
      await apply(migrator,bodies.quote,'cinatoken.shared_key_quote_versions_activation','reviewed-v2');
      await apply(migrator,bodies.dispatch,'cinatoken.shared_quote_attempt_activation');
      await apply(migrator,bodies.outbox,'cinatoken.shared_key_economic_outbox_activation');
      await apply(migrator,bodies.consumer,'cinatoken.shared_key_snapshot_consumer_activation');
      stage('quote-dispatch-outbox-and-consumer-installed');
      await migrator.unsafe(`INSERT INTO cinatoken_gateway.users(id,email) VALUES
          ('reader-seller','reader-seller@example.invalid'),
          ('reader-new-seller','reader-new-seller@example.invalid'),
          ('reader-buyer','reader-buyer@example.invalid');
        INSERT INTO cinatoken_gateway.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,is_default,default_scope_key)
          VALUES ('reader-workspace','personal','reader-buyer','Default','default',
            true,'personal:reader-buyer');
        INSERT INTO cinatoken_gateway.api_keys(id,key,user_id,workspace_id)
          VALUES ('reader-api-key','synthetic-api-key','reader-buyer','reader-workspace');
        INSERT INTO cinatoken_gateway.shared_keys
          (id,seller_user_id,channel_type,api_key,key_fingerprint,status)
          VALUES ('reader-key','reader-seller','openai','synthetic-upstream-key',
            'reader-fingerprint','active');
        INSERT INTO cinatoken_gateway.user_earnings(user_id)
          VALUES ('reader-seller'),('reader-new-seller');
        INSERT INTO cinatoken_economic_quotes.shared_key_quote_versions
          (version_id,shared_key_id,seller_user_id,input_price_per_million,
            output_price_per_million,cache_read_price_per_million,
            cache_write_price_per_million,commission_rate,currency,price_unit,
            billing_mode,entitlement_version)
          VALUES ('reader-q1','reader-key','reader-seller',1.25,2.5,0.1,0.2,
            0.1,'USD','per_million_tokens','shared_seller_key','synthetic-v1');
        INSERT INTO cinatoken_economic_quotes.shared_key_quote_transitions
          (transition_id,shared_key_id,supersedes_transition_id,transition_kind,
            quote_version_id,seller_user_id)
          VALUES ('reader-t1','reader-key',NULL,'activate','reader-q1','reader-seller');`).simple();
      await migrator.begin(async tx=>{
        await insertLog(tx,'reader-legacy');
        await tx.unsafe(`INSERT INTO cinatoken_gateway.shared_key_earnings
          (id,request_log_id,shared_key_id,seller_user_id,input_tokens,
            output_tokens,gross_amount,platform_fee,net_amount,created_at)
          VALUES ('reader-legacy-earning','reader-legacy','reader-key','reader-seller',
            10,20,2,0,2,'2026-09-24T00:00:00Z')`);
      });
      assert.equal((await economicEvent(migrator,producer,consumer,
        'reader-economic','reader-t1','reader-q1')).out_net_micros,'5625000');
      assert.equal((await economicEvent(migrator,producer,consumer,
        'reader-pending','reader-t1','reader-q1',true)).out_decision,'pending_manual');
      stage('legacy-economic-and-pending-historical-sources-seeded');
      await apply(migrator,bodies.guard,'cinatoken.shared_key_earnings_history_guard_activation');
      await apply(migrator,bodies.store,'cinatoken.shared_key_credited_usage_store_activation');
      await assert.rejects(migrator.begin(async tx=>tx.unsafe(bodies.reader).simple()),
        error=>error?.constraint_name==='shared_key_stats_reader_install');
      await apply(migrator,bodies.reader,'cinatoken.shared_key_credited_usage_reader_install');
      stage('reader-install-requires-explicit-review-flag');
      const read=async(seller='reader-seller')=>migrator.unsafe(`SELECT * FROM
        cinatoken_shared_stats.read_shared_key_credited_usage($1::text,
          ARRAY['reader-key']::text[])`,[seller]);
      await assert.rejects(read(),error=>error?.constraint_name==='shared_key_stats_reader_not_active');
      const activate=async()=>migrator.begin(async tx=>{
        await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await tx.unsafe(`SET LOCAL cinatoken.shared_key_stats_reader_activate='reviewed-v1'`);
        await tx.unsafe(`SELECT cinatoken_shared_stats.activate_credited_usage_reader()`);
      });
      await assert.rejects(activate(),error=>error?.constraint_name==='shared_key_stats_reader_not_ready');
      stage('reader-and-activation-fail-before-both-backfills');
      for(const kind of ['legacy','economic_attempt']) {
        for(let page=0;page<5;page++) {
          const result=await migrator.begin(async tx=>{
            await tx.unsafe(`SET LOCAL cinatoken.shared_key_stats_backfill_activation='reviewed-v1'`);
            return (await tx.unsafe(`SELECT * FROM
              cinatoken_shared_stats.backfill_credited_usage($1,1)`,[kind]))[0];
          });
          if(result.complete) break;
          assert.ok(page<4,'bounded backfill must complete');
        }
      }
      await activate();
      await activate();
      let rows=await read();
      assert.equal(rows.length,1);
      assert.equal(rows[0].seller_user_id,'reader-seller');
      assert.equal(rows[0].input_tokens,'1000010');
      assert.equal(rows[0].output_tokens,'2000020');
      assert.equal(rows[0].net_micros,'7625000');
      assert.equal((await read())[0].net_micros,'7625000');
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        cinatoken_shared_stats.contributions`))[0].n,2);
      stage('audited-read-replays-without-pending-credit-or-double-count');
      await assert.rejects(runtime.unsafe(`SELECT * FROM cinatoken_shared_stats.summaries`),
        error=>error?.code==='42501');
      await assert.rejects(runtime.unsafe(`SELECT * FROM
        cinatoken_shared_stats.read_shared_key_credited_usage('reader-seller',
          ARRAY['reader-key']::text[])`),error=>error?.code==='42501');
      await assert.rejects(runtime.unsafe(`SELECT * FROM
        cinatoken_shared_stats.read_shared_key_credited_usage('reader-buyer',
          ARRAY['reader-key']::text[])`),error=>error?.code==='42501');
      await assert.rejects(consumer.unsafe(`SELECT * FROM
        cinatoken_shared_stats.read_shared_key_credited_usage('reader-seller',
          ARRAY['reader-key']::text[])`),
        error=>error?.code==='42501');
      stage('runtime-arbitrary-key-and-private-table-probes-denied');
      await migrator.begin(async tx=>{
        await tx.unsafe(`UPDATE cinatoken_gateway.shared_keys
          SET seller_user_id='reader-new-seller',served_input_tokens=10,
            served_output_tokens=20,earned_total=2 WHERE id='reader-key'`);
        await tx.unsafe(`INSERT INTO cinatoken_economic_quotes.shared_key_quote_versions
          (version_id,shared_key_id,seller_user_id,input_price_per_million,
            output_price_per_million,cache_read_price_per_million,
            cache_write_price_per_million,commission_rate,currency,price_unit,
            billing_mode,entitlement_version)
          VALUES ('reader-q2','reader-key','reader-new-seller',1.25,2.5,
            0.1,0.2,0.1,'USD','per_million_tokens','shared_seller_key','synthetic-v2')`);
        await tx.unsafe(`INSERT INTO cinatoken_economic_quotes.shared_key_quote_transitions
          (transition_id,shared_key_id,supersedes_transition_id,transition_kind,
            quote_version_id,seller_user_id)
          VALUES ('reader-t2','reader-key','reader-t1','activate',
            'reader-q2','reader-new-seller')`);
      });
      rows=await read('reader-new-seller');
      assert.equal(rows[0].seller_user_id,'reader-new-seller');
      assert.equal(rows[0].net_micros,'0');
      assert.equal(rows[0].input_tokens,'0');
      assert.equal(rows[0].last_credited_at,null);
      assert.equal((await read('reader-seller')).length,0);
      assert.equal((await migrator.unsafe(`SELECT net_micros::text AS net FROM
        cinatoken_shared_stats.summaries WHERE shared_key_id='reader-key'
        AND seller_user_id='reader-seller'`))[0].net,'7625000');
      stage('owner-transfer-excludes-historical-seller-credit-from-current-owner-view');
      assert.equal((await economicEvent(migrator,producer,consumer,
        'reader-new-credit','reader-t2','reader-q2')).out_net_micros,'5625000');
      assert.equal((await read('reader-new-seller'))[0].net_micros,'5625000');
      assert.equal((await migrator.unsafe(`SELECT net_micros::text AS net FROM
        cinatoken_shared_stats.summaries WHERE shared_key_id='reader-key'
        AND seller_user_id='reader-seller'`))[0].net,'7625000');
      stage('post-transfer-credit-appears-only-for-new-owner');
      await migrator.unsafe(`ALTER TABLE cinatoken_gateway.shared_key_earnings
        DISABLE TRIGGER shared_key_earnings_capture_credited_usage`);
      await assert.rejects(read('reader-new-seller'),
        error=>error?.constraint_name==='shared_key_stats_reader_not_active');
      await migrator.unsafe(`ALTER TABLE cinatoken_gateway.shared_key_earnings
        ENABLE TRIGGER shared_key_earnings_capture_credited_usage`);
      assert.equal((await read('reader-new-seller'))[0].net_micros,'5625000');
      stage('disabled-source-trigger-closes-reader');
      await grantPostgresRuntime({DATABASE_URL:
        `postgres://cinatoken_gateway_migrator:${passwords.migrator}@127.0.0.1:${cluster.port}/postgres`});
      await assert.rejects(runtime.unsafe(`SELECT * FROM
        cinatoken_shared_stats.read_shared_key_credited_usage('reader-new-seller',
          ARRAY['reader-key']::text[])`),error=>error?.code==='42501');
      assert.equal((await read('reader-new-seller'))[0].net_micros,'5625000');
      stage('broad-gateway-runtime-grant-rerun-does-not-expose-private-reader');
      report.status='PASS';
    } catch(error) {
      failure=error;report.status='FAIL';report.error=errorInfo(error);
    } finally {
      await Promise.allSettled(clients.map(sql=>sql.end({timeout:1})));
      try {await cluster.cleanup();report.cleanup='PASS';}
      catch(error) {report.cleanup='FAIL';report.cleanupError=errorInfo(error);failure??=error;}
      await writeFile(resultPath,JSON.stringify(report,null,2)+'\n');
    }
    if(failure) throw failure;
  });
