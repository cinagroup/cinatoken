import assert from 'node:assert/strict';
import test from 'node:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as sourceRun from './run-usage-recovery-postgres.ts';
import * as sourceSupervisor from './supervise-usage-recovery-postgres.ts';
const override=process.env.GATEWAY_POSTGRES_SUPERVISION_MODULE;
if(override&&!isAbsolute(override))throw new Error('Supervisor override must be an absolute local path');
const built=override?await import(pathToFileURL(override).href):null;
const {createPostgresRecoveryRun}=built??sourceRun;
const {supervisePostgresRecoveryRun}=built??sourceSupervisor;

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const profile={observationBudgetMs:10,cleanupObservationMs:5};
const options={scope:{kind:'all'},maxRegistrations:1,maxItems:1,concurrency:1,leaseSeconds:30,
  runBudgetMs:60000,reservedBytesPerScan:512,reservedBytesPerConsumer:1024};
function clock(){
  let time=0,id=0;const timers=new Map(),history=[];
  const api={now:()=>time,set(fn,delay){const key=++id;timers.set(key,{fn,at:time+delay});history.push(fn);return key;},clear:key=>timers.delete(key)};
  return {api,advance(value){time=value;const due=[...timers].filter(([,x])=>x.at<=time);for(const [key,x] of due){timers.delete(key);x.fn();}},
    setTime:value=>{time=value;},fire:()=>[...timers.values()][0]?.fn(),stale:()=>history[0]?.(),count:()=>timers.size};
}
function fixture(t,{rejectRelease=false,queryThrow=false,capacityThrow=false}={}){
  const gate=deferred(),entered=deferred(),calls=[];let held=0,released=0;
  const raw={options:{parsers:{},serializers:{}},unsafe(query){calls.push(query);entered.resolve();
    if(queryThrow)throw new Error('sensitive synthetic driver failure');
    return {then:(yes,no)=>gate.promise.then(yes,no),values:()=>gate.promise};},
    begin(){throw new Error('unexpected transaction');},end(){throw new Error('shared pool must stay open');}};
  const capacity={tryAcquire(){if(capacityThrow)throw new Error('capacity allocation failed');held++;return {release(){if(rejectRelease)throw new Error('release failed');held--;released++;}};}};
  const run=createPostgresRecoveryRun({driver:'postgres',raw},options,capacity);
  t.after(async()=>{gate.resolve([]);await run.completion.catch(()=>{});});
  return {run,gate,entered:entered.promise,calls,held:()=>held,released:()=>released};
}

test('observation expires with an owned statement and holds; late success completes the SAME run',async t=>{
  const f=fixture(t),c=clock(),s=supervisePostgresRecoveryRun(f.run,profile,{clock:c.api});await f.entered;
  const initial=s.snapshot();assert.equal(initial.pending.statement,1);assert.equal(initial.heldLanes,2);assert.equal(initial.resources,'pending');
  assert.equal(initial.result.resources,'pending');assert.equal(initial.cancellation,'not_requested');assert.equal(initial.physicalClose,'not_observed');
  c.advance(10);assert.equal(s.snapshot().result.stopReason,'observation_deadline');assert.equal(f.held(),2);
  c.advance(15);const expired=await s.observation;assert.equal(expired.status,'observation_expired');assert.equal(expired.snapshot.settled,false);
  assert.equal(s.completion,f.run.completion);assert.equal(expired.snapshot.heldLanes,2);assert.equal(c.count(),0);
  assert.ok(Object.isFrozen(expired)&&Object.isFrozen(expired.snapshot)&&Object.isFrozen(expired.snapshot.pending)&&Object.isFrozen(expired.snapshot.result));
  f.gate.resolve([]);const result=await s.completion;assert.equal(result.resources,'confirmed');assert.equal(f.held(),0);
  assert.equal(s.snapshot().settled,true);assert.equal(s.snapshot().heldLanes,0);assert.equal(expired.snapshot.heldLanes,2);
  assert.equal(f.calls.length,1);assert.equal(result.registered,0);assert.equal(result.claimed,0);assert.equal(c.count(),0);
});
test('late driver failure remains unconfirmed after observer expiration and cannot release the failed lane',async t=>{
  const f=fixture(t),c=clock(),s=supervisePostgresRecoveryRun(f.run,profile,{clock:c.api});await f.entered;c.advance(15);
  assert.equal((await s.observation).status,'observation_expired');f.gate.reject(new Error('private SQL value'));
  const result=await s.completion;assert.equal(result.resources,'unconfirmed');assert.equal(result.retainedHolds,1);assert.equal(f.held(),1);
  assert.equal(s.snapshot().uncertainLanes,1);assert.equal(s.snapshot().pending.statement,0);assert.equal(f.calls.length,1);
  assert.ok(!JSON.stringify(s.snapshot()).includes('private'));assert.equal(s.snapshot().result.stopReason,'observation_deadline');
});
test('completion during grace clears the timer, while stopped admission is not reopened',async t=>{
  const f=fixture(t),c=clock(),s=supervisePostgresRecoveryRun(f.run,profile,{clock:c.api});await f.entered;c.advance(10);
  f.gate.resolve([]);assert.equal((await s.observation).status,'completed');assert.equal((await s.completion).stopReason,'observation_deadline');
  c.advance(200);c.stale();assert.equal(c.count(),0);assert.equal(f.released(),2);assert.equal(f.calls.length,1);
});
test('delayed timer does not renew grace from its late callback time',async t=>{
  const f=fixture(t),c=clock(),s=supervisePostgresRecoveryRun(f.run,profile,{clock:c.api});await f.entered;c.advance(100);
  assert.equal((await s.observation).status,'observation_expired');assert.equal(c.count(),0);assert.equal(f.held(),2);
});
test('early timer reschedules without prematurely stopping admission',async t=>{
  const f=fixture(t),c=clock(),s=supervisePostgresRecoveryRun(f.run,profile,{clock:c.api});await f.entered;c.setTime(3);c.fire();
  assert.equal(s.snapshot().result.admissionStopped,false);assert.equal(c.count(),1);c.advance(15);await s.observation;
});
for(const pre of [false,true])test((pre?'pre':'mid')+'-aborted observation stops admission and keeps the admitted query owned',async t=>{
  const f=fixture(t),c=clock(),abort=new AbortController();if(pre)abort.abort();
  const s=supervisePostgresRecoveryRun(f.run,profile,{clock:c.api,signal:abort.signal});await f.entered;if(!pre){c.setTime(2);abort.abort();}
  assert.equal(s.snapshot().result.stopReason,'aborted');assert.equal(f.held(),2);c.advance(pre?5:7);
  assert.equal((await s.observation).status,'observation_expired');f.gate.resolve([]);await s.completion;assert.equal(f.calls.length,1);
});
for(const invalid of [NaN,Infinity,-1])test('invalid clock '+String(invalid)+' stops observation without freeing work',async t=>{
  const f=fixture(t),c=clock(),s=supervisePostgresRecoveryRun(f.run,profile,{clock:c.api});await f.entered;c.setTime(invalid);c.fire();
  assert.equal((await s.observation).status,'clock_invalid');assert.equal(s.snapshot().result.stopReason,'clock_invalid');assert.equal(f.held(),2);assert.equal(c.count(),0);
});
test('clock regression from a later tick is latched even above the start',async t=>{
  const f=fixture(t),c=clock(),s=supervisePostgresRecoveryRun(f.run,profile,{clock:c.api});await f.entered;c.setTime(8);c.fire();c.setTime(7);c.fire();
  assert.equal((await s.observation).status,'clock_invalid');assert.equal(f.held(),2);
});
for(const method of ['now','set'])test('throwing clock '+method+' after attachment keeps completion owned',async t=>{
  const f=fixture(t),c=clock(),s=supervisePostgresRecoveryRun(f.run,profile,{clock:c.api});await f.entered;
  c.api[method]=()=>{throw new Error('clock implementation failed');};c.fire();assert.equal((await s.observation).status,'clock_invalid');assert.equal(f.held(),2);
});
test('clear failure and a stale timer cannot mutate a completed run or release twice',async t=>{
  const f=fixture(t),c=clock(),abort=new AbortController(),s=supervisePostgresRecoveryRun(f.run,profile,{clock:c.api,signal:abort.signal});
  c.api.clear=()=>{throw new Error('clear failed');};f.gate.resolve([]);const observed=await s.observation;assert.equal(observed.status,'completed');
  const before=s.snapshot();c.stale();abort.abort();assert.deepEqual(s.snapshot(),before);assert.equal(f.released(),2);
});
test('invalid profile or initial clock never cancels or loses an already-created run',async t=>{
  const f=fixture(t),c=clock();for(const patch of [{observationBudgetMs:0},{observationBudgetMs:60001},{cleanupObservationMs:NaN},{cleanupObservationMs:0}]){
    assert.throws(()=>supervisePostgresRecoveryRun(f.run,{...profile,...patch},{clock:c.api}),TypeError);
  }
  c.setTime(NaN);assert.throws(()=>supervisePostgresRecoveryRun(f.run,profile,{clock:c.api}),TypeError);assert.equal(c.count(),0);
  assert.equal(f.held(),2);f.gate.resolve([]);await f.run.completion;assert.equal(f.held(),0);
});
test('caller profile mutation cannot extend an attached observation',async t=>{
  const f=fixture(t),c=clock(),input={...profile},s=supervisePostgresRecoveryRun(f.run,input,{clock:c.api});input.observationBudgetMs=60000;input.cleanupObservationMs=60000;
  c.advance(15);assert.equal((await s.observation).status,'observation_expired');
});
test('one run allows one observation owner and never accumulates duplicate timer/listener budgets',async t=>{
  const f=fixture(t),c=clock(),s=supervisePostgresRecoveryRun(f.run,profile,{clock:c.api});
  assert.throws(()=>supervisePostgresRecoveryRun(f.run,profile,{clock:c.api}),/already has/);assert.equal(c.count(),1);
  c.advance(15);await s.observation;assert.throws(()=>supervisePostgresRecoveryRun(f.run,profile,{clock:c.api}),/already has/);assert.equal(c.count(),0);
});
test('caller cannot replace the run handle or mutate observer accounting via the returned completion result',async t=>{
  const f=fixture(t),c=clock(),s=supervisePostgresRecoveryRun(f.run,profile,{clock:c.api});assert.ok(Object.isFrozen(f.run));
  f.gate.resolve([]);const result=await s.completion,original=s.snapshot();result.committed=999;result.resources='unconfirmed';result.retainedHolds=99;
  assert.deepEqual(s.snapshot(),original);assert.equal((await s.observation).snapshot.result.committed,0);
});
test('failure before any SQL reports completion rejection with no fabricated driver error',async t=>{
  const f=fixture(t,{capacityThrow:true}),c=clock(),s=supervisePostgresRecoveryRun(f.run,profile,{clock:c.api});
  assert.equal((await s.observation).status,'completion_rejected');await assert.rejects(s.completion,/capacity allocation/);
  assert.equal(s.snapshot().heldLanes,0);assert.equal(s.snapshot().uncertainLanes,0);assert.equal(c.count(),0);
});
test('failed hold release is unconfirmed and is not retried by observation or stale timers',async t=>{
  const f=fixture(t,{rejectRelease:true}),c=clock(),s=supervisePostgresRecoveryRun(f.run,profile,{clock:c.api});f.gate.resolve([]);
  assert.equal((await s.observation).status,'completed');assert.equal((await s.completion).retainedHolds,2);
  assert.equal(s.snapshot().resources,'unconfirmed');assert.equal(s.snapshot().heldLanes,2);c.stale();assert.equal(f.released(),0);
});
test('real timer observation reports but does not settle or release a pending scan',{timeout:2000},async t=>{
  const f=fixture(t),s=supervisePostgresRecoveryRun(f.run,{observationBudgetMs:10,cleanupObservationMs:5});
  assert.equal((await s.observation).status,'observation_expired');assert.equal(f.held(),2);assert.equal(s.snapshot().settled,false);
  f.gate.resolve([]);await s.completion;assert.equal(f.held(),0);
});
