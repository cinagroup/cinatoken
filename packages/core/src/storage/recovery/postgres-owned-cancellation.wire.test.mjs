import assert from 'node:assert/strict';
import test from 'node:test';
import { peer,deferred,tick } from './postgres-recovery-operation-owner.wire.test.mjs';
const opts={owned_cancel:true};
const quiet=()=>new Promise(resolve=>setTimeout(resolve,30));
const owned=(raw,sql)=>raw.unsafe(sql,[],opts);
const firstHold={backendIdentity:true,holdReady:q=>q==='select first'};
const outcome=promise=>Promise.resolve(promise).then(value=>({ok:true,value}),error=>({ok:false,error}));

test('owned cancel of lazy query is cached, observed, and never starts SQL',{timeout:5000},async t=>{
  const p=await peer(t,{backendIdentity:true}),q=owned(p.raw,'select never');
  const handle=q.cancelOwned();assert.equal(handle,q.cancelOwned());assert.equal(q.cancel(),handle.result);
  assert.deepEqual(await handle.result,{status:'not_dispatched'});assert.deepEqual(await handle.transportClosed,{status:'not_started'});
  assert.deepEqual(await handle.transportRawClosed,{status:'not_started'});
  assert.deepEqual(await handle.primaryCloseObserved,{status:'not_started'});
  assert.deepEqual(await handle.primaryRawClosed,{status:'not_started'});
  await assert.rejects(Promise.resolve(q),{code:'57014'});await tick();assert.deepEqual(p.queries,[]);assert.deepEqual(p.cancelPackets,[]);
});
test('owned cancel does not silently enable cancellation for ordinary queries',{timeout:5000},async t=>{
  const p=await peer(t),q=p.raw.unsafe('select normal'),handle=q.cancelOwned();assert.deepEqual(await handle.result,{status:'unsupported'});
  await q;assert.deepEqual(p.queries,['select normal']);
});
test('owned query is exclusive BEFORE any cancellation request',{timeout:5000},async t=>{
  const p=await peer(t,firstHold);await p.raw.unsafe('select warm');
  const first=Promise.resolve(owned(p.raw,'select first'));await p.seen('select first');
  const next=Promise.resolve(p.raw.unsafe('select next'));await quiet();const beforeRelease=[...p.queries];
  p.release();await first;await next;assert.deepEqual(beforeRelease,['select warm','select first'],'cancellable query must not pipeline its successor');
  assert.equal(p.trace[1].connectionId,p.trace[2].connectionId);
});
test('cancellation retires primary session while separately owning a held cancel connection',{timeout:5000},async t=>{
  const p=await peer(t,{...firstHold,holdCancelClose:true}),q=owned(p.raw,'select first'),running=Promise.resolve(q);await p.entered;
  const handle=q.cancelOwned();assert.equal(q.cancelOwned(),handle);assert.equal(q.cancel(),handle.result);await p.cancelled;
  assert.deepEqual(p.cancelPackets,[{pid:1001,secret:2001}]);assert.deepEqual(handle.snapshot(),{result:'pending',transportClose:'pending',transportRawClose:'pending',primaryClose:'pending',primaryRawClose:'not_observable'});
  const next=Promise.resolve(p.raw.unsafe('select next'));p.release();await running;await next;
  assert.notEqual(p.trace[0].connectionId,p.trace[1].connectionId);assert.equal(handle.snapshot().transportClose,'pending');
  p.releaseCancel();assert.deepEqual(await handle.result,{status:'transport_closed'});assert.deepEqual(await handle.transportClosed,{status:'close_observed'});
  assert.deepEqual(await handle.primaryCloseObserved,{status:'close_observed'});
  assert.equal(p.cancelPackets.length,1);
});
test('completed old query cannot cancel later query on a reused session',{timeout:5000},async t=>{
  const p=await peer(t,{backendIdentity:true}),q=owned(p.raw,'select old');await q;
  await p.raw.unsafe('select newer');assert.deepEqual(await q.cancelOwned().result,{status:'already_settled'});assert.equal(p.cancelPackets.length,0);
});
test('pool-queued owned query cancels locally without disturbing active SQL',{timeout:5000},async t=>{
  const p=await peer(t,firstHold),first=Promise.resolve(p.raw.unsafe('select first'));await p.entered;
  const q=owned(p.raw,'select never'),observed=outcome(q);await tick();const handle=q.cancelOwned();
  assert.deepEqual(await handle.result,{status:'not_dispatched'});assert.equal((await observed).error.code,'57014');
  p.release();await first;await p.raw.unsafe('select after');assert.deepEqual(p.queries,['select first','select after']);assert.equal(p.cancelPackets.length,0);
});
test('cancelled connecting query does not strand the pool after startup completes',{timeout:5000},async t=>{
  const gate=deferred(),entered=deferred();t.after(()=>gate.resolve());
  const p=await peer(t,{backendIdentity:true,beforeSocket:async n=>{if(n===1){entered.resolve();await gate.promise;}}});
  const q=owned(p.raw,'select never'),observed=outcome(q);await entered.promise;
  assert.deepEqual(await q.cancelOwned().result,{status:'not_dispatched'});assert.equal((await observed).error.code,'57014');
  const next=Promise.resolve(p.raw.unsafe('select after'));gate.resolve();await next;assert.deepEqual(p.queries,['select after']);
});
test('cancel transport delayed until after target completion sends no stale cancellation',{timeout:5000},async t=>{
  const gate=deferred(),entered=deferred();t.after(()=>gate.resolve());
  const p=await peer(t,{...firstHold,beforeSocket:async n=>{if(n===2){entered.resolve();await gate.promise;}}});
  const q=owned(p.raw,'select first'),running=Promise.resolve(q);await p.entered;const handle=q.cancelOwned();await entered.promise;
  p.release();await running;await p.raw.unsafe('select later');gate.resolve();
  assert.deepEqual(await handle.result,{status:'target_finished'});assert.deepEqual(await handle.transportClosed,{status:'close_observed'});
  assert.equal(p.cancelPackets.length,0);assert.notEqual(p.trace[0].connectionId,p.trace[1].connectionId);
});
for(const asyncFailure of [false,true])test('cancel socket factory '+(asyncFailure?'reject':'throw')+' is owned without claiming primary completion',{timeout:5000},async t=>{
  const p=await peer(t,{...firstHold,beforeSocket:n=>{if(n===2){if(asyncFailure)return Promise.reject(new Error('private factory error'));throw new Error('private factory error');}}});
  const q=owned(p.raw,'select first'),running=Promise.resolve(q);await p.entered;const handle=q.cancelOwned();
  await assert.rejects(handle.result,{code:'CANCEL_TRANSPORT_FAILED'});assert.deepEqual(await handle.transportClosed,{status:'not_started'});
  assert.deepEqual(await handle.transportRawClosed,{status:'not_started'});
  assert.equal(q.ownedSettled,false);p.release();await running;await p.raw.unsafe('select after');
  assert.notEqual(p.trace[0].connectionId,p.trace[1].connectionId);assert.equal(p.cancelPackets.length,0);
});
test('transaction locally queued cancellation removes only that query and permits rollback',{timeout:5000},async t=>{
  const p=await peer(t,firstHold);let second,secondResult;
  const transaction=outcome(p.raw.begin(async tx=>{const first=Promise.resolve(owned(tx,'select first'));await p.entered;
    second=owned(tx,'select never');secondResult=outcome(second);await tick();const handle=second.cancelOwned();assert.deepEqual(await handle.result,{status:'not_dispatched'});
    p.release();await first;await second;
  }));
  assert.equal((await transaction).ok,false);assert.equal((await secondResult).error.code,'57014');
  assert.deepEqual(p.queries.map(q=>q.trim()),['begin','select first','rollback']);
});
test('cancelled transaction cannot send internal COMMIT on the retired session',{timeout:5000},async t=>{
  const p=await peer(t,firstHold);let handle;
  const transaction=outcome(p.raw.begin(async tx=>{const q=owned(tx,'select first'),running=Promise.resolve(q);await p.entered;handle=q.cancelOwned();await p.cancelled;p.release();await running;}));
  assert.equal((await transaction).ok,false);await handle.result;await handle.transportClosed;
  await p.raw.unsafe('select after');assert.ok(!p.queries.some(q=>q.trim()==='commit'));assert.ok(!p.queries.some(q=>q.trim()==='rollback'));
  assert.notEqual(p.trace.find(q=>q.query==='select first').connectionId,p.trace.find(q=>q.query==='select after').connectionId);
});

for(const acceptBeforeThrow of [false,true])test('cancel write failure accepted='+acceptBeforeThrow+' is observed before the held close',{timeout:5000},async t=>{
  const marker=Buffer.alloc(4);marker.writeUInt32BE(80877102);
  const p=await peer(t,{...firstHold,holdCancelClose:true,writeFault:{marker,acceptBeforeThrow,holdClose:true}});
  const q=owned(p.raw,'select first'),running=Promise.resolve(q);await p.entered;p.armWriteFault();
  const handle=q.cancelOwned();await assert.rejects(handle.result,{code:'CANCEL_TRANSPORT_FAILED'});
  if(acceptBeforeThrow)await p.cancelled;
  assert.deepEqual(handle.snapshot(),{result:'failed',transportClose:'pending',transportRawClose:'pending',primaryClose:'pending',primaryRawClose:'not_observable'});
  p.release();await running;const next=Promise.resolve(p.raw.unsafe('select after'));await quiet();
  assert.deepEqual(p.queries,['select first']);assert.equal(p.writeFaultState().attempts,1);
  p.releaseFaultClose();await handle.transportClosed;await next;
  assert.notEqual(p.trace[0].connectionId,p.trace[1].connectionId);
  assert.equal(p.cancelPackets.length,acceptBeforeThrow?1:0);
});

test('cancel connection timeout does not settle the held main query',{timeout:5000},async t=>{
  const p=await peer(t,{...firstHold,holdCancelClose:true}),q=owned(p.raw,'select first');let settled=false;
  const running=Promise.resolve(q).then(()=>{settled=true;});await p.entered;const handle=q.cancelOwned();await p.cancelled;
  await assert.rejects(handle.result,{code:'CANCEL_TRANSPORT_FAILED'});await handle.transportClosed;
  assert.equal(settled,false);p.release();await running;assert.equal(settled,true);
});

test('unexpected cancel reply is a transport failure, not a query result',{timeout:5000},async t=>{
  const p=await peer(t,{...firstHold,cancelReply:true,holdCancelClose:true}),q=owned(p.raw,'select first'),running=Promise.resolve(q);
  await p.entered;const handle=q.cancelOwned();await assert.rejects(handle.result,{code:'CANCEL_TRANSPORT_FAILED'});
  await handle.transportClosed;assert.equal(q.ownedSettled,false);p.release();await running;
});

test('cancel transport uses target endpoint and factory captured before options mutation',{timeout:5000},async t=>{
  const p=await peer(t,{...firstHold,beforeSocket:()=>{}}),q=owned(p.raw,'select first'),running=Promise.resolve(q);await p.entered;
  const saved={host:p.raw.options.host[0],port:p.raw.options.port[0],socket:p.raw.options.socket};
  p.raw.options.host[0]='invalid.invalid';p.raw.options.port[0]=1;
  p.raw.options.socket=()=>{throw new Error('mutated factory must not be used by cancel');};
  const handle=q.cancelOwned();await p.cancelled;await handle.result;await handle.transportClosed;
  Object.assign(p.raw.options,{socket:saved.socket});p.raw.options.host[0]=saved.host;p.raw.options.port[0]=saved.port;
  p.release();await running;assert.deepEqual(p.cancelPackets,[{pid:1001,secret:2001}]);
});

for(const mode of ['describe','cursor','forEach','readable'])test('owned mode '+mode+' rejects before statement dispatch',{timeout:5000},async t=>{
  const p=await peer(t,{backendIdentity:true}),q=owned(p.raw,'select never');
  const changed=mode==='cursor'?q.cursor(1,()=>{}):mode==='forEach'?q.forEach(()=>{}):q[mode]();
  await assert.rejects(Promise.resolve(changed),{code:'CANCELLATION_UNSUPPORTED_MODE'});
  assert.deepEqual(p.queries,[]);await p.raw.unsafe('select after');
});

test('explicit reserve handles reject opted-in cancellation before SQL',{timeout:5000},async t=>{
  const p=await peer(t,{backendIdentity:true});await p.raw.unsafe('select warm');const reserved=await p.raw.reserve();
  await assert.rejects(Promise.resolve(owned(reserved,'select never')),{code:'CANCELLATION_UNSUPPORTED_RESERVED'});
  reserved.release();await p.raw.unsafe('select after');assert.deepEqual(p.queries,['select warm','select after']);
});

test('parameter-description cancellation never sends delayed Bind or Execute',{timeout:5000},async t=>{
  const p=await peer(t,{backendIdentity:true,holdDescribe:true});
  const q=p.raw.unsafe('select $1',[null],opts),running=outcome(q);await p.described;
  const handle=q.cancelOwned();await p.cancelled;await handle.result;p.releaseDescribe();
  assert.equal((await running).error.code,'57014');await handle.transportClosed;
  await p.raw.unsafe('select after');assert.deepEqual(p.queries,['select after']);
});

test('owned query waits for existing ordinary work rather than joining busy pipeline',{timeout:5000},async t=>{
  const p=await peer(t,firstHold);await p.raw.unsafe('select warm');
  const first=Promise.resolve(p.raw.unsafe('select first'));await p.seen('select first');
  const next=Promise.resolve(owned(p.raw,'select next'));await quiet();assert.deepEqual(p.queries,['select warm','select first']);
  p.release();await first;await next;
});

test('closed primary while cancel factory is pending cannot target the replacement session',{timeout:5000},async t=>{
  const gate=deferred(),entered=deferred();t.after(()=>gate.resolve());
  const p=await peer(t,{...firstHold,beforeSocket:async n=>{if(n===2){entered.resolve();await gate.promise;}}});
  const q=owned(p.raw,'select first'),running=outcome(q);await p.entered;const handle=q.cancelOwned();await entered.promise;
  p.disconnect();assert.equal((await running).ok,false);await p.raw.unsafe('select later');
  assert.deepEqual(handle.snapshot(),{result:'pending',transportClose:'pending',transportRawClose:'pending',primaryClose:'close_observed',primaryRawClose:'not_observable'});gate.resolve();
  assert.deepEqual(await handle.result,{status:'target_finished'});await handle.transportClosed;
  assert.deepEqual(p.cancelPackets,[]);assert.notEqual(p.trace[0].connectionId,p.trace[1].connectionId);
});
