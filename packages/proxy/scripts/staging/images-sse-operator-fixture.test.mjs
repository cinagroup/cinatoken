import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createSqliteD1} from '../../src/test-support/sqlite-d1.ts';
import {drainNodeBackgroundWork} from '../../src/runtime/schedule-background-work.ts';
import {imageSseRow,imageSsePrompt,parseImageSseProbe} from './images-sse-probe-contract.ts';
import {sseSnapshotFaultRow} from './images-sse-snapshot-fault.ts';
import {createImagesSseSnapshotStagingGateway} from './images-sse-snapshot-gateway-handler.ts';
import upstream from './images-sse-window-upstream.ts';
import {imageSseFixture} from '../../../../scripts/deploy/staging-image-sse-fixture.mjs';
import {canonicalSseOperatorRow,failedSseOperatorCleanupStatements} from '../../../../scripts/deploy/staging-sse-operator-fixture.mjs';

const permutations=[['runId','probeId','mode'],['runId','mode','probeId'],['probeId','runId','mode'],['probeId','mode','runId'],['mode','runId','probeId'],['mode','probeId','runId']];
for(const order of permutations)test('Operator seed matches Worker CAS bytes for order '+order.join(','),()=>{
  const probe={runId:'c02-success-'+randomUUID(),probeId:randomUUID(),mode:'success'},input=Object.fromEntries(order.map(k=>[k,probe[k]]));
  assert.deepEqual(canonicalSseOperatorRow(input),imageSseRow(parseImageSseProbe(imageSsePrompt(probe))));
});
test('Operator normalization drops non-contract object fields without changing identity',()=>{
  const p={runId:'c02-success-'+randomUUID(),probeId:randomUUID(),mode:'success'};
  assert.deepEqual(canonicalSseOperatorRow({...p,untrusted:'not a row field'}),canonicalSseOperatorRow(p));
});

async function setup(t,canonical){
  const db=createSqliteD1(),tasks=[],messages=[],key='synthetic-snapshot-client-'+randomUUID();
  t.mock.method(globalThis,'fetch',async()=>{throw Error('External network forbidden');});
  for(const m of ['log','warn','error'])t.mock.method(console,m,(...a)=>messages.push(a));
  for(const name of ['request-dispatch-intents','request-usage-settlements','request-usage-recovery-jobs'])db.sqlite.exec(readFileSync(new URL(`../../../core/migrations-proposals/d1/${name}.sql`,import.meta.url),'utf8'));
  const counts=()=>db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,db.sqlite.prepare('SELECT COUNT(*) n FROM '+name).get().n]);
  const baseline=counts(),runId='c02-success-'+randomUUID(),expiresAt=new Date(Date.now()+3600000).toISOString(),keyHash='sha256:'+createHash('sha256').update(key).digest('hex');
  const fixture=await imageSseFixture(runId,keyHash,expiresAt);for(const s of fixture.seed)db.sqlite.prepare(s.sql).run(...s.params);
  const p={runId,probeId:randomUUID(),mode:'before-fail'},u={runId,mode:'success',probeId:randomUUID()}; // Actual failed operator order.
  const sr=sseSnapshotFaultRow(p),ur=canonical?canonicalSseOperatorRow(u):imageSseRow(u);
  for(const row of [sr,ur])db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(row.key,row.value,row.description);
  const ctx={waitUntil(p){assert.equal(this,ctx);tasks.push(p);p.catch(()=>{});}};let sends=0;
  const app=createImagesSseSnapshotStagingGateway((input,init)=>{sends++;return upstream.fetch(new Request(input,init),{PROBE_DB:db.binding},ctx);});
  const abort=new AbortController();t.after(async()=>{abort.abort();await Promise.allSettled(tasks);await drainNodeBackgroundWork();db.sqlite.close();});
  const response=await app.fetch(new Request('https://example.invalid/v1/images/generations',{method:'POST',signal:abort.signal,
    headers:{Authorization:'Bearer '+key,'Content-Type':'application/json','x-c02-sse-snapshot':`c02-snapshot:${runId}:${p.probeId}:${p.mode}`},
    body:JSON.stringify({model:fixture.cases['small-generations'].model,prompt:imageSsePrompt(u),stream:true})}),
    {DB:db.binding,DATABASE_DRIVER:'d1',SHARED_KEY_ENCRYPTION_SECRET:'synthetic-material-not-for-real-secrets',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false'},ctx);
  const wire=await response.text();for(let i=0;i<tasks.length;i++)await tasks[i].catch(()=>{});await drainNodeBackgroundWork();
  const id=response.headers.get('X-Generation-Id'),journal={runId,keyHash,expiresAt,requests:[{id,mode:p.mode,probeId:p.probeId,upstreamProbeId:u.probeId,startedAt:new Date().toISOString()}],probes:[u]};
  const observed=['request_dispatch_intents','request_usage_settlements','request_usage_recovery_jobs','request_usage_commit_receipts','api_key_request_logs','user_budget_reservations'].map(t=>db.sqlite.prepare('SELECT * FROM '+t).all().map(r=>({...r})));
  await db.binding.prepare(fixture.revoke.sql).bind(...fixture.revoke.params).run();
  const input={journal,observed,snapshotRows:db.sqlite.prepare('SELECT key,value,description FROM system_config WHERE key=?').all(sr.key).map(r=>({...r})),
    upstreamRows:db.sqlite.prepare('SELECT key,value,description FROM system_config WHERE key=?').all(ur.key).map(r=>({...r})),
    users:db.sqlite.prepare('SELECT id,metadata,budget_spent_micros,budget_reserved_micros FROM users WHERE id=?').all(fixture.ids.user).map(r=>({...r})),
    keys:db.sqlite.prepare('SELECT id,user_id,workspace_id,key_hash,status FROM api_keys WHERE id=?').all(fixture.ids.key).map(r=>({...r}))};
  const backgroundErrors=(await Promise.allSettled(tasks)).filter(r=>r.status==='rejected').map(r=>String(r.reason?.message));
  return {db,counts,baseline,response,wire,messages,backgroundErrors,input,sends};
}
test('Real gateway/SQLite reproduces reordered armed-row 503 and safely removes unknown synthetic fixture',async t=>{
  const f=await setup(t,false);assert.equal(f.response.status,503);assert.match(f.wire,/gateway.image_settlement_unconfirmed/);assert.equal(f.sends,1);
  assert.equal(JSON.parse(f.input.upstreamRows[0].value).phase,'armed');assert.deepEqual(f.input.observed.map(r=>r.length),[1,0,0,0,0,1]);
  assert.match(JSON.stringify(f.backgroundErrors),/SSE probe not armed or ownership\/state changed/);
  const statements=await failedSseOperatorCleanupStatements(f.input);await f.db.binding.batch(statements.map(s=>f.db.binding.prepare(s.sql).bind(...s.params)));
  assert.deepEqual(f.counts(),f.baseline);
});
test('Canonical operator row reaches SSE completed/error/DONE and actual terminal probe',async t=>{
  const f=await setup(t,true);assert.equal(f.response.status,200);assert.match(f.wire,/image_generation.completed/);assert.match(f.wire,/gateway.image_settlement_unconfirmed/);
  assert.equal((f.wire.match(/data: \[DONE\]/g)||[]).length,1);assert.equal(JSON.parse(f.input.upstreamRows[0].value).phase,'terminal');
  await assert.rejects(failedSseOperatorCleanupStatements(f.input));
});
for(const change of ['changed-upstream','changed-budget','changed-probe','new-intent'])test('Failed-probe cleanup transaction refuses '+change,async t=>{
  const f=await setup(t,false),statements=await failedSseOperatorCleanupStatements(f.input),before=f.counts();
  if(change==='changed-upstream')f.db.sqlite.prepare('UPDATE system_config SET value=? WHERE key=?').run('{}',f.input.upstreamRows[0].key);
  if(change==='changed-budget')f.db.sqlite.prepare('UPDATE users SET budget_reserved_micros=100001 WHERE id=?').run(f.input.users[0].id);
  if(change==='changed-probe')f.db.sqlite.prepare('UPDATE system_config SET value=? WHERE key=?').run('{}',f.input.snapshotRows[0].key);
  if(change==='new-intent'){const row={...f.input.observed[0][0],request_id:'gen-'+randomUUID(),dispatch_claim_id:randomUUID()};const cols=Object.keys(row);f.db.sqlite.prepare(`INSERT INTO request_dispatch_intents(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).run(...Object.values(row));}
  await assert.rejects(f.db.binding.batch(statements.map(s=>f.db.binding.prepare(s.sql).bind(...s.params))));
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM users').get().n,1);assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM user_budget_reservations').get().n,1);
  if(change!=='new-intent')assert.deepEqual(f.counts(),before);
});
