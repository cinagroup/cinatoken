import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {createSqliteD1} from '../../src/test-support/sqlite-d1.ts';
import {sseSnapshotFaultRow} from './images-sse-snapshot-fault-v2.ts';
import {observeSseClientAbort,sseCancelObservationRow,SSE_CANCEL_OBSERVER_MS} from './images-sse-cancel-observer.ts';
import {createImagesSseCancelStagingGateway,SSE_CANCEL_HEADER} from './images-sse-cancel-gateway-handler.ts';
import {SSE_SNAPSHOT_HEADER} from './images-sse-snapshot-gateway-handler-v2.ts';

const probe=()=>({runId:'c02-success-'+randomUUID(),probeId:randomUUID(),mode:'before-hold'});
function setup(t){
  const db=createSqliteD1(),p=probe(),row=sseCancelObservationRow(p),snapshot=sseSnapshotFaultRow(p),tasks=[],abort=new AbortController();
  t.after(()=>db.sqlite.close());
  const request=new Request('https://example.invalid/v1/images/generations',{signal:abort.signal});
  const response=new Response('untouched',{headers:{'Content-Type':'text/event-stream','X-Generation-Id':'gen-'+randomUUID()}});
  for(const r of [row,snapshot])db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(r.key,r.value,r.description);
  const context={waitUntil(p){assert.equal(this,context);tasks.push(p);p.catch(()=>{});}};
  const read=()=>db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(row.key)?.value;
  return {db,p,row,snapshot,tasks,abort,request,response,context,read};
}
test('observer uses real signal, records once, never consumes response or abort reason',async t=>{
  const f=setup(t);let writes=0;f.db.hooks.beforeStatement=sql=>{if(sql.startsWith('UPDATE'))writes++;};
  observeSseClientAbort(f.request,f.response,f.db.binding,f.context,f.p);assert.equal(f.tasks.length,1);
  f.abort.abort('PRIVATE_REASON');await Promise.all(f.tasks);f.abort.abort();
  const v=JSON.parse(f.read());assert.equal(v.signalAborted,true);assert.equal(v.phase,'request-aborted');
  assert.equal(v.snapshotValue,f.snapshot.value);assert.equal(writes,1);assert.doesNotMatch(f.read(),/PRIVATE_REASON/);
  assert.equal(f.response.bodyUsed,false);assert.equal(await f.response.text(),'untouched');
});
test('observer deadline removes listener without fabricating cancellation',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=setup(t);
  observeSseClientAbort(f.request,f.response,f.db.binding,f.context,f.p);
  t.mock.timers.tick(SSE_CANCEL_OBSERVER_MS);await Promise.all(f.tasks);f.abort.abort();
  assert.equal(f.read(),f.row.value);
});
test('already-aborted native signal is observed after synchronous waitUntil registration',async t=>{
  const f=setup(t);f.abort.abort();observeSseClientAbort(f.request,f.response,f.db.binding,f.context,f.p);
  await Promise.all(f.tasks);assert.equal(JSON.parse(f.read()).phase,'request-aborted');
});
for(const fault of ['missing-row','foreign-owner','oversized-snapshot','failed-write'])
test('observer failure preserves evidence and surfaces rejection: '+fault,async t=>{
  const f=setup(t);
  if(fault==='missing-row')f.db.sqlite.prepare('DELETE FROM system_config WHERE key=?').run(f.row.key);
  if(fault==='foreign-owner')f.db.sqlite.prepare('UPDATE system_config SET description=? WHERE key=?').run('foreign',f.row.key);
  if(fault==='oversized-snapshot')f.db.sqlite.prepare('UPDATE system_config SET value=? WHERE key=?').run('x'.repeat(2049),f.snapshot.key);
  if(fault==='failed-write')f.db.hooks.beforeStatement=sql=>{if(sql.startsWith('UPDATE'))throw Error('synthetic_failure');};
  const before=f.read();observeSseClientAbort(f.request,f.response,f.db.binding,f.context,f.p);f.abort.abort();
  await assert.rejects(f.tasks[0]);assert.equal(f.read(),before);
});
for(const invalid of ['status','content-type','request-id'])
test('non-SSE/non-success response never attaches observer: '+invalid,async t=>{
  const f=setup(t),r=new Response('{}',{status:invalid==='status'?401:200,headers:{
    'Content-Type':invalid==='content-type'?'application/json':'text/event-stream',
    'X-Generation-Id':invalid==='request-id'?'spoofed':'gen-'+randomUUID()}});
  observeSseClientAbort(f.request,r,f.db.binding,f.context,f.p);f.abort.abort();
  assert.equal(f.tasks.length,0);assert.equal(f.read(),f.row.value);
});
for(const invalid of ['value','mode','path','method','content-type','driver'])
test('cancellation header is bounded and cannot bypass gateway validation: '+invalid,async()=>{
  const p=probe(),app=createImagesSseCancelStagingGateway(async()=>{assert.fail('No dispatch');});
  const db={prepare(){assert.fail('No DB access');}},headers={
    [SSE_CANCEL_HEADER]:invalid==='value'?'unknown':'v1',
    [SSE_SNAPSHOT_HEADER]:`c02-snapshot:${p.runId}:${p.probeId}:${invalid==='mode'?'before-fail':p.mode}`,
    'Content-Type':invalid==='content-type'?'text/plain':'application/json'};
  const r=await app.fetch(new Request('https://example.invalid'+(invalid==='path'?'/elsewhere':'/v1/images/generations'),
    {method:invalid==='method'?'GET':'POST',headers}),{DB:db,DATABASE_DRIVER:invalid==='driver'?'postgres':'d1'}, {});
  assert.equal(r.status,400);
});
