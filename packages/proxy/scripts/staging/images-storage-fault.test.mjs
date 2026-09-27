import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createSqliteD1 } from '../../src/test-support/sqlite-d1.ts';
import { createWorkerHandler } from '../../src/runtime/worker-handler.ts';
import { withImageStorageFault } from './images-storage-fault.ts';
import { imageStorageFaultHeader, imageStorageFaultRow, parseImageStorageFault } from './images-storage-fault-contract.ts';
import { imageSuccessFixture } from '../../../../scripts/deploy/staging-image-success-fixture.mjs';
import upstream from './images-upstream.ts';

test('storage fault control accepts only finite modes and synthetic identities', () => {
  const probe={runId:'c02-success-'+randomUUID(),probeId:randomUUID(),mode:'after-fail'};
  assert.deepEqual(parseImageStorageFault(imageStorageFaultHeader(probe)),probe);
  for(const bad of [null,'x'.repeat(10000),imageStorageFaultHeader(probe)+':10000',imageStorageFaultHeader(probe).replace('after-fail','arbitrary')])assert.equal(parseImageStorageFault(bad),null);
});

for (const mode of ['before-abort', 'after-abort']) {
  test(`native abort contract and capability guard: ${mode}`, () => {
    const probe = { runId: 'c02-success-' + randomUUID(), probeId: randomUUID(), mode };
    assert.deepEqual(parseImageStorageFault(imageStorageFaultHeader(probe)), probe);
    assert.equal(parseImageStorageFault(imageStorageFaultHeader(probe).replace(mode, mode + '-isolate')), null);
    const db = createSqliteD1({}, { applyMigrations: false });
    try {
      for (const options of [undefined, {}, { abortContext: {} }, { abortContext: { abort: true } }]) {
        assert.throws(() => withImageStorageFault(db.binding, probe, options), /NATIVE_ABORT_UNAVAILABLE/);
      }
    } finally { db.sqlite.close(); }
  });

  for (const condition of ['throwing-spy', 'returning-spy', 'unarmed', 'other-tenant', 'changed-owner']) {
    test(`abort wiring only (not native termination proof): ${mode} / ${condition}`, async () => {
      const db = createSqliteD1({}, { applyMigrations: false });
      // Minimal real SQLite schema isolates the facade from any recovery implementation.
      db.sqlite.exec('CREATE TABLE system_config(key TEXT PRIMARY KEY,value TEXT,description TEXT,updated_at TEXT); CREATE TABLE api_key_request_logs(id TEXT PRIMARY KEY,user_id TEXT,api_key_id TEXT,workspace_id TEXT,status TEXT)');
      const probe = { runId: 'c02-success-' + randomUUID(), probeId: randomUUID(), mode };
      const row = imageStorageFaultRow(probe), sentinel = new Error('TEST_SPY_NOT_NATIVE_TERMINATION');
      const phase = mode === 'before-abort' ? 'abort-requested-before-commit' : 'abort-requested-after-commit';
      let calls = 0;
      const read = () => JSON.parse(db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(row.key)?.value ?? 'null');
      const count = () => db.sqlite.prepare('SELECT COUNT(*) AS n FROM api_key_request_logs').get().n;
      const context = { abort() {
        assert.equal(this, context, 'native method receiver must be preserved');
        calls++;
        assert.equal(read().phase, phase, 'durable marker must precede abort');
        assert.equal(count(), mode === 'before-abort' ? 0 : 1, 'only after-abort may follow a real commit');
        if (condition === 'throwing-spy') throw sentinel;
      } };
      try {
        if (condition !== 'unarmed') db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)')
          .run(row.key, row.value, condition === 'changed-owner' ? 'different-owner' : row.description);
        const wrapped = withImageStorageFault(db.binding, probe, { abortContext: context });
        const tenant = condition === 'other-tenant' ? 'c02-success-' + randomUUID() : probe.runId;
        const statement = () => wrapped.prepare('INSERT INTO api_key_request_logs (id, user_id, api_key_id, workspace_id,status) VALUES(?,?,?,?,?)')
          .bind('gen-' + randomUUID(), tenant + '-user', tenant + '-key', tenant + '-workspace', 'success');
        if (condition === 'other-tenant') {
          await wrapped.batch([statement()]); assert.equal(calls, 0); assert.equal(read().phase, 'armed'); assert.equal(count(), 1);
        } else if (condition === 'unarmed' || condition === 'changed-owner') {
          await assert.rejects(wrapped.batch([statement()]), /NOT_ARMED_OR_OWNERSHIP_CHANGED/);
          assert.equal(calls, 0); assert.equal(count(), 0);
        } else {
          await assert.rejects(wrapped.batch([statement()]), error => condition === 'throwing-spy'
            ? error === sentinel : /NATIVE_ABORT_RETURNED/.test(error.message));
          assert.equal(calls, 1); assert.equal(read().phase, phase);
          assert.equal(count(), mode === 'before-abort' ? 0 : 1);
          // A later matching batch cannot trigger this request-owned one-shot twice.
          await wrapped.batch([statement()]); assert.equal(calls, 1);
          // A different facade cannot re-arm the same durable row.
          const replay = withImageStorageFault(db.binding, probe, { abortContext: context });
          await assert.rejects(replay.batch([replay.prepare('INSERT INTO api_key_request_logs (id, user_id, api_key_id, workspace_id,status) VALUES(?,?,?,?,?)')
            .bind('gen-' + randomUUID(), tenant + '-user', tenant + '-key', tenant + '-workspace', 'success')]), /NOT_ARMED_OR_OWNERSHIP_CHANGED/);
          assert.equal(calls, 1);
        }
      } finally { db.sqlite.close(); }
    });
  }
}

test('D1 facade preserves native first/raw/all/run/bind semantics and rejects foreign statements', async () => {
  const db=createSqliteD1(),probe={runId:'c02-success-'+randomUUID(),probeId:randomUUID(),mode:'before-fail'};
  const wrapped=withImageStorageFault(db.binding,probe);
  try {
    assert.equal(await wrapped.prepare('SELECT ? AS n').bind(4).first('n'),4);
    assert.deepEqual(await wrapped.prepare('SELECT ? AS n').bind(5).raw({columnNames:true}),[['n'],[5]]);
    assert.equal((await wrapped.batch([wrapped.prepare('SELECT ? AS n').bind(6)]))[0].results[0].n,6);
    await assert.rejects(wrapped.batch([db.binding.prepare('SELECT 1')]),/FOREIGN_STATEMENT/);
    assert.throws(()=>wrapped.withSession(),/NOT_IN_SCOPE/);
  } finally {db.sqlite.close();}
});

test('positive synthetic reservation reconciles a committed batch after its acknowledgement fails', async t => {
  await new Promise(resolve=>setImmediate(resolve));
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('External network forbidden');});
  const errors=[];t.mock.method(console,'error',(...args)=>errors.push(args.join(' ')));
  let commits=0,sends=0;
  const db=createSqliteD1({afterBatch(sql){if(sql.some(s=>s.startsWith('INSERT INTO api_key_request_logs'))){commits++;throw new Error('Synthetic committed ACK loss');}}});
  const runId='c02-success-'+randomUUID(),key='synthetic-reserved-client';
  const fixture=await imageSuccessFixture(runId,'sha256:'+createHash('sha256').update(key).digest('hex'),new Date(Date.now()+3600000).toISOString());
  const tasks=[],context={waitUntil(p){tasks.push(p);p.catch(()=>undefined);}};
  const env={DB:db.binding,DATABASE_DRIVER:'d1',SHARED_KEY_ENCRYPTION_SECRET:'synthetic-material-not-for-real-secrets',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false'};
  const handler=createWorkerHandler({imageFetch:async(input,init)=>{sends++;return upstream.fetch(new Request(input,init));}});
  try {
    for(const s of fixture.seed)db.sqlite.prepare(s.sql).run(...s.params);
    db.sqlite.prepare('UPDATE users SET budget_max=1 WHERE id=?').run(fixture.ids.user);
    db.sqlite.prepare('UPDATE api_keys SET limit_micros=NULL WHERE id=?').run(fixture.ids.key);
    const endpoint=fixture.cases['small-generations'].endpoint;
    const caps=JSON.parse(db.sqlite.prepare('SELECT image_capabilities FROM model_endpoints WHERE id=?').get(endpoint).image_capabilities);
    caps.pricing[0].cost_usd='0.1';db.sqlite.prepare('UPDATE model_endpoints SET image_capabilities=? WHERE id=?').run(JSON.stringify(caps),endpoint);
    const response=await handler.fetch(new Request('https://example.invalid/v1/images/generations',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model:fixture.cases['small-generations'].model,prompt:'synthetic boundary'})}),env,context);
    assert.equal(response.status,200);await response.body?.cancel();for(let i=0;i<tasks.length;i++)await tasks[i];
    assert.equal(sends,1);assert.equal(commits,1);assert.deepEqual(errors,[]);
    assert.deepEqual({...db.sqlite.prepare('SELECT state,settled_micros FROM user_budget_reservations WHERE user_id=?').get(fixture.ids.user)},{state:'settled',settled_micros:100000});
    assert.deepEqual({...db.sqlite.prepare('SELECT budget_spent_micros,budget_reserved_micros FROM users WHERE id=?').get(fixture.ids.user)},{budget_spent_micros:100000,budget_reserved_micros:0});
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM api_key_request_logs').get().n,1);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM user_audit_logs WHERE event_type=?').get('usage_charge').n,1);
  } finally {for(let i=0;i<tasks.length;i++)await tasks[i].catch(()=>undefined);db.sqlite.close();}
});

for(const mode of ['before-release','after-release','before-fail','after-fail','unarmed','other-tenant','release-timeout']) {
  test('real Worker app / SQLite storage fault boundary: '+mode,{timeout:10000},async t=>{
    await new Promise(resolve=>setImmediate(resolve));
    t.mock.method(globalThis,'fetch',async()=>{throw new Error('External network forbidden');});
    const errors=[];t.mock.method(console,'error',(...args)=>errors.push(args.join(' ')));
    let nativeBatches=0,sends=0;
    const db=createSqliteD1({afterBatch(sql){if(sql.some(s=>s.startsWith('INSERT INTO api_key_request_logs')))nativeBatches++;}});
    const key='synthetic-storage-client',runId='c02-success-'+randomUUID();
    const fixture=await imageSuccessFixture(runId,'sha256:'+createHash('sha256').update(key).digest('hex'),new Date(Date.now()+3600000).toISOString());
    const probe={runId:mode==='other-tenant'?'c02-success-'+randomUUID():runId,probeId:randomUUID(),mode:mode==='unarmed'||mode==='other-tenant'?'before-fail':mode==='release-timeout'?'before-release':mode};
    const row=imageStorageFaultRow(probe),tasks=[];
    const context={waitUntil(p){const item={p,settled:false};tasks.push(item);p.finally(()=>{item.settled=true;}).catch(()=>undefined);}};
    const env={DB:withImageStorageFault(db.binding,probe,{pollMs:5,polls:mode==='release-timeout'?1:20}),DATABASE_DRIVER:'d1',SHARED_KEY_ENCRYPTION_SECRET:'synthetic-material-not-for-real-secrets',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false'};
    const handler=createWorkerHandler({imageFetch:async(input,init)=>{sends++;return upstream.fetch(new Request(input,init));}});
    const read=()=>{const value=db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(row.key)?.value;return value?JSON.parse(value):null;};
    const logs=()=>db.sqlite.prepare('SELECT id,status,charged_cost,upstream_attempt_count FROM api_key_request_logs WHERE api_key_id=?').all(fixture.ids.key);
    try {
      for(const s of fixture.seed)db.sqlite.prepare(s.sql).run(...s.params);
      if(mode!=='unarmed')db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(row.key,row.value,row.description);
      const response=await handler.fetch(new Request('https://example.invalid/v1/images/generations',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model:fixture.cases['small-generations'].model,prompt:'synthetic boundary'})}),env,context);
      assert.equal(response.status,200);assert.equal((await response.json()).data[0].b64_json,'AQID');
      if(mode==='before-release'||mode==='after-release'){
        const phase=mode==='before-release'?'held-before-commit':'held-after-commit';
        const deadline=performance.now()+2000;
        while(read()?.phase!==phase&&performance.now()<deadline)await new Promise(resolve=>setImmediate(resolve));
        assert.equal(read().phase,phase);assert.ok(tasks.some(item=>!item.settled),'background host hold must survive response EOF');
        assert.equal(logs().length,mode==='before-release'?0:1);
        const value=db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(row.key).value;
        const release=JSON.stringify({...JSON.parse(value),phase:'release-requested'});
        assert.equal(db.sqlite.prepare('UPDATE system_config SET value=? WHERE key=? AND description=? AND value=?').run(release,row.key,row.description,value).changes,1);
      }
      for(let i=0;i<tasks.length;i++)await tasks[i].p;
      const committed=['before-release','after-release','after-fail','other-tenant'].includes(mode);
      assert.equal(nativeBatches,committed?1:0);assert.equal(sends,1);assert.equal(logs().length,committed?1:0);
      if(committed){assert.equal(logs()[0].status,'success');assert.equal(logs()[0].charged_cost,0);assert.equal(logs()[0].upstream_attempt_count,1);}
      assert.equal(db.sqlite.prepare('SELECT COALESCE(SUM(request_count),0) AS n FROM public_model_daily_stats').get().n,committed?1:0);
      const errorExpected=['before-fail','after-fail','unarmed','release-timeout'].includes(mode);
      assert.equal(errors.length,errorExpected?1:0);if(errorExpected)assert.match(errors[0],/C02_D1_FAULT/);
      const expected={'before-release':'ack-returned','after-release':'ack-returned','before-fail':'failed-before-commit','after-fail':'committed-ack-lost','other-tenant':'armed','release-timeout':'release-timeout'};
      assert.equal(read()?.phase,expected[mode]);
      // These observations expose the current recovery gap; no retry or durable
      // settlement is invented by the test adapter after a pre-commit failure.
      assert.deepEqual({...db.sqlite.prepare('SELECT budget_spent_micros,budget_reserved_micros FROM users WHERE id=?').get(fixture.ids.user)},{budget_spent_micros:0,budget_reserved_micros:0});
    } finally {
      const value=db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(row.key)?.value;
      if(value&&JSON.parse(value).phase.startsWith('held-'))db.sqlite.prepare('UPDATE system_config SET value=? WHERE key=?').run(JSON.stringify({...JSON.parse(value),phase:'release-requested'}),row.key);
      for(let i=0;i<tasks.length;i++)await tasks[i].p.catch(()=>undefined);
      db.sqlite.prepare('DELETE FROM system_config WHERE key=? AND description=?').run(row.key,row.description);
      for(const s of fixture.cleanup)db.sqlite.prepare(s.sql).run(...s.params);
      db.sqlite.close();
    }
  });
}
