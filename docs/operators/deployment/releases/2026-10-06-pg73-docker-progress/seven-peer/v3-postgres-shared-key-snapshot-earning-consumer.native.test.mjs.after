// Review-only PG18.6 fixture. Fresh loopback cluster; synthetic actors only.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { listPg73Migrations } from './pg73-native-fixture.mjs';

const gateway='cinatoken_gateway';
const quotes='cinatoken_economic_quotes';
const outbox='cinatoken_economic_outbox';
const consumerSchema='cinatoken_economic_consumer';
const migrations=new URL('../../../packages/core/migrations-postgres/',import.meta.url);
const proposalPaths={
  quote:new URL('../../../packages/core/migrations-proposals/postgres/shared-key-quote-versions.sql',import.meta.url),
  dispatch:new URL('../../../packages/core/migrations-proposals/postgres/shared-key-dispatch-quote-attempts.sql',import.meta.url),
  outbox:new URL('../../../packages/core/migrations-proposals/postgres/shared-key-economic-outbox.sql',import.meta.url),
  consumer:new URL('../../../packages/core/migrations-proposals/postgres/shared-key-snapshot-earning-consumer.sql',import.meta.url),
};
const sha=value=>createHash('sha256').update(value).digest('hex');
const info=error=>({code:error?.code??null,constraint:error?.constraint_name??null,
  message:String(error?.message??error).slice(0,300)});

function client(cluster,username,password,label) {
  return postgres({host:'127.0.0.1',port:cluster.port,database:'postgres',
    username,password,ssl:false,max:1,prepare:false,fetch_types:false,
    connect_timeout:3,idle_timeout:0,max_lifetime:0,backoff:false,onnotice(){},
    connection:{application_name:`cinatoken-snapshot-consumer-v340-${label}`}});
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
function quote(id,inputPrice='1.250000',commission='0.100000') {
  return {version_id:id,shared_key_id:'snapshot-key',seller_user_id:'snapshot-seller',
    input_price_per_million:inputPrice,output_price_per_million:'2.500000',
    cache_read_price_per_million:'0.100000',cache_write_price_per_million:'0.200000',
    commission_rate:commission,currency:'USD',price_unit:'per_million_tokens',
    billing_mode:'shared_seller_key',entitlement_version:'synthetic-entitlement-v1'};
}
async function insertLog(tx,id,{charge='10.000000',chargeMicros=10000000,
  input=1000000,output=2000000}={}) {
  await tx.unsafe(`INSERT INTO ${gateway}.api_key_request_logs
    (id,user_id,api_key_id,workspace_id,charged_cost,budget_charged_micros,
      input_tokens,output_tokens,cache_read_tokens,cache_write_tokens)
    VALUES ($1,'snapshot-buyer','snapshot-api-key','snapshot-workspace',
      $2,$3,$4,$5,0,0)`,[id,charge,chargeMicros,input,output]);
}
function event(id,count,{charge='10.000000',chargeMicros=10000000,
  input=1000000,output=2000000,certainty='confirmed',basis='actual',
  buyerCertainty='actual'}={}) {
  return {event_id:id,request_log_id:id,event_type:'shared_key_usage_settled',
    event_version:1,buyer_user_id:'snapshot-buyer',buyer_api_key_id:'snapshot-api-key',
    workspace_id:'snapshot-workspace',buyer_charge_basis:basis,
    buyer_usage_certainty:buyerCertainty,buyer_charged_cost:charge,
    buyer_budget_charged_micros:chargeMicros,buyer_input_tokens:input,
    buyer_output_tokens:output,buyer_cache_read_tokens:0,
    buyer_cache_write_tokens:0,attempt_count:count,event_certainty:certainty};
}
function outcome(id,claim,overrides={}) {
  return {event_id:id,request_log_id:id,attempt_id:claim.attempt_id,
    attempt_index:claim.attempt_index,shared_key_id:claim.shared_key_id,
    transition_id:claim.transition_id,quote_version_id:claim.quote_version_id,
    usage_certainty:'actual',input_tokens:1000000,output_tokens:2000000,
    cache_read_tokens:0,cache_write_tokens:0,provider_cost_certainty:'actual',
    provider_cost_micros:2000000,evidence_kind:'provider_usage',
    evidence_sha256:'b'.repeat(64),observed_at:new Date().toISOString(),
    ...overrides};
}

test('native PG18 snapshot seller consumer uses immutable per-attempt quote and atomic event idempotency',
  {timeout:300_000,skip:!process.env.GATEWAY_NATIVE_PG_BIN},async()=>{
    const cluster=await startNativePostgres();
    const reportPath=join(dirname(cluster.owned),
      `report-snapshot-consumer-v340-${randomUUID()}.json`);
    const report={status:'RUNNING',cleanup:'PENDING',binaryVersion:cluster.binaryVersion,
      scope:'owned PG18.6; PG73 + v338 quote + v339 dispatch/outbox + v340 consumer proposals',
      stages:[],sourceSha256:{},limitations:[
        'No production outbox producer, consumer worker, queue, adjustment event or payout is activated.',
        'The fixture is PostgreSQL-only and synthetic; it does not prove D1/MySQL or real critical-write integration.',
        'A pending_manual v1 decision is not resolved in place. Late actual reconciliation requires the C05 adjustment event and approval contract.',
        'The proposal credits the current withdrawable seller balance for confirmed actual-buyer attempts; C12 release/hold policy and financial approval remain open.',
        'The formula follows the legacy shared-key token-price calculation, not provider_cost_micros; provider cost is a certainty gate.',
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
        CREATE ROLE cinatoken_consumer_acl_probe NOLOGIN;
        CREATE SCHEMA ${gateway} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime,cinatoken_gateway_shared_quote_attempt_producer,
          cinatoken_gateway_shared_earning_consumer;
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator=client(cluster,'cinatoken_gateway_migrator',migratorPassword,'migrator');
      const producer=client(cluster,'cinatoken_gateway_shared_quote_attempt_producer',producerPassword,'producer');
      const consumerA=client(cluster,'cinatoken_gateway_shared_earning_consumer',consumerPassword,'consumer-a');
      const consumerB=client(cluster,'cinatoken_gateway_shared_earning_consumer',consumerPassword,'consumer-b');
      const runtime=client(cluster,'cinatoken_gateway_runtime',runtimePassword,'runtime');
      clients.push(migrator,producer,consumerA,consumerB,runtime);
      await migrator.unsafe(`CREATE TABLE ${gateway}.schema_migrations
        (version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`);
      const files = await listPg73Migrations();
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
        nativeTest:sha(await readFile(new URL(import.meta.url)))};
      await migrator.begin(async tx=>{
        await tx.unsafe("SET LOCAL cinatoken.shared_key_quote_versions_activation = 'reviewed-v2'");
        await tx.unsafe(bodies.quote).simple();
      });
      await migrator.begin(async tx=>{
        await tx.unsafe("SET LOCAL cinatoken.shared_quote_attempt_activation = 'reviewed-v1'");
        await tx.unsafe(bodies.dispatch).simple();
      });
      await migrator.begin(async tx=>{
        await tx.unsafe("SET LOCAL cinatoken.shared_key_economic_outbox_activation = 'reviewed-v1'");
        await tx.unsafe(bodies.outbox).simple();
      });
      stage('immutable-quote-attempt-outbox-dependencies-installed');

      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(bodies.consumer).simple();
      }),/Snapshot earning consumer activation or migration ledger differs/);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`UPDATE ${gateway}.schema_migrations
          SET version='0042_forged_middle_version.sql'
          WHERE version='0042_gateway_keys_workspace.sql'`);
        await tx.unsafe("SET LOCAL cinatoken.shared_key_snapshot_consumer_activation = 'reviewed-v1'");
        await tx.unsafe(bodies.consumer).simple();
      }),/Snapshot earning consumer activation or migration ledger differs/);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`ALTER TABLE ${gateway}.shared_key_earnings
          DISABLE TRIGGER shared_key_earnings_reject_economic_event`);
        await tx.unsafe("SET LOCAL cinatoken.shared_key_snapshot_consumer_activation = 'reviewed-v1'");
        await tx.unsafe(bodies.consumer).simple();
      }),/Snapshot earning consumer source ownership or guard differs/);
      assert.equal((await migrator.unsafe(`SELECT
        pg_catalog.to_regnamespace('${consumerSchema}') IS NULL AS absent`))[0].absent,true);
      stage('default-off-exact-ledger-and-legacy-guard-preflight');

      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES GRANT USAGE ON SCHEMAS
        TO cinatoken_consumer_acl_probe WITH GRANT OPTION`);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe("SET LOCAL cinatoken.shared_key_snapshot_consumer_activation = 'reviewed-v1'");
        await tx.unsafe(bodies.consumer).simple();
      }),/Snapshot earning consumer activation or migration ledger differs/);
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES REVOKE USAGE ON SCHEMAS
        FROM cinatoken_consumer_acl_probe`);
      stage('hostile-default-schema-grant-option-rejected-before-ddl');

      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES GRANT USAGE ON SCHEMAS
          TO cinatoken_consumer_acl_probe;
        ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES
          TO cinatoken_consumer_acl_probe;
        ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS
          TO cinatoken_consumer_acl_probe;`).simple();
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe("SET LOCAL cinatoken.shared_key_snapshot_consumer_activation = 'reviewed-v1'");
        await tx.unsafe(bodies.consumer).simple();
      }),/Snapshot earning consumer ACL exceeds reviewed contract/);
      assert.equal((await migrator.unsafe(`SELECT
        pg_catalog.to_regnamespace('${consumerSchema}') IS NULL AS absent`))[0].absent,true);
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES REVOKE USAGE ON SCHEMAS
          FROM cinatoken_consumer_acl_probe;
        ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES
          FROM cinatoken_consumer_acl_probe;
        ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS
          FROM cinatoken_consumer_acl_probe;`).simple();
      await migrator.begin(async tx=>{
        await tx.unsafe("SET LOCAL cinatoken.shared_key_snapshot_consumer_activation = 'reviewed-v1'");
        await tx.unsafe(bodies.consumer).simple();
      });
      stage('private-consumer-install-and-hostile-default-acl-rejection');

      const postflight=bodies.consumer.match(/DO \$postflight\$[\s\S]*?\$postflight\$;/)?.[0];
      assert.ok(postflight);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`GRANT USAGE ON SCHEMA ${consumerSchema}
          TO cinatoken_gateway_shared_earning_consumer WITH GRANT OPTION`);
        await tx.unsafe(postflight).simple();
      }),/Snapshot earning consumer ACL exceeds reviewed contract/);
      await assert.rejects(migrator.begin(async tx=>{
        await tx.unsafe(`GRANT EXECUTE ON FUNCTION ${consumerSchema}.
          consume_shared_key_economic_event(text)
          TO cinatoken_gateway_shared_earning_consumer WITH GRANT OPTION`);
        await tx.unsafe(postflight).simple();
      }),/Snapshot earning consumer ACL exceeds reviewed contract/);
      stage('consumer-schema-and-function-grant-option-drift-rejected');

      await expectCode(runtime.unsafe(`SELECT * FROM ${consumerSchema}.
        consume_shared_key_economic_event('absent')`),'42501');
      await expectCode(consumerA.unsafe(`SELECT * FROM ${consumerSchema}.
        shared_key_attempt_consumptions`),'42501');
      await expectCode(consumerA.unsafe(`INSERT INTO ${consumerSchema}.
        shared_key_event_consumptions(event_id,decision,attempt_count,
          credited_attempts,pending_attempts,total_net_micros,processed_at)
        VALUES ('forged','credited',1,1,0,0,now())`),'42501');
      await expectCode(migrator.unsafe(`SELECT * FROM ${consumerSchema}.
        consume_shared_key_economic_event('absent')`),'23514',
      'shared_key_consumer_protocol');
      stage('runtime-and-direct-write-denied-dedicated-function-only');

      await migrator.unsafe(`INSERT INTO ${gateway}.users(id,email) VALUES
          ('snapshot-seller','seller-snapshot@example.invalid'),
          ('snapshot-buyer','buyer-snapshot@example.invalid');
        INSERT INTO ${gateway}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,is_default,default_scope_key)
          VALUES ('snapshot-workspace','personal','snapshot-buyer','Default','default',
            true,'personal:snapshot-buyer');
        INSERT INTO ${gateway}.api_keys(id,key,user_id,workspace_id)
          VALUES ('snapshot-api-key','synthetic-api-key','snapshot-buyer','snapshot-workspace');
        INSERT INTO ${gateway}.shared_keys
          (id,seller_user_id,channel_type,api_key,key_fingerprint,status)
          VALUES ('snapshot-key','snapshot-seller','openai','synthetic-upstream-key',
            'synthetic-fingerprint','active');`).simple();
      await insertObject(migrator,`${quotes}.shared_key_quote_versions`,quote('snapshot-q1'));
      await migrator.unsafe(`INSERT INTO ${quotes}.shared_key_quote_transitions
        (transition_id,shared_key_id,supersedes_transition_id,transition_kind,
          quote_version_id,seller_user_id)
        VALUES ('snapshot-t1','snapshot-key',NULL,'activate','snapshot-q1','snapshot-seller')`);
      const claim=async(id,index)=>(await producer.unsafe(`SELECT * FROM
        ${quotes}.claim_shared_key_dispatch_quote_attempt($1,$2,$3,'snapshot-key','synthetic-target')`,
      [randomUUID(),id,index]))[0];
      const consume=async(sql,id)=>(await sql.unsafe(`SELECT * FROM
        ${consumerSchema}.consume_shared_key_economic_event($1)`,[id]))[0];
      const balance=async()=>BigInt((await migrator.unsafe(`SELECT balance_micros::text AS n
        FROM ${gateway}.user_earnings WHERE user_id='snapshot-seller'`))[0]?.n??0);
      const counts=async id=>(await migrator.unsafe(`SELECT
        (SELECT count(*)::int FROM ${consumerSchema}.shared_key_attempt_consumptions
          WHERE event_id=$1) AS details,
        (SELECT count(*)::int FROM ${consumerSchema}.shared_key_event_consumptions
          WHERE event_id=$1) AS markers,
        (SELECT count(*)::int FROM ${gateway}.portal_ledger_entries
          WHERE reference_type='shared_key_attempt_earning' AND reference_id IN
            (SELECT attempt_id::text FROM ${outbox}.shared_key_economic_event_attempts
              WHERE event_id=$1)) AS ledger`,[id]))[0];
      const settle=async(id,claims,outcomes,options={})=>migrator.begin(async tx=>{
        await insertLog(tx,id,options);
        await insertObject(tx,`${outbox}.shared_key_economic_events`,event(id,claims.length,options));
        for(const row of outcomes) await insertObject(tx,
          `${outbox}.shared_key_economic_event_attempts`,row);
      });
      stage('synthetic-seller-buyer-quote-installed');

      const crash=await claim('crash-replay',1);
      await settle('crash-replay',[crash],[outcome('crash-replay',crash)]);
      await assert.rejects(consumerA.begin(async tx=>{
        const result=await consume(tx,'crash-replay');
        assert.deepEqual([result.out_decision,result.out_net_micros],
          ['credited','5625000']);
        throw new Error('synthetic-crash-before-commit');
      }),/synthetic-crash-before-commit/);
      assert.deepEqual(await counts('crash-replay'),{details:0,markers:0,ledger:0});
      assert.equal(await balance(),0n);
      stage('crash-before-commit-rolls-back-detail-balance-ledger-marker');

      const firstResult=await consume(consumerA,'crash-replay');
      assert.equal(firstResult.out_net_micros,'5625000');
      assert.deepEqual(await counts('crash-replay'),{details:1,markers:1,ledger:1});
      assert.equal(await balance(),5625000n);
      const account=(await migrator.unsafe(`SELECT balance_micros::text AS balance,
        locked_amount_micros::text AS locked,
        lifetime_earned_micros::text AS lifetime,
        contribution_value_micros::text AS contribution,
        balance::text AS displayed_balance
        FROM ${gateway}.user_earnings WHERE user_id='snapshot-seller'`))[0];
      assert.deepEqual(account,{balance:'5625000',locked:'0',lifetime:'5625000',
        contribution:'5625000',displayed_balance:'5.625000'});
      const replay=await consume(consumerB,'crash-replay');
      assert.deepEqual(replay,firstResult);
      assert.equal(await balance(),5625000n);
      stage('commit-ack-loss-replay-same-event-one-credit');

      const replayRace=await claim('concurrent-replay',1);
      await settle('concurrent-replay',[replayRace],[outcome('concurrent-replay',replayRace)]);
      let entered;
      let release;
      const reached=new Promise(resolve=>{entered=resolve;});
      const hold=new Promise(resolve=>{release=resolve;});
      const winner=consumerA.begin(async tx=>{
        const result=await consume(tx,'concurrent-replay');
        entered();
        await hold;
        return result;
      });
      await reached;
      const loser=consume(consumerB,'concurrent-replay');
      const observed=await Promise.race([loser.then(()=> 'completed'),
        delay(120).then(()=> 'blocked')]);
      assert.equal(observed,'blocked');
      release();
      const [winnerResult,loserResult]=await Promise.all([winner,loser]);
      assert.deepEqual(loserResult,winnerResult);
      assert.deepEqual(await counts('concurrent-replay'),{details:1,markers:1,ledger:1});
      assert.equal(await balance(),11250000n);
      stage('concurrent-consumers-serialize-on-event-row-one-credit');

      // The later-started event wins the seller account first while the
      // earlier-started consumer waits on a different request-log row. The
      // old function-entry timestamp would reverse ledger time order here.
      const timeLate=await claim('timestamp-late-credit',1);
      const timeFirst=await claim('timestamp-first-credit',1);
      await settle('timestamp-late-credit',[timeLate],
        [outcome('timestamp-late-credit',timeLate)]);
      await settle('timestamp-first-credit',[timeFirst],
        [outcome('timestamp-first-credit',timeFirst)]);
      let logLocked;
      let releaseLog;
      const didLockLog=new Promise(resolve=>{logLocked=resolve;});
      const logHold=new Promise(resolve=>{releaseLog=resolve;});
      const heldLog=migrator.begin(async tx=>{
        await tx.unsafe(`SELECT id FROM ${gateway}.api_key_request_logs
          WHERE id='timestamp-late-credit' FOR UPDATE`);
        logLocked();
        await logHold;
      });
      await didLockLog;
      const laterCommit=consume(consumerB,'timestamp-late-credit');
      let waiting=false;
      try {
        for(let poll=0;poll<30;poll++) {
          const [activity]=await cluster.admin.unsafe(`SELECT wait_event_type
            FROM pg_catalog.pg_stat_activity
            WHERE application_name='cinatoken-snapshot-consumer-v340-consumer-b'
              AND state='active'`);
          if(activity?.wait_event_type==='Lock') {waiting=true;break;}
          await delay(50);
        }
        assert.equal(waiting,true,'earlier consumer must reach blocked log lock');
        const firstCredit=await consume(consumerA,'timestamp-first-credit');
        assert.equal(firstCredit.out_net_micros,'5625000');
      } finally {
        releaseLog();
      }
      await heldLog;
      const lastCredit=await laterCommit;
      assert.equal(lastCredit.out_net_micros,'5625000');
      const [timeOrder]=await migrator.unsafe(`SELECT
        first_ledger.balance_after_micros::text AS first_balance,
        last_ledger.balance_after_micros::text AS last_balance,
        first_ledger.created_at<last_ledger.created_at AS ledger_time_increases,
        account.updated_at=last_ledger.created_at AS account_matches_last,
        first_detail.processed_at=first_ledger.created_at AS first_detail_matches,
        last_detail.processed_at=last_ledger.created_at AS last_detail_matches
        FROM ${gateway}.portal_ledger_entries AS first_ledger
        JOIN ${gateway}.portal_ledger_entries AS last_ledger
          ON last_ledger.reference_id=$2
          AND last_ledger.reference_type='shared_key_attempt_earning'
        JOIN ${consumerSchema}.shared_key_attempt_consumptions AS first_detail
          ON first_detail.attempt_id::text=$1
        JOIN ${consumerSchema}.shared_key_attempt_consumptions AS last_detail
          ON last_detail.attempt_id::text=$2
        JOIN ${gateway}.user_earnings AS account
          ON account.user_id='snapshot-seller'
        WHERE first_ledger.reference_id=$1
          AND first_ledger.reference_type='shared_key_attempt_earning'`,
      [timeFirst.attempt_id,timeLate.attempt_id]);
      assert.equal(BigInt(timeOrder.last_balance)-BigInt(timeOrder.first_balance),
        5625000n);
      assert.deepEqual([timeOrder.ledger_time_increases,
        timeOrder.account_matches_last,timeOrder.first_detail_matches,
        timeOrder.last_detail_matches],[true,true,true,true]);
      stage('same-seller-opposite-entry-order-keeps-balance-and-ledger-time-monotone');

      const mixedKnown=await claim('mixed-outcomes',1);
      const mixedUnknown=await claim('mixed-outcomes',2);
      await settle('mixed-outcomes',[mixedKnown,mixedUnknown],[
        outcome('mixed-outcomes',mixedKnown,{input_tokens:1000000,output_tokens:0}),
        outcome('mixed-outcomes',mixedUnknown,{
          usage_certainty:'unknown',input_tokens:null,output_tokens:null,
          cache_read_tokens:null,cache_write_tokens:null,
          provider_cost_certainty:'unknown',provider_cost_micros:null,
          evidence_kind:'timeout',evidence_sha256:null})],
      {certainty:'unresolved'});
      const beforeMixed=await balance();
      const mixedResult=await consume(consumerA,'mixed-outcomes');
      assert.deepEqual([mixedResult.out_decision,mixedResult.out_credited_attempts,
        mixedResult.out_pending_attempts,mixedResult.out_net_micros],
      ['pending_manual',1,1,'1125000']);
      assert.equal(await balance(),beforeMixed+1125000n);
      const mixedRows=await migrator.unsafe(`SELECT attempt_index,decision,pending_reason,
        net_micros::text AS net FROM ${consumerSchema}.shared_key_attempt_consumptions
        WHERE event_id='mixed-outcomes' ORDER BY attempt_index`);
      assert.deepEqual(mixedRows.map(r=>[r.attempt_index,r.decision,r.pending_reason,r.net]),
        [[1,'credited',null,'1125000'],[2,'pending_manual','attempt_unresolved',null]]);
      assert.deepEqual(await counts('mixed-outcomes'),{details:2,markers:1,ledger:1});
      stage('mixed-known-and-unknown-attempts-credit-only-confirmed');

      const reserved=await claim('reserved-buyer',1);
      await settle('reserved-buyer',[reserved],[outcome('reserved-buyer',reserved)],
        {basis:'reserved',buyerCertainty:'unknown'});
      const beforeReserved=await balance();
      const reservedResult=await consume(consumerA,'reserved-buyer');
      assert.deepEqual([reservedResult.out_decision,reservedResult.out_credited_attempts,
        reservedResult.out_pending_attempts],['pending_manual',0,1]);
      assert.equal(await balance(),beforeReserved);
      assert.deepEqual(await counts('reserved-buyer'),{details:1,markers:1,ledger:0});
      stage('buyer-reserved-basis-cannot-form-withdrawable-credit');

      const estimated=await claim('estimated-cost',1);
      await settle('estimated-cost',[estimated],[outcome('estimated-cost',estimated,{
        provider_cost_certainty:'estimated'})],{certainty:'unresolved'});
      const beforeEstimated=await balance();
      const estimatedResult=await consume(consumerA,'estimated-cost');
      assert.deepEqual([estimatedResult.out_decision,
        estimatedResult.out_pending_attempts],['pending_manual',1]);
      assert.equal(await balance(),beforeEstimated);
      assert.deepEqual(await counts('estimated-cost'),{details:1,markers:1,ledger:0});
      stage('estimated-provider-cost-remains-pending-with-zero-credit');

      const falseActual=await claim('timeout-labeled-actual',1);
      await settle('timeout-labeled-actual',[falseActual],
        [outcome('timeout-labeled-actual',falseActual,{
          evidence_kind:'timeout'})]);
      const beforeFalseActual=await balance();
      const falseActualResult=await consume(consumerA,'timeout-labeled-actual');
      assert.deepEqual([falseActualResult.out_decision,
        falseActualResult.out_pending_attempts],['pending_manual',1]);
      assert.equal(await balance(),beforeFalseActual);
      assert.equal((await migrator.unsafe(`SELECT pending_reason FROM ${consumerSchema}.
        shared_key_attempt_consumptions
        WHERE event_id='timeout-labeled-actual'`))[0].pending_reason,
      'evidence_not_settleable');
      stage('timeout-label-with-forged-actual-certainty-stays-pending');

      const zero=await claim('confirmed-zero',1);
      await settle('confirmed-zero',[zero],[outcome('confirmed-zero',zero,{
        usage_certainty:'confirmed_zero',input_tokens:0,output_tokens:0,
        cache_read_tokens:0,cache_write_tokens:0,
        provider_cost_certainty:'confirmed_zero',provider_cost_micros:0,
        evidence_kind:'confirmed_rejection',evidence_sha256:null})],
      {charge:'0.000000',chargeMicros:0,input:0,output:0});
      const beforeZero=await balance();
      const zeroResult=await consume(consumerA,'confirmed-zero');
      assert.deepEqual([zeroResult.out_decision,zeroResult.out_net_micros],
        ['credited','0']);
      assert.equal(await balance(),beforeZero);
      assert.deepEqual(await counts('confirmed-zero'),{details:1,markers:1,ledger:1});
      stage('confirmed-zero-stable-zero-ledger-no-seller-credit');

      const reprice=await claim('old-quote',1);
      const splitFirst=await claim('split-quotes',1);
      const ledgerConflict=await claim('ledger-conflict',1);
      await settle('old-quote',[reprice],[outcome('old-quote',reprice)]);
      await settle('ledger-conflict',[ledgerConflict],
        [outcome('ledger-conflict',ledgerConflict)]);
      await insertObject(migrator,`${quotes}.shared_key_quote_versions`,
        quote('snapshot-q2','99.000000','0.900000'));
      await migrator.unsafe(`INSERT INTO ${quotes}.shared_key_quote_transitions
        (transition_id,shared_key_id,supersedes_transition_id,transition_kind,
          quote_version_id,seller_user_id)
        VALUES ('snapshot-t2','snapshot-key','snapshot-t1','activate',
          'snapshot-q2','snapshot-seller')`);
      const splitSecond=await claim('split-quotes',2);
      await settle('split-quotes',[splitFirst,splitSecond],[
        outcome('split-quotes',splitFirst),outcome('split-quotes',splitSecond)],
      {charge:'200.000000',chargeMicros:200000000});
      await insertObject(migrator,`${quotes}.shared_key_quote_versions`,
        quote('snapshot-q3','1.500000','0.333333'));
      await migrator.unsafe(`INSERT INTO ${quotes}.shared_key_quote_transitions
        (transition_id,shared_key_id,supersedes_transition_id,transition_kind,
          quote_version_id,seller_user_id)
        VALUES ('snapshot-t3','snapshot-key','snapshot-t2','activate',
          'snapshot-q3','snapshot-seller')`);
      const rounding=await claim('half-micro-round',1);
      await settle('half-micro-round',[rounding],[outcome('half-micro-round',rounding,{
        input_tokens:1,output_tokens:0,provider_cost_micros:1})],
      {charge:'0.000002',chargeMicros:2,input:1,output:0});
      await migrator.unsafe(`INSERT INTO ${quotes}.shared_key_quote_transitions
        (transition_id,shared_key_id,supersedes_transition_id,transition_kind,
          quote_version_id,seller_user_id)
        VALUES ('snapshot-t4','snapshot-key','snapshot-t3','revoke',
          NULL,'snapshot-seller');
        UPDATE ${gateway}.shared_keys SET status='revoked' WHERE id='snapshot-key'`).simple();
      const beforeReprice=await balance();
      const oldResult=await consume(consumerA,'old-quote');
      assert.equal(oldResult.out_net_micros,'5625000');
      assert.equal(await balance(),beforeReprice+5625000n);
      const oldDetail=(await migrator.unsafe(`SELECT quote_version_id,
        input_price_per_million::text AS input_price,
        commission_rate::text AS commission,net_micros::text AS net
        FROM ${consumerSchema}.shared_key_attempt_consumptions
        WHERE event_id='old-quote'`))[0];
      assert.deepEqual(oldDetail,{quote_version_id:'snapshot-q1',
        input_price:'1.250000',commission:'0.100000',net:'5625000'});
      const beforeSplit=await balance();
      const splitResult=await consume(consumerA,'split-quotes');
      assert.deepEqual([splitResult.out_decision,splitResult.out_net_micros],
        ['credited','16025000']);
      assert.equal(await balance(),beforeSplit+16025000n);
      const splitRows=await migrator.unsafe(`SELECT attempt_index,quote_version_id,
        gross_micros::text AS gross,platform_fee_micros::text AS fee,
        net_micros::text AS net FROM ${consumerSchema}.shared_key_attempt_consumptions
        WHERE event_id='split-quotes' ORDER BY attempt_index`);
      assert.deepEqual(splitRows.map(r=>[r.attempt_index,r.quote_version_id,r.gross,r.fee,r.net]),
        [[1,'snapshot-q1','6250000','625000','5625000'],
          [2,'snapshot-q2','104000000','93600000','10400000']]);
      stage('two-attempt-split-price-and-commission-use-own-captured-versions');

      const roundingResult=await consume(consumerA,'half-micro-round');
      assert.equal(roundingResult.out_net_micros,'1');
      const roundingDetail=(await migrator.unsafe(`SELECT gross_micros::text AS gross,
        platform_fee_micros::text AS fee,net_micros::text AS net
        FROM ${consumerSchema}.shared_key_attempt_consumptions
        WHERE event_id='half-micro-round'`))[0];
      assert.deepEqual(roundingDetail,{gross:'2',fee:'1',net:'1'});
      stage('half-micro-gross-round-and-ceiling-commission-match-legacy-policy');
      await expectCode(producer.unsafe(`SELECT * FROM
        ${quotes}.claim_shared_key_dispatch_quote_attempt($1,'after-revoke',1,
          'snapshot-key','synthetic-target')`,[randomUUID()]),
      '23514','shared_quote_attempt_unavailable');
      stage('reprice-commission-change-and-revoke-do-not-revalue-old-attempt');

      const beforeConflict=await balance();
      await migrator.unsafe(`INSERT INTO ${gateway}.portal_ledger_entries
        (id,user_id,kind,amount_micros,balance_after_micros,locked_after_micros,
          reference_type,reference_id,created_at)
        VALUES ('synthetic-ledger-conflict','snapshot-seller',
          'shared_key_attempt_earning',0,0,0,
          'shared_key_attempt_earning',$1,now())`,
      [ledgerConflict.attempt_id]);
      await expectCode(consume(consumerA,'ledger-conflict'),'23505',
        'portal_ledger_entries_reference_unique');
      assert.deepEqual(await counts('ledger-conflict'),{details:0,markers:0,ledger:1});
      assert.equal(await balance(),beforeConflict);
      await migrator.unsafe(`DELETE FROM ${gateway}.portal_ledger_entries
        WHERE id='synthetic-ledger-conflict'`);
      const conflictResult=await consume(consumerB,'ledger-conflict');
      assert.equal(conflictResult.out_net_micros,'5625000');
      assert.deepEqual(await counts('ledger-conflict'),{details:1,markers:1,ledger:1});
      assert.equal(await balance(),beforeConflict+5625000n);
      stage('ledger-unique-failure-atomically-rolls-back-and-replays');

      await expectCode(migrator.unsafe(`INSERT INTO ${gateway}.shared_key_earnings
        (id,request_log_id,shared_key_id,seller_user_id,
          gross_amount,platform_fee,net_amount)
        VALUES ('legacy-double-pay','old-quote','snapshot-key','snapshot-seller',
          6.250000,0.625000,5.625000)`),
      '23514','shared_key_economic_legacy_double_pay');
      assert.equal(await balance(),beforeConflict+5625000n);
      stage('legacy-synchronous-path-cannot-double-pay-consumed-event');

      await expectCode(migrator.unsafe(`UPDATE ${consumerSchema}.
        shared_key_attempt_consumptions SET net_micros=999999
        WHERE event_id='old-quote'`),'23514','shared_key_consumption_append_only');
      await expectCode(migrator.unsafe(`DELETE FROM ${consumerSchema}.
        shared_key_event_consumptions WHERE event_id='old-quote'`),
      '23514','shared_key_consumption_append_only');
      stage('consumption-detail-and-marker-append-only');

      report.status='PASS';
    } catch(error) {
      failure=error;report.status='FAIL';report.error=info(error);
    } finally {
      await Promise.allSettled(clients.map(sql=>sql.end({timeout:1})));
      try {await cluster.cleanup();report.cleanup='PASS';}
      catch(error) {report.cleanup='FAIL';report.cleanupError=info(error);failure??=error;}
      await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
      console.log('Native shared-key snapshot earning consumer report: '+reportPath);
    }
    if(failure) throw failure;
  });
