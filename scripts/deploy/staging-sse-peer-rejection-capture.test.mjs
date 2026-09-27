import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {createSseOperatorClock} from './staging-sse-operator-clock.mjs';
import {createSsePeerRejectionCapture,PEER_REJECTION_LIMITS as limits} from './staging-sse-peer-rejection-capture.mjs';
import {SSE_STAGING_SCOPE as gateway} from './staging-sse-reconciliation.mjs';
const target='https://'+gateway.domain+'/v1/images/generations';
const canonical=reason=>JSON.stringify({status:'rejected',reason,dispatch_started:false});
const sha=v=>createHash('sha256').update(v).digest('hex');
function setup(response,{persist,clock=createSseOperatorClock()}={}){
  const events=[],calls=[];
  const capture=createSsePeerRejectionCapture({clock,persist:persist??(async e=>{events.push(e);}),fetchImpl:async(...args)=>{calls.push(args);return response;}});
  return {capture,events,calls,send:(signal)=>capture.fetch(target,{method:'POST',signal})};
}
for(const [reason,status] of [['peer_not_active_here',409],['request_aborted',409],['identity_unavailable',503],['invalid_peer',400],['profile_unavailable',404]])
test('canonical bounded gateway declaration: '+reason,async()=>{
  const wire=canonical(reason),response=new Response(wire,{status,headers:{'Content-Type':'application/json','Set-Cookie':'local-secret','X-Debug':'local-secret'}});
  const x=setup(response);assert.equal(await x.send(),response);
  const r=x.capture.report();assert.equal(r.inferenceAttempts,1);assert.equal(r.journalFailed,false);
  assert.deepEqual(r.rejection.gatewayDeclaration,{reason,dispatch_started:false});assert.equal(r.rejection.bodySha256,sha(wire));
  assert.equal(r.rejection.naturalEof,true);assert.equal(r.rejection.digestScope,'complete');assert.equal(r.rejection.retryAllowed,false);
  assert.equal(x.events[0].state,'HEADERS');assert.equal(x.events[1].state,'EOF');
  assert.doesNotMatch(JSON.stringify(r),/local-secret/);await assert.rejects(x.send());assert.equal(x.calls.length,1);
});
for(const [name,wire,status,headers] of [
  ['extra property',canonical('peer_not_active_here').replace('}',',"secret":"local-secret"}'),409,{}],
  ['duplicate key','{"status":"success","status":"rejected","reason":"peer_not_active_here","dispatch_started":false}',409,{}],
  ['unknown reason',canonical('local-secret'),409,{}],
  ['wrong HTTP status',canonical('peer_not_active_here'),500,{}],
  ['dispatch started','{"status":"rejected","reason":"peer_not_active_here","dispatch_started":true}',409,{}],
  ['trailing text',canonical('peer_not_active_here')+'local-secret',409,{}],
  ['invalid UTF8',Buffer.concat([Buffer.from(canonical('peer_not_active_here')),Buffer.from([0xff])]),409,{}],
  ['BOM','\ufeff'+canonical('peer_not_active_here'),409,{}],
  ['HTML media type',canonical('peer_not_active_here'),409,{'Content-Type':'text/html'}],
  ['generation header',canonical('peer_not_active_here'),409,{'X-Generation-Id':'local-secret'}],
])test('untrusted body stays digest-only: '+name,async()=>{
  const x=setup(new Response(wire,{status,headers:{'Content-Type':'application/json',...headers}}));await x.send();
  const r=x.capture.report().rejection;assert.equal(r.gatewayDeclaration,null);assert.equal(r.naturalEof,true);assert.equal(r.bodySha256,sha(wire));
  assert.doesNotMatch(JSON.stringify(x.capture.report()),/local-secret/);
});
test('success response remains the original unread stream',async()=>{
  const response=new Response('data: local-secret\n\n',{status:200});const x=setup(response);
  assert.equal(await x.send(),response);assert.equal(response.bodyUsed,false);assert.equal(x.events.length,0);
  assert.equal(x.capture.report().rejection,null);assert.equal(await response.text(),'data: local-secret\n\n');
});
test('non-inference calls pass through without evidence or an inference reservation',async()=>{
  const r=new Response('local-secret',{status:403}),x=setup(r);
  assert.equal(await x.capture.fetch(target,{method:'GET'}),r);assert.equal(r.bodyUsed,false);
  assert.equal(x.capture.report().inferenceAttempts,0);assert.equal(x.events.length,0);
});
test('split chunks yield a digest of exactly the original UTF8 bytes',async()=>{
  const wire=Buffer.from(canonical('request_aborted'));let offset=0;
  const x=setup(new Response(new ReadableStream({pull(c){if(offset===wire.length)c.close();else c.enqueue(wire.subarray(offset,++offset));}}),{status:409,headers:{'Content-Type':'application/json'}}));
  await x.send();assert.equal(x.capture.report().rejection.bodySha256,sha(wire));assert.equal(x.capture.report().rejection.gatewayDeclaration.reason,'request_aborted');
});
for(const size of [limits.bytes,limits.bytes+1,1024*1024])test('byte cap and exact-size EOF: '+size,async()=>{
  let cancelled=0;const body=new ReadableStream({start(c){c.enqueue(Buffer.alloc(size,65));if(size===limits.bytes)c.close();},cancel(){cancelled++;}});
  const x=setup(new Response(body,{status:500}));await x.send();const r=x.capture.report().rejection;
  assert.equal(r.bytesCaptured,limits.bytes);assert.equal(r.bodySha256,sha(Buffer.alloc(limits.bytes,65)));
  assert.equal(r.naturalEof,size===limits.bytes);assert.equal(r.digestScope,size===limits.bytes?'complete':'prefix');assert.equal(cancelled,size===limits.bytes?0:1);
});
test('empty-chunk flood is bounded by read calls',async()=>{
  let cancelled=0;const x=setup(new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array());},cancel(){cancelled++;}}),{status:409}));
  await x.send();const r=x.capture.report().rejection;assert.equal(r.readCalls,128);assert.equal(r.state,'READ_LIMIT');assert.equal(r.naturalEof,false);assert.equal(cancelled,1);
});
test('abort cancels the owner without synthesizing EOF',async()=>{
  const ac=new AbortController();let cancelled=0;
  const x=setup(new Response(new ReadableStream({pull(){ac.abort();return new Promise(()=>{});},cancel(){cancelled++;}},{highWaterMark:0}),{status:409}));
  await x.send(ac.signal);const r=x.capture.report().rejection;assert.equal(r.state,'ABORTED');assert.equal(r.naturalEof,false);assert.equal(cancelled,1);
});
test('noncooperative pending read/cancel cannot retain the operator past its deadline',async()=>{
  let cancelled=0;const x=setup(new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled++;return new Promise(()=>{});}}),{status:409}));
  const start=performance.now();await x.send();assert.ok(performance.now()-start<5000);const r=x.capture.report().rejection;
  assert.equal(r.naturalEof,false);assert.equal(r.gatewayDeclaration,null);assert.equal(r.state,'READ_TIMEOUT');assert.equal(cancelled,1);
});
test('late completion cannot alter an already returned evidence snapshot',async()=>{
  const ac=new AbortController();let controller;
  const x=setup(new Response(new ReadableStream({start(c){controller=c;}}),{status:409}));
  const p=x.send(ac.signal);setTimeout(()=>ac.abort(),20);await p;const r=x.capture.report();
  try{controller.close();}catch{}await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(x.capture.report(),r);
});
test('header journal failure does not read body or lose response status',async()=>{
  let cancelled=0;const response=new Response(new ReadableStream({cancel(){cancelled++;}}),{status:409});
  const x=setup(response,{persist:async()=>{throw Error('local-secret');}});assert.equal(await x.send(),response);
  assert.equal(x.capture.report().journalFailed,true);assert.equal(x.capture.report().rejection.state,'JOURNAL_FAILED');assert.equal(x.capture.report().rejection.readCalls,0);assert.equal(cancelled,1);
});
test('noncooperative journal has an independent bounded failure',async()=>{
  const x=setup(new Response('never saved',{status:409}),{persist:()=>new Promise(()=>{})});
  const start=performance.now();await x.send();assert.ok(performance.now()-start<5000);assert.equal(x.capture.report().journalFailed,true);
});
test('transport failure remains one attempt without an invented response',async()=>{
  const x=createSsePeerRejectionCapture({clock:createSseOperatorClock(),persist:async()=>{},fetchImpl:async()=>{throw Error('local-secret');}});
  await assert.rejects(x.fetch(target,{method:'POST'}));assert.deepEqual(x.report(),{inferenceAttempts:1,journalFailed:false,rejection:null});
});
test('a valid declaration prefix without EOF is never accepted',async()=>{
  const ac=new AbortController(),wire=canonical('peer_not_active_here');let calls=0;
  const x=setup(new Response(new ReadableStream({pull(c){if(!calls++)c.enqueue(Buffer.from(wire));else ac.abort();}},{highWaterMark:0}),{status:409,headers:{'Content-Type':'application/json'}}));
  await x.send(ac.signal);const r=x.capture.report().rejection;assert.equal(r.bodySha256,sha(wire));
  assert.equal(r.digestScope,'prefix');assert.equal(r.gatewayDeclaration,null);assert.equal(r.naturalEof,false);
});
test('read failure is distinct from deadline and never logs thrown error text',async()=>{
  const x=setup(new Response(new ReadableStream({pull(c){c.error(Error('local-secret'));}}),{status:500}));
  await x.send();assert.equal(x.capture.report().rejection.state,'READ_FAILED');assert.doesNotMatch(JSON.stringify(x.capture.report()),/local-secret/);
});
test('null body is not observed EOF',async()=>{
  const x=setup(new Response(null,{status:409}));await x.send();const r=x.capture.report().rejection;
  assert.equal(r.state,'NO_BODY');assert.equal(r.naturalEof,false);assert.equal(r.bodySha256,null);
});
test('final journal failure retains observed EOF but remains a durability failure',async()=>{
  let saves=0;const x=setup(new Response(canonical('request_aborted'),{status:409,headers:{'Content-Type':'application/json'}}),{persist:async()=>{if(++saves===2)throw Error('local-secret');}});
  await x.send();const r=x.capture.report();assert.equal(r.journalFailed,true);assert.equal(r.rejection.naturalEof,true);assert.equal(saves,2);
});
test('late headers after request abort are cancelled without starting capture',async()=>{
  let resolve,cancelled=0;const events=[],ac=new AbortController();
  const x=createSsePeerRejectionCapture({clock:createSseOperatorClock(),persist:async e=>{events.push(e);},fetchImpl:()=>new Promise(r=>{resolve=r;})});
  const p=x.fetch(target,{method:'POST',signal:ac.signal});ac.abort();
  resolve(new Response(new ReadableStream({cancel(){cancelled++;}}),{status:409}));await p;
  assert.equal(cancelled,1);assert.equal(events.length,0);assert.equal(x.report().rejection,null);
});
test('late headers after seal cannot change final evidence or append a journal',async()=>{
  let resolve,cancelled=0;const events=[];
  const x=createSsePeerRejectionCapture({clock:createSseOperatorClock(),persist:async e=>{events.push(e);},fetchImpl:()=>new Promise(r=>{resolve=r;})});
  const p=x.fetch(target,{method:'POST'}),before=x.seal();
  resolve(new Response(new ReadableStream({cancel(){cancelled++;}}),{status:409}));await p;
  assert.equal(cancelled,1);assert.equal(events.length,0);assert.deepEqual(x.report(),before);assert.deepEqual(x.seal(),before);
  await assert.rejects(x.fetch(target,{method:'POST'}));
});
test('seal during a pending read owns cancellation and freezes partial evidence',async()=>{
  let entered;const ready=new Promise(r=>{entered=r;});let cancelled=0;const events=[];
  const response=new Response(new ReadableStream({pull(){entered();return new Promise(()=>{});},cancel(){cancelled++;}},{highWaterMark:0}),{status:409});
  const x=setup(response,{persist:async e=>{events.push(e);}});const p=x.send();await ready;const before=x.capture.seal();await p;
  assert.equal(cancelled,1);assert.equal(before.rejection.naturalEof,false);assert.deepEqual(x.capture.report(),before);assert.equal(events.length,1);
});
test('seal during journal persistence reports unresolved durability and starts no new save',async()=>{
  let entered,resolve;const ready=new Promise(r=>{entered=r;});let saves=0;
  const x=setup(new Response('uncommitted',{status:409}),{persist:()=>{saves++;entered();return new Promise(r=>{resolve=r;});}});
  const p=x.send();await ready;const before=x.capture.seal();resolve();await p;
  assert.equal(before.journalFailed,true);assert.equal(saves,1);assert.deepEqual(x.capture.report(),before);
});
test('real local HTTP response is captured exactly once without external network',async t=>{
  let requests=0;const wire=canonical('peer_not_active_here');
  const server=createServer((req,res)=>{requests++;req.resume();res.writeHead(409,{'Content-Type':'application/json'});res.write(wire.slice(0,20));setImmediate(()=>res.end(wire.slice(20)));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const x=createSsePeerRejectionCapture({clock:createSseOperatorClock(),persist:async()=>{},fetchImpl:(_,init)=>fetch('http://127.0.0.1:'+server.address().port,init)});
  const r=await x.fetch(target,{method:'POST',body:'synthetic'});assert.equal(r.status,409);assert.equal(requests,1);
  assert.equal(x.report().rejection.bodySha256,sha(wire));assert.equal(x.report().rejection.gatewayDeclaration.reason,'peer_not_active_here');
});
