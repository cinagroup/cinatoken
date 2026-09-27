import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createSseHostExpirySession} from './staging-sse-host-expiry-session.mjs';
import {createSseOperatorClock,assertSseOperatorTiming} from './staging-sse-operator-clock.mjs';
import {SSE_STAGING_SCOPE as g} from './staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as c} from './staging-sse-recovery-access.mjs';
import {SSE_HOST_EXPIRY_WARNING} from './staging-sse-host-expiry-evidence-v2.mjs';
function fixture(real=false){
  const runId='c02-success-'+randomUUID(),baseline={previousPublicHttp:356,firstRoundUsdCap:2};
  const input={scope:{account:g.account,database:g.database,gateway:g.worker,controller:c.worker},version:randomUUID(),runId,
    keyHash:'sha256:'+'a'.repeat(64),expiresAt:'2026-09-08T12:00:00.000Z',tokenName:'cinatoken-sse-v203-'+randomUUID(),
    plans:['before-hold','after-hold'].map(mode=>({mode,snapshot:{runId,mode,probeId:randomUUID()},upstream:{runId,mode:'success',probeId:randomUUID()}})),
    budget:{...baseline,capReset:false,maxPublicHttp:32,maxRpc:2}};
  let ns=0n,wall='2026-09-08T00:00:00.000Z';const clock=real?createSseOperatorClock():createSseOperatorClock({readNs:()=>ns,wallNow:()=>wall});
  const session=createSseHostExpirySession({input,baseline,clock});
  const advance=(ms,at)=>{ns=BigInt(ms)*1000000n;if(at)wall=at;};
  const response=()=>new Response(null,{status:200,headers:{'Content-Type':'text/event-stream','X-Generation-Id':'gen-'+randomUUID()}});
  const raw=(p=session.plan.plans[0])=>Buffer.from(JSON.stringify({scriptName:g.worker,scriptVersion:{id:input.version},outcome:'canceled',eventTimestamp:1000,
    event:{request:{url:'https://'+g.domain+'/v1/images/generations',method:'POST',headers:{'x-c02-sse-host-expiry':'v1','x-c02-sse-cancel-observe':'v1',
      'x-c02-sse-snapshot':`c02-snapshot:${runId}:${p.snapshot.probeId}:${p.mode}`,Authorization:'NEVER_PERSIST'}}},
    logs:[{level:'warn',message:[SSE_HOST_EXPIRY_WARNING],timestamp:32000}],exceptions:[]}));
  return {session,advance,response,raw,input,baseline};
}
test('No first write before fresh preflight; late preflight expires',()=>{
  const f=fixture();assert.throws(()=>f.session.assertWriteReady());f.session.preflightComplete();f.advance(60002);assert.throws(()=>f.session.assertWriteReady());
});
test('Preflight cannot be silently replaced after writes begin',()=>{
  const f=fixture();f.session.preflightComplete();f.session.assertWriteReady();assert.throws(()=>f.session.preflightComplete());
});
test('Validated plan deep freeze prevents external mutation',()=>{
  const f=fixture();f.input.tokenName='bad';assert.notEqual(f.session.plan.tokenName,'bad');assert.throws(()=>f.session.plan.plans.pop());
});
test('Caller cannot substitute a plan or repeat an uncertain inference',()=>{
  const f=fixture();f.session.preflightComplete();const p=f.session.plan.plans[0];
  assert.throws(()=>f.session.beginRequest(structuredClone(p)));f.session.beginRequest(p);assert.throws(()=>f.session.beginRequest(p));
});
test('Actual callback samples survive UTC rollback; duplicate callback is rejected',()=>{
  const f=fixture(),s=f.session;s.preflightComplete();const e=s.beginRequest(s.plan.plans[0]);
  f.advance(1000,'2025-01-01T00:00:00.000Z');s.markHeaders(e,f.response());assert.throws(()=>s.markHeaders(e,f.response()));
  f.advance(2000,'2024-01-01T00:00:00.000Z');let aborted=0;s.cancelRequest(e,()=>aborted++);
  assert.equal(aborted,1);assert.throws(()=>s.cancelRequest(e,()=>aborted++));
  f.advance(2100);const finished=s.finishRequest(e);f.advance(2200);assert.equal(s.finishRequest(e),finished);
  f.advance(33000,'2023-01-01T00:00:00.000Z');s.receive(f.raw());
  const p=s.platform();assert.equal(assertSseOperatorTiming(e.timing,p.receipts[0].sample).clientClockOrderingVerified,true);
  assert.equal(p.events[0].responseStatus,null);assert.equal(p.events[0].receivedAt,p.receipts[0].sample.wallAt);
  assert.doesNotMatch(JSON.stringify(p),/NEVER_PERSIST|Authorization/);
});
for(const mutation of ['duplicate','invalid-json','wrong-version','oversize'])test('Collector '+mutation+' fails without fabricating receipts',()=>{
  const f=fixture();if(mutation==='duplicate')f.session.receive(f.raw());
  let data=f.raw();if(mutation==='invalid-json')data=Buffer.from('no');if(mutation==='oversize')data=Buffer.alloc(131073);
  if(mutation==='wrong-version'){const r=JSON.parse(data);r.scriptVersion.id=randomUUID();data=Buffer.from(JSON.stringify(r));}
  const state=f.session.receive(data);assert.ok(state.firstFailure);assert.equal(state.receipts.length,mutation==='duplicate'?1:0);
  assert.throws(()=>f.session.platform());const first=state.firstFailure;f.session.transportClose();assert.deepEqual(f.session.capture().firstFailure,first);
});
test('Late second message cannot overwrite earlier receipt',()=>{
  const f=fixture();f.advance(31000);f.session.receive(f.raw());f.advance(62000);f.session.receive(f.raw(f.session.plan.plans[1]));
  const p=f.session.platform();assert.deepEqual(p.receipts.map(r=>r.sample.monoMs),[31000,62000]);
  p.receipts[0].sample.monoMs=0;assert.equal(f.session.platform().receipts[0].sample.monoMs,31000);
});
for(const fail of [false,true])test('RPC completion sample captured even on '+(fail?'failure':'success'),async()=>{
  const f=fixture();const work=f.session.rpc(async(signal,start)=>{assert.ok(signal instanceof AbortSignal);assert.equal(start.monoMs,0);f.advance(1234);if(fail)throw Error('uncertain ACK');return 7;});
  if(fail)await assert.rejects(work);else assert.equal(await work,7);assert.equal(f.session.lastRpcFinished.monoMs,1234);
});
test('Real Node HTTP body abort captures headers/cancel/finish once with original AbortSignal',{timeout:10000},async t=>{
  const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream','X-Generation-Id':'gen-'+randomUUID()});res.write('data: {"type":"image_generation.completed","b64_json":"AQID"}\n\n');});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const {session:s}=fixture(true);s.preflightComplete();const e=s.beginRequest(s.plan.plans[0]),scope=s.abortScope(5000);
  try{
    const response=await fetch('http://127.0.0.1:'+server.address().port,{signal:scope.signal});s.markHeaders(e,response);
    const reader=response.body.getReader();await reader.read();const pending=reader.read();
    s.cancelRequest(e,scope.abort);await assert.rejects(pending,{name:'AbortError'});await reader.cancel().catch(()=>{});s.finishRequest(e);
    assert.ok(e.timing.started.monoMs<=e.timing.headers.monoMs&&e.timing.headers.monoMs<=e.timing.cancel.monoMs&&e.timing.cancel.monoMs<=e.timing.finished.monoMs);
  }finally{scope.abort();scope.dispose();}
});
for(const fail of [false,true])test('RPC cap counts '+(fail?'uncertain':'successful')+' calls without reset',async()=>{
  const {session:s}=fixture();let calls=0;
  const run=()=>s.rpc(async()=>{calls++;if(fail)throw Error('uncertain');});
  for(let n=0;n<2;n++){if(fail)await assert.rejects(run());else await run();}
  await assert.rejects(run());assert.equal(calls,2);
});
