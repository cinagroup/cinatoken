import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readByokD1FrozenMigrations} from './byok-d1-frozen-migrations-fixture.mjs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {BYOK_D1_CASES} from './byok-d1-acceptance.ts';
const {BYOK_D1_CONTROL_KEY,BYOK_D1_ORIGIN,handleByokD1OneShot}=await import(process.env.BYOK_D1_ONE_SHOT_MODULE
  ?pathToFileURL(resolve(process.env.BYOK_D1_ONE_SHOT_MODULE)).href:new URL('./byok-d1-one-shot.ts',import.meta.url).href);
const {guardByokD1}=await import(process.env.BYOK_D1_GUARD_MODULE
  ?pathToFileURL(resolve(process.env.BYOK_D1_GUARD_MODULE)).href:new URL('./byok-d1-guard.ts',import.meta.url).href);
const runId='c02-byok-a1b2c3d4e5f6',bearer='a1'.repeat(32);
const hash=value=>createHash('sha256').update(value).digest('hex');
const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

// Frozen 0001–0068 migration fixture. SQLite metadata is synthetic (zero read /
// write billing counters); these are historical protocol tests, not native D1 evidence.
function fixture(){
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
  for(const {sql} of readByokD1FrozenMigrations())db.exec(sql);
  const calls=[],batches=[],hooks={};
  const sync=(sql,values)=>{calls.push({sql,values});const s=db.prepare(sql),select=s.columns().length>0;
    const results=select?s.all(...values):[],changes=select?0:Number(s.run(...values).changes);
    return {success:true,results,meta:{changes,rows_read:0,rows_written:0}};};
  class Statement{
    constructor(sql,values=[]){this.sql=sql;this.values=values;}
    bind(...values){return new Statement(this.sql,values);}
    async all(){await hooks.before?.(this);const result=sync(this.sql,this.values);await hooks.after?.(this,result);return result;}
    run(){return this.all();}
    async first(){return (await this.all()).results[0]??null;}
  }
  const raw={prepare:sql=>new Statement(sql),async batch(items){
    await hooks.beforeBatch?.(items);batches.push(items);db.exec('BEGIN IMMEDIATE');let results;
    try{results=items.map(s=>sync(s.sql,s.values));db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
    await hooks.afterBatch?.(items,results);return results;
  }};
  const now=Math.floor(Date.now()/1000),initial={version:1,runId,tokenHash:hash(bearer),issuedAt:now-10,expiresAt:now+300,
    state:'ready',cursor:0,pendingCase:null,receipts:[]};
  const set=v=>db.prepare('UPDATE system_config SET value=? WHERE key=?').run(typeof v==='string'?v:JSON.stringify(v),BYOK_D1_CONTROL_KEY);
  db.prepare('INSERT INTO system_config(key,value) VALUES(?,?)').run(BYOK_D1_CONTROL_KEY,JSON.stringify(initial));
  const read=()=>JSON.parse(db.prepare('SELECT value FROM system_config WHERE key=?').get(BYOK_D1_CONTROL_KEY).value);
  const tasks=[],ctx={waitUntil(task){assert.equal(this,ctx);tasks.push(task);}};
  const request=(action=BYOK_D1_CASES[0],options={})=>new Request(BYOK_D1_ORIGIN+'/__staging/byok-d1/'+action,
    {method:'POST',headers:{Authorization:'Bearer '+bearer},...options});
  const send=(action,options)=>handleByokD1OneShot(request(action,options),raw,ctx);
  const close=async()=>{await Promise.all(tasks);db.close();};
  return {db,raw,calls,batches,hooks,initial,set,read,ctx,tasks,request,send,close};
}
const controlUpdate=s=>s.sql.startsWith('UPDATE system_config');

test('all ten cases: claim before seed, durable PASS before HTTP, exact ordered terminal journal',async t=>{
  const f=fixture();try{
    f.hooks.beforeBatch=async items=>{if(items[0].sql.startsWith('INSERT INTO users')){
      const state=f.read();assert.equal(state.state,'pending');assert.equal(state.pendingCase,BYOK_D1_CASES[state.cursor]);
    }};
    let maxStatements=0;const queryCounts=[];
    for(const [i,id] of BYOK_D1_CASES.entries()){
      const response=await f.send(id),body=await response.json();
      assert.equal(response.status,200,JSON.stringify(body));assert.equal(response.headers.get('cache-control'),'no-store');
      assert.equal(body.code,'case_pass');assert.equal(body.receipt.caseId,id);assert.equal(body.receipt.counters.active,0);
      assert.equal(body.receipt.result.midBatchWallClockExpiryVerified,false);
      const state=f.read();assert.equal(state.cursor,i+1);assert.equal(state.state,i===9?'done':'ready');
      assert.deepEqual(state.receipts.at(-1),body.receipt);assert.equal(state.pendingCase,null);
      assert.ok(!JSON.stringify(body).includes(bearer));assert.ok(!JSON.stringify(body).includes(hash(bearer)));
      assert.ok(!JSON.stringify(body).includes('enc:v2:'));assert.ok(!JSON.stringify(body).includes('SELECT'));
      maxStatements=Math.max(maxStatements,body.receipt.counters.statements);
      queryCounts.push({caseId:id,statements:body.receipt.counters.statements,calls:body.receipt.counters.calls});
    }
    assert.ok(maxStatements>103&&maxStatements<=200);
    const before=f.batches.length;assert.equal((await f.send()).status,409);assert.equal(f.batches.length,before);
    assert.equal(f.read().receipts.length,10);
    t.diagnostic(JSON.stringify({queryCounts,controlStatementsPerSuccessfulCase:3}));
  }finally{await f.close();}
});
test('request allowlist rejects wrong origin/path/query/method/body/token format before database I/O',async()=>{
  const f=fixture();try{
    const base=f.request().url;
    const requests=[new Request(base.replace('cinatoken-proxy-staging','cinatoken-proxy'),{method:'POST'}),
      new Request(base+'?runId=arbitrary',{method:'POST'}),new Request(base+'#x',{method:'POST'}),
      f.request('cleanup'),f.request('../stop'),f.request(undefined,{method:'GET'}),
      f.request(undefined,{body:'{}'}),f.request(undefined,{headers:{Authorization:'Bearer short'}}),
      f.request(undefined,{headers:{Authorization:'Bearer '+'A'.repeat(64)}})];
    for(const r of requests)assert.ok((await handleByokD1OneShot(r,f.raw,f.ctx)).status>=400);
    assert.equal(f.calls.length,0);assert.equal(f.tasks.length,0);
  }finally{await f.close();}
});
test('wrong well-formed token reads only, with no control/fixture write',async()=>{
  const f=fixture();try{assert.equal((await f.send(undefined,{headers:{Authorization:'Bearer '+'b2'.repeat(32)}})).status,404);
    assert.equal(f.calls.length,1);assert.equal(f.batches.length,0);assert.deepEqual(f.read(),f.initial);
  }finally{await f.close();}
});
test('waitUntil registration failure cannot begin any database operation',async()=>{
  const f=fixture();try{const result=await handleByokD1OneShot(f.request(),f.raw,{waitUntil(){throw Error('host rejected');}});
    assert.equal(result.status,503);await new Promise(r=>setImmediate(r));assert.equal(f.calls.length,0);
  }finally{await f.close();}
});
test('already cancelled requests perform no I/O',async()=>{
  const f=fixture();try{assert.equal((await f.send(undefined,{signal:AbortSignal.abort()})).status,409);assert.equal(f.calls.length,0);
  }finally{await f.close();}
});
test('cancellation during read/hash is rejected before claim',async()=>{
  const f=fixture(),controller=new AbortController();try{f.hooks.after=async s=>{if(s.sql.startsWith('SELECT value'))controller.abort();};
    assert.equal((await f.send(undefined,{signal:controller.signal})).status,409);assert.deepEqual(f.read(),f.initial);
    assert.equal(f.batches.length,0);
  }finally{await f.close();}
});
for(const [label,patch] of [['expired',{issuedAt:1,expiresAt:2}],['not-yet-valid',{issuedAt:Math.floor(Date.now()/1000)+60,expiresAt:Math.floor(Date.now()/1000)+120}]])
test('database-clock admission rejects '+label,async()=>{
  const f=fixture();try{f.set({...f.initial,...patch});assert.equal((await f.send()).status,409);assert.equal(f.batches.length,0);
    assert.equal(f.read().state,'ready');
  }finally{await f.close();}
});
test('strict bounded control parsing rejects corrupt or unowned state, no writes',async()=>{
  const f=fixture();try{
    const bad=['{','x'.repeat(32769),JSON.stringify({...f.initial,extra:'ignored?'}),
      {...f.initial,runId:'production'},{...f.initial,expiresAt:f.initial.issuedAt+901},
      {...f.initial,cursor:1},{...f.initial,state:'pending'},{...f.initial,pendingCase:BYOK_D1_CASES[0]},
      {...f.initial,state:'done'},{...f.initial,receipts:[{caseId:BYOK_D1_CASES[0]}]},
      {...f.initial,tokenHash:'x'.repeat(64)},{...f.initial,state:'failed'}];
    for(const value of bad){f.set(value);const before=f.calls.length;assert.ok((await f.send()).status>=400);
      assert.ok(f.calls.slice(before).every(c=>c.sql.startsWith('SELECT value')));}
    assert.equal(f.batches.length,0);
  }finally{await f.close();}
});
test('two requests racing one case: exactly one atomic claim and one fixture',async()=>{
  const f=fixture();try{const responses=await Promise.all([f.send(),f.send()]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
    assert.equal(f.batches.filter(b=>b[0].sql.startsWith('INSERT INTO users')).length,1);assert.equal(f.read().cursor,1);
  }finally{await f.close();}
});
test('out-of-order and consumed cases never write or run',async()=>{
  const f=fixture();try{assert.equal((await f.send(BYOK_D1_CASES[1])).status,409);assert.equal(f.batches.length,0);
    assert.equal((await f.send()).status,200);const count=f.batches.length;assert.equal((await f.send()).status,409);
    assert.equal(f.batches.length,count);
  }finally{await f.close();}
});
test('claim committed but acknowledgement lost: keep PENDING and never start/replay fixture',async()=>{
  const f=fixture();try{f.hooks.after=async s=>{if(controlUpdate(s))throw Error('unknown transport');};
    assert.equal((await f.send()).status,503);assert.equal(f.read().state,'pending');assert.equal(f.batches.length,0);
    assert.equal((await f.send()).status,409);assert.equal(f.batches.length,0);
  }finally{await f.close();}
});
test('expiry between authorization read and claim is checked inside the atomic database write',async()=>{
  const f=fixture();try{
    const now=Math.floor(Date.now()/1000);f.set({...f.initial,issuedAt:now-899,expiresAt:now+1});
    f.hooks.before=async s=>{if(controlUpdate(s)&&JSON.parse(s.values[0]).state==='pending'){
      // Advance SQLite's clock only in this admission predicate. This local
      // fault does not claim native clock/statement expiry evidence.
      s.sql=s.sql.replaceAll("unixepoch('now')","unixepoch('now', '+2 seconds')");
    }};
    assert.equal((await f.send()).status,409);assert.equal(f.batches.length,0);assert.equal(f.read().state,'ready');
  }finally{await f.close();}
});
test('claim acknowledgement with invalid change count fails closed without a fixture',async()=>{
  const f=fixture();try{f.hooks.after=async(s,r)=>{if(controlUpdate(s))r.meta.changes=2;};
    assert.equal((await f.send()).status,503);assert.equal(f.read().state,'pending');assert.equal(f.batches.length,0);
  }finally{await f.close();}
});
test('seed acknowledgement lost preserves committed synthetic rows and terminal failure, never auto-deletes',async()=>{
  const f=fixture();try{f.hooks.afterBatch=async items=>{if(items[0].sql.startsWith('INSERT INTO users'))throw Error('ack lost');};
    assert.equal((await f.send()).status,500);assert.equal(f.read().state,'failed');
    assert.equal(f.read().receipts[0].counters.nativeRejectedCalls,1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM users').get().n,1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM byok_keys').get().n,3);
    const count=f.batches.length;assert.equal((await f.send()).status,409);assert.equal(f.batches.length,count);
    assert.ok(f.calls.every(c=>!c.sql.startsWith('DELETE')));
  }finally{await f.close();}
});
test('HTTP PASS is withheld while the durable terminal receipt is still pending',async()=>{
  const f=fixture(),entered=defer(),held=defer();let running,settled=false;
  try{f.hooks.before=async s=>{if(controlUpdate(s)&&JSON.parse(s.values[0]).cursor===1){entered.resolve();await held.promise;}};
    running=f.send().then(r=>{settled=true;return r;});await entered.promise;
    assert.equal(settled,false);assert.equal(f.read().state,'pending');assert.equal(f.read().receipts.length,0);
    held.resolve();assert.equal((await running).status,200);assert.equal(f.read().receipts[0].outcome,'PASS');
  }finally{held.resolve();await running;await f.close();}
});
test('known case failure is terminal, bounded and redacted; no automatic cleanup',async()=>{
  const f=fixture();try{f.hooks.beforeBatch=async()=>{throw Error('secret SQL diagnostic '+bearer);};
    const result=await f.send(),text=await result.text();assert.equal(result.status,500);assert.ok(!text.includes(bearer));
    assert.equal(f.read().state,'failed');assert.equal(f.read().receipts[0].outcome,'FAIL');
    assert.equal((await f.send()).status,409);assert.ok(f.calls.every(c=>!c.sql.startsWith('DELETE')));
  }finally{await f.close();}
});
for(const afterCommit of [false,true])test('final receipt acknowledgement '+(afterCommit?'lost after commit':'fails before commit')+' cannot return success',async()=>{
  const f=fixture();try{
    f.hooks[afterCommit?'after':'before']=async s=>{if(controlUpdate(s)&&JSON.parse(s.values[0]).cursor===1)throw Error('transport');};
    assert.equal((await f.send()).status,503);assert.equal(f.read().state,afterCommit?'ready':'pending');
    const count=f.batches.length;assert.equal((await f.send()).status,409);assert.equal(f.batches.length,count);
  }finally{await f.close();}
});
test('disconnect after claim does not abandon work or erase its durable receipt',async()=>{
  const f=fixture(),controller=new AbortController();try{
    f.hooks.beforeBatch=async items=>{if(items[0].sql.startsWith('INSERT INTO users'))controller.abort();};
    assert.equal((await f.send(undefined,{signal:controller.signal})).status,200);assert.equal(f.read().cursor,1);
  }finally{await f.close();}
});
test('stop after expiry seals new admissions but preserves pending ownership until external reconciliation',async()=>{
  const f=fixture(),entered=defer(),held=defer();let running;
  try{
    f.hooks.beforeBatch=async items=>{if(items[0].sql.startsWith('INSERT INTO users')){entered.resolve();await held.promise;}};
    running=f.send();await entered.promise;assert.equal(f.read().state,'pending');
    const stop=await f.send('stop');assert.equal(stop.status,200);assert.equal((await stop.json()).code,'admissions_stopped');
    assert.equal(f.read().pendingCase,BYOK_D1_CASES[0]);assert.equal((await f.send()).status,409);
    held.resolve();assert.equal((await running).status,503);assert.equal(f.read().state,'stopped');
    assert.equal(f.read().pendingCase,BYOK_D1_CASES[0]);assert.equal(f.read().receipts.length,0);
    assert.equal((await f.send('stop')).status,409);
    // Stop is also valid for an expired idle permit; it never revives it.
    f.set({...f.initial,issuedAt:1,expiresAt:2});assert.equal((await f.send('stop')).status,200);
    assert.equal((await f.send()).status,409);
  }finally{held.resolve();await running;await f.close();}
});
test('guard forwards original statement objects, parameters and one native batch without insertion',async()=>{
  const f=fixture();try{
    const g=guardByokD1(f.raw),a=g.db.prepare('SELECT ? AS n').bind(17),b=g.db.prepare('SELECT ? AS n').bind(23);
    const result=await g.db.batch([a,b]);assert.deepEqual(result.map(r=>r.results[0].n),[17,23]);
    assert.equal(f.batches.length,1);assert.deepEqual(f.batches[0].map(s=>s.sql),['SELECT ? AS n','SELECT ? AS n']);
    assert.deepEqual(f.batches[0].map(s=>s.values),[[17],[23]]);assert.equal(g.snapshot().statements,2);
    assert.equal(g.snapshot().active,0);g.seal();await assert.rejects(g.db.prepare('SELECT 1').all(),/guard_limit/);
  }finally{await f.close();}
});
test('guard statement budget, bind limit, unsupported APIs and foreign prepared statements fail closed',async()=>{
  const f=fixture();try{
    const g=guardByokD1(f.raw);for(let i=0;i<200;i++)await g.db.prepare('SELECT 1').first();
    assert.equal(g.snapshot().callsWithoutRowMetadata,200);await assert.rejects(g.db.prepare('SELECT 1').first(),/guard_limit/);
    assert.equal(f.calls.length,200);const h=guardByokD1(f.raw);
    assert.throws(()=>h.db.prepare('SELECT 1').bind(...Array(101).fill(0)),/guard_limit/);
    assert.throws(()=>guardByokD1(f.raw).db.exec('SELECT 1'),/database_api/);
    assert.throws(()=>guardByokD1(f.raw).db.withSession(),/database_api/);
    assert.throws(()=>guardByokD1(f.raw).db.batch([f.raw.prepare('SELECT 1')]),/guard_limit/);
    assert.throws(()=>guardByokD1(f.raw).db.prepare('x'.repeat(100001)),/guard_limit/);
  }finally{await f.close();}
});
test('guard elapsed admission deadline performs no query and never pretends to cancel one',async()=>{
  const f=fixture();try{const g=guardByokD1(f.raw,performance.now()-20001);
    await assert.rejects(g.db.prepare('SELECT 1').all(),/guard_limit/);assert.equal(f.calls.length,0);
  }finally{await f.close();}
});
test('guard tracks both outstanding native calls until they really settle',async()=>{
  const f=fixture(),held=defer();let first,second;try{
    f.hooks.before=async()=>held.promise;const g=guardByokD1(f.raw);
    first=g.db.prepare('SELECT 1').all();second=g.db.prepare('SELECT 2').all();assert.equal(g.snapshot().active,2);
    await assert.rejects(g.db.prepare('SELECT 3').all(),/guard_limit/);assert.equal(g.snapshot().active,2);
    held.resolve();await Promise.all([first,second]);assert.equal(g.snapshot().active,0);assert.equal(g.snapshot().peakActive,2);
  }finally{held.resolve();await Promise.all([first,second]);await f.close();}
});
for(const [name,value] of [['rows_read',100001],['rows_written',10001],['rows_written',-1]])
test('guard rejects acknowledged metadata threshold / '+name+'='+value,async()=>{
  const f=fixture();try{f.hooks.after=async(_s,result)=>{result.meta[name]=value;};const g=guardByokD1(f.raw);
    await assert.rejects(g.db.prepare('SELECT 1').all(),/guard_limit/);assert.equal(g.snapshot().active,0);
    await assert.rejects(g.db.prepare('SELECT 2').all(),/guard_limit/);assert.equal(f.calls.length,1);
  }finally{await f.close();}
});
test('missing native metadata seals future queries instead of treating it as zero cost',async()=>{
  const f=fixture();try{f.hooks.after=async(_s,r)=>{delete r.meta.rows_written;};const g=guardByokD1(f.raw);
    await assert.rejects(g.db.prepare('SELECT 1').all(),/guard_limit/);
    assert.equal(g.snapshot().callsWithoutRowMetadata,1);assert.equal(g.snapshot().nativeRejectedCalls,0);
    await assert.rejects(g.db.prepare('SELECT 2').all(),/guard_limit/);assert.equal(f.calls.length,1);
  }finally{await f.close();}
});
