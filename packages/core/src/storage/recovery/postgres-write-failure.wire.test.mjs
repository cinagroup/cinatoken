import assert from 'node:assert/strict';
import test from 'node:test';
import { peer, tick, deferred } from './postgres-recovery-operation-owner.wire.test.mjs';

if(!process.env.GATEWAY_POSTGRES_RECOVERY_DRIVER)throw new Error('Explicit isolated candidate required');
for(const acceptBeforeThrow of [false,true])for(const immediate of [false,true]){
  test(`socket write fault accepted=${acceptBeforeThrow} immediate=${immediate} never retries bytes and retires connection`,{timeout:5000},async t=>{
    const marker='select fault_marker',p=await peer(t,{writeFault:{marker,acceptBeforeThrow}});
    await p.raw.unsafe('select warm');
    p.armWriteFault();
    const failed=p.owner.client.raw.unsafe(marker+(immediate?' '.repeat(1100):''));
    await assert.rejects(Promise.resolve(failed),error=>error===p.faultError);
    await tick();await tick();
    assert.deepEqual(p.writeFaultState(),{attempts:1,accepted:acceptBeforeThrow?1:0,thrown:true},'failed bytes are not resent by Sync or a pending timer');
    await p.raw.unsafe('select root_after_failure');
    assert.equal(p.trace.find(row=>row.query==='select root_after_failure').connectionId,2,'pool recovers only with another physical connection');
    assert.equal(await p.owner.drain(),'unconfirmed');
    assert.ok(p.queries.filter(q=>q.trim()===marker).length<=1);
  });
}

for(const acceptBeforeThrow of [false,true])for(const immediate of [false,true]){
  test(`BEGIN write fault accepted=${acceptBeforeThrow} immediate=${immediate} never grants callback or replays`,{timeout:5000},async t=>{
    const p=await peer(t,{writeFault:{marker:'begin ',acceptBeforeThrow}});let callbacks=0;
    await p.raw.unsafe('select warm');p.armWriteFault();
    await assert.rejects(p.raw.begin(immediate?' '.repeat(1100):'',async()=>{callbacks++;}));
    await p.raw.unsafe('select root_after_failure');
    assert.equal(callbacks,0);assert.deepEqual(p.writeFaultState(),{attempts:1,accepted:acceptBeforeThrow?1:0,thrown:true});
    assert.equal(p.trace.find(row=>row.query==='select root_after_failure').connectionId,2);
    assert.ok(p.trace.filter(row=>row.query==='begin').length<=1);
  });
}

for(const command of ['commit','rollback'])test(`internal ${command} write fault never finalizes a later connection`,{timeout:5000},async t=>{
  const p=await peer(t,{writeFault:{marker:command,acceptBeforeThrow:true}});
  await assert.rejects(p.owner.client.raw.begin(async tx=>{
    await tx.unsafe('select inside');p.armWriteFault();if(command==='rollback')throw new Error('rollback requested');
  }));
  await p.raw.begin(tx=>tx.unsafe('select later_transaction'));
  assert.equal(await p.owner.drain(),'unconfirmed');
  assert.deepEqual(p.trace.filter(row=>row.connectionId===2).map(row=>row.query),['begin','select later_transaction','commit']);
  assert.deepEqual(p.writeFaultState(),{attempts:command==='commit'?2:1,accepted:command==='commit'?2:1,thrown:true});
  // A later transaction has its own legitimate COMMIT. No old bytes cross connection identity.
  assert.ok(p.trace.filter(row=>row.connectionId===1&&row.query===command).length<=1);
});

test('write fault rejects driver-local queued work and leaves owner unconfirmed', {timeout:5000}, async t=>{
  const p=await peer(t,{maxPipeline:0,writeFault:{marker:'select fault_marker',acceptBeforeThrow:false}}),finished=deferred();
  const operation=p.owner.client.raw.begin(async tx=>{
    p.armWriteFault();
    const outcomes=await Promise.allSettled(['select fault_marker','select forbidden_queued_one','select forbidden_queued_two']
      .map(query=>Promise.resolve(tx.unsafe(query))));
    finished.resolve(outcomes);
  });
  await assert.rejects(operation);const outcomes=await finished.promise;
  assert.deepEqual(outcomes.map(value=>value.status),['rejected','rejected','rejected']);
  assert.equal(await p.owner.drain(),'unconfirmed');
  await p.raw.unsafe('select root_after_failure');
  assert.ok(!p.queries.some(query=>query.includes('forbidden_queued')));
  assert.deepEqual(p.writeFaultState(),{attempts:1,accepted:0,thrown:true});
});

test('write fault waits for actual close before pool reuse despite late ReadyForQuery and drain', {timeout:5000}, async t=>{
  const p=await peer(t,{writeFault:{marker:'select fault_marker',acceptBeforeThrow:true,holdClose:true}});
  await p.raw.unsafe('select warm');p.armWriteFault();
  await assert.rejects(Promise.resolve(p.owner.client.raw.unsafe('select fault_marker')));
  await p.faultResponse();await tick();
  let settled=false;const outside=p.raw.unsafe('select root_after_failure').execute().then(
    ()=>{settled=true;return {status:'fulfilled'};},error=>{settled=true;return {status:'rejected',error};});
  p.drainTransport();await tick();await tick();
  assert.equal(settled,false);assert.ok(!p.queries.includes('select root_after_failure'));
  assert.equal(await p.owner.drain(),'unconfirmed');
  p.releaseFaultClose();assert.equal((await outside).status,'fulfilled');
  assert.equal(p.trace.find(row=>row.query==='select root_after_failure').connectionId,2);
});

test('ordinary parameter validation error is not misclassified as a broken socket', {timeout:5000}, async t=>{
  const p=await peer(t);await p.raw.unsafe('select warm');
  await assert.rejects(p.raw.unsafe('select $1',[undefined]),{code:'UNDEFINED_VALUE'});
  await p.raw.unsafe('select after_validation_error');
  assert.equal(p.trace.find(row=>row.query==='select after_validation_error').connectionId,1);
});
