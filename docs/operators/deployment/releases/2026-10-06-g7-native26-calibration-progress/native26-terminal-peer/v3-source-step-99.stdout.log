// Review-only v349 loader successor. Uses the real Admin CommonJS export and an owned loopback PG cluster.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import signedStatsReaderModule from '../../../packages/admin/lib/shared-key-signed-stats-reader.ts';
import { dirname, join } from 'node:path';

const { readSignedSellerStatsPage } = signedStatsReaderModule;
import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';

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
  claim: 'shared-key-stats-signed-claim-v348.sql',
  bound: 'shared-key-stats-claim-reader-v349.sql',
};
const historicalFixtureSha256 = '095f8ec4748cd92e35f37b86891ef8762bc8b8b5ca65ab49abc55b067c1d9be9';
const digest = body => createHash('sha256').update(body).digest('hex');
const errorInfo = error => ({code:error?.code??null,constraint:error?.constraint_name??null,
  message:String(error?.message??error).slice(0,450)});
function connect(cluster,username,password,label) {
  return postgres({host:'127.0.0.1',port:cluster.port,database:'postgres',username,password,
    ssl:false,max:1,prepare:false,fetch_types:false,connect_timeout:3,
    idle_timeout:0,max_lifetime:0,backoff:false,onnotice(){},
    connection:{application_name:`cinatoken-stats-claim-reader-v349-${label}`}});
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

test('native PG18 C04.7 signed claim to credited-usage reader binding (Admin CJS loader successor)',
  {timeout:300_000,skip:!process.env.GATEWAY_NATIVE_PG_BIN},async()=>{
    const cluster=await startNativePostgres();
    const resultPath=join(dirname(cluster.owned),
      `report-stats-claim-reader-v349-cjs-loader-successor-${randomUUID()}.json`);
    const report={status:'RUNNING',cleanup:'PENDING',binaryVersion:cluster.binaryVersion,
      scope:'owned loopback PG18.6, exact PG73 plus v344 and v348/v349 review-only proposals',
      sourceSha256:{},stages:[],
      lineage:{historicalFixture:'scripts/db/cutover/postgres-shared-key-stats-claim-reader-v349.native.test.mjs',
        historicalFixtureSha256,contract:'real Admin CommonJS default module export; unchanged signed-reader SQL and role authority'},
      limitations:[
        'Loader-only successor: no Admin reader, production guard, SQL proposal, formal migration, role, or ACL change.',
        'Review-only SQL and local application reader only; no independent production issuer, secret provisioning, formal migration or production activation.',
        'Full-history readiness audit is tested on a small fixture, not benchmarked for production data volume.',
        'The dedicated direct stats-reader LOGIN is the only caller. Ordinary runtime and direct verifier access remain denied.',
        'Nonce uniqueness is only committed-transaction replay protection: explicit rollback after disclosure permits replay until the short claim expiry.',
      ]};
    const stage=(name,detail={})=>report.stages.push({name,result:'PASS',...detail});
    const clients=[];
    let failure;
    try {
      assert.match(cluster.binaryVersion,/PostgreSQL\) 18\.6/);
      assert.equal(typeof readSignedSellerStatsPage,'function');
      stage('admin-commonjs-default-loader-resolves-real-signed-reader-export');
      const passwords=Object.fromEntries(['migrator','runtime','producer','consumer','statsReader']
        .map(name=>[name,randomBytes(24).toString('hex')]));
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${passwords.migrator}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${passwords.runtime}';
        CREATE ROLE cinatoken_gateway_shared_quote_attempt_producer LOGIN PASSWORD '${passwords.producer}';
        CREATE ROLE cinatoken_gateway_shared_earning_consumer LOGIN PASSWORD '${passwords.consumer}';
        CREATE ROLE cinatoken_gateway_stats_reader LOGIN NOINHERIT PASSWORD '${passwords.statsReader}';
        CREATE SCHEMA cinatoken_gateway AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime,cinatoken_gateway_shared_quote_attempt_producer,
          cinatoken_gateway_shared_earning_consumer,
          cinatoken_gateway_stats_reader;
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator=connect(cluster,'cinatoken_gateway_migrator',passwords.migrator,'migrator');
      const runtime=connect(cluster,'cinatoken_gateway_runtime',passwords.runtime,'runtime');
      const producer=connect(cluster,'cinatoken_gateway_shared_quote_attempt_producer',passwords.producer,'producer');
      const consumer=connect(cluster,'cinatoken_gateway_shared_earning_consumer',passwords.consumer,'consumer');
      const statsReader=connect(cluster,'cinatoken_gateway_stats_reader',passwords.statsReader,'stats-reader');
      clients.push(migrator,runtime,producer,consumer,statsReader);
      await migrator.unsafe(`CREATE TABLE cinatoken_gateway.schema_migrations
        (version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`);
      const files=await listPg73Migrations();
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
        nativeFixture:digest(await readFile(new URL(import.meta.url),'utf8')),
        adminSignedReader:digest(await readFile(new URL('packages/admin/lib/shared-key-signed-stats-reader.ts',root),'utf8')),
        adminSellerRoute:digest(await readFile(new URL('packages/admin/lib/routes/user/shared-keys.ts',root),'utf8')),
        runtimeGrant:digest(await readFile(new URL('scripts/db/cutover/grant-postgres-runtime.ts',root),'utf8')),
        historicalFixture:digest(await readFile(new URL(
          'scripts/db/cutover/postgres-shared-key-stats-claim-reader-v349.native.test.mjs',root)))};
      assert.equal(report.sourceSha256.historicalFixture,historicalFixtureSha256);
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
      await assert.rejects(migrator.begin(async tx=>tx.unsafe(bodies.claim).simple()),
        error=>error?.constraint_name==='shared_key_stats_claim_install');
      await apply(migrator,bodies.claim,'cinatoken.shared_key_stats_claim_install');
      await assert.rejects(migrator.begin(async tx=>tx.unsafe(bodies.bound).simple()),
        error=>error?.constraint_name==='shared_key_stats_claim_reader_install');
      await apply(migrator,bodies.bound,
        'cinatoken.shared_key_stats_claim_reader_install');
      stage('signed-claim-and-bound-reader-default-off-install');
      const secret=randomBytes(32);
      await migrator.unsafe(`INSERT INTO cinatoken_stats_claim.keys
        (key_id,secret,not_before,not_after)
        VALUES ('reader-issuer-v1',pg_catalog.decode($1,'hex'),
          pg_catalog.clock_timestamp()-interval '1 minute',
          pg_catalog.clock_timestamp()+interval '1 hour')`,[secret.toString('hex')]);
      const claim=(overrides={})=>({keyId:'reader-issuer-v1',
        sellerId:'reader-seller',keyIds:['reader-key'],
        expiresEpoch:Math.floor(Date.now()/1000)+120,nonce:randomUUID(),
        ...overrides});
      const signature=(c,audience='stats.read')=>createHmac('sha256',secret)
        .update(`v1|${audience}|${c.keyId}|${c.sellerId}|${c.keyIds.join(',')}|${c.expiresEpoch}|${c.nonce}`,'utf8')
        .digest();
      const signedRead=(sql,c,sig=signature(c))=>sql.unsafe(`SELECT * FROM
        cinatoken_shared_stats.read_shared_key_credited_usage_with_claim(
          $1::text,$2::text,pg_catalog.string_to_array($3::text,','),
          $4::bigint,$5::uuid,$6::bytea)`,
        [c.keyId,c.sellerId,c.keyIds.join(','),c.expiresEpoch,c.nonce,sig]);
      const read=async(seller='reader-seller')=>migrator.unsafe(`SELECT * FROM
        cinatoken_shared_stats.read_shared_key_credited_usage($1::text,
          ARRAY['reader-key']::text[])`,[seller]);
      await assert.rejects(read(),error=>error?.constraint_name==='shared_key_stats_reader_not_active');
      await assert.rejects(signedRead(statsReader,claim()),
        error=>error?.constraint_name==='shared_key_stats_claim_reader_not_active');
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
      const firstClaim=claim();
      rows=await signedRead(statsReader,firstClaim);
      assert.equal(rows.length,1);
      assert.equal(rows[0].seller_user_id,'reader-seller');
      assert.equal(rows[0].input_tokens,'1000010');
      assert.equal(rows[0].output_tokens,'2000020');
      assert.equal(rows[0].net_micros,'7625000');
      await assert.rejects(signedRead(statsReader,firstClaim),
        error=>error?.constraint_name==='shared_key_stats_claim_replay');
      stage('signed-reader-projects-audited-credit-and-committed-replay-denied');
      const appClaim=claim();
      const appRows=await readSignedSellerStatsPage(
        `postgres://cinatoken_gateway_stats_reader:${passwords.statsReader}@127.0.0.1:${cluster.port}/postgres`,
        {keyId:appClaim.keyId,sellerUserId:appClaim.sellerId,
          keyIds:appClaim.keyIds,expiresEpoch:appClaim.expiresEpoch,
          nonce:appClaim.nonce,signatureHex:signature(appClaim).toString('hex')});
      assert.equal(appRows.length,1);
      assert.equal(appRows[0].net_micros,'7625000');
      await assert.rejects(readSignedSellerStatsPage(
        `postgres://cinatoken_gateway_runtime:${passwords.runtime}@127.0.0.1:${cluster.port}/postgres`,
        {keyId:appClaim.keyId,sellerUserId:appClaim.sellerId,
          keyIds:appClaim.keyIds,expiresEpoch:appClaim.expiresEpoch,
          nonce:appClaim.nonce,signatureHex:signature(appClaim).toString('hex')}),
      /shared_key_stats_reader_login_mismatch/);
      stage('admin-reader-client-uses-dedicated-login-and-bound-function');
      const rollbackClaim=claim();
      await assert.rejects(statsReader.begin(async tx=>{
        assert.equal((await signedRead(tx,rollbackClaim))[0].net_micros,'7625000');
        throw new Error('intentional-reader-rollback');
      }),/intentional-reader-rollback/);
      assert.equal((await signedRead(statsReader,rollbackClaim))[0].net_micros,'7625000');
      stage('explicit-rollback-after-disclosure-permits-replay-until-expiry');
      const victimClaim=claim();
      await assert.rejects(signedRead(statsReader,
        {...victimClaim,sellerId:'reader-new-seller'},signature(victimClaim)),
      error=>error?.constraint_name==='shared_key_stats_claim_signature');
      await assert.rejects(signedRead(statsReader,
        {...victimClaim,keyIds:['other-key']},signature(victimClaim)),
      error=>error?.constraint_name==='shared_key_stats_claim_signature');
      await assert.rejects(signedRead(statsReader,victimClaim,
        signature(victimClaim,'stats.admin')),
      error=>error?.constraint_name==='shared_key_stats_claim_signature');
      stage('seller-key-and-audience-tampering-denied-by-bound-reader');
      assert.equal((await signedRead(statsReader,
        claim({sellerId:'reader-buyer'}))).length,0);
      assert.equal((await signedRead(statsReader,
        claim({keyIds:['not-an-owned-key']}))).length,0);
      stage('valid-claim-cannot-project-another-seller-or-unowned-key');
      await assert.rejects(runtime.unsafe(`SELECT * FROM cinatoken_shared_stats.summaries`),
        error=>error?.code==='42501');
      await assert.rejects(statsReader.unsafe(`SELECT * FROM
        cinatoken_shared_stats.summaries`),error=>error?.code==='42501');
      await assert.rejects(statsReader.unsafe(`SELECT * FROM
        cinatoken_shared_stats.reader_ready`),error=>error?.code==='42501');
      await assert.rejects(statsReader.unsafe(`SELECT * FROM
        cinatoken_shared_stats.read_shared_key_credited_usage('reader-seller',
          ARRAY['reader-key']::text[])`),error=>error?.code==='42501');
      const directClaim=claim();
      await assert.rejects(statsReader.unsafe(`SELECT
        cinatoken_stats_claim.verify_seller_stats_claim(
          $1::text,$2::text,pg_catalog.string_to_array($3::text,','),
          $4::bigint,$5::uuid,$6::bytea)`,
        [directClaim.keyId,directClaim.sellerId,directClaim.keyIds.join(','),
          directClaim.expiresEpoch,directClaim.nonce,signature(directClaim)]),
      error=>error?.code==='42501');
      await assert.rejects(signedRead(runtime,claim()),
        error=>error?.code==='42501');
      await assert.rejects(signedRead(migrator,claim()),
        error=>error?.constraint_name==='shared_key_stats_claim_reader_not_active');
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
      stage('runtime-and-reader-direct-private-probes-denied');
      const readiness=(await migrator.unsafe(`SELECT activated_at,
        legacy_rows,economic_rows FROM cinatoken_shared_stats.reader_ready WHERE id`))[0];
      await migrator.unsafe(`DELETE FROM cinatoken_shared_stats.reader_ready WHERE id`);
      await assert.rejects(signedRead(statsReader,claim()),
        error=>error?.constraint_name==='shared_key_stats_claim_reader_not_active');
      await migrator.unsafe(`INSERT INTO cinatoken_shared_stats.reader_ready
        (id,activated_at,legacy_rows,economic_rows)
        VALUES (true,$1,$2,$3)`,[readiness.activated_at,
          readiness.legacy_rows,readiness.economic_rows]);
      await migrator.unsafe(`UPDATE cinatoken_shared_stats.backfill_cursors
        SET complete=false WHERE source_kind='economic_attempt'`);
      await assert.rejects(signedRead(statsReader,claim()),
        error=>error?.constraint_name==='shared_key_stats_claim_reader_not_active');
      await migrator.unsafe(`UPDATE cinatoken_shared_stats.backfill_cursors
        SET complete=true WHERE source_kind='economic_attempt'`);
      stage('ready-row-and-backfill-cursor-drift-close-signed-reader');
      const oldOwnerClaim=claim();
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
      assert.equal((await signedRead(statsReader,oldOwnerClaim)).length,0);
      rows=await signedRead(statsReader,claim({sellerId:'reader-new-seller'}));
      assert.equal(rows.length,1);
      assert.equal(rows[0].seller_user_id,'reader-new-seller');
      assert.equal(rows[0].net_micros,'0');
      stage('owner-transfer-excludes-historical-seller-credit-from-current-owner-view');
      assert.equal((await economicEvent(migrator,producer,consumer,
        'reader-new-credit','reader-t2','reader-q2')).out_net_micros,'5625000');
      assert.equal((await read('reader-new-seller'))[0].net_micros,'5625000');
      assert.equal((await signedRead(statsReader,
        claim({sellerId:'reader-new-seller'})))[0].net_micros,'5625000');
      assert.equal((await migrator.unsafe(`SELECT net_micros::text AS net FROM
        cinatoken_shared_stats.summaries WHERE shared_key_id='reader-key'
        AND seller_user_id='reader-seller'`))[0].net,'7625000');
      stage('post-transfer-credit-appears-only-for-new-owner');
      await migrator.unsafe(`ALTER TABLE cinatoken_gateway.shared_key_earnings
        DISABLE TRIGGER shared_key_earnings_capture_credited_usage`);
      await assert.rejects(read('reader-new-seller'),
        error=>error?.constraint_name==='shared_key_stats_reader_not_active');
      await assert.rejects(signedRead(statsReader,
        claim({sellerId:'reader-new-seller'})),
      error=>error?.constraint_name==='shared_key_stats_claim_reader_not_active');
      await migrator.unsafe(`ALTER TABLE cinatoken_gateway.shared_key_earnings
        ENABLE TRIGGER shared_key_earnings_capture_credited_usage`);
      assert.equal((await read('reader-new-seller'))[0].net_micros,'5625000');
      stage('disabled-source-trigger-closes-reader');
      // Keep original grant calls and rejection checks on the owned PG73 ledger.
      const grantPostgresRuntime = ({ DATABASE_URL }) =>
        grantPg73RuntimeFixture({ cluster, migrator, migratorUrl: DATABASE_URL });
      await grantPostgresRuntime({DATABASE_URL:
        `postgres://cinatoken_gateway_migrator:${passwords.migrator}@127.0.0.1:${cluster.port}/postgres`});
      await assert.rejects(runtime.begin(async tx=>{
        await tx.unsafe(`INSERT INTO cinatoken_gateway.portal_sessions
          (token_hash,subject,email,expires_at)
          VALUES ('forged-stats-session','victim-subject',
            'victim@example.invalid',pg_catalog.clock_timestamp()+interval '1 hour')`);
        await tx.unsafe(`UPDATE cinatoken_gateway.users SET
          external_system='cinaauth',external_user_id='victim-subject'
          WHERE id='reader-seller'`);
        assert.equal((await tx.unsafe(`SELECT count(*)::int AS n FROM
          cinatoken_gateway.portal_sessions
          WHERE token_hash='forged-stats-session'`))[0].n,1);
        throw new Error('intentional-runtime-identity-forgery-rollback');
      }),/intentional-runtime-identity-forgery-rollback/);
      stage('ordinary-runtime-can-forge-portal-session-and-user-mapping');
      await assert.rejects(runtime.unsafe(`SELECT * FROM
        cinatoken_shared_stats.read_shared_key_credited_usage('reader-new-seller',
          ARRAY['reader-key']::text[])`),error=>error?.code==='42501');
      await assert.rejects(signedRead(runtime,
        claim({sellerId:'reader-new-seller'})),error=>error?.code==='42501');
      assert.equal((await signedRead(statsReader,
        claim({sellerId:'reader-new-seller'})))[0].net_micros,'5625000');
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
      process.stdout.write(`stats-claim-reader-v349-cjs-loader-successor-report=${resultPath}\n`);
    }
    if(failure) throw failure;
  });
