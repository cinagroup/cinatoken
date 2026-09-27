import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFinancialEngine } from '../../test-support/postgres-financial-engine.mjs';
import { createDispatchIntentRepositoryPostgres } from './dispatch-intent-postgres.ts';
import { createUsageSettlementFactsRepositoryPostgres } from './usage-settlement-facts-postgres.ts';
import { createUsageRecoveryJobsPostgres } from './usage-recovery-jobs-postgres.ts';
import { sample } from './usage-settlement-test-support.mjs';
import { SettlementConflictError, SettlementRecoveryClaimUncertainError } from './settlement-recovery-types.ts';

const g='cinatoken_gateway', table=`${g}.request_usage_recovery_jobs`, all={kind:'all'};
const tenant={kind:'tenant',userId:'user',workspaceId:'workspace'};
const proposal=name=>readFileSync(new URL('../../../migrations-proposals/postgres/'+name,import.meta.url),'utf8');
test('PostgreSQL recovery job registration, ownership and bounded retry contract', { timeout: 150_000 },async t=>{
  assert.ok(!process.env.GATEWAY_PG_FINANCIAL_BASELINE);
  const f=await createFinancialEngine({migrationHead:'0068_function_schema_resolution.sql'});t.after(()=>f.pg.close());
  for(const file of ['request-dispatch-intents.sql','request-usage-settlement-facts.sql'])await f.pg.transaction(tx=>tx.exec(proposal(file)));
  const facts=createUsageSettlementFactsRepositoryPostgres(f.client),intents=createDispatchIntentRepositoryPostgres(f.client);
  const now=async()=>Number((await f.pg.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS n')).rows[0].n);
  async function persist(){
    const value=sample(0.25);
    Object.assign(value.intent,{userId:'user',apiKeyId:'key',workspaceId:'workspace'});
    Object.assign(value.params.requestLog,{userId:'user',apiKeyId:'key',workspaceId:'workspace'});
    value.params.userId='user';value.params.audit.apiKeyId='key';
    await intents.prepare(value.intent,(await now())+60000);
    assert.equal(await intents.claim(value.intent,0,value.dispatchClaimId),'granted');
    return {value,ref:await facts.persist(value)};
  }
  await f.reset('public,pg_temp,pg_catalog');
  const beforeSchema=await persist();
  await f.pg.transaction(tx=>tx.exec(proposal('request-usage-recovery-jobs.sql')));
  const jobs=createUsageRecoveryJobsPostgres(f.client);
  const guard=(await f.pg.query(`SELECT pg_get_functiondef('${g}.guard_usage_recovery_job()'::regprocedure) AS source`)).rows[0].source;
  for(const prefix of ['public','pg_temp'])await f.pg.exec(`CREATE ${prefix==='pg_temp'?'TEMP ':''}TABLE ${prefix==='public'?'public.':''}request_usage_recovery_jobs (LIKE ${table} INCLUDING ALL)`);
  const count=async()=>Number((await f.pg.query(`SELECT count(*)::text AS n FROM ${table}`)).rows[0].n);
  const wrapper=(hooks={})=>{
    const adapt=raw=>({async unsafe(query,params){await hooks.beforeQuery?.(query,params);const rows=await raw.unsafe(query,params);await hooks.afterQuery?.(query,params,rows,raw);return rows;}});
    return createUsageRecoveryJobsPostgres({...f.client,raw:{...adapt(f.client.raw),async begin(run){
      await hooks.beforeBegin?.();const result=await f.client.raw.begin(async tx=>{const result=await run(adapt(tx));await hooks.beforeCommit?.();return result;});
      await hooks.afterCommit?.();return result;
    }}});
  };
  async function check(name,run){await t.test(name,async()=>{
    await f.reset('public,pg_temp,pg_catalog');
    await f.pg.exec('TRUNCATE public.request_usage_recovery_jobs,pg_temp.request_usage_recovery_jobs');
    await run();
  });}
  async function enqueue(){const entry=await persist();return {...entry,job:await jobs.ensure(entry.ref)};}
  async function claim(ref,seconds=30,repo=jobs){const row=await jobs.inspect(ref);const result=await repo.claim({ref,revision:row.revision},seconds);assert.equal(result.status,'claimed');return result.lease;}
  const waitExpiry=()=>f.pg.query('SELECT pg_sleep(1.1)');
  await t.test('expand-only proposal discovers facts accepted before jobs existed without a financial backfill',async()=>{
    assert.equal(f.migrations.length,68);assert.equal(await count(),0);
    const before=await f.snapshot(g);
    assert.deepEqual(await jobs.scanUnregistered(tenant,50),[beforeSchema.ref]);
    const row=await jobs.ensure(beforeSchema.ref);assert.equal(row.state,'pending');assert.equal(row.attempts,0);assert.equal(row.revision,0);
    assert.equal(row.createdAtMs,row.availableAtMs);assert.equal(row.updatedAtMs,row.createdAtMs);
    assert.deepEqual(await jobs.scanUnregistered(all,50),[]);assert.deepEqual(await f.snapshot(g),before);
    const pgFunction=(await f.pg.query(`SELECT prosecdef,proconfig FROM pg_catalog.pg_proc WHERE oid='${g}.guard_usage_recovery_job()'::regprocedure`)).rows[0];
    assert.equal(pgFunction.prosecdef,false);assert.deepEqual(pgFunction.proconfig,['search_path=pg_catalog, pg_temp']);
    for(const path of ['../context.ts','../../index.ts'])assert.doesNotMatch(readFileSync(new URL(path,import.meta.url),'utf8'),/usage-recovery-jobs-postgres/);
    for(const method of ['commit','complete','renew','dispatch'])assert.equal(typeof jobs[method],'undefined');
  });
  await check('registration is idempotent, never exposes ownership and preserves the original snapshot and funds',async()=>{
    const {ref,value}=await persist(),before=await f.snapshot(g);
    const rows=await Promise.all(Array.from({length:6},()=>jobs.ensure(ref)));assert.equal(await count(),1);
    assert.ok(rows.every(row=>JSON.stringify(row)===JSON.stringify(rows[0])));
    assert.equal(Object.isFrozen(rows[0]),true);assert.equal(Object.isFrozen(rows[0].ref),true);
    assert.equal('proof' in rows[0],false);assert.equal('lease_token' in rows[0],false);
    const lease=await claim(ref);assert.equal((await jobs.ensure(ref)).state,'leased');
    assert.equal((await jobs.inspect(ref)).proof,undefined);assert.equal(lease.attempts,1);
    assert.deepEqual(await facts.load(ref),value);assert.deepEqual(await f.snapshot(g),before);
  });
  for(const patch of [{requestId:'other'},{attemptIndex:2},{userId:'other'},{apiKeyId:'other-key'},{workspaceId:'other-workspace'},
    {operation:'images.edits'},{contextSha256:'b'.repeat(64)},{dispatchClaimId:randomUUID()},{payloadSha256:'b'.repeat(64)}]){
    await check(`complete reference mismatch rejects registration, claim, failure and reads: ${Object.keys(patch)[0]}`,async()=>{
      const {ref}=await enqueue(),wrong={...ref,...patch};const before=await jobs.inspect(ref);
      await assert.rejects(jobs.ensure(wrong),SettlementConflictError);assert.equal(await jobs.inspect(wrong),null);
      assert.deepEqual(await jobs.claim({ref:wrong,revision:0},10),{status:'not_claimed'});
      const lease=await claim(ref);assert.equal(await jobs.fail({...lease,ref:wrong},'snapshot_invalid'),'not_owned');
      assert.equal((await jobs.inspect(ref)).attempts,before.attempts+1);
    });
  }
  await check('invalid scope, size, revision, proof and reasons reject before database I/O',async()=>{
    const {ref}=await persist();let calls=0;const bad=createUsageRecoveryJobsPostgres({driver:'postgres',raw:{unsafe(){calls++;},begin(){calls++;}}});
    for(const input of [{},{kind:'tenant',userId:'user\n',workspaceId:'workspace'},{kind:'tenant',userId:'user'}])await assert.rejects(bad.scanDue(input,1),TypeError);
    for(const limit of [0,51,NaN,Infinity,1.5])for(const method of ['scanDue','scanUnregistered'])await assert.rejects(bad[method](all,limit),TypeError);
    for(const revision of [-1,NaN,Number.MAX_SAFE_INTEGER])await assert.rejects(bad.claim({ref,revision},10),TypeError);
    for(const seconds of [0,301,NaN,1.5])await assert.rejects(bad.claim({ref,revision:0},seconds),TypeError);
    const base={ref,revision:1,proof:{token:randomUUID(),revision:1},expiresAtMs:1,attempts:1};
    for(const patch of [{proof:{token:base.proof.token+'\n',revision:1}},{proof:{token:base.proof.token,revision:2}},{revision:0}])await assert.rejects(bad.fail({...base,...patch},'execution_error'),TypeError);
    await assert.rejects(bad.fail(base,'arbitrary raw error text'),TypeError);assert.equal(calls,0);
    for(const driver of ['d1','mysql',undefined])assert.throws(()=>createUsageRecoveryJobsPostgres({driver}),/PostgreSQL/);
  });
  await check('scans are bounded references only, with exact tenant filters and no processed watermark',async()=>{
    const refs=[];for(let n=0;n<53;n++)refs.push((await persist()).ref);
    const first=await jobs.scanUnregistered(all,50);assert.equal(first.length,50);
    for(const ref of first)await jobs.ensure(ref);
    const second=await jobs.scanUnregistered(tenant,50);assert.equal(second.length,3);
    for(const ref of second)await jobs.ensure(ref);
    assert.deepEqual(await jobs.scanUnregistered(all,50),[]);
    assert.equal((await jobs.scanDue(all,50)).length,50);
    for(const wrong of [{...tenant,userId:'other'},{...tenant,workspaceId:'other-workspace'}]){
      assert.deepEqual(await jobs.scanDue(wrong,50),[]);assert.deepEqual(await jobs.scanUnregistered(wrong,50),[]);
    }
    // Newly committed input is discoverable on another full anti-join, no remembered cursor.
    const late=(await persist()).ref;assert.deepEqual(await jobs.scanUnregistered(all,50),[late]);
    const scanQueries=f.queries.filter(x=>x.query.includes('ORDER BY'));
    assert.ok(scanQueries.length>0);assert.ok(scanQueries.every(x=>!x.query.includes('payload_json')&&!x.query.includes('lease_token')));
  });
  await check('registration write failure remains discoverable; ACK loss reconciles no more than one insertion',async()=>{
    const {ref}=await persist();let inserts=0;
    await assert.rejects(wrapper({beforeQuery(q){if(q.startsWith('INSERT'))throw new Error('pre-write');}}).ensure(ref),SettlementConflictError);
    assert.deepEqual(await jobs.scanUnregistered(all,1),[ref]);assert.equal(await count(),0);
    const row=await wrapper({afterQuery(q){if(q.startsWith('INSERT')){inserts++;throw new Error('lost ACK');}}}).ensure(ref);
    assert.equal(row.state,'pending');assert.equal(inserts,1);assert.equal(await count(),1);
  });
  await check('registration ACK and read failure does not claim acceptance but full scan finds the durable pending job',async()=>{
    const {ref}=await persist();let inserts=0;
    await assert.rejects(wrapper({beforeQuery(q){if(q.startsWith('SELECT'))throw new Error('read unavailable');},afterQuery(q){if(q.startsWith('INSERT')){inserts++;throw new Error('ACK');}}}).ensure(ref),/read unavailable/);
    assert.equal(inserts,1);assert.deepEqual(await jobs.scanDue(all,1),[{ref,revision:0}]);assert.equal(await count(),1);
  });
  await check('many claimers yield one explicit owner, with no same-revision regrant or sending permission',async()=>{
    const {ref,value}=await enqueue();const before=await f.snapshot(g),dispatch=await intents.inspect(value.intent);
    const results=await Promise.all(Array.from({length:8},()=>jobs.claim({ref,revision:0},30)));
    assert.equal(results.filter(x=>x.status==='claimed').length,1);assert.equal(results.filter(x=>x.status==='not_claimed').length,7);
    const lease=results.find(x=>x.status==='claimed').lease;assert.equal(lease.revision,1);assert.equal(lease.attempts,1);
    assert.equal(Object.isFrozen(lease),true);assert.equal(Object.isFrozen(lease.proof),true);
    assert.deepEqual(await jobs.claim({ref,revision:0},30),{status:'not_claimed'});
    assert.deepEqual(await jobs.claim({ref,revision:1},30),{status:'not_claimed'});
    assert.deepEqual(await jobs.scanDue(all,50),[]);assert.deepEqual(await f.snapshot(g),before);
    assert.deepEqual(await intents.inspect(value.intent),dispatch);assert.equal(await intents.claim(value.intent,1,value.dispatchClaimId),'not_granted');
  });
  for(const stage of ['beforeBegin','beforeCommit','afterCommit'])await check(`claim ${stage} failure grants nothing and never reads back or retries`,async()=>{
    const {ref}=await enqueue();let queries=0;
    await assert.rejects(wrapper({[stage](){throw new Error(stage);},beforeQuery(){queries++;}}).claim({ref,revision:0},30),SettlementRecoveryClaimUncertainError);
    assert.equal(queries,stage==='beforeBegin'?0:2);const row=await jobs.inspect(ref);
    assert.equal(row.state,stage==='afterCommit'?'leased':'pending');assert.equal(row.attempts,stage==='afterCommit'?1:0);
  });
  await check('proof is withheld until COMMIT ACK; mutating caller reference after invocation cannot redirect claim',async()=>{
    const {ref}=await enqueue();let release,reached;const gate=new Promise(r=>release=r),atAck=new Promise(r=>reached=r);
    const mutable={ref:{...ref},revision:0};let settled=false;
    const pending=wrapper({async afterCommit(){reached();await gate;}}).claim(mutable,30).then(x=>{settled=true;return x;});
    mutable.ref.userId='other';mutable.revision=9;await atAck;
    assert.equal(settled,false);release();const result=await pending;assert.equal(result.status,'claimed');assert.deepEqual(result.lease.ref,ref);
  });
  await check('expired old owner is fenced before takeover, and a new revision never restores the old proof',async()=>{
    const {ref}=await enqueue(),old=await claim(ref,1);await waitExpiry();
    const before=await jobs.inspect(ref);
    assert.equal(await jobs.fail({...old,expiresAtMs:Number.MAX_SAFE_INTEGER},'snapshot_invalid'),'not_owned');assert.deepEqual(await jobs.inspect(ref),before);
    const next=await claim(ref,30);assert.equal(next.revision,2);assert.equal(next.attempts,2);assert.notEqual(next.proof.token,old.proof.token);
    for(const proof of [old.proof,{...next.proof,token:old.proof.token},{...next.proof,revision:1}]){
      assert.equal(await jobs.fail({...next,revision:proof.revision,proof},'execution_error'),'not_owned');
    }
    assert.equal(await jobs.fail(next,'interrupted'),'deferred');
  });
  await check('expiry is checked again after the lock statement and in-transaction delay',async()=>{
    const {ref}=await enqueue(),lease=await claim(ref,1);
    const slow=wrapper({async afterQuery(q,p,r,raw){if(q.includes('FOR UPDATE OF j'))await raw.unsafe('SELECT pg_sleep(1.1)');}});
    assert.equal(await slow.fail(lease,'execution_error'),'not_owned');assert.equal((await jobs.inspect(ref)).state,'leased');
  });
  await check('claim lease starts at the database mutation after lock delay, not before waiting',async()=>{
    const {ref}=await enqueue();let afterLock;
    const slow=wrapper({async afterQuery(q,p,r,raw){if(q.includes('FOR UPDATE OF j')){
      await raw.unsafe('SELECT pg_sleep(1.1)');
      afterLock=Number((await raw.unsafe('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS n'))[0].n);
    }}});
    const result=await slow.claim({ref,revision:0},1);assert.equal(result.status,'claimed');
    assert.ok(result.lease.expiresAtMs>=afterLock+1000);
  });
  await check('a proof delivered after its lease expired is not authority to update a job',async()=>{
    const {ref}=await enqueue();
    const delayed=wrapper({afterCommit(){return f.pg.query('SELECT pg_sleep(1.1)');}});
    const result=await delayed.claim({ref,revision:0},1);assert.equal(result.status,'claimed');
    assert.equal(await jobs.fail(result.lease,'snapshot_invalid'),'not_owned');
    assert.equal((await jobs.inspect(ref)).state,'leased');
  });
  await check('negative control: transaction-start timestamp wrongly accepts failure after expiry',async()=>{
    const {ref}=await enqueue(),lease=await claim(ref,1);
    await f.pg.exec(guard.replace('clock_timestamp()','transaction_timestamp()'));
    try{
      const slow=wrapper({async afterQuery(q,p,r,raw){if(q.includes('FOR UPDATE OF j'))await raw.unsafe('SELECT pg_sleep(1.1)');}});
      assert.equal(await slow.fail(lease,'execution_error'),'deferred');
    }finally{await f.pg.exec(guard);}
  });
  await check('clock regression below last mutation cannot extend or clear the current lease',async()=>{
    const {ref}=await enqueue(),lease=await claim(ref,30),before=await jobs.inspect(ref);
    await f.pg.exec(guard.replace('clock_timestamp()',"(clock_timestamp()-interval '1 hour')"));
    try{assert.equal(await jobs.fail(lease,'interrupted'),'not_owned');assert.deepEqual(await jobs.inspect(ref),before);}
    finally{await f.pg.exec(guard);}
  });
  for(const reason of ['execution_error','interrupted'])await check(`${reason} schedules database-owned backoff; stale reporting cannot reset it`,async()=>{
    const {ref}=await enqueue(),lease=await claim(ref);assert.equal(await jobs.fail(lease,reason),'deferred');
    const row=await jobs.inspect(ref);assert.equal(row.state,'pending');assert.equal(row.revision,2);assert.equal(row.attempts,1);
    assert.equal(row.availableAtMs-row.updatedAtMs,5000);assert.equal(row.lastError,reason);assert.equal(row.expiresAtMs,null);
    assert.equal(await jobs.fail(lease,reason),'not_owned');assert.deepEqual(await jobs.claim({ref,revision:2},30),{status:'not_claimed'});
    assert.deepEqual(await jobs.scanDue(all,50),[]);
  });
  for(const reason of ['snapshot_invalid','settlement_conflict'])await check(`${reason} blocks permanently without raw error text, re-enqueue, automatic reset or money mutation`,async()=>{
    const {ref}=await enqueue(),before=await f.snapshot(g),lease=await claim(ref);
    assert.equal(await jobs.fail(lease,reason),'blocked');const row=await jobs.inspect(ref);assert.equal(row.lastError,reason);assert.equal(row.availableAtMs,null);
    assert.deepEqual(await jobs.ensure(ref),row);assert.deepEqual(await jobs.scanUnregistered(all,50),[]);assert.deepEqual(await jobs.scanDue(all,50),[]);
    assert.deepEqual(await jobs.claim({ref,revision:row.revision},30),{status:'not_claimed'});assert.deepEqual(await f.snapshot(g),before);
  });
  await check('five expired claims exhaust durably; even the expired fifth owner cannot report failure',async()=>{
    const {ref}=await enqueue();let lease;
    for(let attempt=1;attempt<=5;attempt++){lease=await claim(ref,1);assert.equal(lease.attempts,attempt);await waitExpiry();}
    assert.equal(await jobs.fail(lease,'execution_error'),'not_owned');assert.equal((await jobs.inspect(ref)).state,'leased');
    assert.deepEqual(await jobs.claim({ref,revision:lease.revision},1),{status:'exhausted'});
    const row=await jobs.inspect(ref);assert.equal(row.attempts,5);assert.equal(row.revision,6);assert.equal(row.lastTransition,'exhausted');assert.equal(row.lastError,'retry_exhausted');
    assert.deepEqual(await jobs.scanDue(all,50),[]);assert.deepEqual(await jobs.ensure(ref),row);
  });
  await check('backoff grows 5/10/20/40 seconds then blocks the fifth active failure (test-only clock oracle)',async()=>{
    const {ref}=await enqueue();let tick=await now();
    await f.pg.exec(guard.replace('clock_timestamp()',"to_timestamp(current_setting('cinatoken_test.epoch_ms')::double precision/1000)"));
    try{
      for(let attempt=1;attempt<=5;attempt++){
        await f.pg.query("SELECT set_config('cinatoken_test.epoch_ms',$1,false)",[String(tick)]);
        const lease=await claim(ref,30);assert.equal(lease.attempts,attempt);
        assert.equal(await jobs.fail(lease,'execution_error'),attempt===5?'blocked':'deferred');
        const row=await jobs.inspect(ref);assert.equal(row.attempts,attempt);
        if(attempt<5){assert.equal(row.availableAtMs-row.updatedAtMs,5000*2**(attempt-1));tick=row.availableAtMs;}
        else{assert.equal(row.lastError,'retry_exhausted');assert.equal(row.lastTransition,'failed');}
      }
    }finally{await f.pg.exec(guard);}
  });
  await check('failure transaction rollback preserves owner; failure ACK loss persists but cannot report a second failure',async()=>{
    const {ref}=await enqueue(),lease=await claim(ref),before=await jobs.inspect(ref);
    await assert.rejects(wrapper({beforeCommit(){throw new Error('rollback');}}).fail(lease,'interrupted'),/rollback/);assert.deepEqual(await jobs.inspect(ref),before);
    await assert.rejects(wrapper({afterCommit(){throw new Error('lost failure ACK');}}).fail(lease,'interrupted'),/lost failure ACK/);
    assert.equal((await jobs.inspect(ref)).state,'pending');assert.equal(await jobs.fail(lease,'interrupted'),'not_owned');
  });
  await check('failure owns proof and full reference before the first await',async()=>{
    const {ref}=await enqueue(),lease=await claim(ref);
    const mutable={...lease,ref:{...lease.ref},proof:{...lease.proof}};
    const pending=jobs.fail(mutable,'interrupted');mutable.ref.userId='other';mutable.proof.token=randomUUID();mutable.proof.revision=9;
    assert.equal(await pending,'deferred');assert.equal((await jobs.inspect(ref)).lastError,'interrupted');
  });
  await check('direct SQL cannot forge initial ownership, time, orphan scope or mutate immutable identity',async()=>{
    const {ref}=await persist();
    const insert=`INSERT INTO ${table}(request_id,payload_sha256,fact_created_at_ms,user_id,workspace_id)
      SELECT request_id,payload_sha256,created_at_ms,user_id,workspace_id FROM ${g}.request_usage_settlements WHERE request_id=$1`;
    for(const [column,expr] of [['state',"'leased'"],['revision','1'],['attempts','1'],['created_at_ms','1'],['available_at_ms','1'],['lease_token',"'"+randomUUID()+"'"]]){
      await assert.rejects(f.pg.query(insert.replace('workspace_id)','workspace_id,'+column+')').replace('created_at_ms,user_id,workspace_id FROM','created_at_ms,user_id,workspace_id,'+expr+' FROM'),[ref.requestId]));
    }
    await assert.rejects(f.pg.query(`INSERT INTO ${table}(request_id,payload_sha256,fact_created_at_ms,user_id,workspace_id) VALUES('orphan',$1,1,'user','workspace')`,['a'.repeat(64)]),/foreign key/);
    await assert.rejects(f.pg.query(insert.replace('created_at_ms,user_id,workspace_id FROM',"created_at_ms,'other',workspace_id FROM"),[ref.requestId]),/foreign key/);
    await jobs.ensure(ref);
    for(const assignment of ["request_id='other'","payload_sha256=repeat('b',64)","user_id='other'","workspace_id='other-workspace'",'fact_created_at_ms=fact_created_at_ms+1','created_at_ms=created_at_ms+1',
      'updated_at_ms=updated_at_ms+1','available_at_ms=available_at_ms+1',"state='committed'",'attempts=5',"last_transition='exhausted'"]){
      await assert.rejects(f.pg.query(`UPDATE ${table} SET revision=revision+1,${assignment} WHERE request_id=$1`,[ref.requestId]));
    }
    await assert.rejects(f.pg.query(`DELETE FROM ${table} WHERE request_id=$1`,[ref.requestId]),/deletion/);
    assert.equal((await jobs.inspect(ref)).revision,0);
  });
  await check('corrupt wire integers and mismatched returned identity fail closed',async()=>{
    const {ref}=await enqueue();
    for(const wire of ['01','1\n','9007199254740992','1.0',1,null])await assert.rejects(wrapper({afterQuery(q,p,rows){if(q.startsWith('SELECT'))rows[0].revision=wire;}}).inspect(ref));
    await assert.rejects(wrapper({afterQuery(q,p,rows){if(q.startsWith('SELECT'))rows[0].user_id='other';}}).inspect(ref),SettlementConflictError);
    await assert.rejects(wrapper({afterQuery(q,p,rows){if(q.startsWith('UPDATE'))rows[0].lease_token=randomUUID();}}).claim({ref,revision:0},30),SettlementRecoveryClaimUncertainError);
    assert.equal((await jobs.inspect(ref)).state,'pending');
  });
  for(const path of ['public,pg_temp,pg_catalog','pg_temp,public,pg_catalog','pg_catalog,cinatoken_gateway,pg_temp'])await check(`qualified relations and fixed function search_path ignore shadows: ${path}`,async()=>{
    await f.pg.exec('SET search_path TO '+path);const before={actual:await f.snapshot(g),public:await f.snapshot('public'),temp:await f.snapshot('pg_temp')};
    const {ref}=await enqueue();const lease=await claim(ref);assert.equal(await jobs.fail(lease,'snapshot_invalid'),'blocked');
    for(const prefix of ['public','pg_temp'])assert.equal((await f.pg.query(`SELECT count(*)::int AS n FROM ${prefix}.request_usage_recovery_jobs`)).rows[0].n,0);
    assert.deepEqual(await f.snapshot(g),before.actual);assert.deepEqual(await f.snapshot('public'),before.public);assert.deepEqual(await f.snapshot('pg_temp'),before.temp);
  });
  await check('due work has global and tenant partial indexes; no full-payload or performance claim',async()=>{
    const indexes=(await f.pg.query(`SELECT indexdef FROM pg_catalog.pg_indexes WHERE schemaname=$1 AND tablename='request_usage_recovery_jobs'`,[g])).rows;
    for(const [clause,name] of [['','request_usage_recovery_due'],["user_id='user' AND workspace_id='workspace' AND ",'request_usage_recovery_tenant_due']]){
      assert.ok(indexes.some(x=>x.indexdef.includes(name)&&x.indexdef.includes('WHERE')));
      await f.pg.transaction(async tx=>{await tx.exec('SET LOCAL enable_seqscan=off');const plan=(await tx.query(`EXPLAIN SELECT request_id FROM ${table} WHERE ${clause}state IN ('pending','leased') AND available_at_ms<=9999999999999 ORDER BY available_at_ms,request_id LIMIT 50`)).rows.map(x=>x['QUERY PLAN']).join('\n');assert.match(plan,new RegExp(name));});
    }
  });
  await check('missing job schema never falls back to settlement or unprotected financial writes',async()=>{
    const {ref}=await persist(),before=await f.snapshot(g);await f.pg.exec(`DROP TABLE ${table}`);
    await assert.rejects(jobs.ensure(ref),/does not exist/);await assert.rejects(jobs.scanDue(all,1),/does not exist/);
    assert.deepEqual(await f.snapshot(g),before);assert.ok(await facts.load(ref));
  });
});

test('three clean processes discover unregistered input, lose claim ACK, then obtain only a new expired-lease revision', {timeout:120_000},()=>{
  const parent=realpathSync(tmpdir()),owned=mkdtempSync(join(parent,'cinatoken-pg-jobs-'));
  const child=fileURLToPath(new URL('../../test-support/postgres-recovery-jobs-child.mjs',import.meta.url));
  let terminal=true;
  try{
    for(const mode of ['persist','claim-lost-ack','recover']){
      const result=spawnSync(process.execPath,['--import','tsx',child,join(owned,'db'),mode],{
        encoding:'utf8',timeout:35_000,env:{...process.env,GATEWAY_PG_FINANCIAL_BASELINE:''},
      });
      terminal=result.error===undefined && result.status!==null;
      assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
      assert.equal(JSON.parse(result.stdout).mode,mode);
    }
  }finally{
    // Preserve an uncertain child fixture for inspection; never infer shutdown from a timeout.
    if(terminal){
      const target=realpathSync(owned);assert.equal(dirname(target),parent);assert.equal(resolve(target),resolve(owned));
      assert.ok(basename(target).startsWith('cinatoken-pg-jobs-'));rmSync(target,{recursive:true});
    }
  }
});
