import assert from 'node:assert/strict';
import test from 'node:test';
import { ownPostgresRecoveryOperations, ownPostgresRecoveryOperationsForDiagnostics,
  POSTGRES_RECOVERY_STATEMENT_DEADLINE_FENCE } from './postgres-recovery-operation-owner.ts';
import { createPostgresRecoveryInvocationDeadline } from './postgres-recovery-invocation-deadline.ts';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(override={},diagnostic=false,deadline){
  const calls=[];
  const raw={options:{parsers:{},serializers:{}},
    ...(deadline ? {recoveryStatementDeadlineFence:POSTGRES_RECOVERY_STATEMENT_DEADLINE_FENCE} : {}),
    unsafe(query){calls.push(query);const promise=Promise.resolve([{ok:true}]);return {then:(yes,no)=>promise.then(yes,no),values:()=>promise};},
    async begin(run){return run(raw);},end(){throw new Error('must not close shared pool');},...override};
  let alarms=0;const factory=diagnostic?ownPostgresRecoveryOperationsForDiagnostics:ownPostgresRecoveryOperations;
  const owner=factory({driver:'postgres',raw},()=>alarms++,deadline);
  return {raw,owner,calls,alarms:()=>alarms};
}

test('ordinary owner does not expose arbitrary-SQL owned cancellation',async()=>{
  const f=fixture({ownedCancellation:'postgres-js-3.4.9-owned-cancel-v302',ownedRecoveryScanFence:'postgres-js-3.4.9-owned-scan-v307'});
  assert.equal('ownedStatement' in f.owner,false);
  assert.equal(Object.hasOwn(f.owner,'ownedStatement'),false);
  assert.equal(typeof f.owner.ownedRecoveryScan,'function');
  assert.equal(await f.owner.drain(),'confirmed');
  assert.deepEqual(f.calls,[]);
});

test('owner executes lazy queries once and successful values/then drain without touching shared pool',async()=>{
  const f=fixture(),q=f.owner.client.raw.unsafe('select fixture');assert.deepEqual(f.calls,[]);
  assert.deepEqual(await q.values(),[{ok:true}]);assert.deepEqual(await q,[{ok:true}]);assert.equal(f.calls.length,1);
  assert.equal(f.owner.pending(),0);assert.equal(await f.owner.drain(),'confirmed');assert.equal(f.alarms(),0);
  await assert.rejects(Promise.resolve(f.owner.client.raw.unsafe('late')),/sealed/);assert.equal(f.calls.length,1);
});
test('same invocation deadline rejects a lazy statement at consumption before driver dispatch',async()=>{
  let time=0;const deadline=createPostgresRecoveryInvocationDeadline(10,()=>time);
  const f=fixture({},false,deadline),query=f.owner.client.raw.unsafe('never dispatched');
  time=10;
  await assert.rejects(Promise.resolve(query),/budget expired/);
  await assert.rejects(Promise.resolve(query.values()),/budget expired/);
  assert.deepEqual(f.calls,[]);assert.equal(f.owner.pending(),0);
  assert.equal(await f.owner.drain(),'confirmed');assert.equal(f.alarms(),0);
});
test('old driver cannot accept a recovery deadline even before a local SQL call',()=>{
  const deadline=createPostgresRecoveryInvocationDeadline(10,()=>0);
  assert.throws(()=>fixture({recoveryStatementDeadlineFence:'old'},false,deadline),
    /Recovery statement deadline driver required/);
});
test('ordinary SQL carries the identical deadline to the candidate without requesting cancellation',async()=>{
  const deadline=createPostgresRecoveryInvocationDeadline(10,()=>0),options=[];
  const f=fixture({unsafe(_query,_params,extra){options.push(extra);const p=Promise.resolve([]);
    return {then:(yes,no)=>p.then(yes,no),values:()=>p};}},false,deadline);
  await f.owner.client.raw.unsafe('ordinary recovery read');
  assert.equal(options.length,1);assert.deepEqual(Object.keys(options[0]),['recovery_admission_deadline']);
  assert.equal(options[0].recovery_admission_deadline,deadline);
  assert.equal(await f.owner.drain(),'confirmed');
});
test('same invocation deadline rejects a new transaction before calling the driver',async()=>{
  let time=0,begins=0;const deadline=createPostgresRecoveryInvocationDeadline(10,()=>time);
  const f=fixture({begin(){begins++;throw new Error('must not begin');}},false,deadline);
  time=10;
  await assert.rejects(f.owner.client.raw.begin(async()=>7),/budget expired/);
  assert.equal(begins,0);assert.equal(await f.owner.drain(),'confirmed');assert.equal(f.alarms(),0);
});
test('clock failure prevents new owner SQL without treating it as a driver failure',async()=>{
  let time=0;const deadline=createPostgresRecoveryInvocationDeadline(10,()=>time);
  const f=fixture({},false,deadline);time=NaN;
  await assert.rejects(Promise.resolve(f.owner.client.raw.unsafe('never dispatched')),/clock invalid/);
  assert.deepEqual(f.calls,[]);assert.equal(await f.owner.drain(),'confirmed');assert.equal(f.alarms(),0);
});
test('deadline expiry keeps an already-started statement owned until its original completion',async()=>{
  let time=0;const deadline=createPostgresRecoveryInvocationDeadline(10,()=>time),gate=deferred();
  const f=fixture({unsafe(query){f.calls.push(query);return {then:(yes,no)=>gate.promise.then(yes,no),values:()=>gate.promise};}},false,deadline);
  const started=Promise.resolve(f.owner.client.raw.unsafe('already started'));
  await tick();assert.equal(f.owner.pending(),1);
  time=10;
  await assert.rejects(Promise.resolve(f.owner.client.raw.unsafe('never dispatched')),/budget expired/);
  let drained=false;const drain=f.owner.drain().then(value=>{drained=true;return value;});
  await tick();assert.equal(drained,false);assert.deepEqual(f.calls,['already started']);
  gate.resolve([]);await started;assert.equal(await drain,'confirmed');assert.equal(f.alarms(),0);
});
for(const arrays of [false,true])test('pending '+(arrays?'values':'then')+' query retains ownership until its own terminal outcome',async()=>{
  const gate=deferred(),f=fixture({unsafe(){return {then:(yes,no)=>gate.promise.then(yes,no),values:()=>gate.promise};}});
  const q=f.owner.client.raw.unsafe('pending'),running=Promise.resolve(arrays?q.values():q);await tick();assert.equal(f.owner.pending(),1);
  let done=false;const draining=f.owner.drain().then(x=>{done=true;return x;});await tick();assert.equal(done,false);
  gate.resolve([]);await running;assert.equal(await draining,'confirmed');assert.equal(f.owner.pending(),0);
});
test('driver rejection is sticky unconfirmed even if a later exact read succeeds',async()=>{
  let fail=true;const f=fixture({unsafe(){const p=fail?Promise.reject(new Error('sensitive driver message')):Promise.resolve([]);return {then:(yes,no)=>p.then(yes,no),values:()=>p};}});
  await assert.rejects(Promise.resolve(f.owner.client.raw.unsafe('first')));fail=false;await f.owner.client.raw.unsafe('readback');
  assert.equal(await f.owner.drain(),'unconfirmed');assert.equal(f.alarms(),1);
});
test('synchronous driver throw is observed and conservatively retained',async()=>{
  const f=fixture({unsafe(){throw new Error('driver throw');}});
  await assert.rejects(Promise.resolve(f.owner.client.raw.unsafe('first')),/driver throw/);assert.equal(f.owner.pending(),0);
  assert.equal(await f.owner.drain(),'unconfirmed');
});
test('successful transaction owns its callback and statement before reporting a confirmed drain',async()=>{
  const gate=deferred(),entered=deferred(),f=fixture();
  const running=f.owner.client.raw.begin(async tx=>{await tx.unsafe('first');entered.resolve();await gate.promise;return 7;});
  await entered.promise;assert.ok(f.owner.pending()>=2);let done=false;const draining=f.owner.drain().then(x=>{done=true;return x;});
  await tick();assert.equal(done,false);gate.resolve();assert.equal(await running,7);assert.equal(await draining,'confirmed');
});
test('connection-close race keeps callback owned after outer begin rejects and blocks its later SQL',async()=>{
  const gate=deferred(),entered=deferred(),closed=deferred();let callback;
  const f=fixture({begin(run){callback=run(f.raw);void callback.catch(()=>undefined);return Promise.race([callback,closed.promise]);}});
  const running=f.owner.client.raw.begin(async tx=>{await tx.unsafe('first');entered.resolve();await gate.promise;return tx.unsafe('forbidden-after-close');});
  await entered.promise;closed.reject(new Error('connection closed'));await assert.rejects(running,/connection closed/);
  assert.equal(f.owner.unconfirmed(),true);assert.ok(f.owner.pending()>0);
  let done=false;const draining=f.owner.drain().then(x=>{done=true;return x;});await tick();assert.equal(done,false);
  gate.resolve();await assert.rejects(callback,/no longer owns SQL admission/);assert.equal(await draining,'unconfirmed');
  assert.deepEqual(f.calls,['first']);assert.equal(f.alarms(),1);
});
test('already-issued callback SQL remains owned even after the outer begin rejection',async()=>{
  const gate=deferred(),entered=deferred(),closed=deferred();let callback;
  const f=fixture({unsafe(){entered.resolve();return {then:(yes,no)=>gate.promise.then(yes,no),values:()=>gate.promise};},
    begin(run){callback=run(f.raw);void callback.catch(()=>undefined);return Promise.race([callback,closed.promise]);}});
  const running=f.owner.client.raw.begin(tx=>tx.unsafe('already-issued'));await entered.promise;
  closed.reject(new Error('closed'));await assert.rejects(running);assert.ok(f.owner.pending()>=2);
  let done=false;const draining=f.owner.drain().then(x=>{done=true;return x;});await tick();assert.equal(done,false);
  gate.resolve([]);await callback;assert.equal(await draining,'unconfirmed');
});
test('late callback after outer settlement cannot start any SQL',async()=>{
  let callback;const f=fixture({begin(run){callback=run;return Promise.reject(new Error('closed before callback'));}});
  await assert.rejects(f.owner.client.raw.begin(tx=>tx.unsafe('late')));
  assert.throws(()=>callback(f.raw),/after ownership ended/);assert.deepEqual(f.calls,[]);assert.equal(await f.owner.drain(),'unconfirmed');
});

test('snapshot distinguishes outer transaction, callback and SQL and remains immutable after settlement',async()=>{
  const query=deferred(),entered=deferred(),closed=deferred();let callback;
  const f=fixture({unsafe(){entered.resolve();return {then:(yes,no)=>query.promise.then(yes,no),values:()=>query.promise};},
    begin(run){callback=run(f.raw);void callback.catch(()=>undefined);return Promise.race([callback,closed.promise]);}});
  const running=f.owner.client.raw.begin(tx=>tx.unsafe('pending'));await entered.promise;
  const cancellation={requested:0,resultPending:0,closePending:0,transportRawClosePending:0,primaryClosePending:0,primaryRawClosePending:0};
  const before=f.owner.snapshot();assert.deepEqual(before,{statement:1,transaction:1,callback:1,cancellation,sealed:false,unconfirmed:false});assert.ok(Object.isFrozen(before));
  closed.reject(new Error('closed'));await assert.rejects(running);assert.deepEqual(f.owner.snapshot(),{statement:1,transaction:0,callback:1,cancellation,sealed:false,unconfirmed:true});
  const drain=f.owner.drain();assert.equal(f.owner.snapshot().sealed,true);query.resolve([]);await callback;assert.equal(await drain,'unconfirmed');
  assert.deepEqual(f.owner.snapshot(),{statement:0,transaction:0,callback:0,cancellation,sealed:true,unconfirmed:true});assert.equal(before.statement,1);
});

function ownedFixture(){
  const primary=deferred(),result=deferred(),closed=deferred(),transportRawClosed=deferred(),primaryClosed=deferred(),rawClosed=deferred(),options=[];let cancelled=0;
  const handle=Object.freeze({result:result.promise,transportClosed:closed.promise,transportRawClosed:transportRawClosed.promise,primaryCloseObserved:primaryClosed.promise,primaryRawClosed:rawClosed.promise,
    snapshot:()=>({result:'pending',transportClose:'pending',transportRawClose:'pending',primaryClose:'pending',primaryRawClose:'pending'})});
  const q={then:(yes,no)=>primary.promise.then(yes,no),values:()=>primary.promise,cancelOwned:()=>{cancelled++;return handle;}};
  const f=fixture({ownedCancellation:'postgres-js-3.4.9-owned-cancel-v302',unsafe(_query,_params,opt){options.push(opt);return q;}},true);
  return {...f,primary,result,closed,transportRawClosed,primaryClosed,rawClosed,handle,cancelled:()=>cancelled,options};
}

test('owned statement requires a candidate before dispatching SQL',async()=>{
  const f=fixture({},true);assert.throws(()=>f.owner.ownedStatement('select controlled'),/Owned cancellation driver required/);
  assert.deepEqual(f.calls,[]);assert.equal(f.owner.pending(),0);assert.equal(await f.owner.drain(),'confirmed');
});

test('primary success, cancel result and auxiliary close have separate application owners',async()=>{
  const f=ownedFixture(),statement=f.owner.ownedStatement('select controlled',[7]);
  assert.deepEqual(f.options,[{owned_cancel:true}]);assert.equal(f.owner.pending(),1);
  const handle=statement.cancel();assert.equal(statement.cancel(),handle);assert.equal(f.cancelled(),1);
  const before=f.owner.snapshot();assert.ok(Object.isFrozen(before));assert.ok(Object.isFrozen(before.cancellation));
  assert.deepEqual(before.cancellation,{requested:1,resultPending:1,closePending:1,transportRawClosePending:1,primaryClosePending:1,primaryRawClosePending:1});
  f.primary.resolve([]);await statement.completion;assert.equal(f.owner.pending(),5);
  let drained=false;const drain=f.owner.drain().then(value=>{drained=true;return value;});
  f.result.resolve({status:'transport_closed'});await tick();assert.equal(drained,false);
  assert.deepEqual(f.owner.snapshot().cancellation,{requested:1,resultPending:0,closePending:1,transportRawClosePending:1,primaryClosePending:1,primaryRawClosePending:1});
  f.closed.resolve({status:'close_observed'});await tick();assert.equal(drained,false);
  assert.equal(f.owner.snapshot().cancellation.primaryClosePending,1);
  f.primaryClosed.resolve({status:'close_observed'});await tick();assert.equal(drained,false);
  f.rawClosed.resolve({status:'raw_closed'});await tick();assert.equal(drained,false);
  f.transportRawClosed.resolve({status:'raw_closed'});assert.equal(await drain,'unconfirmed');assert.equal(f.owner.pending(),0);
  assert.deepEqual(before.cancellation,{requested:1,resultPending:1,closePending:1,transportRawClosePending:1,primaryClosePending:1,primaryRawClosePending:1});assert.equal(f.alarms(),1);
});

test('cancel transport rejection remains owned until auxiliary close and main SQL settle',async()=>{
  const f=ownedFixture(),statement=f.owner.ownedStatement('select controlled');
  const handle=statement.cancel();const drain=f.owner.drain();
  f.result.reject(new Error('private cancel error'));await tick();assert.equal(f.owner.pending(),5);
  f.closed.resolve({status:'close_observed'});await tick();assert.equal(f.owner.pending(),4);
  f.primaryClosed.resolve({status:'close_observed'});await tick();assert.equal(f.owner.pending(),3);
  f.rawClosed.resolve({status:'raw_close_rejected'});await tick();assert.equal(f.owner.pending(),2);
  f.transportRawClosed.resolve({status:'raw_close_rejected'});await tick();assert.equal(f.owner.pending(),1);
  f.primary.resolve([]);await statement.completion;assert.equal(await drain,'unconfirmed');
  await assert.rejects(handle.result,/private cancel error/);assert.equal(f.alarms(),1);
});

test('cancellation registered during drain stays owned, and no cancellation starts after drain',async()=>{
  const f=ownedFixture(),statement=f.owner.ownedStatement('select controlled');
  const drain=f.owner.drain();await tick();
  statement.cancel();f.primary.resolve([]);await statement.completion;
  f.result.resolve({status:'transport_closed'});await tick();assert.equal(f.owner.pending(),4);
  f.closed.resolve({status:'close_observed'});f.transportRawClosed.resolve({status:'raw_closed'});f.primaryClosed.resolve({status:'close_observed'});f.rawClosed.resolve({status:'raw_closed'});
  assert.equal(await drain,'unconfirmed');
  const late=f.owner.ownedStatement.bind(f.owner);assert.throws(()=>late('select late'),/sealed/);
  const settled=ownedFixture(),finished=settled.owner.ownedStatement('select complete');
  settled.primary.resolve([]);await finished.completion;assert.equal(await settled.owner.drain(),'confirmed');
  assert.throws(()=>finished.cancel(),/already drained/);assert.equal(settled.cancelled(),0);
});
