import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import WebSocket from 'ws';
import {createSseCapacityPeerDiagnosticClient} from './staging-sse-capacity-peer-diagnostic-client.mjs';
import {captureSseCapacityPrimaryV3,PEER_V3_WATCH_URL} from './staging-sse-capacity-peer-protocol-v3.mjs';
import {createSseOperatorClock} from './staging-sse-operator-clock.mjs';
import {classifySsePeerV3MismatchDiagnostic} from './staging-sse-peer-mismatch-diagnostic.mjs';
const canonical='{"status":"rejected","reason":"peer_not_active_here","dispatch_started":false}';
const credentials={'cf-access-client-id':'LOCAL_ID_PRIVATE','cf-access-client-secret':'LOCAL_SECRET_PRIVATE'};
const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t,{same=false,mutate,persist,send}={}){
  const clock=createSseOperatorClock(),instance=randomUUID(),observed=same?instance:randomUUID(),records=[],sockets=new Set(),clients=[];
  let calls=0,reservations=0;
  const response=new Response(new ReadableStream({pull(){assert.fail('Primary must remain unread');}},{highWaterMark:0}),{headers:{
    'content-type':'text/event-stream','cache-control':'no-store','x-generation-id':'gen-'+randomUUID(),
    'x-c02-capacity-primary':'v3','x-c02-capacity-before':'0/0','x-c02-capacity-peer':instance+':1','x-c02-capacity-instance':instance}});
  const primary=captureSseCapacityPrimaryV3(response,clock.sample(),clock.clockId);
  const server=createServer((_r,out)=>{out.writeHead(404);out.end();});
  server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{});});
  server.on('upgrade',(request,socket)=>{
    calls++;assert.equal(reservations,calls);assert.equal(request.headers['x-c02-capacity-peer'],primary.peer);
    const wire={status:409,body:canonical,headers:[['Content-Type','application/json'],['Cache-Control','no-store'],
      ['x-c02-peer-diagnostic','instance-v1'],['x-c02-peer-observed-instance',observed]]};
    mutate?.(wire,calls);if(send){send(socket,wire);return;}
    socket.end('HTTP/1.1 '+wire.status+' Rejected\r\n'+wire.headers.map(([k,v])=>k+': '+v+'\r\n').join('')+
      'Content-Length: '+Buffer.byteLength(wire.body)+'\r\n\r\n'+wire.body);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const client=createSseCapacityPeerDiagnosticClient({clock,reserve:()=>{reservations++;},persist:async row=>{
    records.push(row);await persist?.(row);
  },socketFactory:(url,options)=>{
    assert.equal(url,PEER_V3_WATCH_URL);assert.equal(options.followRedirects,false);assert.equal(options.maxHeaderSize,16384);
    const socket=new WebSocket('ws://127.0.0.1:'+server.address().port,options);clients.push(socket);return socket;
  }});
  t.after(async()=>{client.stop();for(const s of clients)s.terminate();for(const s of sockets)s.destroy();
    await new Promise(resolve=>server.close(resolve));await response.body.cancel();});
  return {client,clock,primary,observed,records,response,get calls(){return calls;},get reservations(){return reservations;},open:()=>client.open(primary,credentials)};
}
for(const same of [false,true])test('original HTTP rejection evidence is bounded, classified and saved before next upgrade: '+same,async t=>{
  const f=await fixture(t,{same});await assert.rejects(f.open(),/discovery_exhausted/);
  const report=f.client.report(),diagnostics=f.client.diagnostics();assert.equal(f.calls,8);assert.equal(f.reservations,8);
  assert.equal(diagnostics.records.length,8);assert.equal(diagnostics.stopped,true);assert.equal(diagnostics.retryAuthorization,false);
  assert.equal(report.error,'discovery_exhausted');assert.equal(report.nativeVerified,false);assert.equal(f.response.bodyUsed,false);
  for(const [i,row] of diagnostics.records.entries()){
    assert.equal(row.attempt,i+1);assert.equal(row.result,'CLASSIFIED');assert.equal(row.persisted,true);
    assert.equal(row.classification.classification,same?'epoch_mismatch':'instance_mismatch');
    assert.deepEqual(row.primary,f.primary);assert.equal(row.complete,true);assert.equal(row.bodyUtf8,canonical);assert.equal(row.bodySha256,hash(canonical));
    assert.equal(row.bodySha256,report.upgrades[i].rejectionSha256);assert.deepEqual(row.headersAt,report.upgrades[i].headersAt);
    assert.ok(row.received.monoMs>=row.headersAt.monoMs);assert.ok(Buffer.byteLength(JSON.stringify(row))<=2048);
    const headers=new Headers([['content-type','application/json'],['cache-control','no-store'],...row.diagnosticHeaders]);
    assert.deepEqual(classifySsePeerV3MismatchDiagnostic({primary:row.primary,status:row.status,headers,body:Buffer.from(row.bodyUtf8),complete:true}),row.classification);
    const saved=f.records.findIndex(v=>v.kind===row.kind&&v.attempt===row.attempt);assert.ok(saved>=0);
    assert.equal(f.records[saved].persisted,false,'Journal stores observed event, never invents its own ACK');
    if(i<7)assert.ok(saved<f.records.findIndex(v=>v.kind==='capacity-peer-v3-upgrade'&&v.attempt===i+2));
  }
  assert.ok(Buffer.byteLength(JSON.stringify(diagnostics))<17000);assert.doesNotMatch(JSON.stringify({report,diagnostics,records:f.records}),/LOCAL_ID_PRIVATE|LOCAL_SECRET_PRIVATE/);
  assert.throws(()=>diagnostics.records.push({}));assert.deepEqual(f.client.diagnostics(),diagnostics);
});
for(const [name,mutate] of [
  ['missing',w=>w.headers=w.headers.filter(([k])=>!k.startsWith('x-c02-peer-'))],
  ['wrong version',w=>w.headers[2][1]='LOCAL_SECRET_PRIVATE'],
  ['bad UUID',w=>w.headers[3][1]='LOCAL_SECRET_PRIVATE'],
  ['large UUID',w=>w.headers[3][1]='LOCAL_SECRET_PRIVATE'.repeat(200)],
])test('invalid diagnostics remain explicitly unavailable without leaking values: '+name,async t=>{
  const f=await fixture(t,{mutate});await assert.rejects(f.open(),/discovery_exhausted/);assert.equal(f.calls,8);
  const d=f.client.diagnostics();assert.equal(d.records.length,8);
  for(const row of d.records){assert.equal(row.result,'UNAVAILABLE');assert.equal(row.classification,null);assert.deepEqual(row.diagnosticHeaders,[]);}
  assert.doesNotMatch(JSON.stringify({d,records:f.records}),/LOCAL_SECRET_PRIVATE/);
});
for(const [name,mutate] of [
  ['duplicate UUID',w=>w.headers.push(['x-c02-peer-observed-instance',randomUUID()])],
  ['duplicate version',w=>w.headers.push(['x-c02-peer-diagnostic','instance-v1'])],
  ['wrong status',w=>w.status=401],['wrong reason',w=>w.body=canonical.replace('peer_not_active_here','watch_already_used')],
  ['private body',w=>w.body='LOCAL_SECRET_PRIVATE'],['oversized body',w=>w.body='x'.repeat(513)],
  ['redirect',w=>w.headers.push(['Location','https://private.invalid/LOCAL_SECRET_PRIVATE'])],
  ['duplicate JSON field',w=>w.body=canonical.replace('"status":','"status":"rejected","status":')],
])test('noncanonical response never gets diagnostic evidence or another attempt: '+name,async t=>{
  const f=await fixture(t,{mutate});await assert.rejects(f.open());assert.equal(f.calls,1);
  assert.deepEqual(f.client.diagnostics().records,[]);assert.doesNotMatch(JSON.stringify(f.records),/LOCAL_SECRET_PRIVATE/);
});
for(const mode of ['throw','timeout'])test('diagnostic journal failure stops discovery without erasing observation: '+mode,{timeout:4000},async t=>{
  const f=await fixture(t,{persist(row){if(row.kind==='capacity-peer-v3-mismatch-diagnostic'){
    if(mode==='throw')throw Error('LOCAL_SECRET_PRIVATE');return new Promise(()=>{});
  }}});await assert.rejects(f.open(),/journal/);assert.equal(f.calls,1);assert.equal(f.client.report().journalUnconfirmed,true);
  const row=f.client.diagnostics().records[0];assert.equal(row.result,'CLASSIFIED');assert.equal(row.persisted,false);
  assert.doesNotMatch(JSON.stringify(f.client.report()),/LOCAL_SECRET_PRIVATE/);
});
test('late diagnostic journal ACK cannot mutate sealed evidence or dispatch next request',async t=>{
  const entered=Promise.withResolvers(),ack=Promise.withResolvers();
  const f=await fixture(t,{persist(row){if(row.kind==='capacity-peer-v3-mismatch-diagnostic'){entered.resolve();return ack.promise;}}});
  const opening=f.open();void opening.catch(()=>{});await entered.promise;f.client.stop();const sealed=f.client.diagnostics();
  ack.resolve();await assert.rejects(opening);await delay(10);assert.deepEqual(f.client.diagnostics(),sealed);
  assert.equal(sealed.records[0].persisted,false);assert.equal(f.calls,1);
});
test('partial rejection does not manufacture EOF or classification',{timeout:4000},async t=>{
  const f=await fixture(t,{send(socket){socket.write('HTTP/1.1 409 Rejected\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: 78\r\n\r\n'+canonical.slice(0,20));}});
  await assert.rejects(f.open(),/rejection_timeout/);assert.equal(f.calls,1);assert.deepEqual(f.client.diagnostics().records,[]);
});
test('diagnostic journal inputs are frozen and cannot redirect the next watch',async t=>{
  const f=await fixture(t,{persist(row){if(row.kind==='capacity-peer-v3-mismatch-diagnostic')row.primary.peer='forged';}});
  await assert.rejects(f.open(),/journal/);assert.equal(f.calls,1);assert.equal(f.client.diagnostics().records[0].primary.peer,f.primary.peer);
});
