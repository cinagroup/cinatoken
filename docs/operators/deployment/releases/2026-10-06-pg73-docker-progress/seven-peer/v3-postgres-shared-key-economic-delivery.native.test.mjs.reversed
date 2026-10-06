// Review-only native PG18.6 fixture. Fresh owned loopback cluster, synthetic facts.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { createPostgresSharedEarningDelivery } from
  '../../../packages/proxy/src/runtime/postgres-shared-earning-delivery.ts';

const gateway='cinatoken_gateway';
const quotes='cinatoken_economic_quotes';
const outbox='cinatoken_economic_outbox';
const consumerSchema='cinatoken_economic_consumer';
const deliverySchema='cinatoken_economic_delivery';
const migrations=new URL('../../../packages/core/migrations-postgres/',import.meta.url);
const proposalPaths={
  quote:new URL('../../../packages/core/migrations-proposals/postgres/shared-key-quote-versions.sql',import.meta.url),
  dispatch:new URL('../../../packages/core/migrations-proposals/postgres/shared-key-dispatch-quote-attempts.sql',import.meta.url),
  outbox:new URL('../../../packages/core/migrations-proposals/postgres/shared-key-economic-outbox.sql',import.meta.url),
  consumer:new URL('../../../packages/core/migrations-proposals/postgres/shared-key-snapshot-earning-consumer.sql',import.meta.url),
  delivery:new URL('../../../packages/core/migrations-proposals/postgres/shared-key-economic-delivery.sql',import.meta.url),
};
const sha=value=>createHash('sha256').update(value).digest('hex');
const info=error=>({code:error?.code??null,constraint:error?.constraint_name??null,
  message:String(error?.message??error).slice(0,300)});
function client(cluster,username,password,label) {
  return postgres({host:'127.0.0.1',port:cluster.port,database:'postgres',
    username,password,ssl:false,max:1,prepare:false,fetch_types:false,
    connect_timeout:3,idle_timeout:0,max_lifetime:0,backoff:false,onnotice(){},
    connection:{application_name:`cinatoken-economic-delivery-v342-${label}`}});
}
async function insertObject(sql,table,row) {
  const columns=Object.keys(row);
  return sql.unsafe(`INSERT INTO ${table} (${columns.join(',')}) VALUES
    (${columns.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));
}
async function expectCode(work,code,constraint) {
  await assert.rejects(work,error=>{
    assert.equal(error?.code,code,String(error));
    if(constraint) assert.equal(error?.constraint_name,constraint,String(error));
    return true;
  });
}
function quote() {
  return {version_id:'delivery-q1',shared_key_id:'delivery-key',
    seller_user_id:'delivery-seller',input_price_per_million:'1.250000',
    output_price_per_million:'2.500000',cache_read_price_per_million:'0.100000',
    cache_write_price_per_million:'0.200000',commission_rate:'0.100000',
    currency:'USD',price_unit:'per_million_tokens',billing_mode:'shared_seller_key',
    entitlement_version:'synthetic-entitlement-v1'};
}
function event(id) {
  return {event_id:id,request_log_id:id,event_type:'shared_key_usage_settled',
    event_version:1,buyer_user_id:'delivery-buyer',
    buyer_api_key_id:'delivery-api-key',workspace_id:'delivery-workspace',
    buyer_charge_basis:'actual',buyer_usage_certainty:'actual',
    buyer_charged_cost:'10.000000',buyer_budget_charged_micros:10000000,
    buyer_input_tokens:1000000,buyer_output_tokens:2000000,
    buyer_cache_read_tokens:0,buyer_cache_write_tokens:0,
    attempt_count:1,event_certainty:'confirmed'};
}
function outcome(id,claim) {
  return {event_id:id,request_log_id:id,attempt_id:claim.attempt_id,
    attempt_index:claim.attempt_index,shared_key_id:claim.shared_key_id,
    transition_id:claim.transition_id,quote_version_id:claim.quote_version_id,
    usage_certainty:'actual',input_tokens:1000000,output_tokens:2000000,
    cache_read_tokens:0,cache_write_tokens:0,provider_cost_certainty:'actual',
    provider_cost_micros:2000000,evidence_kind:'provider_usage',
    evidence_sha256:'c'.repeat(64),observed_at:new Date().toISOString()};
}
async function insertLog(tx,id) {
  await tx.unsafe(`INSERT INTO ${gateway}.api_key_request_logs
    (id,user_id,api_key_id,workspace_id,charged_cost,budget_charged_micros,
      input_tokens,output_tokens,cache_read_tokens,cache_write_tokens)
    VALUES ($1,'delivery-buyer','delivery-api-key','delivery-workspace',
      10.000000,10000000,1000000,2000000,0,0)`,[id]);
}

test('native PG18 economic delivery keeps an atomic event-ID job and marker-gated retry',
  {timeout:300_000,skip:!process.env.GATEWAY_NATIVE_PG_BIN},async()=>{
    const cluster=await startNativePostgres();
    const reportPath=join(dirname(cluster.owned),
      `report-economic-delivery-v342-${randomUUID()}.json`);
    const report={status:'RUNNING',cleanup:'PENDING',binaryVersion:cluster.binaryVersion,
      scope:'owned PG18.6; PG73 + v338/v339/v340 + review-only v342 delivery',
      stages:[],sourceSha256:{},limitations:[
        'No production Queue worker, scheduler, runtime credential or financial activation is installed.',
        'Synthetic PostgreSQL facts do not prove production crash recovery or D1/MySQL parity.',
        'The delivery role can only pass an event ID; the separate v340 consumer commits the financial marker.',
        'Manual dead-letter recovery requires an operator decision and an audited reason code.',
      ]};
    const stage=(name,detail={})=>report.stages.push({name,result:'PASS',...detail});
    const clients=[];
    let failure;
    try {
      assert.match(cluster.binaryVersion,/PostgreSQL\) 18\.6/);
      const passwords=Object.fromEntries(['migrator','runtime','producer','consumer',
        'delivery','recovery'].map(name=>[name,randomBytes(24).toString('hex')]));
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${passwords.migrator}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${passwords.runtime}';
        CREATE ROLE cinatoken_gateway_shared_quote_attempt_producer LOGIN PASSWORD '${passwords.producer}';
        CREATE ROLE cinatoken_gateway_shared_earning_consumer LOGIN PASSWORD '${passwords.consumer}';
        CREATE ROLE cinatoken_gateway_shared_earning_delivery LOGIN PASSWORD '${passwords.delivery}';
        CREATE ROLE cinatoken_gateway_shared_earning_recovery LOGIN PASSWORD '${passwords.recovery}';
        CREATE ROLE cinatoken_delivery_acl_probe NOLOGIN;
        CREATE SCHEMA ${gateway} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime,cinatoken_gateway_shared_quote_attempt_producer,
          cinatoken_gateway_shared_earning_consumer,
          cinatoken_gateway_shared_earning_delivery,
          cinatoken_gateway_shared_earning_recovery;
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;
        ALTER ROLE cinatoken_gateway_shared_earning_consumer IN DATABASE postgres
          SET transaction_timeout='30s';
        ALTER ROLE cinatoken_gateway_shared_earning_consumer IN DATABASE postgres
          SET statement_timeout='15s';
        ALTER ROLE cinatoken_gateway_shared_earning_consumer IN DATABASE postgres
          SET lock_timeout='5s';
        ALTER ROLE cinatoken_gateway_shared_earning_consumer IN DATABASE postgres
          SET idle_in_transaction_session_timeout='10s';
        ALTER ROLE cinatoken_gateway_shared_earning_delivery IN DATABASE postgres
          SET transaction_timeout='30s';
        ALTER ROLE cinatoken_gateway_shared_earning_delivery IN DATABASE postgres
          SET statement_timeout='15s';
        ALTER ROLE cinatoken_gateway_shared_earning_delivery IN DATABASE postgres
          SET lock_timeout='5s';
        ALTER ROLE cinatoken_gateway_shared_earning_delivery IN DATABASE postgres
          SET idle_in_transaction_session_timeout='10s';`).simple();
      const migrator=client(cluster,'cinatoken_gateway_migrator',passwords.migrator,'migrator');
      const migratorB=client(cluster,'cinatoken_gateway_migrator',passwords.migrator,'migrator-b');
      const producer=client(cluster,'cinatoken_gateway_shared_quote_attempt_producer',passwords.producer,'producer');
      const consumer=client(cluster,'cinatoken_gateway_shared_earning_consumer',passwords.consumer,'consumer');
      const deliveryA=client(cluster,'cinatoken_gateway_shared_earning_delivery',passwords.delivery,'delivery-a');
      const deliveryB=client(cluster,'cinatoken_gateway_shared_earning_delivery',passwords.delivery,'delivery-b');
      const recovery=client(cluster,'cinatoken_gateway_shared_earning_recovery',passwords.recovery,'recovery');
      const runtime=client(cluster,'cinatoken_gateway_runtime',passwords.runtime,'runtime');
      clients.push(migrator,migratorB,producer,consumer,deliveryA,deliveryB,recovery,runtime);
      await migrator.unsafe(`CREATE TABLE ${gateway}.schema_migrations
        (version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`);
      const files=(await readdir(migrations)).filter(name=>name.endsWith('.sql')).sort();
      assert.equal(files.length,73);
      const corpus=[];
      for(const name of files) {
        const body=await readFile(new URL(name,migrations),'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx=>{
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${gateway}.schema_migrations(version) VALUES ($1)`,[name]);
        });
      }
      stage('formal-pg73-installed');
      const bodies={};
      for(const [name,path] of Object.entries(proposalPaths))
        bodies[name]=await readFile(path,'utf8');
      report.sourceSha256={formalMigrationCorpus:sha(corpus.join('\n')),
        quoteProposal:sha(bodies.quote),dispatchProposal:sha(bodies.dispatch),
        outboxProposal:sha(bodies.outbox),consumerProposal:sha(bodies.consumer),
        deliveryProposal:sha(bodies.delivery),
        deliveryRuntime:sha(await readFile(new URL(
          '../../../packages/proxy/src/runtime/postgres-shared-earning-delivery.ts',import.meta.url))),
        nativeTest:sha(await readFile(new URL(import.meta.url)))};
      const activate=async(key,body)=>migrator.begin(async tx=>{
        await tx.unsafe(`SET LOCAL cinatoken.${key} = 'reviewed-v1'`);
        await tx.unsafe(body).simple();
      });
      await migrator.begin(async tx=>{
        await tx.unsafe("SET LOCAL cinatoken.shared_key_quote_versions_activation = 'reviewed-v2'");
        await tx.unsafe(bodies.quote).simple();
      });
      await activate('shared_quote_attempt_activation',bodies.dispatch);
      await activate('shared_key_economic_outbox_activation',bodies.outbox);
      await activate('shared_key_snapshot_consumer_activation',bodies.consumer);
      stage('immutable-event-and-marker-dependencies-installed');

      await migrator.unsafe(`INSERT INTO ${gateway}.users(id,email) VALUES
          ('delivery-seller','seller-delivery@example.invalid'),
          ('delivery-buyer','buyer-delivery@example.invalid');
        INSERT INTO ${gateway}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,is_default,default_scope_key)
          VALUES ('delivery-workspace','personal','delivery-buyer','Default','default',
            true,'personal:delivery-buyer');
        INSERT INTO ${gateway}.api_keys(id,key,user_id,workspace_id)
          VALUES ('delivery-api-key','synthetic-api-key','delivery-buyer','delivery-workspace');
        INSERT INTO ${gateway}.shared_keys
          (id,seller_user_id,channel_type,api_key,key_fingerprint,status)
          VALUES ('delivery-key','delivery-seller','openai','synthetic-upstream-key',
            'synthetic-fingerprint','active');`).simple();
      await insertObject(migrator,`${quotes}.shared_key_quote_versions`,quote());
      await migrator.unsafe(`INSERT INTO ${quotes}.shared_key_quote_transitions
        (transition_id,shared_key_id,supersedes_transition_id,transition_kind,
          quote_version_id,seller_user_id)
        VALUES ('delivery-t1','delivery-key',NULL,'activate','delivery-q1','delivery-seller')`);
      const quoteClaim=async id=>(await producer.unsafe(`SELECT * FROM
        ${quotes}.claim_shared_key_dispatch_quote_attempt($1,$2,1,'delivery-key','synthetic-target')`,
      [randomUUID(),id]))[0];
      const settleIn=async(tx,id,c)=>{
        await insertLog(tx,id);
        await insertObject(tx,`${outbox}.shared_key_economic_events`,event(id));
        await insertObject(tx,`${outbox}.shared_key_economic_event_attempts`,outcome(id,c));
      };
      const settle=async id=>{
        const c=await quoteClaim(id);
        await migrator.begin(tx=>settleIn(tx,id,c));
        return c;
      };
      const consume=async id=>(await consumer.unsafe(`SELECT * FROM
        ${consumerSchema}.consume_shared_key_economic_event($1)`,[id]))[0];
      const claim=async(sql,n=1)=>(await sql.unsafe(`SELECT * FROM
        ${deliverySchema}.claim_events($1,60)`,[n]));
      const claimExact=async(sql,id)=>(await sql.unsafe(`SELECT * FROM
        ${deliverySchema}.claim_event($1,60)`,[id]));
      const inspect=async(sql,id)=>(await sql.unsafe(`SELECT * FROM
        ${deliverySchema}.inspect_event($1)`,[id]))[0];
      const ack=async(sql,row)=>(await sql.unsafe(`SELECT
        ${deliverySchema}.ack_event($1,$2) AS result`,
      [row.out_event_id,row.out_claim_token]))[0].result;
      const fail=async(sql,row,code='synthetic_failure')=>(await sql.unsafe(`SELECT
        ${deliverySchema}.fail_event($1,$2,$3) AS result`,
      [row.out_event_id,row.out_claim_token,code]))[0].result;
      const job=async id=>(await migrator.unsafe(`SELECT event_id,status,attempt_count,
        recovery_count,claim_token::text AS claim_token,last_failure_code,
        next_attempt_at,lease_until,completed_at,dead_at
        FROM ${deliverySchema}.shared_key_event_delivery_jobs WHERE event_id=$1`,[id]))[0];
      const balance=async()=>BigInt((await migrator.unsafe(`SELECT balance_micros::text AS n
        FROM ${gateway}.user_earnings WHERE user_id='delivery-seller'`))[0]?.n??0);

      await settle('before-install-pending');
      await settle('before-install-consumed');
      await consume('before-install-consumed');
      await assert.rejects(migrator.begin(tx=>tx.unsafe(bodies.delivery).simple()),
        /Economic delivery activation, role or migration ledger differs/);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`UPDATE ${gateway}.schema_migrations
          SET version='0042_forged_middle_version.sql'
          WHERE version='0042_gateway_keys_workspace.sql'`);
        await tx.unsafe("SET LOCAL cinatoken.shared_key_economic_delivery_activation = 'reviewed-v1'");
        await tx.unsafe(bodies.delivery).simple();
      }),/Economic delivery activation, role or migration ledger differs/);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`ALTER TABLE ${consumerSchema}.shared_key_event_consumptions
          DISABLE TRIGGER shared_key_event_consumptions_no_change`);
        await tx.unsafe("SET LOCAL cinatoken.shared_key_economic_delivery_activation = 'reviewed-v1'");
        await tx.unsafe(bodies.delivery).simple();
      }),/Economic delivery source catalog or consumer guard differs/);
      assert.equal((await migrator.unsafe(`SELECT
        pg_catalog.to_regnamespace('${deliverySchema}') IS NULL AS absent`))[0].absent,true);
      stage('default-off-exact-ledger-and-consumer-marker-guard-pins');

      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES
        TO cinatoken_delivery_acl_probe`);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe("SET LOCAL cinatoken.shared_key_economic_delivery_activation = 'reviewed-v1'");
        await tx.unsafe(bodies.delivery).simple();
      }),/Economic delivery catalog or ACL exceeds reviewed contract/);
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES
        FROM cinatoken_delivery_acl_probe`);
      const installRaceClaim=await quoteClaim('install-inflight');
      let installEntered;let installRelease;
      const installReady=new Promise(resolve=>{installEntered=resolve;});
      const installHold=new Promise(resolve=>{installRelease=resolve;});
      const inFlight=migratorB.begin(async tx=>{
        await settleIn(tx,'install-inflight',installRaceClaim);
        installEntered();
        await installHold;
      });
      await installReady;
      const installation=activate('shared_key_economic_delivery_activation',bodies.delivery);
      await delay(100);
      installRelease();
      await inFlight;
      await installation;
      assert.deepEqual((await migrator.unsafe(`SELECT event_id,status
        FROM ${deliverySchema}.shared_key_event_delivery_jobs ORDER BY event_id`))
        .map(r=>[r.event_id,r.status]),[
          ['before-install-consumed','completed'],['before-install-pending','pending'],
          ['install-inflight','pending']]);
      stage('locked-backfill-pending-and-marker-completed; hostile-default-acl-rollback');
      stage('inflight-source-transaction-commits-before-installer-lock-and-is-backfilled');

      await expectCode(runtime.unsafe(`SELECT * FROM ${deliverySchema}.claim_events(1,60)`),'42501');
      await expectCode(consumer.unsafe(`SELECT * FROM ${deliverySchema}.claim_events(1,60)`),'42501');
      await expectCode(recovery.unsafe(`SELECT * FROM ${deliverySchema}.claim_events(1,60)`),'42501');
      await expectCode(deliveryA.unsafe(`SELECT * FROM ${deliverySchema}.shared_key_event_delivery_jobs`),'42501');
      await expectCode(deliveryA.unsafe(`SELECT * FROM ${consumerSchema}.
        consume_shared_key_economic_event('before-install-pending')`),'42501');
      await expectCode(deliveryA.unsafe(`SELECT * FROM ${outbox}.shared_key_economic_events`),'42501');
      await expectCode(deliveryA.unsafe(`SELECT ${deliverySchema}.
        requeue_dead_letter('before-install-pending','manual_review')`),'42501');
      stage('dedicated-roles-only-event-id-functions-no-direct-financial-access');

      const rollbackClaim=await quoteClaim('rollback-event');
      await assert.rejects(migrator.begin(async tx=>{
        await settleIn(tx,'rollback-event',rollbackClaim);
        assert.equal((await tx.unsafe(`SELECT count(*)::int AS n FROM ${deliverySchema}.
          shared_key_event_delivery_jobs WHERE event_id='rollback-event'`))[0].n,1);
        throw new Error('synthetic-buyer-rollback');
      }),/synthetic-buyer-rollback/);
      assert.equal(await job('rollback-event'),undefined);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM ${outbox}.
        shared_key_economic_events WHERE event_id='rollback-event'`))[0].n,0);
      await settle('atomic-event');
      assert.equal((await job('atomic-event')).status,'pending');
      const columns=(await migrator.unsafe(`SELECT column_name FROM information_schema.columns
        WHERE table_schema=$1 AND table_name='shared_key_event_delivery_jobs'
        ORDER BY ordinal_position`,[deliverySchema])).map(r=>r.column_name);
      assert.deepEqual(columns,['event_id','status','next_attempt_at','attempt_count',
        'recovery_count','claim_token','claimed_at','lease_until','completed_at',
        'dead_at','last_failure_code']);
      stage('event-trigger-job-atomic-rollback-and-event-id-only-transport');

      // The pre-install pending row is claimed before newer work. A completion
      // without a committed consumer marker is rejected even by the owner.
      assert.equal((await claimExact(deliveryA,'no-such-event')).length,0);
      assert.equal((await claimExact(deliveryA,'before-install-consumed')).length,0);
      assert.equal((await inspect(deliveryA,'no-such-event')).out_status,'absent');
      assert.equal((await inspect(deliveryA,'before-install-consumed')).out_status,'completed');
      // Future default-off Queue-ID runtime adapter can call this exact-ID
      // function and pass its returned token to ACK/fail after consumption.
      const first=(await claimExact(deliveryA,'before-install-pending'))[0];
      assert.equal(first.out_event_id,'before-install-pending');
      await expectCode(ack(deliveryA,first),'23514','shared_key_delivery_marker_required');
      await expectCode(migrator.begin(async tx=>{
        await tx.unsafe(`UPDATE ${deliverySchema}.shared_key_event_delivery_jobs
          SET status='completed',claim_token=NULL,claimed_at=NULL,lease_until=NULL,
            completed_at=clock_timestamp() WHERE event_id=$1`,[first.out_event_id]);
      }),'23514','shared_key_delivery_marker_required');
      const initialBalance=await balance();
      await consume(first.out_event_id);
      assert.equal(await ack(deliveryA,first),'completed');
      assert.equal(await ack(deliveryA,first),'already_completed');
      assert.equal(await balance(),initialBalance+5625000n);
      stage('marker-gated-ack-and-ack-response-loss-idempotency');

      const inflight=(await claimExact(deliveryA,'install-inflight'))[0];
      assert.equal(inflight.out_event_id,'install-inflight');
      await consume(inflight.out_event_id);
      assert.equal(await ack(deliveryA,inflight),'completed');

      // Claim and hold one row lock; a second claimant skips it and gets the
      // next event without waiting. Both claims are bounded to one row.
      await settle('concurrent-claim-b');
      let reached;let release;
      const entered=new Promise(resolve=>{reached=resolve;});
      const hold=new Promise(resolve=>{release=resolve;});
      const held=deliveryA.begin(async tx=>{
        const rows=await claim(tx);
        reached();
        await hold;
        return rows[0];
      });
      await entered;
      let other;
      try {
        other=(await claim(deliveryB))[0];
        assert.ok(other);
        assert.notEqual(other.out_event_id,'atomic-event');
      } finally {release();}
      const heldRow=await held;
      assert.equal(heldRow.out_event_id,'atomic-event');
      assert.notEqual(other.out_claim_token,heldRow.out_claim_token);
      assert.equal((await claim(deliveryB)).length,0);
      stage('bounded-skip-locked-concurrent-claims-distinct');

      // Reclaim after a lost claim ACK. The old token is fenced while the new
      // lease can drive the idempotent consumer and completion.
      await migrator.unsafe(`UPDATE ${deliverySchema}.shared_key_event_delivery_jobs
        SET claimed_at=clock_timestamp()-interval '2 minutes',
          lease_until=clock_timestamp()-interval '1 minute'
        WHERE event_id='atomic-event'`);
      const replacement=(await claimExact(deliveryB,'atomic-event'))[0];
      assert.equal(replacement.out_event_id,'atomic-event');
      assert.notEqual(replacement.out_claim_token,heldRow.out_claim_token);
      await consume('atomic-event');
      await expectCode(ack(deliveryA,heldRow),'23514','shared_key_delivery_stale_claim');
      assert.equal(await ack(deliveryB,replacement),'completed');
      await consume('atomic-event');
      assert.equal((await job('atomic-event')).attempt_count,2);
      stage('expired-lease-new-token-fences-old-ack-and-consumer-replay');

      // Consume the other claimed event, then simulate losing the ACK by
      // letting its lease expire. The next scan sees the marker and completes.
      const beforeReplay=await balance();
      await consume(other.out_event_id);
      await migrator.unsafe(`UPDATE ${deliverySchema}.shared_key_event_delivery_jobs
        SET claimed_at=clock_timestamp()-interval '2 minutes',
          lease_until=clock_timestamp()-interval '1 minute' WHERE event_id=$1`,
      [other.out_event_id]);
      assert.equal((await claim(deliveryA)).length,0);
      assert.equal((await job(other.out_event_id)).status,'completed');
      assert.equal(await balance(),beforeReplay+5625000n);
      stage('lost-ack-lease-scan-reconciles-marker-without-second-credit');

      await settle('retry-backoff');
      const retryFirst=(await claim(deliveryA))[0];
      assert.equal(retryFirst.out_event_id,'retry-backoff');
      assert.equal(await fail(deliveryA,retryFirst),'pending');
      const backoff=await job('retry-backoff');
      assert.equal(backoff.last_failure_code,'synthetic_failure');
      const seconds=(new Date(backoff.next_attempt_at).getTime()-Date.now())/1000;
      assert.ok(seconds>3 && seconds<=6,`first retry delay ${seconds}s`);
      assert.equal((await claim(deliveryB)).length,0);
      await migrator.unsafe(`UPDATE ${deliverySchema}.shared_key_event_delivery_jobs
        SET next_attempt_at=clock_timestamp()-interval '1 second'
        WHERE event_id='retry-backoff'`);
      const retrySecond=(await claim(deliveryB))[0];
      assert.equal(retrySecond.out_attempt_count,2);
      await consume('retry-backoff');
      assert.equal(await fail(deliveryB,retrySecond),'completed');
      stage('bounded-backoff-and-failure-after-consumer-commit-completes');

      await settle('dead-letter');
      let exhausted=(await claim(deliveryA))[0];
      for(let attempt=1;attempt<=8;attempt++) {
        assert.equal(exhausted.out_attempt_count,attempt);
        const result=await fail(deliveryA,exhausted,'synthetic_failure');
        if(attempt===8) {
          assert.equal(result,'dead_letter');
        } else {
          assert.equal(result,'pending');
          await migrator.unsafe(`UPDATE ${deliverySchema}.shared_key_event_delivery_jobs
            SET next_attempt_at=clock_timestamp()-interval '1 second'
            WHERE event_id='dead-letter'`);
          exhausted=(await claim(deliveryA))[0];
        }
      }
      assert.equal((await job('dead-letter')).status,'dead_letter');
      assert.equal((await inspect(deliveryA,'dead-letter')).out_status,'dead_letter');
      assert.equal((await claim(deliveryA)).length,0);
      await expectCode(recovery.unsafe(`SELECT ${deliverySchema}.
        requeue_dead_letter('atomic-event','manual_review')`),
      '23514','shared_key_delivery_recovery_state');
      assert.equal((await recovery.unsafe(`SELECT ${deliverySchema}.
        requeue_dead_letter('dead-letter','operator_reviewed') AS n`))[0].n,1);
      const audit=(await migrator.unsafe(`SELECT recovery_number,reason_code,recovered_by
        FROM ${deliverySchema}.shared_key_delivery_recoveries
        WHERE event_id='dead-letter'`))[0];
      assert.deepEqual(audit,{recovery_number:1,reason_code:'operator_reviewed',
        recovered_by:'cinatoken_gateway_shared_earning_recovery'});
      await expectCode(migrator.unsafe(`UPDATE ${deliverySchema}.
        shared_key_delivery_recoveries SET reason_code='forged'
        WHERE event_id='dead-letter'`),'23514','shared_key_delivery_recovery_append_only');
      const recovered=(await claim(deliveryB))[0];
      assert.equal(recovered.out_event_id,'dead-letter');
      assert.equal(recovered.out_attempt_count,1);
      await consume('dead-letter');
      assert.equal(await ack(deliveryB,recovered),'completed');
      stage('eight-attempt-dead-letter-and-audited-manual-requeue');

      // A source insert can begin before a scanner and commit after it. The
      // trigger-owned job appears on the next scan without a time cursor.
      const lateClaim=await quoteClaim('late-commit');
      let lateEntered;let lateRelease;
      const lateReady=new Promise(resolve=>{lateEntered=resolve;});
      const lateHold=new Promise(resolve=>{lateRelease=resolve;});
      const lateTransaction=migratorB.begin(async tx=>{
        await settleIn(tx,'late-commit',lateClaim);
        lateEntered();
        await lateHold;
      });
      await lateReady;
      assert.equal((await claim(deliveryA)).length,0);
      assert.equal((await claimExact(deliveryA,'late-commit')).length,0);
      assert.equal((await inspect(deliveryA,'late-commit')).out_status,'absent');
      assert.equal(await job('late-commit'),undefined);
      lateRelease();
      await lateTransaction;
      const lateDelivery=(await claimExact(deliveryA,'late-commit'))[0];
      assert.equal(lateDelivery.out_event_id,'late-commit');
      await consume('late-commit');
      assert.equal(await ack(deliveryA,lateDelivery),'completed');
      stage('late-commit-after-empty-scan-is-not-lost');

      // A marker can arrive at max lease expiry; reconciliation still has an
      // event-key path even if the job has already gone to dead letter.
      await settle('dead-marker-race');
      await migrator.unsafe(`UPDATE ${deliverySchema}.shared_key_event_delivery_jobs
        SET status='leased',attempt_count=8,claim_token=$1,claimed_at=clock_timestamp()-interval '2 minutes',
          lease_until=clock_timestamp()-interval '1 minute'
        WHERE event_id='dead-marker-race'`,[randomUUID()]);
      assert.equal((await claim(deliveryA)).length,0);
      assert.equal((await job('dead-marker-race')).status,'dead_letter');
      await expectCode(deliveryA.unsafe(`SELECT ${deliverySchema}.
        reconcile_consumed_event('dead-marker-race')`),
      '23514','shared_key_delivery_marker_required');
      await consume('dead-marker-race');
      assert.equal((await deliveryA.unsafe(`SELECT ${deliverySchema}.
        reconcile_consumed_event('dead-marker-race') AS result`))[0].result,'completed');
      stage('exhausted-lease-marker-race-has-marker-only-reconciliation');

      await settle('runtime-candidate');
      const beforeRuntimeBalance=await balance();
      const runtimeCandidate=createPostgresSharedEarningDelivery({enabled:true,
        leaseSeconds:30,forbiddenClients:[migrator,runtime,producer].map(raw=>({driver:'postgres',raw})),
        async openDeliveryClient(){return {driver:'postgres',raw:deliveryA};},
        async retireConfirmedDeliveryClient(value){assert.equal(value.raw,deliveryA);},
        async openEarningClient(){return {driver:'postgres',raw:consumer};},
        async retireConfirmedEarningClient(value){assert.equal(value.raw,consumer);},
      });
      const runtimeOutcome=await runtimeCandidate.runEventOnce('runtime-candidate');
      assert.deepEqual(runtimeOutcome,{status:'completed',queueAckSafe:false,
        physicalClose:'not_observed',disposition:'completed',result:{
          eventId:'runtime-candidate',decision:'credited',creditedAttempts:1,
          pendingAttempts:0,netMicros:'5625000',
        }});
      assert.equal((await job('runtime-candidate')).status,'completed');
      assert.equal(await balance(),beforeRuntimeBalance+5625000n);
      stage('dedicated-login-event-id-runtime-candidate-credits-and-acks-once');

      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n
        FROM ${deliverySchema}.shared_key_event_delivery_jobs`))[0].n,
      (await migrator.unsafe(`SELECT count(*)::int AS n
        FROM ${outbox}.shared_key_economic_events`))[0].n);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n
        FROM ${deliverySchema}.shared_key_event_delivery_jobs j
        WHERE j.status='completed' AND NOT EXISTS
          (SELECT 1 FROM ${consumerSchema}.shared_key_event_consumptions c
            WHERE c.event_id=j.event_id)`))[0].n,0);
      stage('every-committed-event-has-one-job-and-every-completion-a-marker');
      report.status='PASS';
    } catch(error) {
      failure=error;report.status='FAIL';report.error=info(error);
    } finally {
      await Promise.allSettled(clients.map(sql=>sql.end({timeout:1})));
      try {await cluster.cleanup();report.cleanup='PASS';}
      catch(error) {report.cleanup='FAIL';report.cleanupError=info(error);failure??=error;}
      await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
      console.log('Native shared-key economic delivery report: '+reportPath);
    }
    if(failure) throw failure;
  });
