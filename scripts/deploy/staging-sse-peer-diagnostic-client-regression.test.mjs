import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {setTimeout as delay,setImmediate as tick} from 'node:timers/promises';
import WebSocket,{WebSocketServer} from 'ws';
import {createSseOperatorClock} from './staging-sse-operator-clock.mjs';
import {PEER_V3_PROFILE,PEER_V3_WATCH_URL,PEER_V3_STAGES} from './staging-sse-capacity-peer-protocol-v3.mjs';
import {createSseCapacityPeerDiagnosticClient} from './staging-sse-capacity-peer-diagnostic-client.mjs';

const instanceId=randomUUID(),peer=instanceId+':1';
const common={profile:PEER_V3_PROFILE,instanceId,watchEpoch:1};
const sample=(sequence=1,barrier=0,requests=1)=>({...common,kind:'sample',barrier,sequence,maxRequests:1,maxReservedBytes:1024,requests,reservedBytes:requests*1024});
const ack=(barrier,stage)=>({...common,kind:'barrier',barrier,stage});
const credentials={'cf-access-client-id':'local-id','cf-access-client-secret':'LOCAL_PRIVATE_SECRET'};
const mismatch='{"status":"rejected","reason":"peer_not_active_here","dispatch_started":false}';
const primary=clock=>({profile:PEER_V3_PROFILE,requestId:'gen-'+randomUUID(),status:200,peer,instanceId,before:'0/0',received:clock.sample()});
const until=async check=>{for(let i=0;i<200;i++){if(check())return;await delay(5);}assert.fail('Local test condition not reached');};

async function fixture(t,{actions=[],headers={},connect,onMark,persist,reserve,socketCreated,clock=createSseOperatorClock()}={}){
  const server=createServer((_req,res)=>{res.writeHead(404);res.end();}),wss=new WebSocketServer({noServer:true,perMessageDeflate:false});
  const rawSockets=new Set(),clientSockets=[],records=[],optionsSeen=[],requests=[],commands=[];
  let calls=0,reservations=0;
  server.on('connection',socket=>{rawSockets.add(socket);socket.on('close',()=>rawSockets.delete(socket));socket.on('error',()=>{});});
  wss.on('headers',out=>{
    const values={'Cache-Control':'no-store','x-c02-capacity-peer':peer,'x-c02-capacity-instance':instanceId,'x-c02-capacity-watch':'v3',...headers};
    for(const [name,value] of Object.entries(values))if(value!==null)out.push(name+': '+value);
  });
  server.on('upgrade',(req,socket,head)=>{
    calls++;requests.push({method:req.method,path:req.url,peer:req.headers['x-c02-capacity-peer'],watch:req.headers['x-c02-capacity-watch']});
    assert.equal(req.headers['cf-access-client-secret'],credentials['cf-access-client-secret']);
    assert.equal(reservations,calls);assert.ok(records.some(r=>r.kind==='capacity-peer-v3-upgrade'&&r.attempt===calls&&r.result==='PENDING'));
    const action=actions[calls-1];
    if(action){action(req,socket,head);return;}
    wss.handleUpgrade(req,socket,head,ws=>{
      ws.on('error',()=>{});let sequence=1;
      ws.on('message',(data,binary)=>{
        assert.equal(binary,false);const command=JSON.parse(data.toString());commands.push(command);
        assert.ok(records.some(r=>r.stage===command.stage&&r.result==='PENDING'));
        if(onMark){onMark(ws,command,()=>++sequence);return;}
        // An old queued sample is not the requested new phase.
        ws.send(JSON.stringify(sample(++sequence,command.barrier-1)));
        ws.send(JSON.stringify(ack(command.barrier,command.stage)));
        ws.send(JSON.stringify(sample(++sequence,command.barrier,command.barrier===1?1:0)));
      });
      if(connect)connect(ws);else ws.send(JSON.stringify(sample()));
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address(),url='ws://127.0.0.1:'+address.port+'/__staging/sse-capacity/watch-v3';
  const client=createSseCapacityPeerDiagnosticClient({clock,reserve:()=>{reservations++;if(reserve)reserve();},persist:async row=>{
    records.push(structuredClone(row));if(persist)await persist(row);
  },socketFactory:(requested,options)=>{
    optionsSeen.push({requested,options:{...options,headers:undefined}});assert.equal(requested,PEER_V3_WATCH_URL);
    const ws=new WebSocket(url,options);clientSockets.push(ws);if(socketCreated)socketCreated(ws);return ws;
  }});
  t.after(async()=>{client.stop();for(const ws of clientSockets)ws.terminate();for(const ws of wss.clients)ws.terminate();
    for(const socket of rawSockets)socket.destroy();await new Promise(resolve=>server.close(resolve));wss.close();});
  return {client,clock,records,requests,commands,optionsSeen,clientSockets,server,wss,
    open:()=>client.open(primary(clock),credentials),get calls(){return calls;},get reservations(){return reservations;}};
}
const reject=(status=409,body=mismatch,extra='')=>(_req,socket)=>socket.end('HTTP/1.1 '+status+' Rejected\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: '+Buffer.byteLength(body)+'\r\n'+extra+'\r\n'+body);

test('real loopback: one upgrade, write-ahead records, three causal phases and sealed sanitized report',async t=>{
  const f=await fixture(t),baseline=await f.open();assert.equal(baseline.sample.requests,1);assert.equal(baseline.status,101);
  for(const stage of PEER_V3_STAGES){const r=await f.client.phase(stage,{after:f.clock.sample()});
    assert.equal(r.result,'PASS');assert.equal(r.barrier.barrier,r.sample.barrier);
    assert.ok(r.sent.monoMs<=r.acknowledged.monoMs&&r.acknowledged.monoMs<=r.received.monoMs);}
  assert.equal(f.calls,1);assert.equal(f.reservations,1);assert.equal(f.commands.length,3);
  assert.deepEqual(f.requests,[{method:'GET',path:'/__staging/sse-capacity/watch-v3',peer,watch:'v3'}]);
  const sealed=f.client.stop();await tick();assert.deepEqual(f.client.report(),sealed);assert.equal(sealed.failed,false);
  assert.equal(sealed.records.length,4);assert.equal(sealed.nativeVerified,false);assert.equal(sealed.c02GatePassed,false);
  assert.ok(Buffer.byteLength(JSON.stringify(sealed))<16384);assert.doesNotMatch(JSON.stringify(sealed),/LOCAL_PRIVATE_SECRET|cf-access-client-secret|local-id/);
  const opts=f.optionsSeen[0].options;assert.equal(opts.maxPayload,512);assert.equal(opts.followRedirects,false);assert.equal(opts.perMessageDeflate,false);
  assert.equal(opts.autoPong,false);assert.equal(opts.maxHeaderSize,16384);
  assert.throws(()=>sealed.records.push({}));await assert.rejects(()=>f.open(),/client_unavailable/);assert.equal(f.calls,1);
});
test('real loopback: exactly complete mismatches may consume additional targeted GET budget',async t=>{
  const f=await fixture(t,{actions:[reject(),reject()]}),r=await f.open();
  assert.equal(f.calls,3);assert.equal(f.reservations,3);assert.equal(r.upgradeAttempt,3);
  const report=f.client.report();assert.deepEqual(report.upgrades.map(r=>r.result),['MISMATCH','MISMATCH','MATCH']);
  for(const r of report.upgrades.slice(0,2)){assert.equal(r.rejectionComplete,true);assert.equal(r.rejectionBytes,Buffer.byteLength(mismatch));assert.match(r.rejectionSha256,/^[a-f0-9]{64}$/);}
});
test('real loopback: discovery is capped at eight consumed upgrades without inference',async t=>{
  const f=await fixture(t,{actions:Array.from({length:8},()=>reject())});await assert.rejects(f.open(),/discovery_exhausted/);
  assert.equal(f.calls,8);assert.equal(f.reservations,8);assert.equal(f.commands.length,0);assert.equal(f.client.report().failed,true);
});
for(const [name,action] of [
  ['authentication',reject(401,'{"private":"LOCAL_PRIVATE_SECRET"}')],
  ['redirect',reject(302,'','Location: https://other.invalid/\r\n')],
  ['already used',reject(409,mismatch.replace('peer_not_active_here','watch_already_used'))],
  ['whitespace',reject(409,' '+mismatch)], ['duplicate key',reject(409,mismatch.replace('"status":"rejected"','"status":"rejected","status":"rejected"'))],
  ['generation header',reject(409,mismatch,'x-generation-id: gen-private\r\n')],
  ['wrong JSON type',(_r,s)=>s.end('HTTP/1.1 409 Rejected\r\nContent-Type: text/html\r\nCache-Control: no-store\r\nContent-Length: 1\r\n\r\nx')],
  ['truncated body',(_r,s)=>s.end('HTTP/1.1 409 Rejected\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: 1000\r\n\r\n'+mismatch)],
  ['oversized body',reject(409,'x'.repeat(513))],
  ['lost upgrade acknowledgement',(_r,s)=>s.destroy()],
])test('real loopback: no retry after '+name,async t=>{
  const f=await fixture(t,{actions:[action]});await assert.rejects(f.open());await tick();
  assert.equal(f.calls,1);assert.equal(f.reservations,1);assert.equal(f.client.report().failed,true);
  assert.doesNotMatch(JSON.stringify(f.client.report()),/LOCAL_PRIVATE_SECRET|gen-private|other.invalid/);
});
for(const [name,headers] of [
  ['peer',{'x-c02-capacity-peer':instanceId+':2'}],['instance',{'x-c02-capacity-instance':randomUUID()}],
  ['version',{'x-c02-capacity-watch':'v2'}],['cache',{'Cache-Control':'public'}],['missing identity',{'x-c02-capacity-peer':null}],
])test('real loopback: 101 with wrong '+name+' is terminal',async t=>{
  const f=await fixture(t,{headers});await assert.rejects(f.open(),/upgrade_contract/);assert.equal(f.calls,1);
});
for(const [name,connect] of [
  ['binary',ws=>ws.send(Buffer.from(JSON.stringify(sample())))],
  ['oversized',ws=>ws.send('x'.repeat(513))],
  ['old idle baseline',ws=>ws.send(JSON.stringify(sample(1,0,0)))],
  ['sequence gap',ws=>ws.send(JSON.stringify(sample(2)))],
  ['ping',ws=>ws.ping('private')],
  ['close',ws=>ws.close()],
])test('real loopback: '+name+' never establishes successful baseline',async t=>{
  const f=await fixture(t,{connect});await assert.rejects(f.open());assert.equal(f.calls,1);assert.equal(f.client.report().failed,true);
});
test('real loopback: connection established then closed is never reconnected',async t=>{
  const f=await fixture(t);await f.open();for(const ws of f.wss.clients)ws.terminate();await until(()=>f.client.report().stopped);
  await assert.rejects(()=>f.client.phase('held',{after:f.clock.sample()}),/client_unavailable/);assert.equal(f.calls,1);
});
test('real loopback: ACK without first post-marker sample cannot satisfy phase',async t=>{
  const f=await fixture(t,{onMark(ws,command){ws.send(JSON.stringify(ack(command.barrier,command.stage)));ws.close();}});
  await f.open();await assert.rejects(()=>f.client.phase('held',{after:f.clock.sample()}));
  assert.equal(f.commands.length,1);assert.equal(f.client.report().records[1].sample,undefined);assert.equal(f.calls,1);
});
test('real loopback: sample before ACK fails, no marker resend',async t=>{
  const f=await fixture(t,{onMark(ws,c,next){ws.send(JSON.stringify(sample(next(),c.barrier)));}});await f.open();
  await assert.rejects(()=>f.client.phase('held',{after:f.clock.sample()}),/message_contract/);
  assert.equal(f.commands.length,1);assert.equal(f.client.report().markerAttempts,1);
});
test('real loopback: missing marker ACK times out and no command is repeated',{timeout:8000},async t=>{
  const f=await fixture(t,{onMark(){}});await f.open();await assert.rejects(()=>f.client.phase('held',{after:f.clock.sample()}),/marker_timeout/);
  assert.equal(f.commands.length,1);assert.equal(f.calls,1);
});
test('real loopback: incomplete rejection times out, not a discovery retry',{timeout:4000},async t=>{
  const action=(_r,s)=>s.write('HTTP/1.1 409 Rejected\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n');
  const f=await fixture(t,{actions:[action]});await assert.rejects(f.open(),/rejection_timeout/);assert.equal(f.calls,1);
});
test('real loopback: missing baseline times out after matched 101 without reconnect',{timeout:8000},async t=>{
  const f=await fixture(t,{connect(){}});await assert.rejects(f.open(),/upgrade_timeout/);assert.equal(f.calls,1);
  assert.equal(f.client.report().upgrades[0].status,101);
});
test('write-ahead journal failure prevents first network dispatch',async t=>{
  const f=await fixture(t,{persist(){throw Error('LOCAL_PRIVATE_SECRET');}});await assert.rejects(f.open(),/journal/);
  assert.equal(f.calls,0);assert.equal(f.reservations,1);assert.equal(f.client.report().journalUnconfirmed,true);
  assert.doesNotMatch(JSON.stringify(f.client.report()),/LOCAL_PRIVATE_SECRET/);
});
test('marker write-ahead failure consumes local stage but emits no command',async t=>{
  const f=await fixture(t,{persist(row){if(row.stage==='held')throw Error('private');}});await f.open();
  await assert.rejects(()=>f.client.phase('held',{after:f.clock.sample()}),/journal/);
  assert.equal(f.commands.length,0);assert.equal(f.client.report().markerAttempts,1);
});
test('stop during pending journal seals facts; late completion cannot create a socket or evidence',async t=>{
  const pending=Promise.withResolvers();let entered=false;
  const f=await fixture(t,{persist(){entered=true;return pending.promise;}});const opening=f.open();void opening.catch(()=>{});
  await until(()=>entered);const sealed=f.client.stop();pending.resolve();await assert.rejects(opening);await tick();
  assert.deepEqual(f.client.report(),sealed);assert.equal(sealed.failed,true);assert.equal(sealed.journalUnconfirmed,true);assert.equal(f.calls,0);
});
test('pending journal timeout prevents late dispatch and preserves same sealed report',{timeout:4000},async t=>{
  const pending=Promise.withResolvers();const f=await fixture(t,{persist(){return pending.promise;}});
  await assert.rejects(f.open(),/journal/);const sealed=f.client.report();pending.resolve();await tick();
  assert.equal(f.calls,0);assert.deepEqual(f.client.report(),sealed);
});
test('original primary monotonic age bounds all discovery; old receipt gets zero dispatch',async t=>{
  let ns=0n;const clock=createSseOperatorClock({readNs:()=>ns}),p=primary(clock);ns=21000000000n;
  const f=await fixture(t,{clock});await assert.rejects(()=>f.client.open(p,credentials));assert.equal(f.calls,0);assert.equal(f.reservations,0);
});
test('original clock epoch and causal prerequisite cannot be replaced',async t=>{
  const f=await fixture(t);await f.open();const other=createSseOperatorClock();
  await assert.rejects(()=>f.client.phase('held',{after:other.sample()}));assert.equal(f.commands.length,0);assert.equal(f.calls,1);
});
test('shared HTTP budget exhaustion stops before constructing a socket',async t=>{
  const f=await fixture(t,{reserve(){throw Error('budget exhausted');}});await assert.rejects(f.open(),/budget/);
  assert.equal(f.calls,0);assert.equal(f.optionsSeen.length,0);assert.equal(f.client.report().upgradeAttempts,1);
});
test('all mismatches share the original twenty-second clock window',async t=>{
  let ns=0n;const clock=createSseOperatorClock({readNs:()=>ns});
  const f=await fixture(t,{clock,actions:[reject()],persist(row){if(row.result==='MISMATCH')ns=21000000000n;}});
  await assert.rejects(f.open());assert.equal(f.calls,1);assert.equal(f.client.report().failed,true);
});
test('real loopback: duplicate upgrade identity header cannot use last-wins',async t=>{
  const f=await fixture(t,{headers:{'x-c02-capacity-watch':'v3\r\nx-c02-capacity-watch: v3'}});
  await assert.rejects(f.open(),/upgrade_contract/);assert.equal(f.calls,1);
});
test('real loopback: fragmented text is reassembled within the explicit message bound',async t=>{
  const f=await fixture(t,{connect(ws){const raw=JSON.stringify(sample());for(let i=0;i<raw.length;i++)ws.send(raw[i],{fin:i===raw.length-1,binary:false});}});
  assert.equal((await f.open()).sample.sequence,1);assert.equal(f.calls,1);
});
test('real loopback: a failed send confirmation cannot become a successful phase even after ACK/sample',async t=>{
  let confirm;
  const f=await fixture(t,{socketCreated(ws){const send=ws.send.bind(ws);ws.send=(data,options,callback)=>send(data,options,()=>{confirm=callback;});}});
  await f.open();const phase=f.client.phase('held',{after:f.clock.sample()});void phase.catch(()=>{});
  await until(()=>confirm&&f.client.report().records[1]?.sample);confirm(Error('LOCAL_PRIVATE_SECRET'));
  await assert.rejects(phase,/marker_send/);assert.equal(f.client.report().failed,true);assert.equal(f.commands.length,1);
  assert.doesNotMatch(JSON.stringify(f.client.report()),/LOCAL_PRIVATE_SECRET/);
});
test('stop seals pending send; late successful callback cannot promote the phase',async t=>{
  let confirm;
  const f=await fixture(t,{socketCreated(ws){const send=ws.send.bind(ws);ws.send=(data,options,callback)=>send(data,options,()=>{confirm=callback;});}});
  await f.open();const phase=f.client.phase('held',{after:f.clock.sample()});void phase.catch(()=>{});
  await until(()=>confirm&&f.client.report().records[1]?.sample);const sealed=f.client.stop();confirm();
  await assert.rejects(phase);await tick();assert.deepEqual(f.client.report(),sealed);assert.equal(sealed.failed,true);assert.equal(f.commands.length,1);
});
test('stopping during completed-phase journal still marks evidence unconfirmed',async t=>{
  const pending=Promise.withResolvers();let entered=false;
  const f=await fixture(t,{persist(row){if(row.stage==='held'&&row.result==='PASS'){entered=true;return pending.promise;}}});
  await f.open();const phase=f.client.phase('held',{after:f.clock.sample()});void phase.catch(()=>{});await until(()=>entered);
  const sealed=f.client.stop();pending.resolve();await assert.rejects(phase);await tick();
  assert.equal(sealed.failed,true);assert.equal(sealed.journalUnconfirmed,true);assert.deepEqual(f.client.report(),sealed);
});
test('real loopback: observer deadline terminates without reconnect or further markers',async t=>{
  // Register the original client lifetime under this explicit timer model.
  // Never switch timer implementations while an older real timer is live.
  t.mock.timers.enable({apis:['setTimeout']});
  let ns=0n;const clock=createSseOperatorClock({readNs:()=>ns});
  const g=await fixture(t,{clock});await g.open();ns=181000000000n;t.mock.timers.tick(180001);
  assert.equal(g.client.report().error,'observer_timeout');assert.equal(g.calls,1);assert.equal(g.client.report().failed,true);
});
