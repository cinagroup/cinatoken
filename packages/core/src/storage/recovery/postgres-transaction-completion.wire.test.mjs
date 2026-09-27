import assert from 'node:assert/strict';
import test from 'node:test';
import { peer, tick, deferred } from './postgres-recovery-operation-owner.wire.test.mjs';

if(!process.env.GATEWAY_POSTGRES_RECOVERY_DRIVER)throw new Error('Explicit isolated candidate required');
const settings={timeout:5000};
const observe=promise=>Promise.resolve(promise).then(value=>({status:'fulfilled',value}),error=>({status:'rejected',error}));

for(const outcome of ['commit','rollback'])for(const method of ['unsafe','lazy','tagged','savepoint','prepare']){
  test(`completed ${outcome} rejects escaped ${method} inside a later live transaction`,settings,async t=>{
    const p=await peer(t);let escaped,lazy;
    const original=p.raw.begin(async tx=>{escaped=tx;lazy=tx.unsafe('select forbidden_lazy');await tx.unsafe('select original');if(outcome==='rollback')throw new Error('synthetic rollback');});
    if(outcome==='rollback')await assert.rejects(original,/synthetic rollback/);else await original;
    let late;
    await p.raw.begin(async tx=>{
      await tx.unsafe('select live');
      late=await observe(Promise.resolve().then(()=>method==='unsafe'?escaped.unsafe('select forbidden_unsafe')
        :method==='lazy'?lazy:method==='tagged'?escaped`select forbidden_tagged`
          :method==='savepoint'?escaped.savepoint(sp=>sp.unsafe('select forbidden_savepoint')):escaped.prepare('forbidden_prepared')));
      await tx.unsafe('select live_barrier');
    });
    assert.equal(late.status,'rejected','ended scope must not perform '+method);
    assert.equal(late.error.code,'TRANSACTION_ENDED');
    assert.deepEqual(p.trace.map(row=>row.query),['begin','select original',outcome,'begin','select live','select live_barrier','commit']);
    assert.ok(p.states.filter(row=>row.query.startsWith('select live')).every(row=>row.transactionBefore));
    await p.raw.unsafe('select root_survives');
  });
}

for(const outcome of ['return','throw'])test(`completed savepoint ${outcome} rejects its old handle while parent stays live`,settings,async t=>{
  const p=await peer(t);let escaped,late;
  await p.raw.begin(async tx=>{
    const nested=tx.savepoint(async sp=>{escaped=sp;await sp.unsafe('select nested');if(outcome==='throw')throw new Error('nested failure');});
    if(outcome==='throw')await assert.rejects(nested,/nested failure/);else await nested;
    late=await observe(escaped.unsafe('select forbidden_nested'));
    await tx.unsafe('select parent_survives');
  });
  assert.equal(late.status,'rejected');assert.equal(late.error.code,'TRANSACTION_ENDED');
  assert.ok(!p.queries.includes('select forbidden_nested'));
  assert.equal(p.states.find(row=>row.query==='select parent_survives').transactionBefore,true);
});

test('callback completion seals user SQL while COMMIT ReadyForQuery is held',settings,async t=>{
  const p=await peer(t,{holdFinish:true});let escaped;
  const pending=p.raw.begin(async tx=>{escaped=tx;await tx.unsafe('select original');});
  await p.seen('commit');
  const late=await observe(escaped.unsafe('select forbidden_during_commit'));
  p.release();await pending;
  assert.equal(late.status,'rejected');assert.equal(late.error.code,'TRANSACTION_ENDED');
  assert.deepEqual(p.queries.map(q=>q.trim()),['begin','select original','commit']);
});

test('returned query arrays finish once before transaction seal',settings,async t=>{
  const p=await peer(t);
  const values=await p.raw.begin(tx=>[tx.unsafe('select returned_one'),tx.unsafe('select returned_two')]);
  assert.equal(values.length,2);assert.deepEqual(p.queries.map(q=>q.trim()),['begin','select returned_one','select returned_two','commit']);
});

test('unawaited nested callback cannot touch a later transaction after parent ends',settings,async t=>{
  const p=await peer(t),entered=deferred(),release=deferred();let nested;
  t.after(()=>release.resolve());
  await p.raw.begin(async tx=>{
    nested=observe(tx.savepoint(async sp=>{await sp.unsafe('select child_started');entered.resolve();await release.promise;await sp.unsafe('select forbidden_child');}));
    await entered.promise;
  });
  let result;
  await p.raw.begin(async tx=>{await tx.unsafe('select live');release.resolve();result=await nested;await tick();await tx.unsafe('select barrier');});
  assert.equal(result.status,'rejected');assert.equal(result.error.code,'TRANSACTION_ENDED');
  assert.ok(!p.queries.includes('select forbidden_child'));assert.ok(!p.queries.some(q=>q.startsWith('rollback to')));
});
