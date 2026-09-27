import assert from 'node:assert/strict';
import test from 'node:test';
import { peer, deferred, tick } from './postgres-recovery-operation-owner.wire.test.mjs';

const settings={timeout:5000};
const observe=promise=>promise.then(value=>({status:'fulfilled',value}),error=>({status:'rejected',error}));

for(const maxPipeline of [0,1,2]){
  test(`reservation at exact pipeline boundary ${maxPipeline} keeps unrelated SQL outside`,settings,async t=>{
    const p=await peer(t,{maxPipeline,holdReady:q=>q.startsWith('select pre_')});
    await p.raw.unsafe('select warm');
    const earlier=[];
    for(let i=0;i<maxPipeline;i++)earlier.push(p.raw.unsafe('select pre_'+i).execute());
    if(maxPipeline)await p.seen('select pre_'+(maxPipeline-1));
    let callbacks=0;
    const result=observe(p.raw.begin(async tx=>{callbacks++;await tx.unsafe('select transaction_work');return 'committed';}));
    await p.seen('begin ');
    const outside=p.raw.unsafe('select unrelated').execute();
    p.release();await Promise.all(earlier);const outcome=await result;await outside;
    assert.equal(outcome.status,'fulfilled',outcome.error?.message);
    assert.equal(outcome.value,'committed');assert.equal(callbacks,1);
    assert.equal(p.states.find(x=>x.query==='select unrelated').transactionBefore,false);
    assert.deepEqual(p.queries.slice(-3).map(q=>q.trim()),['select transaction_work','commit','select unrelated']);
  });
}

test('reservation remains exclusive while BEGIN ReadyForQuery is held',settings,async t=>{
  const p=await peer(t,{holdBegin:true});let callbacks=0;
  await p.raw.unsafe('select warm');
  const result=p.raw.begin(async tx=>{callbacks++;await tx.unsafe('select transaction_work');});
  await p.seen('begin ');const outside=p.raw.unsafe('select unrelated').execute();
  await tick();await tick();assert.equal(callbacks,0);assert.ok(!p.queries.includes('select unrelated'));
  p.release();await result;await outside;
  assert.equal(callbacks,1);assert.equal(p.states.find(x=>x.query==='select unrelated').transactionBefore,false);
});

for(const delayedDrain of [false,true]){
  test(`accepted BEGIN with backpressure preserves reservation; delayed drain=${delayedDrain}`,settings,async t=>{
    const p=await peer(t,{beginBackpressure:true}),entered=deferred(),finish=deferred();
    t.after(()=>finish.resolve());
    const result=observe(p.raw.begin(' '.repeat(1100),async tx=>{
      await tx.unsafe('select transaction_work');entered.resolve();await finish.promise;return 'committed';
    }));
    const callbackEntered=await Promise.race([entered.promise.then(()=>true),result.then(()=>false)]);
    assert.equal(p.forcedFalse(),1,'real BEGIN bytes were forwarded and write returned false');
    assert.equal(callbackEntered,true,(await (callbackEntered?Promise.resolve({}):result)).error?.message);
    const outside=p.raw.unsafe('select unrelated').execute();
    if(delayedDrain)p.drainTransport();
    await tick();await tick();
    const escapedBeforeCommit=p.queries.includes('select unrelated');
    finish.resolve();const outcome=await result;await outside;
    assert.equal(escapedBeforeCommit||p.states.find(x=>x.query==='select unrelated').transactionBefore,false,
      'drain must not offer a reserved idle callback connection to root SQL');
    assert.equal(outcome.status,'fulfilled',outcome.error?.message);
    assert.equal(p.states.find(x=>x.query==='select unrelated').transactionBefore,false);
    assert.deepEqual(p.queries.slice(-3).map(q=>q.trim()),['select transaction_work','commit','select unrelated']);
  });
}

test('server-rejected BEGIN never runs callback and leaves root SQL outside a transaction',settings,async t=>{
  const p=await peer(t,{rejectBegin:true,maxPipeline:0});let callbacks=0;
  await assert.rejects(p.raw.begin(async()=>{callbacks++;}),{code:'25001'});
  await p.raw.unsafe('select unrelated');
  assert.equal(callbacks,0);assert.equal(p.states.find(x=>x.query==='select unrelated').transactionBefore,false);
});

for(const maxPipeline of [0,1]){
  test(`queued BEGINs at capacity ${maxPipeline} each own a full callback and commit`,settings,async t=>{
    const p=await peer(t,{maxPipeline,holdReady:q=>q==='select blocker'});
    const blocker=p.raw.unsafe('select blocker').execute();await p.seen('select blocker');
    let callbacks=0;
    const first=p.owner.client.raw.begin(async tx=>{callbacks++;await tx.unsafe('select first_transaction');});
    const second=p.owner.client.raw.begin(async tx=>{callbacks++;await tx.unsafe('select second_transaction');});
    const outside=p.raw.unsafe('select unrelated').execute();
    p.release();await Promise.all([blocker,first,second,outside]);
    assert.equal(callbacks,2);assert.equal(await p.owner.drain(),'confirmed');
    assert.deepEqual(p.queries.map(q=>q.trim()),['select blocker','begin','select first_transaction','commit',
      'begin','select second_transaction','commit','select unrelated']);
    assert.equal(p.states.find(x=>x.query==='select unrelated').transactionBefore,false);
  });
}

test('connection loss before BEGIN acknowledgement runs no callback and never resends BEGIN',settings,async t=>{
  const p=await peer(t,{holdBegin:true});let callbacks=0;
  const result=observe(p.raw.begin(async()=>{callbacks++;}));await p.seen('begin ');
  const outside=p.raw.unsafe('select unrelated').execute();p.disconnect();
  const outcome=await result;assert.equal(outcome.status,'rejected');assert.equal(outcome.error.code,'CONNECTION_CLOSED');
  await outside;assert.equal(callbacks,0);assert.equal(p.queries.filter(q=>q.trim()==='begin').length,1);
  const received=p.states.find(x=>x.query==='select unrelated');assert.equal(received.connectionId,2);assert.equal(received.transactionBefore,false);
});

test('describe-first parameter queries still execute once inside a capacity-zero transaction',settings,async t=>{
  const p=await peer(t,{maxPipeline:0});
  await p.raw.begin(async tx=>{
    assert.equal((await tx.unsafe('select $1',[42])).length,0);
    assert.equal((await tx.unsafe('select $1, $2',['synthetic','data']).values()).length,0);
  });
  assert.deepEqual(p.queries.map(q=>q.trim()),['begin','select $1','select $1, $2','commit']);
  assert.ok(p.states.filter(x=>x.query.startsWith('select')).every(x=>x.transactionBefore));
});
