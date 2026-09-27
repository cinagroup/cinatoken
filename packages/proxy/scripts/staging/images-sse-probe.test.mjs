import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createSqliteD1 } from '../../src/test-support/sqlite-d1.ts';
import { IMAGE_SSE_MODES, IMAGE_SSE_PATH, imageSsePrompt, imageSseRow, parseImageSseProbe } from './images-sse-probe-contract.ts';
import { imageSseProbeResponse, imageSseFrames, IMAGE_SSE_HOLD_MS } from './images-sse-probe.ts';
import upstream from './images-sse-upstream.ts';
import { UPSTREAM_ORIGIN, SYNTHETIC_PROVIDER_MARKER } from './images-upstream.ts';
import { privateImageSseTransport } from './images-sse-gateway-handler.ts';

function setup(t, mode='success', hooks={}) {
  const db=createSqliteD1(hooks), probe={runId:'c02-success-'+randomUUID(),probeId:randomUUID(),mode};
  const row=imageSseRow(probe), pending=[], abort=new AbortController();
  db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(row.key,row.value,row.description);
  const context={waitUntil(p){pending.push(p);p.catch(()=>undefined);}};
  const read=()=>JSON.parse(db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(row.key).value);
  const options={probe,request:new Request(UPSTREAM_ORIGIN,{signal:abort.signal}),db:db.binding,context,receipt:'synthetic'};
  t.after(async()=>{abort.abort();await Promise.allSettled(pending);db.sqlite.close();});
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('External fetch forbidden');});
  return {db,probe,row,pending,abort,context,read,options};
}
function request(s,patch={},headers={}) {
  const body=JSON.stringify({model:'private-model',prompt:imageSsePrompt(s.probe),stream:true,...patch});
  return new Request(UPSTREAM_ORIGIN+IMAGE_SSE_PATH,{method:'POST',body,signal:s.abort.signal,
    headers:{Authorization:'Bearer '+SYNTHETIC_PROVIDER_MARKER,'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(body)),...headers}});
}
const invoke=(s,r=request(s))=>upstream.fetch(r,{PROBE_DB:s.db.binding},s.context);

test('SSE probe identities and modes are bounded; no arbitrary duration or failure payload',()=>{
  for(const mode of IMAGE_SSE_MODES){const p={runId:'c02-success-'+randomUUID(),probeId:randomUUID(),mode};assert.deepEqual(parseImageSseProbe(imageSsePrompt(p)),p);}
  for(const input of [null,{},'x'.repeat(10000),'c02-sse:fake:fake:hold:9999'])assert.equal(parseImageSseProbe(input),null);
  assert.equal(IMAGE_SSE_HOLD_MS,315000);
});
for(const mode of IMAGE_SSE_MODES.filter(m=>m!=='hold'))test('private SSE fixture produces bounded exact frames: '+mode,async t=>{
  const s=setup(t,mode), response=await invoke(s);
  assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'text/event-stream');
  assert.match(response.headers.get('X-Request-ID'),/^c02-sse-[a-f0-9-]{36}-[a-f0-9]{64}$/);
  const wire=await response.text();assert.equal(wire,imageSseFrames(mode).join(''));assert.ok(Buffer.byteLength(wire)<67000);
  await Promise.all(s.pending);assert.deepEqual(s.read().events.map(e=>e.phase),['started','body-prefix','terminal']);
  assert.equal(s.read().events.at(-1).reason,'eof');
  await assert.rejects(invoke(s),/not armed/);
});
for(const change of ['unarmed','owner','value'])test('probe CAS refuses '+change,async t=>{
  const s=setup(t);
  if(change==='unarmed')s.db.sqlite.prepare('DELETE FROM system_config WHERE key=?').run(s.row.key);
  else s.db.sqlite.prepare(`UPDATE system_config SET ${change==='owner'?'description':'value'}=? WHERE key=?`).run('unrelated-owner',s.row.key);
  const before=s.db.sqlite.prepare('SELECT * FROM system_config').all();
  await assert.rejects(invoke(s),/not armed/);assert.deepEqual(s.db.sqlite.prepare('SELECT * FROM system_config').all(),before);
});
for(const how of ['cancel','abort','expired','cancel-before-read','abort-before-read'])test('held SSE terminates exactly once: '+how,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const s=setup(t,'hold'), response=await invoke(s),reader=response.body.getReader();
  const before=how.endsWith('before-read');
  if(!before)assert.match(new TextDecoder().decode((await reader.read()).value),/partial_image/);
  if(how.startsWith('cancel'))await reader.cancel();
  else {
    const waiting=reader.read();
    if(how==='expired')t.mock.timers.tick(315000);else s.abort.abort();
    await assert.rejects(waiting,{name:'AbortError'});
  }
  await Promise.all(s.pending);
  assert.equal(s.read().phase,'terminal');assert.equal(s.read().events.filter(e=>e.phase==='terminal').length,1);
  assert.equal(s.read().events.at(-1).reason,how.startsWith('cancel')?'response_cancel':how==='expired'?'expired':'request_abort');
  assert.ok(s.read().events.length<=3);
});
test('lost ownership after prefix never overwrites replacement; observer failure is owned',async t=>{
  const s=setup(t,'hold'),response=await invoke(s),reader=response.body.getReader();await reader.read();
  s.db.sqlite.prepare('UPDATE system_config SET value=? WHERE key=?').run('replacement',s.row.key);
  await assert.rejects(reader.cancel(),/ownership/);
  assert.equal(s.db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(s.row.key).value,'replacement');
  assert.ok((await Promise.allSettled(s.pending)).some(r=>r.status==='rejected'));
});
test('cancel racing prefix acknowledgement never enqueues after cancel',async t=>{
  let release,observed;const entered=new Promise(r=>{observed=r;});
  const s=setup(t,'hold',{afterStatement:async(sql,values)=>{
    if(sql.startsWith('UPDATE system_config')&&JSON.parse(values[0]).phase==='body-prefix'){
      observed();await new Promise(r=>{release=r;});
    }
  }});
  const response=await invoke(s),reader=response.body.getReader(),reading=reader.read();await entered;
  const cancelling=reader.cancel();release();await cancelling;assert.equal((await reading).done,true);
  await Promise.all(s.pending);assert.equal(s.read().events.at(-1).reason,'response_cancel');
});
for(const [name,patch,headers,status] of [
  ['missing stream',{stream:undefined},{},422],['false stream',{stream:false},{},422],
  ['bad prompt',{prompt:'not-armed'},{},422],['oversize',{padding:'x'.repeat(5000)},{},413],
  ['wrong marker',{}, {Authorization:'Bearer wrong'},422],['bad MIME',{}, {'Content-Type':'text/plain'},422],
  ['wrong length',{}, {'Content-Length':'1'},422],['no length',{}, {'Content-Length':''},422],
])test('SSE request validation: '+name,async t=>{
  const s=setup(t);assert.equal((await invoke(s,request(s,patch,headers))).status,status);
  assert.equal(s.read().phase,'armed');assert.equal(s.pending.length,0);
});
test('dishonest short Content-Length cannot bypass actual 4 KiB read bound',async t=>{
  const s=setup(t);assert.equal((await invoke(s,request(s,{padding:'x'.repeat(5000)},{'Content-Length':'100'}))).status,413);
  assert.equal(s.read().phase,'armed');
});
test('fixed request read deadline cancels stalled upload without D1 mutation',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const s=setup(t);let cancelled=0;
  const original=request(s), r=new Request(original.url,{method:'POST',headers:original.headers,
    body:new ReadableStream({cancel(){cancelled++;}}),duplex:'half'});
  const result=invoke(s,r);t.mock.timers.tick(10000);assert.equal((await result).status,408);
  assert.equal(cancelled,1);assert.equal(s.read().phase,'armed');
});
for(const suffix of ['?fault=anything','#fragment','/../edits'])test('SSE destination guard rejects '+suffix,async t=>{
  const s=setup(t);let calls=0;const transport=privateImageSseTransport(async()=>{calls++;return new Response();});
  assert.throws(()=>transport(UPSTREAM_ORIGIN+IMAGE_SSE_PATH+suffix,{method:'POST',redirect:'manual'}),/destination/);assert.equal(calls,0);
});
test('transport admits exact SSE and legacy paths only with POST/manual',async()=>{
  let calls=0;const transport=privateImageSseTransport(async()=>{calls++;return new Response();});
  for(const path of [IMAGE_SSE_PATH,'/cases/small/v1/images/generations','/cases/small/v1/images/edits'])await transport(UPSTREAM_ORIGIN+path,{method:'POST',redirect:'manual'});
  for(const [url,init] of [['https://example.com'+IMAGE_SSE_PATH,{method:'POST',redirect:'manual'}],[UPSTREAM_ORIGIN+IMAGE_SSE_PATH,{method:'GET',redirect:'manual'}],[UPSTREAM_ORIGIN+IMAGE_SSE_PATH,{method:'POST',redirect:'follow'}]])assert.throws(()=>transport(url,init),/destination/);
  assert.equal(calls,3);
});
