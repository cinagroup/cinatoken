import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createServer,request as httpRequest} from 'node:http';
import WebSocket,{WebSocketServer} from 'ws';
import {createSqliteD1} from '../../src/test-support/sqlite-d1.ts';
import {resolveWorkerStorageFromBindings} from '../../src/runtime/workers.ts';
import {drainNodeBackgroundWork} from '../../src/runtime/schedule-background-work.ts';
import {runUsageRecoveryD1} from '../../../core/src/storage/recovery/run-usage-recovery-d1.ts';
import {imageSseFixture} from '../../../../scripts/deploy/staging-image-sse-fixture.mjs';
import {createImagesSsePeerDiagnosticGateway} from './images-sse-capacity-peer-diagnostic-handler.ts';
import {installPeerV3TestRuntime} from './images-sse-peer-v3-test-runtime.mjs';
import {sseSnapshotFaultRow} from './images-sse-snapshot-fault-v2.ts';
import {sseCancelObservationRow} from './images-sse-cancel-observer.ts';
import {createSseOperatorClock} from '../../../../scripts/deploy/staging-sse-operator-clock.mjs';
import {createSseHostExpirySession} from '../../../../scripts/deploy/staging-sse-host-expiry-session.mjs';
import {createSseCapacityPeerDiagnosticCoordinator} from '../../../../scripts/deploy/staging-sse-capacity-peer-diagnostic-coordinator.mjs';
import {createSseCapacityPeerWindowV3} from '../../../../scripts/deploy/staging-sse-capacity-peer-window-v3.mjs';
import {createSseCapacityPeerFinalizerV3} from '../../../../scripts/deploy/staging-sse-capacity-peer-finalizer-v3.mjs';
import {PEER_V3_PRIMARY_URL,PEER_V3_WATCH_URL} from '../../../../scripts/deploy/staging-sse-capacity-peer-protocol-v3.mjs';
import {SSE_HOST_EXPIRY_WARNING} from '../../../../scripts/deploy/staging-sse-host-expiry-evidence.mjs';
import {SSE_STAGING_SCOPE as g} from '../../../../scripts/deploy/staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as c} from '../../../../scripts/deploy/staging-sse-recovery-access-v2.mjs';

/** Actual Images handler, SQLite settlement/recovery, original Request abort and
 * real loopback WebSocket. ONLY native host-stop/tail envelopes and elapsed clock
 * offsets are explicitly modeled. Never publish this as live Workers evidence.
 */
export async function setupPeerDiagnosticWindow(t,{occupied=false,foreignFirst=false,fault}={}){
  const runtime=installPeerV3TestRuntime(t),db=createSqliteD1(),tasks=[];
  const reached=Promise.withResolvers(),heldAck=Promise.withResolvers(),abortRecorded=Promise.withResolvers();void heldAck.promise.catch(()=>{});
  for(const method of ['log','warn','error'])t.mock.method(console,method,()=>{});
  let blockOriginalConfirmation=false,blockedReads=0,ms=0,wall=new Date().toISOString(),sends=0,attempts=0,reserved=0;
  let onSleep;
  const waits=[];
  const clock=createSseOperatorClock({readNs:()=>BigInt(ms)*1000000n,wallNow:()=>wall,sleep:async n=>{waits.push(n);ms+=n;await onSleep?.();}});
  const at=(n,label=new Date().toISOString())=>{ms=n;wall=label;};
  const drain=async()=>{for(let i=0;i<tasks.length;i++)await tasks[i].catch(()=>{});await drainNodeBackgroundWork();};
  const server=createServer(),wss=new WebSocketServer({noServer:true}),socketRows=new WeakMap(),rawSockets=new Set(),clientSockets=[];
  let co;
  t.after(async()=>{
    co?.close();heldAck.reject(Error('LOCAL_MODELED_HOST_STOP'));await drain();
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
    if(sql.startsWith('UPDATE system_config SET value=')&&values[2]===cancelSeed.key&&JSON.parse(values[0]).phase==='request-aborted')abortRecorded.resolve();
    if(sql.startsWith('UPDATE system_config SET value=')&&values[2]===snapshotRow.key&&JSON.parse(values[0]).phase==='held-after-insert'){
      reached.resolve();return heldAck.promise;
    }
  };
  db.hooks.beforeStatement=(sql,values)=>{
    if(fault==='watch-403'&&sql.startsWith('UPDATE system_config SET value=')&&values[2]===snapshotRow.key&&JSON.parse(values[0]).phase==='held-after-insert')return abortRecorded.promise;
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
    const events=[];const event=(phase,reason)=>events.push({phase,at:Date.now(),...(reason?{reason}:{})});
    const record=()=>db.sqlite.prepare('UPDATE system_config SET value=? WHERE key=?').run(JSON.stringify({...upstream,windowProfile:'completed-and-done',phase:'terminal',events}),upstreamKey);
    return new Response(new ReadableStream({start(controller){
      event('started');controller.enqueue(Buffer.from('data: '+JSON.stringify({type:'image_generation.completed',b64_json:'AQID',usage:{input_tokens:3,output_tokens:7,total_tokens:10}})+'\n\n'));event('completed-enqueued');
      controller.enqueue(Buffer.from('data: [DONE]\n\n'));event('done-enqueued');
    },cancel(){event('terminal','response_cancel');record();}}),{headers:{'Content-Type':'text/event-stream'}});
  };
  const app=createImagesSsePeerDiagnosticGateway(transport),foreign=createImagesSsePeerDiagnosticGateway(transport);
  const env={DB:db.binding,DATABASE_DRIVER:'d1',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false',SHARED_KEY_ENCRYPTION_SECRET:'synthetic-joint-v3-not-a-real-secret'};
  const context={waitUntil(p){tasks.push(p);void p.catch(()=>{});}};
  const baseline={previousPublicHttp:406,firstRoundUsdCap:2};
  const session=createSseHostExpirySession({clock,baseline,input:{scope:{account:g.account,database:g.database,gateway:g.worker,controller:c.worker},
    version:randomUUID(),runId,keyHash,expiresAt,tokenName:'cinatoken-sse-v230-'+randomUUID(),
    plans:[{mode:'after-hold',snapshot:probe,upstream},{mode:'before-hold',snapshot:{runId,probeId:randomUUID(),mode:'before-hold'},upstream:{runId,probeId:randomUUID(),mode:'success'}}],
    budget:{...baseline,capReset:false,maxPublicHttp:32,maxRpc:2}}});
  session.preflightComplete();
  const readRow=key=>({...db.sqlite.prepare('SELECT key,value,description FROM system_config WHERE key=?').get(key)});
  const observation=()=>({snapshotRow:readRow(snapshotRow.key),snapshot:JSON.parse(readRow(snapshotRow.key).value),upstream:JSON.parse(readRow(upstreamKey).value),
    jobs:db.sqlite.prepare('SELECT state FROM request_usage_recovery_jobs').all().map(r=>({...r})),logs:db.sqlite.prepare('SELECT id FROM api_key_request_logs').all().map(r=>({...r}))});
  const financial=()=>['request_dispatch_intents','request_usage_settlements','request_usage_recovery_jobs','request_usage_commit_receipts','api_key_request_logs','user_budget_reservations']
    .map(table=>db.sqlite.prepare('SELECT * FROM '+table).all().map(row=>({...row})));
  const saved=[],calls=[];
  let body,response,signal,readers=0,clones=0,rpcCalls=0,modelNativeSent=false,readObservationCalls=0;
  const serverAborted=Promise.withResolvers();
  const persist=async row=>{
    if(row.kind==='peer-v3-sealed-evidence'){
      assert.equal(co.report().decision,undefined,'No oracle decision before sealed evidence journal ACK');
      assert.equal(row.peerReport.stopped,true);
    }
    if((fault==='sealed-journal'&&row.kind==='peer-v3-sealed-evidence')||
       (fault==='joint-journal'&&row.kind==='peer-joint-acceptance-v3')||
       (fault==='inference-journal'&&row.kind==='peer-inference'&&row.result==='PENDING'))
      throw Error('LOCAL_SECRET_JOURNAL');
    saved.push(structuredClone(row));
  };
  server.on('connection',socket=>{rawSockets.add(socket);socket.on('close',()=>rawSockets.delete(socket));socket.on('error',()=>{});});
  server.on('request',(request,out)=>{void(async()=>{
    assert.equal(request.method,'POST');assert.equal(request.url,'/v1/images/generations');
    const chunks=[];for await(const chunk of request)chunks.push(chunk);
    const ac=new AbortController();let original;
    out.on('close',()=>{ac.abort();serverAborted.resolve();void original?.cancel().catch(()=>{});});
    const result=await app.fetch(new Request(PEER_V3_PRIMARY_URL,{method:'POST',headers:request.headers,body:Buffer.concat(chunks),signal:ac.signal}),env,context);
    out.writeHead(result.status,Object.fromEntries(result.headers));out.flushHeaders();original=result.body.getReader();
    try{for(;;){const next=await original.read();if(next.done){out.end();break;}if(out.destroyed)break;out.write(next.value);}}
    catch{out.destroy();}finally{try{original.releaseLock();}catch{}}
  })().catch(()=>out.destroy());});
  wss.on('headers',(headers,request)=>{for(const [k,v] of socketRows.get(request).headers)headers.push(k+': '+v);});
  server.on('upgrade',(request,socket,head)=>{void (async()=>{
    attempts++;const selected=foreignFirst&&attempts===1?foreign:app;
    if(['watch-403','watch-403-after-held'].includes(fault)){
      if(fault==='watch-403-after-held')await reached.promise;
      socket.end('HTTP/1.1 403 Rejected\r\nContent-Length: 0\r\n\r\n');return;
    }
    const result=await selected.fetch(new Request(PEER_V3_WATCH_URL.replace('wss:','https:'),{headers:request.headers}),env,context);
    if(result.status!==101){const body=await result.text(),diagnosticHeaders=['x-c02-peer-diagnostic','x-c02-peer-observed-instance'].filter(k=>result.headers.has(k)).map(k=>k+': '+result.headers.get(k)+'\r\n').join('');socket.end('HTTP/1.1 '+result.status+' Rejected\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: '+Buffer.byteLength(body)+'\r\n'+diagnosticHeaders+'\r\n'+body);return;}
    socketRows.set(request,result);const local=runtime.pairs.at(-1)[1];
    wss.handleUpgrade(request,socket,head,ws=>{
      ws.on('error',()=>{});ws.on('message',(data,binary)=>{
        assert.equal(binary,false);
        if(fault==='lost-post-native-ack'&&JSON.parse(data).stage==='post-native'){ws.terminate();return;}
        local.incoming(data.toString());
      });
      ws.on('close',()=>local.close(1000,'loopback_closed'));local.addEventListener('close',()=>ws.close(1000,'local_closed'));
      for(const raw of local.messages.splice(0))ws.send(raw);local.send=raw=>ws.send(raw);
    });
  })().catch(()=>socket.destroy());});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const reserve=()=>{assert.ok(reserved<32);reserved++;};
  co=createSseCapacityPeerDiagnosticCoordinator({session,clock,reserve,persist,socketFactory:(url,options)=>{
    assert.equal(url,PEER_V3_WATCH_URL);assert.equal(readers,1,'Original reader acquired before observation');
    assert.equal(body.locked,true);assert.equal(signal.aborted,false);
    const ws=new WebSocket('ws://127.0.0.1:'+server.address().port,options);clientSockets.push(ws);return ws;
  }});
  const probeHeader='c02-snapshot:'+runId+':'+probe.probeId+':after-hold';
  const fetchImpl=async(url,init)=>{
    assert.equal(url,PEER_V3_PRIMARY_URL);assert.equal(init.method,'POST');assert.equal(init.redirect,'manual');assert.equal(init.cache,'no-store');
    const headers=new Headers(init.headers);
    assert.equal(headers.get('x-c02-capacity-primary'),'v3');assert.equal(headers.has('x-c02-capacity-peer'),false);
    assert.equal(JSON.parse(init.body).model,fixture.cases['small-generations'].model);
    signal=init.signal;
    if(fault==='inference-ack-lost')throw Error('LOCAL_SECRET_INFERENCE');
    // Real local HTTP bytes and abort, not a rewritten gateway rejection. The
    // adapter's Response has an intentionally blank URL accepted by the DTO.
    response=await new Promise((resolve,reject)=>{
      const request=httpRequest({hostname:'127.0.0.1',port:server.address().port,path:'/v1/images/generations',method:'POST',headers:Object.fromEntries(headers)},incoming=>{
        const stream=new ReadableStream({start(controller){
          incoming.on('data',chunk=>controller.enqueue(new Uint8Array(chunk)));
          incoming.on('end',()=>controller.close());incoming.on('error',error=>controller.error(error));
          signal.addEventListener('abort',()=>{controller.error(signal.reason);incoming.destroy();request.destroy(signal.reason);},{once:true});
        },cancel(){incoming.destroy();request.destroy();}});
        resolve(new Response(stream,{status:incoming.statusCode,headers:incoming.headers}));
      });
      request.on('error',reject);request.end(init.body);
    });body=response.body;
    const getReader=body.getReader.bind(body);
    t.mock.method(body,'getReader',(...args)=>{readers++;assert.equal(readers,1);return getReader(...args);});
    t.mock.method(body,'tee',()=>{clones++;throw Error('Original body must not be teed');});
    t.mock.method(response,'clone',()=>{clones++;throw Error('Original response must not be cloned');});
    at(1000);return response;
  };
  async function emitNative(){
    if(modelNativeSent||!signal?.aborted||!co.report().journal.requests[0]?.timing.finished)return;
    modelNativeSent=true;
    await serverAborted.promise;await abortRecorded.promise;
    if(!occupied){blockOriginalConfirmation=true;heldAck.reject(Error('LOCAL_MODELED_HOST_STOP'));await drain();assert.ok(blockedReads>0);blockOriginalConfirmation=false;}
    if(fault==='missing-native')return;
    const entry=co.report().journal.requests[0],value=JSON.parse(readRow(cancelSeed.key).value);
    const warningAt=Date.parse(value.at)+30000;at(Math.max(ms,entry.timing.cancel.monoMs+31000),new Date(warningAt+1000).toISOString());
    session.receive(Buffer.from(JSON.stringify({scriptName:g.worker,scriptVersion:{id:session.plan.version},outcome:'ok',eventTimestamp:Date.parse(entry.headersAt),
      event:{request:{url:PEER_V3_PRIMARY_URL,method:'POST',headers:{'x-c02-sse-host-expiry':'v1','x-c02-sse-cancel-observe':'v1','x-c02-sse-snapshot':probeHeader}},response:{status:200}},
      logs:[{level:'warn',message:[SSE_HOST_EXPIRY_WARNING],timestamp:warningAt}],exceptions:[]})));
  }
  onSleep=emitNative;
  const readObservation=async()=>{
    readObservationCalls++;await reached.promise;
    if(!signal.aborted)at(Math.max(ms,1100));
    const value=observation();
    if(fault==='changed-native'&&signal.aborted)value.upstream.events[0].at++;
    return value;
  };
  const readCancel=async()=>readRow(cancelSeed.key);
  const readFacts=async()=>({observed:financial(),probeRows:[readRow(snapshotRow.key)],cancelRows:[readRow(cancelSeed.key)]});
  const storage=await resolveWorkerStorageFromBindings(env);
  const runRecovery=async({expected})=>{
    rpcCalls++;at(ms+1000,wall);
    const result=await runUsageRecoveryD1(storage.client,{scope:{kind:'tenant',userId:fixture.ids.user,workspaceId:fixture.ids.workspace},maxItems:2,concurrency:1,
      leaseSeconds:10,runBudgetMs:5000,reservedBytesPerConsumer:1024},{tryAcquire(){return {release(){}};}});
    assert.equal(result.committed,expected);
    if(fault==='rpc-ack-lost')throw Error('LOCAL_SECRET_RPC');
    return {status:200,body:{status:'finished',runId:randomUUID(),retry_safe:false,result}};
  };
  // Fixed-scope management is modeled. SQLite revocation, full-field financial
  // reconciliation, monotonic safety wait and atomic deletion are actual code.
  const state=new Map([g,c].map(target=>[target.worker,{enabled:true,previews_enabled:false}]));
  const apps=new Map([g,c].map(target=>[target.app,{id:target.app,type:'self_hosted',domain:target.domain,aud:target.audience,destinations:[{type:'public',uri:target.domain}],
    service_auth_401_redirect:true,policies:[{id:target.policy,name:target===g?'CinaToken staging closed':'CinaToken recovery staging closed',precedence:1,
      decision:'non_identity',include:[],exclude:[],require:[]}]}]));
  const tokenId=randomUUID(),tailId=randomUUID().replaceAll('-',''),foreignTail=randomUUID().replaceAll('-','');
  let tokens=[{id:tokenId,name:session.plan.tokenName,enabled:true}],tails=[{id:tailId},{id:foreignTail}],socketStopped=false,deleteBatches=0;
  for(const app of apps.values())app.policies[0].include=[{service_token:{token_id:tokenId}}];
  const api=async(path,method='GET',value)=>{
    calls.push({path,method});
    if(path==='/d1/database/'+g.database)return {uuid:g.database,name:'cinatoken-staging'};
    if(path==='/access/service_tokens')return structuredClone(tokens);
    if(path==='/access/service_tokens/'+tokenId){
      if(method==='PUT')tokens[0].enabled=false;
      if(method==='DELETE'){assert.ok([...apps.values()].every(a=>a.policies[0].decision==='deny'));tokens=[];}
      return {};
    }
    if(path==='/workers/scripts/'+g.worker+'/tails')return structuredClone(tails);
    if(path==='/workers/scripts/'+g.worker+'/tails/'+tailId){assert.equal(method,'DELETE');tails=tails.filter(t=>t.id!==tailId);return {};}
    for(const target of [g,c]){
      if(path==='/workers/scripts/'+target.worker+'/subdomain'){
        if(method==='POST'){assert.deepEqual(value,{enabled:false,previews_enabled:false});state.set(target.worker,{...value});}
        return {...state.get(target.worker)};
      }
      if(path==='/access/apps/'+target.app){if(method==='PUT')apps.set(target.app,structuredClone(value));return structuredClone(apps.get(target.app));}
      if(path==='/access/apps/'+target.app+'/policies/'+target.policy){assert.equal(method,'PUT');apps.get(target.app).policies=[{id:target.policy,...value}];return {};}
    }
    assert.fail('Unexpected local management target');
  };
  const batch=async statements=>{
    if(statements.some(q=>q.sql.startsWith('DELETE'))){
      deleteBatches++;assert.equal(signal?.aborted,true);assert.ok(co.report().journal.requests[0].timing.finished);
      assert.ok(ms>=351001);assert.ok([...state.values()].every(v=>!v.enabled));assert.deepEqual(tails,[{id:foreignTail}]);assert.equal(tokens.length,0);assert.equal(socketStopped,true);
      assert.equal(co.report().peerReport.stopped,true);
    }
    return (await db.binding.batch(statements.map(q=>db.binding.prepare(q.sql).bind(...q.params)))).map(r=>r.results.map(row=>({...row})));
  };
  const finalizer=createSseCapacityPeerFinalizerV3({session,coordinator:co,api,batch,persist,reserve,tail:{creation:'attempted',id:tailId},stopTail(){socketStopped=true;}});
  const window=createSseCapacityPeerWindowV3({session,coordinator:co,finalizer,fixture,key,ownership:{runId,tokenName:session.plan.tokenName,tokenId},
    accessHeaders:{'cf-access-client-id':'local-id','cf-access-client-secret':'LOCAL_SECRET_NOT_EVIDENCE'},
    fetchImpl,readObservation,readCancel,readFacts,runRecovery,persist});
  return {window,co,session,db,financial,saved,calls,waits,state,finalizer,
    model:{native:true,elapsedClock:true,webSocketPair:true,management:true,actualSqlite:true,actualLoopbackSocket:true,actualLoopbackHttp:true},
    get sends(){return sends;},get readers(){return readers;},get clones(){return clones;},get attempts(){return attempts;},get reserved(){return reserved;},
    get rpcCalls(){return rpcCalls;},get deleteBatches(){return deleteBatches;},get tokens(){return tokens;},get tails(){return tails;},get signal(){return signal;}};
}
