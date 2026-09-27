import assert from 'node:assert/strict';
import {SSE_STAGING_SCOPE} from '../../../../scripts/deploy/staging-sse-reconciliation.mjs';
import {extractSseHostExpiryTail,SSE_HOST_EXPIRY_WARNING} from '../../../../scripts/deploy/staging-sse-host-expiry-evidence.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createSqliteD1} from '../../src/test-support/sqlite-d1.ts';
import {drainNodeBackgroundWork} from '../../src/runtime/schedule-background-work.ts';
import {resolveWorkerStorageFromBindings} from '../../src/runtime/workers.ts';
import {runUsageRecoveryD1} from '../../../core/src/storage/recovery/run-usage-recovery-d1.ts';
import {imageSseFixture} from '../../../../scripts/deploy/staging-image-sse-fixture.mjs';
import {sqliteTotalChangesBinding} from './sqlite-total-changes-binding.mjs';
import {sseSnapshotFaultRow} from './images-sse-snapshot-fault-v2.ts';
import {SSE_SNAPSHOT_HEADER} from './images-sse-snapshot-gateway-handler-v2.ts';
import {SSE_CANCEL_HEADER} from './images-sse-cancel-gateway-handler.ts';
import {sseCancelObservationRow} from './images-sse-cancel-observer.ts';
import {SSE_HOST_EXPIRY_MS,withSseSnapshotHostExpiry} from './images-sse-host-expiry.ts';
import {createImagesSseHostExpiryGateway,SSE_HOST_EXPIRY_HEADER} from './images-sse-host-expiry-gateway-handler.ts';

const flush=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
// Capture real timers before tests install mocked timers. Readiness failures
// must remain terminal even when no mocked deadline has been advanced.
const realSetTimeout=globalThis.setTimeout,realClearTimeout=globalThis.clearTimeout;
export async function awaitPeerTestReadiness(readiness,{owner,label='peer fixture readiness'}={}){
  let timer;
  const earlyEnd=owner?.then(()=>{throw Error(label+' owner ended before readiness');});
  try {
    return await Promise.race([
      ...(earlyEnd?[readiness,earlyEnd]:[readiness]),
      new Promise((_,reject)=>{timer=realSetTimeout(()=>reject(Error(label+' timed out')),5000);}),
    ]);
  }finally{realClearTimeout(timer);}
}
export async function setupPeerFinalizerCleanup(t,mode,{modelPlatform=true,cancel=true,recover=true}={}){
  const db=createSqliteD1(),tasks=[],key='synthetic-'+randomUUID();let controller=new AbortController();
  t.mock.method(globalThis,'fetch',async()=>{throw Error('External network forbidden');});
  for(const method of ['log','warn','error'])t.mock.method(console,method,()=>{});
  for(const name of ['request-dispatch-intents','request-usage-settlements','request-usage-recovery-jobs'])
    db.sqlite.exec(readFileSync(new URL(`../../../core/migrations-proposals/d1/${name}.sql`,import.meta.url),'utf8'));
  const other=await imageSseFixture('c02-success-'+randomUUID(),'sha256:'+'b'.repeat(64),new Date(Date.now()+3600000).toISOString());
  for(const q of other.seed)db.sqlite.prepare(q.sql).run(...q.params);
  const counts=()=>Object.fromEntries(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,db.sqlite.prepare('SELECT COUNT(*) n FROM '+name).get().n]));
  const otherRows=()=>['users','workspaces','api_keys','models','providers','model_routes','model_endpoints'].map(table=>db.sqlite.prepare('SELECT * FROM '+table+' WHERE id LIKE ? ORDER BY id').all(other.ids.runId+'%'));
  const baseline=counts(),unrelated=otherRows();
  let probe={runId:'c02-success-'+randomUUID(),probeId:randomUUID(),mode};
  const keyHash='sha256:'+createHash('sha256').update(key).digest('hex'),expiresAt=new Date(Date.now()+3600000).toISOString();
  const fixture=await imageSseFixture(probe.runId,keyHash,expiresAt);
  for(const s of fixture.seed)db.sqlite.prepare(s.sql).run(...s.params);
  for(const row of [sseSnapshotFaultRow(probe),sseCancelObservationRow(probe)])
    db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(row.key,row.value,row.description);
  let sends=0,markerReads=0;
  db.hooks.beforeStatement=(sql)=>{
    if(sql==='SELECT value FROM system_config WHERE key=? AND description=?')markerReads++;
    // Preserve a real pending-job negative fixture: confirmation read is unavailable.
    if(!recover&&sql==='SELECT * FROM request_usage_settlements WHERE request_id=? AND user_id=? AND api_key_id=? AND workspace_id=? AND payload_sha256=?')
      throw Error('LOCAL_MODELED_CONFIRMATION_UNAVAILABLE');
  };
  const app=createImagesSseHostExpiryGateway(async(input,init)=>{
    sends++;const headers=new Headers(init.headers);
    for(const h of [SSE_HOST_EXPIRY_HEADER,SSE_SNAPSHOT_HEADER,SSE_CANCEL_HEADER])assert.equal(headers.has(h),false);
    return new Response('data: '+JSON.stringify({type:'image_generation.completed',b64_json:'AQID',usage:{input_tokens:3,output_tokens:7,total_tokens:10}})+'\n\ndata: [DONE]\n\n',
      {headers:{'Content-Type':'text/event-stream'}});
  });
  // Local fault model: once the host-stop boundary is triggered, the original
  // producer cannot resume SQL in a later microtask. The independent recovery
  // storage below still uses the same real SQLite database. This is NOT proof
  // that Cloudflare killed an invocation; native acceptance uses real tail data.
  let producerStopped=false;
  const producerNative=sqliteTotalChangesBinding(db), producerStatements=new WeakMap();
  const active=()=>{if(producerStopped)throw Error('LOCAL_MODELED_PRODUCER_TERMINATED');};
  const wrapProducer=native=>{
    const statement={bind(...args){active();return wrapProducer(native.bind(...args));}};
    for(const method of ['run','all','first','raw'])statement[method]=(...args)=>{active();return native[method](...args);};
    producerStatements.set(statement,native);return statement;
  };
  const producerDB={...producerNative,prepare(sql){active();return wrapProducer(producerNative.prepare(sql));},
    batch(statements){active();return producerNative.batch(statements.map(s=>{const native=producerStatements.get(s);assert.ok(native);return native;}));}};
  const env={DB:producerDB,DATABASE_DRIVER:'d1',SHARED_KEY_ENCRYPTION_SECRET:'synthetic-expiry-material-not-for-real-secrets',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false'};
  let resolveHeld,rejectHeld;
  const context={waitUntil(p){assert.equal(this,context);tasks.push(p);p.catch(error=>rejectHeld?.(error));},abort(){assert.fail('Native abort is forbidden in natural expiry profile');}};
  const storage=await resolveWorkerStorageFromBindings({...env,DB:sqliteTotalChangesBinding(db)});
  const recoverOnce=()=>runUsageRecoveryD1(storage.client,{scope:{kind:'tenant',userId:fixture.ids.user,workspaceId:fixture.ids.workspace},maxItems:2,concurrency:1,leaseSeconds:10,runBudgetMs:5000,reservedBytesPerConsumer:1024},{tryAcquire(){return {release(){}};}});
  let rowKey='c02_sse_snapshot:'+probe.probeId;
  let stop;
  // State-model injection, NOT platform evidence: lose the held-marker acknowledgement.
  // The original held JSON is never rewritten or normalized, and SQL is already committed.
  db.hooks.afterStatement=async(sql,values)=>{
    if(sql.startsWith('UPDATE system_config SET value=')&&values[2]===rowKey
      &&['held-before-insert','held-after-insert'].includes(JSON.parse(values[0]).phase)){
      resolveHeld();
      if(modelPlatform)await new Promise((resolve,reject)=>{stop=()=>reject(Error('LOCAL_MODELED_HOST_STOP'));});
    }
  };
  const read=()=>JSON.parse(db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(rowKey).value);
  const financial=()=>['request_dispatch_intents','request_usage_settlements','request_usage_recovery_jobs','request_usage_commit_receipts','api_key_request_logs','user_budget_reservations']
    .map(table=>db.sqlite.prepare('SELECT * FROM '+table).all().map(row=>({...row})));
  const request=(overrides={})=>new Request('https://example.invalid/v1/images/generations',{method:'POST',signal:controller.signal,
    headers:{Authorization:'Bearer '+key,'Content-Type':'application/json',[SSE_HOST_EXPIRY_HEADER]:'v1',[SSE_CANCEL_HEADER]:'v1',
      [SSE_SNAPSHOT_HEADER]:`c02-snapshot:${probe.runId}:${probe.probeId}:${mode}`,...overrides},
    body:JSON.stringify({model:fixture.cases['small-generations'].model,prompt:'synthetic expiry',stream:true})});
  t.mock.timers.enable({apis:['setTimeout']});
  t.after(()=>awaitPeerTestReadiness((async()=>{controller.abort();stop?.();await flush();t.mock.timers.tick(45000);await flush();t.mock.timers.tick(45000);await Promise.allSettled(tasks);await drainNodeBackgroundWork();db.sqlite.close();})(),{label:'peer fixture cleanup'}));
  const journal={runId:probe.runId,keyHash,expiresAt,requests:[],probes:[]};
  const platform={version:randomUUID(),events:[]},saved=[],apiCalls=[],batches=[];
  const perform=async()=>{
  const held=new Promise((resolve,reject)=>{resolveHeld=resolve;rejectHeld=reject;});held.catch(()=>{});
  const startedAt=new Date().toISOString(),response=await app.fetch(request(),env,context),headersAt=new Date().toISOString();
  assert.equal(response.status,200);const id=response.headers.get('X-Generation-Id'),upstreamProbeId=randomUUID();
  const reader=response.body.getReader();await reader.read();const pending=reader.read();pending.catch(()=>{});
  await held;
  assert.equal(read().phase,mode==='before-hold'?'held-before-insert':'held-after-insert');await flush();
  const cancelIssuedAt=new Date().toISOString();if(cancel)controller.abort();await reader.cancel();await pending;await flush();
  if(recover)assert.equal((await recoverOnce()).committed,mode==='after-hold'?1:0);
  if(modelPlatform){producerStopped=true;stop();}else t.mock.timers.tick(SSE_HOST_EXPIRY_MS);
  await flush();await Promise.allSettled(tasks);await drainNodeBackgroundWork();
  if(recover)assert.equal((await recoverOnce()).committed,0);
  const entry={id,mode,probeId:probe.probeId,upstreamProbeId,startedAt,headersAt,cancelIssuedAt};
  const u={runId:probe.runId,probeId:upstreamProbeId,mode:'success'};
  // Cleanup-only synthetic upstream fixture. Actual upstream behavior is tested separately.
  const up={...u,phase:'terminal',windowProfile:'completed-and-done',
    events:['completed-enqueued','done-enqueued','terminal'].map(phase=>({phase,at:Date.now(),...(phase==='terminal'?{reason:'response_cancel'}:{})}))};
  db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run('c02_images_sse_probe:'+upstreamProbeId,JSON.stringify(up),'c02-sse:'+probe.runId);
  journal.requests.push(entry);journal.probes.push(u);
  if(modelPlatform&&cancel){
    const observed=JSON.parse(db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get('c02_sse_cancel:'+probe.probeId).value);
    const at=Date.parse(observed.at)+30000;
    // Synthetic log envelope exercises the validator contract; it is never published as cloud proof.
    platform.events.push(extractSseHostExpiryTail({scriptName:'cinatoken-proxy-staging',scriptVersion:{id:platform.version},outcome:'ok',eventTimestamp:Date.parse(headersAt),
      event:{request:{url:'https://cinatoken-proxy-staging.cinagroup.workers.dev/v1/images/generations',method:'POST',headers:Object.fromEntries([SSE_HOST_EXPIRY_HEADER,SSE_CANCEL_HEADER,SSE_SNAPSHOT_HEADER].map(h=>[h,request().headers.get(h)]))},response:{status:200}},
      logs:[{level:'warn',message:[SSE_HOST_EXPIRY_WARNING],timestamp:at}],exceptions:[]},new Date(at+1000).toISOString()));
  }
  };
  await awaitPeerTestReadiness(perform(),{label:'peer fixture held marker'});
  const repeat=async nextMode=>{
    assert.ok(!journal.requests.some(r=>r.mode===nextMode));mode=nextMode;
    producerStopped=false;probe={runId:journal.runId,probeId:randomUUID(),mode};rowKey='c02_sse_snapshot:'+probe.probeId;controller=new AbortController();stop=undefined;
    for(const row of [sseSnapshotFaultRow(probe),sseCancelObservationRow(probe)])db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(row.key,row.value,row.description);
    await awaitPeerTestReadiness(perform(),{label:'peer fixture repeated held marker'});
  };
  const api=async(path,method)=>{
    apiCalls.push({path,method:method??'GET'});assert.ok(!method||method==='GET');
    const x=SSE_STAGING_SCOPE;
    if(path===`/workers/scripts/${x.worker}/subdomain`)return {enabled:false,previews_enabled:false};
    if(path===`/access/apps/${x.app}`)return {id:x.app,type:'self_hosted',domain:x.domain,aud:x.audience,destinations:[{type:'public',uri:x.domain}],
      policies:[{id:x.policy,name:'CinaToken staging closed',precedence:1,decision:'deny',include:[{everyone:{}}],exclude:[],require:[]}]};
    if(path===`/d1/database/${x.database}`)return {uuid:x.database,name:'cinatoken-staging'};
    assert.fail('Unexpected API target '+path);
  };
  const batch=async statements=>{
    batches.push(structuredClone(statements));assert.ok(statements.length<=256&&statements.every(q=>q.params.length<=100&&Buffer.byteLength(q.sql)<=100000));
    assert.ok(Buffer.byteLength(JSON.stringify(statements))<=1048576);
    return (await db.binding.batch(statements.map(q=>db.binding.prepare(q.sql).bind(...q.params)))).map(r=>r.results);
  };
  const options=()=>({api,batch,journal,platform,nowMs:Date.now()+360000,persist:async e=>saved.push(structuredClone(e))});
  return {db,get probe(){return probe;},read,financial,get rowKey(){return rowKey;},journal,platform,options,saved,apiCalls,batches,counts,baseline,otherRows,unrelated,recoverOnce,repeat,get sends(){return sends;}};
}
