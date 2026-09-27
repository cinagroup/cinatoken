import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { pgCoreSchema } from '../drizzle/schema.pg.ts';
import { createFinancialEngine,now as recordedAt,expires } from '../../test-support/postgres-financial-engine.mjs';
import { createDispatchIntentRepositoryPostgres } from './dispatch-intent-postgres.ts';
import { createUsageSettlementFactsRepositoryPostgres } from './usage-settlement-facts-postgres.ts';
import { createUsageRecoveryJobsPostgres } from './usage-recovery-jobs-postgres.ts';
import { createUsageSettlementRepositoryPostgres } from './usage-settlement-postgres.ts';
import { runUsageRecoveryPostgres, createPostgresRecoveryRun } from './run-usage-recovery-postgres.ts';
import { supervisePostgresRecoveryRun } from './supervise-usage-recovery-postgres.ts';
import { createRequestCapacityPool } from '../../../../proxy/src/services/request-capacity.ts';
import { sample } from './usage-settlement-test-support.mjs';

const g='cinatoken_gateway',all={kind:'all'},tenant={kind:'tenant',userId:'user',workspaceId:'workspace'};
// Synthetic logical reservations, NOT measured Workers/Node memory or production defaults.
const options={scope:all,maxRegistrations:50,maxItems:50,concurrency:2,leaseSeconds:30,runBudgetMs:60000,reservedBytesPerScan:512,reservedBytesPerConsumer:1024};
const pool=(n=3)=>createRequestCapacityPool({maxRequests:n,maxReservedBytes:n*1024});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const claimSQL=q=>q.startsWith('UPDATE cinatoken_gateway.request_usage_recovery_jobs j SET state=CASE');
const receiptSQL=q=>q.startsWith('INSERT INTO cinatoken_gateway.request_usage_commit_receipts');
function observe(run){
  let time=0,id=0;const timers=new Map();
  const clock={now:()=>time,set(fn,delay){const key=++id;timers.set(key,{fn,at:time+delay});return key;},clear:key=>timers.delete(key)};
  const handle=supervisePostgresRecoveryRun(run,{observationBudgetMs:10,cleanupObservationMs:5},{clock});
  return {...handle,expire(){time=15;for(const [key,{fn}] of [...timers]){timers.delete(key);fn();}},timers:()=>timers.size};
}

test('PostgreSQL bounded recovery runner uses real immutable facts, jobs and original financial transactions',{timeout:180_000},async t=>{
  assert.ok(!process.env.GATEWAY_PG_FINANCIAL_BASELINE);
  const f=await createFinancialEngine({migrationHead:'0068_function_schema_resolution.sql'});t.after(()=>f.pg.close());
  for(const name of ['request-dispatch-intents.sql','request-usage-settlement-facts.sql','request-usage-recovery-jobs.sql','request-usage-commit-receipts.sql']){
    await f.pg.transaction(tx=>tx.exec(readFileSync(new URL('../../../migrations-proposals/postgres/'+name,import.meta.url),'utf8')));
  }
  await f.pg.transaction(tx=>tx.exec(readFileSync(new URL('../../../migrations-postgres/0073_recovery_api_key_workspace_lock.sql',import.meta.url),'utf8')));
  const intents=createDispatchIntentRepositoryPostgres(f.client),facts=createUsageSettlementFactsRepositoryPostgres(f.client),jobs=createUsageRecoveryJobsPostgres(f.client);
  const rows=async(q,p=[])=>(await f.pg.query(q,p)).rows;
  async function enqueue({cost=0.25,edit}={}){
    const value=sample(cost);Object.assign(value.intent,{userId:'user',apiKeyId:'key',workspaceId:'workspace'});
    Object.assign(value.params.requestLog,{userId:'user',apiKeyId:'key',workspaceId:'workspace',budgetAccountedAt:recordedAt});
    value.params.userId='user';value.params.audit.apiKeyId='key';value.params.audit.beforeSpent=1;value.params.beforeSpent=1;
    value.recordedAtIso=recordedAt;value.params.requestLog.providerAttempts[0].observedAtIso=recordedAt;edit?.(value);
    const now=Number((await rows('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS n'))[0].n);
    await intents.prepare(value.intent,now+60000);assert.equal(await intents.claim(value.intent,0,value.dispatchClaimId),'granted');
    if(value.params.userBudgetSettlement){
      await f.pg.query(`INSERT INTO ${g}.user_budget_reservations(request_id,user_id,api_key_id,budget_epoch,limit_micros,reserved_micros,state,expires_at,created_at,updated_at)
        VALUES($1,'user','key',0,10000000,500000,'dispatched',$2,$3,$3)`,[value.intent.requestId,expires,recordedAt]);
      await f.pg.exec(`UPDATE ${g}.users SET budget_reserved_micros=budget_reserved_micros+500000 WHERE id='user'`);
    }
    return {value,ref:await facts.persist(value)};
  }
  function wrapped(hooks={}){
    const adapt=raw=>({...raw,unsafe(q,p=[]){
      let pending;const run=mode=>pending??=(async()=>{await hooks.beforeQuery?.(q,p,raw);const operation=raw.unsafe(q,p);
        const result=mode==='array'?await operation.values():await operation;await hooks.afterQuery?.(q,p,result,raw);return result;})();
      return {then:(yes,no)=>run('object').then(yes,no),values:()=>run('array')};
    }});
    const raw={...adapt(f.client.raw),async begin(run){
      await hooks.beforeBegin?.();const value=await f.client.raw.begin(async tx=>{const result=await run(adapt(tx));await hooks.beforeCommit?.(tx);return result;});
      await hooks.afterCommit?.();return value;
    }};
    return {driver:'postgres',raw,drizzle:drizzle(raw,{schema:pgCoreSchema})};
  }
  async function check(name,run){await t.test(name,async()=>{await f.reset('public,pg_temp,pg_catalog');await run();});}
  const summary=async()=>(await rows(`SELECT (SELECT count(*)::int FROM ${g}.request_usage_commit_receipts) AS receipts,
    (SELECT count(*)::int FROM ${g}.api_key_request_logs) AS logs,(SELECT budget_spent::text FROM ${g}.users WHERE id='user') AS spent`))[0];

  await check('bounded discovery repairs missing jobs, commits original facts once and releases all successful holds',async()=>{
    const entries=[];for(let i=0;i<3;i++)entries.push(await enqueue());const capacity=pool();
    const result=await runUsageRecoveryPostgres(f.client,options,capacity);
    assert.equal(result.registered,3);assert.equal(result.scanned,3);assert.equal(result.committed,3);assert.equal(result.resources,'confirmed');
    assert.equal(capacity.snapshot().requests,0);assert.deepEqual(await summary(),{receipts:3,logs:3,spent:'1.750000'});
    for(const {ref,value} of entries){assert.equal((await jobs.inspect(ref)).state,'committed');assert.deepEqual(await facts.load(ref),value);}
    const next=await runUsageRecoveryPostgres(f.client,options,capacity);assert.equal(next.scanned,0);assert.equal(next.committed,0);
  });
  await check('separate registration/item limits cap each list and repeated invocations discover the rest without a cursor',async()=>{
    for(let i=0;i<5;i++)await enqueue({cost:0});const capacity=pool();
    const first=await runUsageRecoveryPostgres(f.client,{...options,maxRegistrations:2,maxItems:1},capacity);
    assert.equal(first.discovered,2);assert.equal(first.registered,2);assert.equal(first.scanned,1);assert.equal(first.claimed,1);assert.equal(first.committed,1);
    assert.equal((await jobs.scanUnregistered(all,50)).length,3);
    const second=await runUsageRecoveryPostgres(f.client,options,capacity);assert.equal(second.registered,3);assert.equal(second.committed,4);
  });
  await check('no capacity or scan-only capacity issues no database reads/writes',async()=>{
    await enqueue();
    for(const n of [0,1]){
      const capacity=n?pool(1):{tryAcquire:()=>null};let io=0;const client=wrapped({beforeQuery(){io++;}});
      const result=await runUsageRecoveryPostgres(client,options,capacity);assert.equal(result.capacityLimited,true);assert.equal(io,0);
      if(n)assert.equal(capacity.snapshot().requests,0);
    }
  });
  await check('partial capacity runs fewer consumers and owns scan overhead before any database operation',async()=>{
    await enqueue();const capacity=pool(2);let checked=0;
    const result=await runUsageRecoveryPostgres(wrapped({beforeQuery(){checked++;assert.equal(capacity.snapshot().requests,2);assert.equal(capacity.snapshot().reservedBytes,1536);}}),options,capacity);
    assert.ok(checked>0);assert.equal(result.capacityLimited,true);assert.equal(result.committed,1);assert.equal(capacity.snapshot().requests,0);
  });
  await check('pre-aborted run and invalid options/clock reject without allocating capacity or accessing DB',async()=>{
    let acquisitions=0,io=0;const capacity={tryAcquire(){acquisitions++;return {release(){}};}},client=wrapped({beforeQuery(){io++;}});
    const abort=new AbortController();abort.abort();assert.equal((await runUsageRecoveryPostgres(client,options,capacity,{signal:abort.signal})).stopReason,'aborted');
    for(const patch of [{maxItems:0},{maxRegistrations:51},{concurrency:5},{leaseSeconds:301},{runBudgetMs:60001},{reservedBytesPerScan:0},{reservedBytesPerConsumer:NaN},{scope:{}}]){
      await assert.rejects(runUsageRecoveryPostgres(client,{...options,...patch},capacity),TypeError);
    }
    await assert.rejects(runUsageRecoveryPostgres(client,options,capacity,{now:()=>NaN}),TypeError);
    for(const driver of ['d1','mysql'])await assert.rejects(runUsageRecoveryPostgres({...client,driver},options,capacity),TypeError);
    assert.equal(acquisitions,0);assert.equal(io,0);
  });
  await check('options and scope are owned before asynchronous scan callbacks can mutate caller input',async()=>{
    await enqueue();const mutable={...options,scope:{...tenant},maxItems:1,maxRegistrations:1};let edited=false;
    const result=await runUsageRecoveryPostgres(wrapped({beforeQuery(){if(!edited){edited=true;mutable.scope.userId='other';mutable.maxItems=0;mutable.maxRegistrations=0;}}}),mutable,pool());
    assert.equal(result.committed,1);
  });
  await check('foreign tenant cannot discover, register, claim or charge another tenant fact',async()=>{
    const {ref}=await enqueue(),before=await f.snapshot(g);
    const result=await runUsageRecoveryPostgres(f.client,{...options,scope:{...tenant,userId:'other'}},pool());
    assert.equal(result.discovered,0);assert.equal(result.scanned,0);assert.equal(await jobs.inspect(ref),null);assert.deepEqual(await f.snapshot(g),before);
  });
  await check('stop during pending scan retains its capacity; late data causes no registration or claim',async()=>{
    await enqueue();const entered=deferred(),gate=deferred(),abort=new AbortController(),capacity=pool();let finished=false;
    const client=wrapped({async beforeQuery(q){if(q.includes('NOT EXISTS (SELECT 1 FROM cinatoken_gateway.request_usage_recovery_jobs')){entered.resolve();await gate.promise;}}});
    const pending=runUsageRecoveryPostgres(client,options,capacity,{signal:abort.signal}).then(x=>{finished=true;return x;});
    await entered.promise;abort.abort();await tick();assert.equal(finished,false);assert.equal(capacity.snapshot().requests,3);
    gate.resolve();const result=await pending;assert.equal(result.registered,0);assert.equal(result.claimed,0);assert.equal(result.stopReason,'aborted');assert.equal(capacity.snapshot().requests,0);
  });
  await check('stop after acknowledged claim defers same lease as interrupted without financial writes',async()=>{
    const {ref}=await enqueue(),abort=new AbortController();
    const result=await runUsageRecoveryPostgres(wrapped({afterQuery(q){if(claimSQL(q))abort.abort();}}),options,pool(),{signal:abort.signal});
    assert.equal(result.claimed,1);assert.equal(result.committed,0);assert.equal(result.deferred,1);
    assert.equal((await jobs.inspect(ref)).lastError,'interrupted');assert.equal((await summary()).receipts,0);
  });
  await check('admission clock regression is latched even when still later than run start',async()=>{
    await enqueue();let clock=100;
    const result=await runUsageRecoveryPostgres(wrapped({afterQuery(q){if(q.includes('NOT EXISTS (SELECT 1 FROM cinatoken_gateway.request_usage_recovery_jobs'))clock=200;
      if(q.startsWith('INSERT INTO cinatoken_gateway.request_usage_recovery_jobs'))clock=150;}}),options,pool(),{now:()=>clock});
    assert.equal(result.stopReason,'clock_invalid');assert.equal(result.claimed,0);
  });
  await check('admission deadline prevents claim after a slow registration but does not pretend to cancel that operation',async()=>{
    await enqueue();let clock=0;
    const result=await runUsageRecoveryPostgres(wrapped({afterQuery(q){if(q.startsWith('INSERT INTO cinatoken_gateway.request_usage_recovery_jobs'))clock=10;}}),{...options,runBudgetMs:10},pool(),{now:()=>clock});
    assert.equal(result.stopReason,'budget');assert.equal(result.registered,1);assert.equal(result.claimed,0);
  });
  await check('known unrepresentable text blocks with a fixed conflict code, preserves the fact and safely releases resources',async()=>{
    const {ref,value}=await enqueue({edit:v=>v.params.requestLog.errorMessage='\u0000'}),capacity=pool();
    const result=await runUsageRecoveryPostgres(f.client,options,capacity);
    assert.equal(result.blocked,1);assert.equal((await jobs.inspect(ref)).lastError,'settlement_conflict');assert.equal(result.resources,'confirmed');
    assert.equal(capacity.snapshot().requests,0);assert.deepEqual(await facts.load(ref),value);assert.equal((await summary()).receipts,0);
  });
  await check('confirmed claim ACK loss grants no financial permission, starts no later candidate and retains only its uncertain lane',async()=>{
    await enqueue();await enqueue();const capacity=pool();let claimTx=false;
    const result=await runUsageRecoveryPostgres(wrapped({afterQuery(q){if(claimSQL(q))claimTx=true;},afterCommit(){if(claimTx){claimTx=false;throw new Error('claim ACK lost');}}}),{...options,concurrency:1},capacity);
    assert.equal(result.claimed,0);assert.equal(result.committed,0);assert.equal(result.stopReason,'database_unconfirmed');assert.equal(result.uncertain,1);
    assert.equal(result.retainedHolds,1);assert.equal(capacity.snapshot().requests,1);assert.equal((await summary()).receipts,0);
  });
  await check('registration ACK loss can confirm the row but stops admission and retains the scan resource owner',async()=>{
    const {ref}=await enqueue(),capacity=pool();let hit=false;
    const result=await runUsageRecoveryPostgres(wrapped({afterQuery(q){if(q.startsWith('INSERT INTO cinatoken_gateway.request_usage_recovery_jobs')){hit=true;throw new Error('registration ACK lost');}}}),options,capacity);
    assert.equal(hit,true);assert.equal(result.registered,1);assert.equal(result.claimed,0);assert.equal(result.resources,'unconfirmed');
    assert.equal(capacity.snapshot().requests,1);assert.equal(capacity.snapshot().reservedBytes,512);assert.equal((await jobs.inspect(ref)).state,'pending');
  });
  await check('rejected outer claim keeps its still-running transaction callback owned without granting or failing that lease',async()=>{
    const {ref}=await enqueue(),capacity=pool(),entered=deferred(),gate=deferred(),closed=deferred();let background,finished=false;
    const base=wrapped({async afterQuery(q){if(claimSQL(q)){entered.resolve();await gate.promise;}}});
    const raw={...base.raw,begin(run){background=base.raw.begin(run);void background.catch(()=>undefined);return Promise.race([background,closed.promise]);}};
    const client={driver:'postgres',raw,drizzle:drizzle(raw,{schema:pgCoreSchema})};
    const pending=runUsageRecoveryPostgres(client,{...options,concurrency:1},capacity).then(x=>{finished=true;return x;});
    await entered.promise;closed.reject(new Error('synthetic connection-close race'));await tick();await tick();
    assert.equal(finished,false);assert.ok(capacity.snapshot().requests>=1);
    gate.resolve();const result=await pending;await background;
    assert.equal(result.claimed,0);assert.equal(result.committed,0);assert.equal(result.uncertain,1);assert.equal(result.retainedHolds,1);
    assert.equal(capacity.snapshot().requests,1);assert.equal((await jobs.inspect(ref)).state,'leased');assert.equal((await summary()).receipts,0);
  });
  await check('one consumer failure does not release a peer still waiting to start its already-admitted claim',async()=>{
    await enqueue();await enqueue();const capacity=pool(),entered=deferred(),gate=deferred(),failed=deferred();let begins=0,finished=false;
    const client=wrapped({async beforeBegin(){begins++;if(begins===1){entered.resolve();await gate.promise;}else{failed.resolve();throw new Error('peer begin failure');}}});
    const pending=runUsageRecoveryPostgres(client,options,capacity).then(x=>{finished=true;return x;});
    await entered.promise;await failed.promise;await tick();assert.equal(finished,false);assert.equal(capacity.snapshot().requests,3);
    gate.resolve();const result=await pending;assert.equal(result.committed,0);assert.equal(result.claimed,1);assert.equal(result.leasesLeftForExpiry,1);
    assert.equal(result.retainedHolds,1);assert.equal(capacity.snapshot().requests,1);
  });
  await check('known decoded snapshot corruption is blocked with no raw error text or financial debit',async()=>{
    const {ref}=await enqueue(),capacity=pool();
    const result=await runUsageRecoveryPostgres(wrapped({afterQuery(q,p,result){if(q.startsWith('SELECT')&&q.includes('s.payload_json'))result[0].payload_json='{}';}}),options,capacity);
    assert.equal(result.blocked,1);assert.equal((await jobs.inspect(ref)).lastError,'snapshot_invalid');assert.equal(result.resources,'confirmed');
    assert.equal(capacity.snapshot().requests,0);assert.equal((await summary()).receipts,0);
  });
  await check('five expired recovery claims become blocked without another recovery grant or any inference',async()=>{
    const {ref}=await enqueue({cost:0});await jobs.ensure(ref);
    for(let i=0;i<5;i++){
      const state=await jobs.inspect(ref);assert.equal((await jobs.claim({ref,revision:state.revision},1)).status,'claimed');
      await f.pg.query('SELECT pg_sleep(1.1)');
    }
    const result=await runUsageRecoveryPostgres(f.client,options,pool());assert.equal(result.blocked,1);assert.equal(result.claimed,0);assert.equal(result.committed,0);
    assert.equal((await jobs.inspect(ref)).lastError,'retry_exhausted');assert.equal((await summary()).receipts,0);
  });
  await check('financial ACK loss may confirm committed result but never clears the independent resource uncertainty',async()=>{
    await enqueue();const capacity=pool();let financial=false;
    const result=await runUsageRecoveryPostgres(wrapped({afterQuery(q){if(receiptSQL(q))financial=true;},afterCommit(){if(financial){financial=false;throw new Error('financial ACK lost');}}}),options,capacity);
    assert.equal(result.committed,1);assert.equal(result.resources,'unconfirmed');assert.equal(result.retainedHolds,1);assert.equal(capacity.snapshot().requests,1);
    assert.deepEqual(await summary(),{receipts:1,logs:1,spent:'1.250000'});
  });
  await check('late financial SQL error does not write failure while its transaction completion is unconfirmed',async()=>{
    const {ref}=await enqueue(),capacity=pool();let failed=false,failWrites=0;
    const result=await runUsageRecoveryPostgres(wrapped({afterQuery(q){if(q.startsWith('insert into "cinatoken_gateway"."api_key_request_logs"')){failed=true;throw new Error('raw failure');}
      if(q.includes("last_transition='failed'"))failWrites++;}}),options,capacity);
    assert.equal(failed,true);assert.equal(result.committed,0);assert.equal(result.leasesLeftForExpiry,1);assert.equal(failWrites,0);
    assert.equal((await jobs.inspect(ref)).state,'leased');assert.equal((await summary()).receipts,0);assert.equal(capacity.snapshot().requests,1);
  });
  await check('abort during admitted financial transaction does not revoke its eventual valid commit or release early',async()=>{
    await enqueue();const abort=new AbortController(),entered=deferred(),gate=deferred(),capacity=pool();let financial=false,finished=false;
    const client=wrapped({afterQuery(q){if(receiptSQL(q))financial=true;},async beforeCommit(){if(financial){financial=false;entered.resolve();await gate.promise;}}});
    const pending=runUsageRecoveryPostgres(client,options,capacity,{signal:abort.signal}).then(x=>{finished=true;return x;});
    await entered.promise;abort.abort();await tick();assert.equal(finished,false);assert.ok(capacity.snapshot().requests>0);
    gate.resolve();const result=await pending;assert.equal(result.committed,1);assert.equal(result.resources,'confirmed');assert.equal(capacity.snapshot().requests,0);
  });
  for(const searchPath of ['public,pg_temp,pg_catalog','pg_temp,public,pg_catalog','pg_catalog,cinatoken_gateway,pg_temp'])await check('runner ignores financial shadow schemas: '+searchPath,async()=>{
    await f.pg.exec('SET search_path TO '+searchPath);const before={public:await f.snapshot('public'),temp:await f.snapshot('pg_temp')};await enqueue();
    assert.equal((await runUsageRecoveryPostgres(f.client,options,pool())).committed,1);
    assert.deepEqual(await f.snapshot('public'),before.public);assert.deepEqual(await f.snapshot('pg_temp'),before.temp);
  });
  await check('missing receipt schema is not a fallback to legacy money; scan and claim remain bounded',async()=>{
    const {ref}=await enqueue(),capacity=pool();await f.pg.exec(`ALTER TABLE ${g}.request_usage_commit_receipts RENAME TO fixture_hidden_receipts`);
    try{const result=await runUsageRecoveryPostgres(f.client,options,capacity);assert.equal(result.committed,0);assert.equal(result.retainedHolds,1);
      assert.equal((await jobs.inspect(ref)).state,'leased');assert.equal((await rows(`SELECT count(*)::int AS n FROM ${g}.api_key_request_logs`))[0].n,0);}
    finally{await f.pg.exec(`ALTER TABLE ${g}.fixture_hidden_receipts RENAME TO request_usage_commit_receipts`);}
  });
  await check('observation expiry during real SQL scan keeps completion and holds, without registering late rows',async()=>{
    await enqueue();const entered=deferred(),gate=deferred(),capacity=pool();let reads=0;
    const client=wrapped({async beforeQuery(){reads++;entered.resolve();await gate.promise;}});
    const run=createPostgresRecoveryRun(client,options,capacity),watch=observe(run);
    try{await entered.promise;assert.equal(watch.snapshot().pending.statement,1);watch.expire();
      const expired=await watch.observation;assert.equal(expired.status,'observation_expired');assert.equal(expired.snapshot.heldLanes,3);
      assert.equal(expired.snapshot.resources,'pending');assert.equal(capacity.snapshot().requests,3);
      gate.resolve();const result=await watch.completion;assert.equal(result.registered,0);assert.equal(result.claimed,0);assert.equal(reads,1);
      assert.equal(capacity.snapshot().requests,0);assert.equal(expired.snapshot.heldLanes,3);assert.equal(watch.timers(),0);
    }finally{gate.resolve();await run.completion;}
  });
  await check('observation expiry at claim COMMIT ACK admits no financial transaction; same acknowledged lease is interrupted',async()=>{
    const {ref}=await enqueue(),entered=deferred(),gate=deferred(),capacity=pool();let claim=false;
    const client=wrapped({afterQuery(q){if(claimSQL(q))claim=true;},async beforeCommit(){if(claim){claim=false;entered.resolve();await gate.promise;}}});
    const run=createPostgresRecoveryRun(client,{...options,concurrency:1},capacity),watch=observe(run);
    try{await entered.promise;const snapshot=watch.snapshot();assert.equal(snapshot.pending.transaction,1);assert.equal(snapshot.pending.callback,0);
      watch.expire();assert.equal((await watch.observation).status,'observation_expired');gate.resolve();const result=await watch.completion;
      assert.equal(result.claimed,1);assert.equal(result.committed,0);assert.equal(result.deferred,1);assert.equal((await jobs.inspect(ref)).lastError,'interrupted');
      assert.equal((await summary()).receipts,0);assert.equal(capacity.snapshot().requests,0);
    }finally{gate.resolve();await run.completion;}
  });
  for(const ackLost of [false,true])await check('late financial '+(ackLost?'ACK loss':'success')+' after observation expiry preserves one charge and independent resource result',async()=>{
    await enqueue();const entered=deferred(),gate=deferred(),capacity=pool();let financial=false,lose=false;
    const client=wrapped({afterQuery(q){if(receiptSQL(q))financial=true;},async beforeCommit(){if(financial){financial=false;lose=ackLost;entered.resolve();await gate.promise;}},
      afterCommit(){if(lose){lose=false;throw new Error('private financial ACK lost');}}});
    const run=createPostgresRecoveryRun(client,{...options,concurrency:1},capacity),watch=observe(run);
    try{await entered.promise;watch.expire();const expired=await watch.observation;assert.equal(expired.snapshot.result.committed,0);
      assert.equal(expired.snapshot.pending.transaction,1);assert.equal(expired.snapshot.pending.callback,0);assert.ok(capacity.snapshot().requests>0);
      gate.resolve();const result=await watch.completion;assert.equal(result.committed,1);assert.equal(result.resources,ackLost?'unconfirmed':'confirmed');
      assert.equal(capacity.snapshot().requests,ackLost?1:0);assert.equal(watch.snapshot().uncertainLanes,ackLost?1:0);
      assert.deepEqual(await summary(),{receipts:1,logs:1,spent:'1.250000'});assert.equal(expired.snapshot.result.committed,0);
      const next=await runUsageRecoveryPostgres(f.client,{...options,concurrency:1},pool());assert.equal(next.committed,0);
      assert.deepEqual(await summary(),{receipts:1,logs:1,spent:'1.250000'});
    }finally{gate.resolve();await run.completion;}
  });
  await check('outer transaction rejection during observation cannot drain a still-running callback or grant a second claim',async()=>{
    await enqueue();const entered=deferred(),gate=deferred(),closed=deferred(),capacity=pool();let callback;
    const base=wrapped({async afterQuery(q){if(claimSQL(q)){entered.resolve();await gate.promise;}}});
    const raw={...base.raw,begin(run){callback=base.raw.begin(run);void callback.catch(()=>{});return Promise.race([callback,closed.promise]);}};
    const run=createPostgresRecoveryRun({driver:'postgres',raw}, {...options,concurrency:1},capacity),watch=observe(run);
    try{await entered.promise;closed.reject(new Error('close'));await tick();await tick();
      const pending=watch.snapshot();assert.equal(pending.pending.transaction,0);assert.equal(pending.pending.callback,1);assert.equal(pending.uncertainLanes,1);
      watch.expire();assert.equal((await watch.observation).status,'observation_expired');assert.equal(capacity.snapshot().requests,1);
      gate.resolve();const result=await watch.completion;await callback;assert.equal(result.claimed,0);assert.equal(result.committed,0);
      assert.equal(result.retainedHolds,1);assert.equal(capacity.snapshot().requests,1);assert.equal((await summary()).receipts,0);
    }finally{gate.resolve();await run.completion;}
  });
});
