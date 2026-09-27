import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setImmediate as nextTurn} from 'node:timers/promises';
import test from 'node:test';
import {createSqliteD1} from '../../src/test-support/sqlite-d1.ts';
import {drainNodeBackgroundWork} from '../../src/runtime/schedule-background-work.ts';
import {imageSseFixture} from '../../../../scripts/deploy/staging-image-sse-fixture.mjs';
import {createImagesSseStagingGateway} from './images-sse-gateway-handler.ts';
import {createWorkerHandler} from '../../src/runtime/worker-handler.ts';
import {resolveWorkerStorageFromBindings} from '../../src/runtime/workers.ts';
import {runUsageRecoveryD1} from '../../../core/src/storage/recovery/run-usage-recovery-d1.ts';
import {RequestExecutionStoppedError} from '../../src/services/request-deadline.ts';

const event=value=>'data: '+JSON.stringify(value)+'\n\n';
const completed=event({type:'image_generation.completed',b64_json:'AQID',usage:{input_tokens:3,output_tokens:7,total_tokens:10}});
const done='data: [DONE]\n\n';
const failure=event({type:'error',error:{message:'Synthetic rejection after completed image',code:'server_error'}});
const logSql=sql=>/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+["`]?api_key_request_logs/i.test(sql);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

async function setup(t,scenario,durable=false){
  const db=createSqliteD1(),tasks=[],messages=[],key='synthetic-sse-window-'+randomUUID(),gate=deferred(),entered=deferred();
  t.mock.method(globalThis,'fetch',async()=>{throw Error('External network forbidden');});
  for(const method of ['log','warn','error'])t.mock.method(console,method,(...args)=>messages.push(args));
  for(const name of ['request-dispatch-intents','request-usage-settlements','request-usage-recovery-jobs'])
    db.sqlite.exec(readFileSync(new URL(`../../../core/migrations-proposals/d1/${name}.sql`,import.meta.url),'utf8'));
  const fixture=await imageSseFixture('c02-success-'+randomUUID(),'sha256:'+createHash('sha256').update(key).digest('hex'),new Date(Date.now()+3600000).toISOString());
  for(const s of fixture.seed)db.sqlite.prepare(s.sql).run(...s.params);
  const context={waitUntil(p){assert.equal(this,context);tasks.push(p);p.catch(()=>undefined);}};
  const abort=new AbortController();let sends=0,cancels=0,commits=0,failed=false;
  const hasDone=!['completed-cancel','completed-deadline','completed-eof','completed-error'].includes(scenario);
  const hold=['completed-cancel','completed-deadline'].includes(scenario);
  const transport=async()=>{
    sends++;
    if(scenario==='json-reject'||scenario==='json-wrong-content-type')return Response.json({error:{message:'Synthetic non-stream response'}},{status:scenario==='json-reject'?400:200});
    return new Response(new ReadableStream({start(c){
      c.enqueue(new TextEncoder().encode(completed+(hasDone?done:scenario==='completed-error'?failure:'')));
      if(!hold)c.close();
    },cancel(){cancels++;}}),{headers:{'Content-Type':'text/event-stream'}});
  };
  const app=durable?createWorkerHandler({imageFetch:transport,imageUsageRecovery:{settlementLeaseSeconds:30,streaming:true}}):createImagesSseStagingGateway(transport);
  const originalBatch=db.binding.batch.bind(db.binding);
  db.binding.batch=async statements=>{
    const targetsLog=statements.some(s=>logSql(s.sql));
    if(targetsLog&&scenario==='pause-before-commit'){entered.resolve();await gate.promise;}
    const result=await originalBatch(statements);
    if(targetsLog){commits++;if(scenario==='pause-after-commit'){entered.resolve();await gate.promise;}}
    return result;
  };
  db.hooks.beforeStatement=sql=>{
    if(logSql(sql)&&scenario==='fail-before-commit'&&!failed){failed=true;throw Error('synthetic_stream_log_precommit_failure');}
  };
  db.hooks.afterBatch=sql=>{
    if(sql.some(logSql)&&scenario==='lose-commit-ack'&&!failed){failed=true;commits++;throw Error('synthetic_stream_commit_ack_lost');}
  };
  const env={DB:db.binding,DATABASE_DRIVER:'d1',SHARED_KEY_ENCRYPTION_SECRET:'synthetic-material-not-for-real-secrets',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false'};
  const storage=await resolveWorkerStorageFromBindings(env);
  const drain=async()=>{for(let i=0;i<tasks.length;i++)await tasks[i];await drainNodeBackgroundWork();};
  t.after(async()=>{gate.resolve();abort.abort();await Promise.allSettled(tasks);await drainNodeBackgroundWork();db.sqlite.close();});
  const observe=()=>({
    logs:db.sqlite.prepare('SELECT id,status,charged_cost,budget_charged_micros,output_image_count,upstream_attempt_count,error_message FROM api_key_request_logs WHERE user_id=?').all(fixture.ids.user).map(r=>({...r})),
    account:{...db.sqlite.prepare('SELECT budget_spent_micros,budget_reserved_micros FROM users WHERE id=?').get(fixture.ids.user)},
    reservations:db.sqlite.prepare('SELECT request_id,state,settled_micros,terminal_reason FROM user_budget_reservations WHERE user_id=?').all(fixture.ids.user).map(r=>({...r})),
    recovery:['request_dispatch_intents','request_usage_settlements','request_usage_recovery_jobs'].map(table=>db.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n),
  });
  return {db,fixture,abort,drain,gate,entered,observe,messages,
    recover:()=>runUsageRecoveryD1(storage.client,{scope:{kind:'all'},maxItems:5,concurrency:1,leaseSeconds:10,runBudgetMs:5000,reservedBytesPerConsumer:1024},{tryAcquire(){return{release(){}};}}),
    get sends(){return sends;},get cancels(){return cancels;},get commits(){return commits;},get failed(){return failed;},
    request:()=>app.fetch(new Request('https://example.invalid/v1/images/generations',{method:'POST',signal:abort.signal,
      headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model:fixture.cases['small-generations'].model,prompt:'synthetic settlement boundary',stream:true})}),env,context)};
}

const scenarios=['drain','unread-cancel','completed-cancel','completed-deadline','completed-eof','completed-error','done-cancel','done-abort','done-cancel-after-turn','done-abort-after-turn','fail-before-commit','lose-commit-ack','pause-before-commit','pause-after-commit'];
for(const durable of [false,true])for(const scenario of scenarios)test(`SSE settlement boundary ${durable?'durable':'legacy'}: ${scenario}`,{timeout:10000},async t=>{
  const f=await setup(t,scenario,durable),response=await f.request();
  assert.equal(response.status,200);const id=response.headers.get('X-Generation-Id');
  let wire='',paused;
  if(scenario==='unread-cancel')await response.body.cancel();
  else if(['completed-cancel','completed-deadline'].includes(scenario)||scenario.startsWith('done-')){
    const reader=response.body.getReader();
    for(;;){const r=await reader.read();assert.equal(r.done,false);wire+=new TextDecoder().decode(r.value);
      if(scenario.startsWith('completed-')?wire.includes('image_generation.completed'):wire.includes('[DONE]'))break;}
    if(scenario.endsWith('-after-turn'))await nextTurn();
    if(scenario==='completed-deadline'){
      f.abort.abort(new RequestExecutionStoppedError('deadline_exceeded'));
      for(;;){const r=await reader.read();if(r.done)break;wire+=new TextDecoder().decode(r.value);}
    }else if(scenario.startsWith('done-abort')){f.abort.abort();await reader.cancel();}
    else await reader.cancel();
  }else if(scenario.startsWith('pause-')){
    let delivered=false;
    const reading=response.text().then(text=>{wire=text;delivered=true;});
    await f.entered.promise;await nextTurn();paused=f.observe();
    assert.equal(delivered,durable,'DONE waits for commit on legacy, durable acceptance on recovery');
    f.gate.resolve();await reading;
  }else wire=await response.text();
  await f.drain();await nextTurn();
  const state=f.observe();
  const settlementWarnings=f.messages.filter(a=>String(a[0]).includes('stream settlement failed')).length;
  process.stdout.write('SSE_WINDOW '+JSON.stringify({scenario,durable,id,wire,state,paused,sends:f.sends,cancels:f.cancels,commits:f.commits,faultReached:f.failed,settlementWarnings})+'\n');
  assert.equal(f.sends,1);assert.deepEqual(state.recovery,durable?[1,1,1]:[0,0,0]);assert.equal(state.reservations.length,1);
  const deferredCommit=durable&&scenario==='fail-before-commit';
  assert.equal(state.account.budget_reserved_micros,deferredCommit?100000:0);
  if((scenario.includes('commit')&&scenario!=='fail-before-commit')||scenario==='lose-commit-ack'||scenario==='drain'){
    assert.match(wire,/image_generation.completed/);assert.match(wire,/\[DONE\]/);assert.doesNotMatch(wire,/"type":"error"/);
  }
  // User-approved success is immutable even when delivery is cancelled.
  const missingLog=scenario==='fail-before-commit';
  const success=['drain','lose-commit-ack','pause-before-commit','pause-after-commit'].includes(scenario)||scenario.startsWith('done-');
  const micros=deferredCommit?0:success||missingLog?100000:0;
  assert.equal(state.account.budget_spent_micros,micros);
  assert.deepEqual(state.reservations,[{request_id:id,state:deferredCommit?'dispatched':missingLog?'expired':'settled',settled_micros:micros,terminal_reason:deferredCommit?null:missingLog?'image_stream_settlement_failed':'request_usage_settled'}]);
  assert.equal(state.logs.length,missingLog?0:1);
  if(!missingLog){const log=state.logs[0];assert.equal(log.id,id);assert.equal(log.status,success?'success':'error');assert.equal(log.charged_cost,success?0.1:0);assert.equal(log.budget_charged_micros,micros);assert.equal(log.output_image_count,success?1:0);assert.equal(log.upstream_attempt_count,1);}
  assert.equal(f.commits,missingLog?0:1);
  assert.equal(f.failed,missingLog||scenario==='lose-commit-ack');
  assert.equal(settlementWarnings,missingLog&&!durable?1:0);
  const frames=wire.split('\n\n').filter(Boolean);
  assert.equal(frames.filter(frame=>frame==='data: [DONE]').length,['unread-cancel','completed-cancel'].includes(scenario)?0:1);
  const errorExpected=['completed-deadline','completed-eof','completed-error'].includes(scenario)||(missingLog&&!durable);
  const errors=frames.filter(frame=>frame.startsWith('data: {')).map(frame=>JSON.parse(frame.slice(6))).filter(frame=>frame.type==='error');
  assert.equal(errors.length,errorExpected?1:0);
  if(errorExpected){assert.equal(errors[0].error.metadata.retry_safe,false);assert.equal(errors[0].error.metadata.outcome_unknown,true);assert.equal(errors[0].error.metadata.request_id,id);}
  if(paused){assert.deepEqual(paused.recovery,durable?[1,1,1]:[0,0,0]);if(scenario==='pause-before-commit'){assert.equal(paused.logs.length,0);assert.deepEqual(paused.account,{budget_spent_micros:0,budget_reserved_micros:100000});assert.deepEqual(paused.reservations,[{request_id:id,state:'dispatched',settled_micros:0,terminal_reason:null}]);}else assert.deepEqual(paused,state);}
  if(deferredCommit){
    const pending=f.db.sqlite.prepare('SELECT state FROM request_usage_recovery_jobs').get();assert.equal(pending.state,'pending');
    // Advance only the test database clock beyond native backoff; no timer or model replay.
    f.db.sqlite.function('unixepoch',{varargs:true},()=>Math.floor(Date.now()/1000)+60);
    assert.equal((await f.recover()).committed,1);assert.equal((await f.recover()).claimed,0);
    const recovered=f.observe();assert.equal(recovered.logs.length,1);assert.equal(recovered.logs[0].status,'success');assert.equal(recovered.logs[0].charged_cost,0.1);
    assert.deepEqual(recovered.account,{budget_spent_micros:100000,budget_reserved_micros:0});assert.equal(f.sends,1);
  }
});

const snapshotSql=sql=>/^INSERT INTO request_usage_settlements/.test(sql);
for(const scenario of ['json-reject','json-wrong-content-type'])test('SSE request with non-SSE failure still persists: '+scenario,async t=>{
  const f=await setup(t,scenario,true),response=await f.request();
  assert.equal(response.status,scenario==='json-reject'?400:502);await response.text();await f.drain();
  const state=f.observe();assert.equal(state.logs.length,1);assert.equal(state.logs[0].status,'error');assert.equal(state.logs[0].charged_cost,0);
  assert.deepEqual(state.recovery,[1,1,1]);assert.equal(state.account.budget_reserved_micros,0);assert.equal(f.sends,1);
  assert.equal((await f.recover()).claimed,0);
});
for(const mode of ['precommit-failure','ack-lost','job-readback-unavailable'])test('SSE durable snapshot fault: '+mode,{timeout:10000},async t=>{
  const f=await setup(t,'snapshot-fault',true);let inserted=false,reached=false;
  f.db.hooks.beforeStatement=sql=>{
    if(mode==='precommit-failure'&&snapshotSql(sql)){reached=true;throw Error('synthetic_snapshot_failure');}
    if(mode==='job-readback-unavailable'&&inserted&&sql.startsWith('SELECT * FROM request_usage_recovery_jobs')){reached=true;throw Error('synthetic_job_readback_unavailable');}
  };
  f.db.hooks.afterStatement=sql=>{if(snapshotSql(sql)){inserted=true;if(mode==='ack-lost'){reached=true;throw Error('synthetic_snapshot_ack_lost');}}};
  const response=await f.request(),wire=await response.text();await f.drain();assert.equal(reached,true);
  assert.match(wire,/image_generation.completed/);assert.equal((wire.match(/data: \[DONE\]/g)||[]).length,1);
  const state=f.observe();assert.equal(f.sends,1);assert.equal(state.recovery[0],1);
  if(mode==='ack-lost'){
    assert.doesNotMatch(wire,/"type":"error"/);assert.equal(state.logs.length,1);assert.equal(state.logs[0].charged_cost,0.1);
  }else {
    assert.match(wire,/"retry_safe":false/);assert.match(wire,/"outcome_unknown":true/);assert.equal(state.logs.length,0);
    assert.deepEqual(state.account,{budget_spent_micros:0,budget_reserved_micros:100000});assert.equal(state.reservations[0].state,'dispatched');
    assert.deepEqual(state.recovery,mode==='precommit-failure'?[1,0,0]:[1,1,1]);
  }
  f.db.hooks.beforeStatement=undefined;f.db.hooks.afterStatement=undefined;
  if(mode==='job-readback-unavailable'){assert.equal((await f.recover()).committed,1);assert.equal((await f.recover()).claimed,0);assert.equal(f.observe().account.budget_spent_micros,100000);assert.equal(f.sends,1);}
  process.stdout.write('SSE_WINDOW '+JSON.stringify({scenario:mode,durable:true,wire,state,recovered:f.observe()})+'\n');
});

for(const boundary of ['before','after'])for(const action of ['cancel','abort'])test(`SSE ${action} during snapshot ${boundary} commit retains success`,{timeout:10000},async t=>{
  const f=await setup(t,'snapshot-pause',true),original=f.db.binding.prepare.bind(f.db.binding);
  const wrap=statement=>{
    const bind=statement.bind.bind(statement),run=statement.run.bind(statement);
    statement.bind=(...args)=>wrap(bind(...args));
    statement.run=async()=>{
      if(boundary==='before'){f.entered.resolve();await f.gate.promise;}
      const result=await run();
      if(boundary==='after'){f.entered.resolve();await f.gate.promise;}
      return result;
    };
    return statement;
  };
  f.db.binding.prepare=sql=>snapshotSql(sql)?wrap(original(sql)):original(sql);
  const response=await f.request(),reader=response.body.getReader();let wire='';
  const reading=(async()=>{for(;;){const r=await reader.read();if(r.done)break;wire+=new TextDecoder().decode(r.value);}})();
  await f.entered.promise;await nextTurn();assert.match(wire,/image_generation.completed/);assert.doesNotMatch(wire,/\[DONE\]/);
  assert.deepEqual(f.observe().recovery,boundary==='before'?[1,0,0]:[1,1,1]);
  if(action==='cancel')await reader.cancel();else f.abort.abort();
  f.gate.resolve();await reading;await f.drain();
  const state=f.observe();assert.equal(state.logs.length,1);assert.equal(state.logs[0].status,'success');assert.equal(state.logs[0].charged_cost,0.1);
  assert.deepEqual(state.account,{budget_spent_micros:100000,budget_reserved_micros:0});assert.equal(f.sends,1);
  if(action==='cancel')assert.doesNotMatch(wire,/\[DONE\]/);else assert.match(wire,/\[DONE\]/);
  assert.equal((await f.recover()).claimed,0);
});
