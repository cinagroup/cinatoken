import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import WebSocket,{WebSocketServer} from 'ws';
import {createSqliteD1} from '../../src/test-support/sqlite-d1.ts';
import {resolveWorkerStorageFromBindings} from '../../src/runtime/workers.ts';
import {drainNodeBackgroundWork} from '../../src/runtime/schedule-background-work.ts';
import {runUsageRecoveryD1} from '../../../core/src/storage/recovery/run-usage-recovery-d1.ts';
import {imageSseFixture} from '../../../../scripts/deploy/staging-image-sse-fixture.mjs';
import {createImagesSseCapacityPeerGatewayV3} from './images-sse-capacity-peer-handler-v3.ts';
import {installPeerV3TestRuntime} from './images-sse-peer-v3-test-runtime.mjs';
import {sseSnapshotFaultRow} from './images-sse-snapshot-fault-v2.ts';
import {sseCancelObservationRow} from './images-sse-cancel-observer.ts';
import {createSseOperatorClock} from '../../../../scripts/deploy/staging-sse-operator-clock.mjs';
import {createSseHostExpirySession} from '../../../../scripts/deploy/staging-sse-host-expiry-session.mjs';
import {createSseCapacityPeerClientV3} from '../../../../scripts/deploy/staging-sse-capacity-peer-client-v3.mjs';
import {captureSseCapacityPrimaryV3,PEER_V3_PRIMARY_URL,PEER_V3_WATCH_URL} from '../../../../scripts/deploy/staging-sse-capacity-peer-protocol-v3.mjs';
import {SSE_HOST_EXPIRY_WARNING} from '../../../../scripts/deploy/staging-sse-host-expiry-evidence.mjs';
import {SSE_STAGING_SCOPE as g} from '../../../../scripts/deploy/staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as c} from '../../../../scripts/deploy/staging-sse-recovery-access-v2.mjs';

/** Actual Images handler, SQLite settlement/recovery, original Request abort and
 * real loopback WebSocket. ONLY native host-stop/tail envelopes and elapsed clock
 * offsets are explicitly modeled. Never publish this as live Workers evidence.
 */
export async function setupPeerAcceptanceV3(t,{occupied=false,foreignFirst=false}={}){
  const runtime=installPeerV3TestRuntime(t),db=createSqliteD1(),tasks=[],abort=new AbortController();
  const reached=Promise.withResolvers(),heldAck=Promise.withResolvers();void heldAck.promise.catch(()=>{});
  for(const method of ['log','warn','error'])t.mock.method(console,method,()=>{});
  let blockOriginalConfirmation=false,blockedReads=0,ms=0,wall=new Date().toISOString(),sends=0,attempts=0,reserved=0;
  const clock=createSseOperatorClock({readNs:()=>BigInt(ms)*1000000n,wallNow:()=>wall});
  const at=(n,label=new Date().toISOString())=>{ms=n;wall=label;};
  const drain=async()=>{for(let i=0;i<tasks.length;i++)await tasks[i].catch(()=>{});await drainNodeBackgroundWork();};
  const server=createServer(),wss=new WebSocketServer({noServer:true}),socketRows=new WeakMap(),rawSockets=new Set(),clientSockets=[];
  let client,reader;
  t.after(async()=>{
    client?.stop();abort.abort();heldAck.reject(Error('LOCAL_MODELED_HOST_STOP'));await drain();
    try{await reader?.cancel();}catch{}
    clientSockets.forEach(ws=>ws.terminate());for(const ws of wss.clients)ws.terminate();for(const s of rawSockets)s.destroy();
    if(server.listening)await new Promise(resolve=>server.close(resolve));wss.close();db.sqlite.close();
  });
  for(const name of ['request-dispatch-intents','request-usage-settlements','request-usage-recovery-jobs'])
    db.sqlite.exec(readFileSync(new URL(`../../../core/migrations-proposals/d1/${name}.sql`,import.meta.url),'utf8'));
  const key='synthetic-joint-v3-'+randomUUID(),keyHash='sha256:'+createHash('sha256').update(key).digest('hex'),expiresAt=new Date(Date.now()+3600000).toISOString();
  const fixture=await imageSseFixture('c02-success-'+randomUUID(),keyHash,expiresAt);
  for(const q of fixture.seed)db.sqlite.prepare(q.sql).run(...q.params);
  const runId=fixture.ids.runId,probe={runId,probeId:randomUUID(),mode:'after-hold'},upstream={runId,probeId:randomUUID(),mode:'success'};
  const snapshotRow=sseSnapshotFaultRow(probe),cancelSeed=sseCancelObservationRow(probe);
  const upstreamKey='c02_images_sse_probe:'+upstream.probeId;
  for(const row of [snapshotRow,cancelSeed,{key:upstreamKey,value:JSON.stringify({...upstream,phase:'armed'}),description:'c02-sse:'+runId}])
    db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(row.key,row.value,row.description);
  db.hooks.afterStatement=(sql,values)=>{
    if(sql.startsWith('UPDATE system_config SET value=')&&values[2]===snapshotRow.key&&JSON.parse(values[0]).phase==='held-after-insert'){
      reached.resolve();return heldAck.promise;
    }
  };
  db.hooks.beforeStatement=sql=>{
    // Explicit local host-stop model: prevent the failed original continuation
    // from acknowledging the snapshot and running fast-path recovery. Actual
    // independent recovery is enabled again only after that owner has drained.
    if(blockOriginalConfirmation&&sql.trim().replace(/\s+/g,' ')==='SELECT * FROM request_usage_settlements WHERE request_id=? AND user_id=? AND api_key_id=? AND workspace_id=? AND payload_sha256=?'){
      blockedReads++;throw Error('LOCAL_MODELED_CONFIRMATION_UNAVAILABLE');
    }
  };
  const transport=async(_input,init)=>{
    sends++;assert.equal(sends,1);const h=new Headers(init.headers);
    for(const name of ['x-c02-capacity-primary','x-c02-capacity-peer','x-c02-capacity-watch','x-c02-sse-host-expiry','x-c02-sse-snapshot','x-c02-sse-cancel-observe'])assert.equal(h.has(name),false);
    const events=[];const event=phase=>events.push({phase,at:Date.now(),...(phase==='terminal'?{reason:'completed'}:{})});
    return new Response(new ReadableStream({start(controller){
      event('started');controller.enqueue(Buffer.from('data: '+JSON.stringify({type:'image_generation.completed',b64_json:'AQID',usage:{input_tokens:3,output_tokens:7,total_tokens:10}})+'\n\n'));event('completed-enqueued');
      controller.enqueue(Buffer.from('data: [DONE]\n\n'));event('done-enqueued');controller.close();event('terminal');
      db.sqlite.prepare('UPDATE system_config SET value=? WHERE key=?').run(JSON.stringify({...upstream,windowProfile:'completed-and-done',phase:'terminal',events}),upstreamKey);
    }}),{headers:{'Content-Type':'text/event-stream'}});
  };
  const app=createImagesSseCapacityPeerGatewayV3(transport),foreign=createImagesSseCapacityPeerGatewayV3(transport);
  const env={DB:db.binding,DATABASE_DRIVER:'d1',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false',SHARED_KEY_ENCRYPTION_SECRET:'synthetic-joint-v3-not-a-real-secret'};
  const context={waitUntil(p){tasks.push(p);void p.catch(()=>{});}};
  const baseline={previousPublicHttp:390,firstRoundUsdCap:2};
  const session=createSseHostExpirySession({clock,baseline,input:{scope:{account:g.account,database:g.database,gateway:g.worker,controller:c.worker},
    version:randomUUID(),runId,keyHash,expiresAt,tokenName:'cinatoken-sse-v225-'+randomUUID(),
    plans:[{mode:'after-hold',snapshot:probe,upstream},{mode:'before-hold',snapshot:{runId,probeId:randomUUID(),mode:'before-hold'},upstream:{runId,probeId:randomUUID(),mode:'success'}}],
    budget:{...baseline,capReset:false,maxPublicHttp:32,maxRpc:2}}});
  session.preflightComplete();const entry=session.beginRequest(session.plan.plans[0]);
  const probeHeader=`c02-snapshot:${runId}:${probe.probeId}:after-hold`;
  const response=await app.fetch(new Request(PEER_V3_PRIMARY_URL,{method:'POST',signal:abort.signal,
    headers:{Authorization:'Bearer '+key,'Content-Type':'application/json','x-c02-capacity-primary':'v3','x-c02-sse-host-expiry':'v1','x-c02-sse-cancel-observe':'v1','x-c02-sse-snapshot':probeHeader},
    body:JSON.stringify({model:fixture.cases['small-generations'].model,prompt:'synthetic joint acceptance',stream:true})}),env,context);
  at(1000);session.markHeaders(entry,response);const primary=captureSseCapacityPrimaryV3(response,entry.timing.headers,clock.clockId);
  reader=response.body.getReader();assert.match(Buffer.from((await reader.read()).value).toString(),/completed/);await reached.promise;
  const journal=()=>({runId,keyHash,expiresAt,tokenName:session.plan.tokenName,requests:[{id:entry.id,mode:entry.mode,probeId:entry.probeId,upstreamProbeId:entry.upstreamProbeId,
    startedAt:entry.startedAt,headersAt:entry.headersAt,cancelIssuedAt:entry.cancelIssuedAt,finishedAt:entry.finishedAt,responseStatus:entry.status,timing:structuredClone(entry.timing)}],probes:[upstream]});
  const readRow=key=>({...db.sqlite.prepare('SELECT key,value,description FROM system_config WHERE key=?').get(key)});
  const observation=()=>({snapshotRow:readRow(snapshotRow.key),snapshot:JSON.parse(readRow(snapshotRow.key).value),upstream:JSON.parse(readRow(upstreamKey).value),
    jobs:db.sqlite.prepare('SELECT state FROM request_usage_recovery_jobs').all().map(r=>({...r})),logs:db.sqlite.prepare('SELECT id FROM api_key_request_logs').all().map(r=>({...r}))});
  const financial=()=>['request_dispatch_intents','request_usage_settlements','request_usage_recovery_jobs','request_usage_commit_receipts','api_key_request_logs','user_budget_reservations']
    .map(table=>db.sqlite.prepare('SELECT * FROM '+table).all().map(row=>({...row})));
  const saved=[];
  server.on('connection',socket=>{rawSockets.add(socket);socket.on('close',()=>rawSockets.delete(socket));socket.on('error',()=>{});});
  wss.on('headers',(headers,request)=>{for(const [k,v] of socketRows.get(request).headers)headers.push(k+': '+v);});
  server.on('upgrade',(request,socket,head)=>{void (async()=>{
    attempts++;const selected=foreignFirst&&attempts===1?foreign:app;
    const result=await selected.fetch(new Request(PEER_V3_WATCH_URL.replace('wss:','https:'),{headers:request.headers}),env,context);
    if(result.status!==101){const body=await result.text();socket.end('HTTP/1.1 '+result.status+' Rejected\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: '+Buffer.byteLength(body)+'\r\n\r\n'+body);return;}
    socketRows.set(request,result);const local=runtime.pairs.at(-1)[1];
    wss.handleUpgrade(request,socket,head,ws=>{
      ws.on('error',()=>{});ws.on('message',(data,binary)=>{assert.equal(binary,false);local.incoming(data.toString());});
      ws.on('close',()=>local.close(1000,'loopback_closed'));local.addEventListener('close',()=>ws.close(1000,'local_closed'));
      for(const raw of local.messages.splice(0))ws.send(raw);local.send=raw=>ws.send(raw);
    });
  })().catch(()=>socket.destroy());});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  client=createSseCapacityPeerClientV3({clock,reserve(){reserved++;},persist(row){saved.push(structuredClone(row));},socketFactory:(url,options)=>{
    assert.equal(url,PEER_V3_WATCH_URL);const ws=new WebSocket('ws://127.0.0.1:'+server.address().port,options);clientSockets.push(ws);return ws;}});
  at(1050);await client.open(primary,{'cf-access-client-id':'local-id','cf-access-client-secret':'LOCAL_SECRET_NOT_EVIDENCE'});
  at(1100);const held={observation:observation(),received:clock.sample()};assert.deepEqual(held.observation.jobs,[{state:'pending'}]);assert.deepEqual(held.observation.logs,[]);
  await client.phase('held',{after:held.received});
  const pending=reader.read();void pending.catch(()=>{});at(1200);session.cancelRequest(entry,()=>abort.abort());
  await assert.rejects(pending);reader.releaseLock();reader=undefined;at(1300);session.finishRequest(entry);
  const cancelRow=readRow(cancelSeed.key),cancelValue=JSON.parse(cancelRow.value);assert.equal(cancelValue.phase,'request-aborted');
  if(!occupied){blockOriginalConfirmation=true;heldAck.reject(Error('LOCAL_MODELED_HOST_STOP'));await drain();assert.ok(blockedReads>0);blockOriginalConfirmation=false;}
  // Synthetic native transport envelope, deliberately labeled local model.
  // It uses the actual abort snapshot and original session receipt mechanism.
  const warningAt=Date.parse(cancelValue.at)+30000;at(33000,new Date(warningAt+1000).toISOString());
  session.receive(Buffer.from(JSON.stringify({scriptName:g.worker,scriptVersion:{id:session.plan.version},outcome:'ok',eventTimestamp:Date.parse(entry.headersAt),
    event:{request:{url:PEER_V3_PRIMARY_URL,method:'POST',headers:{'x-c02-sse-host-expiry':'v1','x-c02-sse-cancel-observe':'v1','x-c02-sse-snapshot':probeHeader}},response:{status:200}},
    logs:[{level:'warn',message:[SSE_HOST_EXPIRY_WARNING],timestamp:warningAt}],exceptions:[]})));
  const native={observation:observation(),cancelRow,platform:session.platform(),received:clock.sample()};
  assert.deepEqual(native.observation,held.observation);await client.phase('post-native',{after:native.received});
  const storage=await resolveWorkerStorageFromBindings(env),recovery={calls:[]};
  for(let i=0;i<2;i++){
    at(34000+i*1000,wall);const call={started:clock.sample(),attempt:i+1,result:'ACK'};
    const result=await session.rpc(()=>runUsageRecoveryD1(storage.client,{scope:{kind:'tenant',userId:fixture.ids.user,workspaceId:fixture.ids.workspace},maxItems:2,concurrency:1,
      leaseSeconds:10,runBudgetMs:5000,reservedBytesPerConsumer:1024},{tryAcquire(){return {release(){}};}}));
    call.finished=session.lastRpcFinished;call.status=200;call.body={status:'finished',runId:randomUUID(),retry_safe:false,result};recovery.calls.push(call);
    assert.equal(result.committed,i===0?1:0);recovery[i?'afterDedup':'afterRecovery']=financial();
  }
  recovery.probeRows=[readRow(snapshotRow.key)];recovery.cancelRows=[readRow(cancelSeed.key)];recovery.received=clock.sample();
  await client.phase('post-recovery',{after:recovery.received});const peerReport=client.stop();saved.push({kind:'sealed-peer-report',peerReport:structuredClone(peerReport)});
  assert.equal(peerReport.failed,false);assert.equal(sends,1);assert.equal(reserved,foreignFirst?2:1);assert.equal(attempts,reserved);
  return {evidence:{peerReport,journal:journal(),primary,held,native,recovery},financial,saved,db,
    model:{native:true,elapsedClock:true,webSocketPair:true,actualSqlite:true,actualLoopbackSocket:true},sends};
}
