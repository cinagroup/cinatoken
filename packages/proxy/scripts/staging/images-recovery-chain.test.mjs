import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createImageUsageRecoveryFactory } from '../../src/services/image-usage-recovery.ts';
import { setup } from './images-recovery-test-support.mjs';
import upstream from './images-upstream.ts';

const latch = () => { let resolve; const promise=new Promise(r=>{resolve=r;});return {promise,resolve}; };
const tick = () => new Promise(resolve=>setImmediate(resolve));

for(const operation of ['generations','edits'])for(const cost of [0,0.1]) {
  test(`opt-in real Images route persists and settles ${operation}, synthetic cost ${cost}`,async t=>{
    const f=await setup(t,{cost});
    const response=await f.request(operation);
    assert.equal(response.status,200,JSON.stringify(f.messages));
    assert.equal((await response.json()).data[0].b64_json,'AQID');
    await f.drain();
    assert.equal(f.sends,1);
    const snapshot=f.row('SELECT * FROM request_usage_settlements');
    assert.ok(snapshot);assert.ok(Buffer.byteLength(snapshot.payload_json)<=256*1024);
    const payload=JSON.parse(snapshot.payload_json);
    assert.equal(payload.params.requestLog.requestOperation,'images.'+operation);
    assert.equal(payload.params.chargedCost,cost);
    for(const forbidden of ['private-prompt-marker','c02-staging-synthetic-provider','@example.invalid'])assert.equal(snapshot.payload_json.includes(forbidden),false);
    assert.equal(f.row('SELECT state FROM request_usage_recovery_jobs').state,'committed');
    assert.equal(f.row('SELECT COUNT(*) AS n FROM request_usage_commit_receipts').n,1);
    assert.equal(f.row('SELECT COUNT(*) AS n FROM api_key_request_logs').n,1);
    assert.equal(f.row('SELECT budget_spent_micros FROM users WHERE id=?',f.fixture.ids.user).budget_spent_micros,cost*1000000);
    assert.equal(f.row('SELECT COALESCE(SUM(request_count),0) AS n FROM public_model_daily_stats').n,1);
    assert.equal((await f.recover()).claimed,0);
  });
}

for(const boundary of ['snapshot','job-confirmation']) {
  test(`success delivery waits for ${boundary} acknowledgement`,{timeout:10000},async t=>{
    const entered=latch(),release=latch();let armed=true;
    const f=await setup(t,{hooks:{async afterStatement(sql){
      if(armed && (boundary==='snapshot'?sql.startsWith('INSERT INTO request_usage_settlements'):sql.startsWith('SELECT * FROM request_usage_recovery_jobs'))) {
        armed=false;entered.resolve();await release.promise;
      }
    }}});
    let delivered=false;
    const pending=f.request().then(response=>{delivered=true;return response;});
    try {
      await entered.promise;await tick();
      assert.equal(delivered,false);
      assert.equal(f.row('SELECT COUNT(*) AS n FROM request_usage_settlements').n,1);
      assert.equal(f.row('SELECT state FROM request_usage_recovery_jobs').state,'pending');
      assert.equal(f.row('SELECT COUNT(*) AS n FROM api_key_request_logs').n,0);
    } finally {release.resolve();}
    const response=await pending;assert.equal(response.status,200);await response.body.cancel();
    await f.drain();assert.equal(f.row('SELECT COUNT(*) AS n FROM api_key_request_logs').n,1);
  });
}

for(const mode of ['before-insert','insert-ack-lost','readback-unavailable','job-readback-unavailable']) {
  test(`durable acceptance fault: ${mode}`,async t=>{
    let fault=true,inserted=false;
    const f=await setup(t,{cost:0.1,hooks:{
      beforeStatement(sql){
        if(!fault)return;
        if(mode==='before-insert'&&sql.startsWith('INSERT INTO request_usage_settlements'))throw new Error('Synthetic pre-insert failure');
        if(inserted&&mode==='readback-unavailable'&&sql.startsWith('SELECT * FROM request_usage_settlements'))throw new Error('Synthetic unavailable snapshot readback');
        if(inserted&&mode==='job-readback-unavailable'&&sql.startsWith('SELECT * FROM request_usage_recovery_jobs'))throw new Error('Synthetic unavailable job readback');
      },
      afterStatement(sql){if(fault&&sql.startsWith('INSERT INTO request_usage_settlements')){
        inserted=true;if(mode==='insert-ack-lost'||mode==='readback-unavailable')throw new Error('Synthetic snapshot ACK loss');
      }},
    }});
    const response=await f.request();
    assert.equal(response.status,mode==='insert-ack-lost'?200:503);
    const body=await response.json();if(response.status===503){assert.match(body.error.message,/may have completed/);assert.equal(body.code,'gateway.image_settlement_unconfirmed');assert.equal(body.error.metadata.retry_safe,false);}
    await f.drain();assert.equal(f.sends,1);
    assert.equal(f.row('SELECT state FROM request_dispatch_intents').state,'dispatch_claimed');
    if(mode!=='insert-ack-lost') {
      assert.equal(f.row('SELECT COUNT(*) AS n FROM api_key_request_logs').n,0);
      assert.equal(f.row('SELECT state FROM user_budget_reservations').state,'dispatched');
      assert.equal(f.row('SELECT budget_spent_micros FROM users WHERE id=?',f.fixture.ids.user).budget_spent_micros,0);
    }
    fault=false;
    const result=await f.recover();
    assert.equal(result.committed,['readback-unavailable','job-readback-unavailable'].includes(mode)?1:0);
    assert.equal(f.row('SELECT COUNT(*) AS n FROM api_key_request_logs').n,mode==='before-insert'?0:1);
    assert.equal(f.sends,1,'recovery must never replay inference');
  });
}

for(const mode of ['before-ledger','ledger-ack-lost','lease-ack-lost']) {
  test(`post-acceptance ${mode} is recoverable without duplicate charges or repricing`,async t=>{
    let fault=true;
    const f=await setup(t,{cost:0.1,hooks:{
      beforeStatement(sql){if(fault&&mode==='before-ledger'&&sql.startsWith('INSERT INTO api_key_request_logs'))throw new Error('Synthetic accounting unavailable');},
      afterStatement(sql){if(fault&&mode==='lease-ack-lost'&&sql.startsWith('UPDATE request_usage_recovery_jobs SET')&&sql.includes('attempts=MIN'))throw new Error('Synthetic claim ACK loss');},
      afterBatch(sql){if(fault&&mode==='ledger-ack-lost'&&sql.some(s=>s.startsWith('INSERT INTO api_key_request_logs')))throw new Error('Synthetic committed batch ACK loss');},
    }});
    const response=await f.request();assert.equal(response.status,200);await response.body.cancel();await f.drain();
    assert.equal(f.row('SELECT COUNT(*) AS n FROM request_usage_settlements').n,1);
    const already=mode==='ledger-ack-lost';
    assert.equal(f.row('SELECT COUNT(*) AS n FROM api_key_request_logs').n,already?1:0);
    assert.equal(f.row('SELECT state FROM request_usage_recovery_jobs').state,already?'committed':mode==='lease-ack-lost'?'leased':'pending');
    // Later endpoint tariff changes are not consulted by replay.
    f.db.sqlite.prepare("UPDATE model_endpoints SET image_capabilities='{}'").run();
    fault=false;f.advance(11);
    assert.equal((await f.recover()).committed,already?0:1);
    assert.equal((await f.recover()).claimed,0);
    assert.equal(f.row('SELECT charged_cost FROM api_key_request_logs').charged_cost,0.1);
    assert.equal(f.row('SELECT COUNT(*) AS n FROM request_usage_commit_receipts').n,1);
    assert.equal(f.row('SELECT budget_spent_micros FROM users WHERE id=?',f.fixture.ids.user).budget_spent_micros,100000);
    assert.equal(f.row('SELECT COUNT(*) AS n FROM user_audit_logs WHERE event_type=?','usage_charge').n,1);
    assert.equal(f.row('SELECT COALESCE(SUM(request_count),0) AS n FROM public_model_daily_stats').n,1);
    assert.equal(f.sends,1);
  });
}

for(const schema of [0,1,2]) {
  test(`partial schema ${schema}/3 fails before provider I/O`,async t=>{
    const f=await setup(t,{schema,cost:0.1});const response=await f.request();await response.body.cancel();await f.drain();
    assert.notEqual(response.status,200);assert.equal(f.sends,0);
    assert.equal(f.row('SELECT budget_spent_micros FROM users WHERE id=?',f.fixture.ids.user).budget_spent_micros,0);
  });
}
for(const trigger of ['request_dispatch_intents_forward_only','request_usage_settlements_claim','request_usage_settlements_immutable','request_usage_commit_receipts_immutable','request_usage_recovery_identity','request_usage_recovery_enqueue','request_usage_recovery_transition','request_usage_recovery_fence','request_usage_recovery_complete']) {
  test(`missing ${trigger} fails before provider I/O`,async t=>{
    const f=await setup(t);f.db.sqlite.exec(`DROP TRIGGER ${trigger}`);
    const response=await f.request();await response.body.cancel();await f.drain();
    assert.notEqual(response.status,200);assert.equal(f.sends,0);
  });
}

test('enqueue disappears after dispatch: definition recheck prevents snapshot and success delivery',async t=>{
  let f;
  f=await setup(t,{transport:async(input,init)=>{f.db.sqlite.exec('DROP TRIGGER request_usage_recovery_enqueue');return upstream.fetch(new Request(input,init));}});
  const response=await f.request();assert.equal(response.status,503);await response.body.cancel();await f.drain();
  assert.equal(f.sends,1);assert.equal(f.row('SELECT COUNT(*) AS n FROM request_usage_settlements').n,0);
  assert.equal(f.row('SELECT COUNT(*) AS n FROM request_usage_recovery_jobs').n,0);
  assert.equal(f.row('SELECT COUNT(*) AS n FROM api_key_request_logs').n,0);
});

test('default route still works with only the formal schema and no recovery SQL',async t=>{
  const f=await setup(t,{schema:0,enabled:false,cost:0.1,hooks:{beforeStatement(sql){assert.equal(/request_(?:usage_(?:settlements|recovery_jobs|commit_receipts)|dispatch_intents)/.test(sql),false);}}});
  const response=await f.request();assert.equal(response.status,200);await response.body.cancel();await f.drain();
  assert.equal(f.sends,1);assert.equal(f.row('SELECT charged_cost FROM api_key_request_logs').charged_cost,0.1);
});

test('recovery projection omits arbitrary upstream usage extensions',async t=>{
  const f=await setup(t,{transport:async()=>Response.json({created:123,data:[{b64_json:'AQID'}],usage:{total_tokens:10,input_tokens:9,output_tokens:1,secret_extension:'private-upstream-marker'}})});
  const response=await f.request();assert.equal(response.status,200);await response.body.cancel();await f.drain();
  const payload=f.row('SELECT payload_json FROM request_usage_settlements').payload_json;
  assert.equal(payload.includes('private-upstream-marker'),false);
  assert.equal(JSON.parse(JSON.parse(payload).params.requestLog.rawUsage).total_tokens,10);
});

test('cancellation during persistence does not detach its write or reverse already accepted usage', {timeout:10000},async t=>{
  const entered=latch(),release=latch(),controller=new AbortController();let armed=true,delivered=false;
  const f=await setup(t,{cost:0.1,hooks:{async afterStatement(sql){if(armed&&sql.startsWith('INSERT INTO request_usage_settlements')){armed=false;entered.resolve();await release.promise;}}}});
  const pending=f.request('generations',{},controller.signal).then(response=>{delivered=true;return response;});
  try {await entered.promise;controller.abort();await tick();assert.equal(delivered,false);assert.equal(f.row('SELECT state FROM request_usage_recovery_jobs').state,'pending');}
  finally {release.resolve();}
  const response=await pending;await response.body?.cancel().catch(()=>undefined);await f.drain();
  assert.equal(f.row('SELECT charged_cost FROM api_key_request_logs').charged_cost,0.1);
  assert.equal(f.row('SELECT state FROM request_usage_recovery_jobs').state,'committed');assert.equal(f.sends,1);
});

test('explicit SSE retains its separate legacy contract and never creates ordinary recovery rows',async t=>{
  const f=await setup(t,{expectIntent:false,transport:async()=>new Response('data: {"type":"image_generation.completed","b64_json":"AQID","created":1}\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}})});
  const endpoint=f.fixture.cases['small-generations'].endpoint;
  const caps=JSON.parse(f.row('SELECT image_capabilities FROM model_endpoints WHERE id=?',endpoint).image_capabilities);
  caps.supports_streaming=true;
  f.db.sqlite.prepare('UPDATE model_endpoints SET image_capabilities=? WHERE id=?').run(JSON.stringify(caps),endpoint);
  const response=await f.request('generations',{stream:true});
  assert.equal(response.status,200,JSON.stringify(f.messages));assert.match(response.headers.get('content-type'),/text\/event-stream/);
  assert.match(await response.text(),/image_generation.completed/);await f.drain();
  assert.equal(f.sends,1);assert.equal(f.row('SELECT COUNT(*) AS n FROM api_key_request_logs').n,1);
  assert.equal(f.row('SELECT COUNT(*) AS n FROM request_dispatch_intents').n,0);
  assert.equal(f.row('SELECT COUNT(*) AS n FROM request_usage_settlements').n,0);
});

async function producer(t, providerKeyId=null) {
  const f=await setup(t),chosen=f.fixture.cases['small-generations'],requestId='gen-'+randomUUID();
  const scope={requestId,userId:f.fixture.ids.user,apiKeyId:f.fixture.ids.key,workspaceId:f.fixture.ids.workspace,
    modelId:chosen.model,operation:'images.generations',expiresAtMs:Date.now()+60000};
  const request=createImageUsageRecoveryFactory(f.storage,{settlementLeaseSeconds:10})(scope);
  const route={providerId:chosen.provider,targetId:chosen.route,providerKeyId,endpoint:{id:chosen.endpoint},apiKey:'private-route-credential'};
  await request.beforeDispatch(route,1,async()=>{},()=>{});
  const params={repos:f.storage.repositories,providerKeyId,requestLogId:requestId,userId:scope.userId,apiKeyId:scope.apiKeyId,workspaceId:scope.workspaceId,userEmail:null,
    modelId:chosen.model,providerId:chosen.provider,routeTargetId:chosen.route,requestProtocol:'openai',upstreamProtocol:'openai',requestOperation:scope.operation,
    routeGroup:'default',status:'success',latencyMs:1,billing:{modelPricingProfileJson:null,imageCount:1,operation:'generations'},
    resultConfirmed:true,effectiveImageCount:1,timing:{upstreamAttemptCount:1,upstreamFailoverCount:0,providerAttempts:[{attemptIndex:1,routeTargetId:chosen.route,providerId:chosen.provider,outcome:'available',reason:'accepted',httpStatus:200,observedAtIso:new Date().toISOString()}]},
  };
  return {f,request,scope,route,params};
}

for(const field of ['requestLogId','userId','apiKeyId','workspaceId','modelId','providerId','routeTargetId','providerKeyId','requestOperation','responseStreamed','repos']) {
  test('trusted producer rejects mismatched '+field+' without creating a snapshot',async t=>{
    const {f,request,params}=await producer(t);
    await assert.rejects(request.persist({...params,[field]:field==='repos'?{}:field==='responseStreamed'?true:'foreign-identity'}),/identity conflict/);
    assert.equal(f.row('SELECT COUNT(*) AS n FROM request_usage_settlements').n,0);
    assert.equal(f.row('SELECT COUNT(*) AS n FROM api_key_request_logs').n,0);
  });
}

test('trusted producer owns scope, chosen identity and accounting inputs across its first await',async t=>{
  const {f,request,scope,route,params}=await producer(t);
  const requestId=params.requestLogId,model=params.modelId;
  scope.requestId='foreign-scope';route.providerId='foreign-provider';route.apiKey='second-private-credential';
  const pending=request.persist(params);
  params.modelId='foreign-model';params.billing.imageCount=9;params.timing.providerAttempts[0].providerId='foreign-attempt';
  const settle=await pending;
  const payload=JSON.parse(f.row('SELECT payload_json FROM request_usage_settlements').payload_json);
  assert.equal(payload.intent.requestId,requestId);assert.equal(payload.params.requestLog.modelId,model);
  assert.equal(JSON.stringify(payload).includes('private-credential'),false);
  assert.equal(f.row('SELECT COUNT(*) AS n FROM api_key_request_logs').n,0,'prepare/persist are not economic writes');
  await settle();assert.equal(f.row('SELECT COUNT(*) AS n FROM api_key_request_logs').n,1);
  await settle();assert.equal(f.row('SELECT COUNT(*) AS n FROM api_key_request_logs').n,1);
});

test('producer rejects oversized retained accounting fields before durable acceptance',async t=>{
  const {f,request,params}=await producer(t);
  await assert.rejects(request.persist({...params,providerModelName:'x'.repeat(513)}),/snapshot shape/);
  assert.equal(f.row('SELECT COUNT(*) AS n FROM request_usage_settlements').n,0);
  assert.equal(f.row('SELECT state FROM request_dispatch_intents').state,'dispatch_claimed');
});

test('private BYOK producer cannot persist an incomplete USD/BYOK accounting snapshot',async t=>{
  const {f,request,params}=await producer(t,'byok:synthetic-private-key');
  await assert.rejects(request.persist(params),/complete verified accounting snapshot/);
  assert.equal(f.row('SELECT COUNT(*) AS n FROM request_usage_settlements').n,0);
});
for(const origin of ['https://user:secret@example.invalid','https://example.invalid/private?q=secret','file:///private','x'.repeat(513)]) {
  test('producer rejects noncanonical gateway origin without retaining sensitive parts: '+origin.slice(0,20),async t=>{
    const {f,request,params}=await producer(t);
    await assert.rejects(request.persist({...params,requestOrigin:origin}),/Invalid recovery gateway origin/);
    assert.equal(f.row('SELECT COUNT(*) AS n FROM request_usage_settlements').n,0);
  });
}
