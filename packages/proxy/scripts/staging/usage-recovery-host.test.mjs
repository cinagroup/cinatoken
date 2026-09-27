import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { setup, sample, prepare } from '../../../core/src/storage/recovery/usage-settlement-test-support.mjs';
import { createUsageRecoveryHost, rejectUsageRecoveryHttp } from '../../src/runtime/usage-recovery-host.ts';
import { setup as imageSetup } from './images-recovery-test-support.mjs';

// Deliberately tiny logical counters, NOT a production/Workers memory estimate.
const settings = { RECOVERY_ENVIRONMENT:'staging', RECOVERY_ENABLED:'true', RECOVERY_MAX_ITEMS:'5', RECOVERY_CONCURRENCY:'2',
  RECOVERY_LEASE_SECONDS:'10', RECOVERY_RUN_BUDGET_MS:'5000', RECOVERY_RESERVED_BYTES:'1024', RECOVERY_INSTANCE_BYTES:'2048' };
const latch=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const tick=()=>new Promise(r=>setImmediate(r));
function context() { return { tasks:[], waitUntil(p){assert.equal(this.tasks.length,0);this.tasks.push(p);} }; }
function fixture(t) {
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('External network forbidden');});
  const logs=[];for(const method of ['log','warn','error'])t.mock.method(console,method,message=>logs.push(message));
  const db=setup(t);
  db.sqlite.exec(readFileSync(new URL('../../../core/migrations-proposals/d1/request-usage-recovery-jobs.sql',import.meta.url),'utf8'));
  return {...db,logs};
}
async function enqueue(db,cost=0) {const value=sample(cost);await prepare(db,value);return db.repo.persist(value);}
const count=db=>db.sqlite.prepare('SELECT COUNT(*) AS n FROM api_key_request_logs').get().n;

for(const value of ['false',undefined,'TRUE','1',''])test('closed/invalid enable performs no D1 I/O: '+String(value),async()=>{
  const host=createUsageRecoveryHost(),ctx=context();
  const db=new Proxy({}, {get(){throw new Error('Database accessed before enable');}});
  assert.deepEqual(await host.run(db,{...settings,RECOVERY_ENABLED:value},ctx),{status:value==='false'?'disabled':'invalid_configuration'});
  assert.equal(ctx.tasks.length,0);assert.deepEqual(host.snapshot(),{active:false,capacity:null});
});
for(const [key,bad] of [
  ['RECOVERY_ENVIRONMENT','production'],['RECOVERY_MAX_ITEMS','51'],['RECOVERY_CONCURRENCY','5'],
  ['RECOVERY_LEASE_SECONDS','301'],['RECOVERY_RUN_BUDGET_MS','60001'],['RECOVERY_RESERVED_BYTES','0'],
  ['RECOVERY_INSTANCE_BYTES','1023'],['RECOVERY_RESERVED_BYTES','9007199254740992'],
])test('server configuration fails closed: '+key,async()=>{
  const ctx=context();assert.deepEqual(await createUsageRecoveryHost().run(null,{...settings,[key]:bad},ctx),{status:'invalid_configuration'});
  assert.equal(ctx.tasks.length,0);
});
for(const value of ['-1','1.5','1e3',' 1','01','NaN','Infinity','1'.repeat(17)])test('noncanonical numeric config rejected: '+value,async()=>{
  assert.equal((await createUsageRecoveryHost().run(null,{...settings,RECOVERY_MAX_ITEMS:value},context())).status,'invalid_configuration');
});

for(const cost of [0,0.25])test('registered host independently settles existing event once, cost='+cost,async t=>{
  const db=fixture(t);await enqueue(db,cost);const host=createUsageRecoveryHost(),ctx=context();
  db.hooks.beforeStatement=()=>{assert.equal(ctx.tasks.length,1);assert.equal(host.snapshot().active,true);assert.equal(host.snapshot().capacity.requests,2);};
  const task=host.run(db.binding,settings,ctx);assert.equal(ctx.tasks.length,1);assert.equal(host.snapshot().active,true);
  const outcome=await task;await Promise.all(ctx.tasks);
  assert.equal(outcome.status,'finished');assert.equal(outcome.result.committed,1);assert.match(outcome.runId,/^[0-9a-f-]{36}$/);
  assert.equal(count(db),1);assert.equal(db.sqlite.prepare("SELECT budget_spent_micros FROM users WHERE id='recovery-user'").get().budget_spent_micros,cost*1e6);
  db.hooks.beforeStatement=undefined;
  assert.equal((await host.run(db.binding,settings,context())).result.claimed,0);
  assert.equal(host.snapshot().active,false);assert.equal(host.snapshot().capacity.reservedBytes,0);
  assert.ok(!JSON.stringify(db.logs).includes('recovery-user'));assert.ok(JSON.stringify(outcome).length<1024);
});

test('waitUntil registration failure prevents I/O and clears the admission gate',async t=>{
  const db=fixture(t);await enqueue(db);const host=createUsageRecoveryHost();
  db.hooks.beforeStatement=()=>assert.fail('D1 must not start');
  const outcome=await host.run(db.binding,settings,{waitUntil(){throw new Error('private runtime detail');}});
  assert.deepEqual(outcome,{status:'host_rejected'});assert.equal(host.snapshot().active,false);assert.equal(host.snapshot().capacity.requests,0);
  db.hooks.beforeStatement=undefined;assert.equal((await host.run(db.binding,settings,context())).result.committed,1);
});

test('overlapping calls have no waiter queue and hold pool until hung D1 actually settles',async t=>{
  const db=fixture(t);await enqueue(db);const entered=latch(),release=latch();const host=createUsageRecoveryHost();
  db.hooks.afterStatement=async sql=>{if(sql.startsWith('SELECT request_id')){entered.resolve();await release.promise;}};
  const first=host.run(db.binding,settings,context());await entered.promise;
  const before=db.logs.length;
  for(let i=0;i<20;i++)assert.deepEqual(await host.run(db.binding,settings,context()),{status:'busy'});
  assert.equal(db.logs.length,before);assert.equal(host.snapshot().capacity.reservedBytes,2048);
  release.resolve();assert.equal((await first).result.committed,1);assert.equal(host.snapshot().capacity.reservedBytes,0);
});

test('profile cannot be swapped to bypass an active or idle isolate pool',async t=>{
  const db=fixture(t),host=createUsageRecoveryHost();await host.run(db.binding,settings,context());
  const before=host.snapshot();
  assert.deepEqual(await host.run(db.binding,{...settings,RECOVERY_INSTANCE_BYTES:'4096'},context()),{status:'profile_changed'});
  assert.deepEqual(host.snapshot(),before);
});

test('settings are copied before I/O; caller mutation cannot change batch or capacity',async t=>{
  const db=fixture(t);await enqueue(db);await enqueue(db);const host=createUsageRecoveryHost(),vars={...settings,RECOVERY_MAX_ITEMS:'1'};
  const task=host.run(db.binding,vars,context());vars.RECOVERY_MAX_ITEMS='50';vars.RECOVERY_INSTANCE_BYTES='1';
  assert.equal((await task).result.scanned,1);assert.equal(count(db),1);
});

test('run window stops new admission but never frees an in-flight D1 read',async t=>{
  const db=fixture(t);await enqueue(db);let time=0;const host=createUsageRecoveryHost({now:()=>time}),entered=latch(),release=latch();
  db.hooks.afterStatement=async sql=>{if(sql.startsWith('SELECT request_id')){entered.resolve();await release.promise;}};
  const ctx=context(),task=host.run(db.binding,settings,ctx);await entered.promise;time=5001;await tick();
  assert.equal(host.snapshot().active,true);assert.equal(host.snapshot().capacity.reservedBytes,2048);
  release.resolve();const outcome=await task;await Promise.all(ctx.tasks);
  assert.equal(outcome.result.admissionStopped,true);assert.equal(outcome.result.claimed,0);assert.equal(count(db),0);
  assert.equal(host.snapshot().capacity.requests,0);
});

test('throwing D1 scan is redacted and a later invocation can recover',async t=>{
  const db=fixture(t);await enqueue(db);const host=createUsageRecoveryHost();
  db.hooks.beforeStatement=()=>{throw new Error('SQL credential and private payload marker');};
  const ctx=context(),outcome=await host.run(db.binding,settings,ctx);await Promise.all(ctx.tasks);
  assert.equal(outcome.status,'execution_failed');assert.equal(host.snapshot().active,false);assert.equal(host.snapshot().capacity.requests,0);
  assert.ok(!JSON.stringify([outcome,db.logs]).includes('private payload'));
  db.hooks.beforeStatement=undefined;assert.equal((await host.run(db.binding,settings,context())).result.committed,1);
});

test('partial pool admission uses one consumer without allocating an extra slot',async t=>{
  const db=fixture(t);await enqueue(db);const host=createUsageRecoveryHost();
  db.hooks.beforeStatement=()=>assert.equal(host.snapshot().capacity.requests,1);
  const outcome=await host.run(db.binding,{...settings,RECOVERY_INSTANCE_BYTES:'1024'},context());
  assert.equal(outcome.result.capacityLimited,true);assert.equal(outcome.result.committed,1);
  assert.equal(host.snapshot().capacity.reservedBytes,0);
});

test('different host instances rely on D1 fencing, not a fictitious fleet-wide lock',async t=>{
  const db=fixture(t);await enqueue(db,0.25);
  const outcomes=await Promise.all([createUsageRecoveryHost(),createUsageRecoveryHost()].map(host=>host.run(db.binding,settings,context())));
  assert.equal(outcomes.reduce((n,r)=>n+r.result.committed,0),1);assert.equal(count(db),1);
  assert.equal(db.sqlite.prepare("SELECT budget_spent_micros FROM users WHERE id='recovery-user'").get().budget_spent_micros,250000);
});

test('a new invocation uses its own binding; numeric host state retains no old D1 client',async t=>{
  const first=fixture(t),second=fixture(t);await enqueue(first);await enqueue(second);
  const host=createUsageRecoveryHost();assert.equal((await host.run(first.binding,settings,context())).result.committed,1);
  first.hooks.beforeStatement=()=>assert.fail('Previous binding must not be reused');
  assert.equal((await host.run(second.binding,settings,context())).result.committed,1);assert.equal(count(first),1);assert.equal(count(second),1);
});

test('disable rejects new work but cannot falsely release a running settlement hold',async t=>{
  const db=fixture(t);await enqueue(db);const entered=latch(),release=latch(),host=createUsageRecoveryHost();
  db.hooks.afterBatch=async()=>{entered.resolve();await release.promise;};
  const ctx=context(),task=host.run(db.binding,settings,ctx);await entered.promise;
  assert.deepEqual(await host.run(db.binding,{...settings,RECOVERY_ENABLED:'false'},context()),{status:'disabled'});
  assert.equal(host.snapshot().active,true);assert.equal(host.snapshot().capacity.reservedBytes,2048);
  release.resolve();assert.equal((await task).result.committed,1);await Promise.all(ctx.tasks);assert.equal(host.snapshot().capacity.requests,0);
});

test('logical run deadline during committed batch ACK does not abandon its actual owner',async t=>{
  const db=fixture(t);await enqueue(db,0.25);let time=0;
  const entered=latch(),release=latch(),host=createUsageRecoveryHost({now:()=>time});
  db.hooks.afterBatch=async()=>{entered.resolve();await release.promise;};
  const task=host.run(db.binding,settings,context());await entered.promise;time=6000;await tick();
  assert.equal(host.snapshot().capacity.requests,2);assert.equal(count(db),1);
  assert.equal((await host.run(db.binding,settings,context())).status,'busy');
  release.resolve();const outcome=await task;assert.equal(outcome.result.committed,1);assert.equal(outcome.result.admissionStopped,true);
  assert.equal(host.snapshot().capacity.requests,0);
});

test('worker wiring exposes only argument-free named trigger; HTTP cannot reach DB',async t=>{
  const db=fixture(t);await enqueue(db);const host=createUsageRecoveryHost();
  // Node-only constructor shim verifies our wiring, NOT Cloudflare RPC authorization.
  const source=readFileSync(new URL('./usage-recovery-worker.ts',import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const exports={};new Function('require','exports',code)(name=>{
    if(name==='cloudflare:workers')return {WorkerEntrypoint:class{constructor(ctx,env){this.ctx=ctx;this.env=env;}}};
    if(name==='../../src/runtime/usage-recovery-host')return {createUsageRecoveryHost:()=>host,rejectUsageRecoveryHttp};
    throw new Error('Unexpected Worker import');
  },exports);
  assert.deepEqual(Object.keys(exports).sort(),['UsageRecovery','default']);
  const entry=new exports.UsageRecovery(context(),{...settings,RECOVERY_DB:db.binding});
  for(const args of [[{scope:{kind:'all'},maxItems:50}],[undefined],['gen-x'],[null,null]])assert.deepEqual(await entry.run(...args),{status:'invalid_arguments'});
  db.hooks.beforeStatement=()=>assert.fail('HTTP must not reach D1');
  for(const handler of [exports.default,entry])for(const method of ['GET','POST','OPTIONS']) {
    const response=await handler.fetch(new Request('https://example.invalid/run?tenant=other',{method,headers:{Authorization:'Bearer fake','Cf-Access-Jwt-Assertion':'fake'}}));
    assert.equal(response.status,404);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(await response.text(),'Not found');
  }
  db.hooks.beforeStatement=undefined;assert.equal((await entry.run()).result.committed,1);
});

for(const operation of ['generations','edits'])for(const cost of [0,0.1])test(`independent host recovers ordinary Images ${operation}, cost=${cost}`,async t=>{
  let fault=true;
  const f=await imageSetup(t,{cost,hooks:{beforeStatement(sql){if(fault&&sql.startsWith('INSERT INTO api_key_request_logs'))throw new Error('Synthetic ledger unavailable');}}});
  const response=await f.request(operation);assert.equal(response.status,200);assert.equal((await response.json()).data[0].b64_json,'AQID');await f.drain();
  assert.equal(f.row('SELECT COUNT(*) AS n FROM api_key_request_logs').n,0);assert.equal(f.sends,1);
  fault=false;f.advance(6);const host=createUsageRecoveryHost(),ctx=context();
  const outcome=await host.run(f.db.binding,settings,ctx);await Promise.all(ctx.tasks);
  assert.equal(outcome.result.committed,1);assert.equal(f.sends,1);
  assert.equal(f.row('SELECT COUNT(*) AS n FROM api_key_request_logs').n,1);
  assert.equal(f.row('SELECT budget_spent_micros FROM users').budget_spent_micros,cost*1e6);
  assert.equal((await host.run(f.db.binding,settings,context())).result.claimed,0);
});
