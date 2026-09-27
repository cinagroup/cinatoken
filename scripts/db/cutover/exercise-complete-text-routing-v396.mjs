import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createPostgresStorageContext } from '../../../packages/core/src/storage/context.ts';
import { computeRouteDataPolicySubjectFingerprintFromRows } from '../../../packages/core/src/route-data-policy.ts';
import { resetRouteStrategyCacheForTests } from '../../../packages/core/src/lib/route-strategy-system-config.ts';
import { createFinalChatQuoteSnapshot } from '../../../packages/proxy/src/services/chat-final-quote-input.ts';
import { parseOpenAiModelFallbacks } from '../../../packages/proxy/src/services/model-fallbacks.ts';
import { resolveRoutesForSurface } from '../../../packages/proxy/src/services/model-router.ts';
import { buildModelFallbackPlan } from '../../../packages/proxy/src/services/model-fallback-plan.ts';
import { readPostgresCompleteTextRoutingProjectionV396 } from '../../../packages/proxy/src/services/postgres-complete-text-routing-projection-v396.ts';
import { attestCompleteTextRoutingV396 } from './attest-complete-text-routing-v396.ts';
import { startJournalCommitAckDropProxyV381 } from '../../../packages/core/src/test-support/postgres-journal-commit-ack-proxy-v381.mjs';
import { exerciseCompleteTextRoutePreparationV398 } from './exercise-complete-text-route-preparation-v398.ts';

const g='cinatoken_gateway';
const sha=v=>createHash('sha256').update(v).digest('hex');
export async function exerciseCompleteTextRoutingV396({migrator,verifier,cap,complete,urls,cluster,bearer,stage,clients}) {
 await migrator.unsafe(`INSERT INTO ${g}.models(id,vendor) VALUES('v396-alpha','other'),('v396-beta','other');
  INSERT INTO ${g}.route_pools(id,model_id,name,status) VALUES('v396-pool-a','v396-alpha','Exact','active'),('v396-pool-b','v396-alpha','Wildcard','active'),('v396-pool-beta','v396-beta','Beta','active');
  INSERT INTO ${g}.model_surfaces(id,model_id,request_protocol,request_operation,route_pool_id,status) VALUES
   ('v396-exact','v396-alpha','openai','chat','v396-pool-a','active'),('v396-wild','v396-alpha','openai','*','v396-pool-b','active'),('v396-beta-surface','v396-beta','openai','*','v396-pool-beta','active');
  INSERT INTO ${g}.model_routes(id,model_id,provider_id,provider_model_name,route_pool_id,upstream_protocol,upstream_operation,adapter,status,priority,weight) VALUES
   ('v396-route-a','v396-alpha','v361-provider','wild','v396-pool-b','openai','chat','passthrough','active',40,1),
   ('v396-route-y','v396-alpha','v361-provider','same-exact','v396-pool-a','openai','chat','passthrough','active',20,3),
   ('v396-route-z','v396-alpha','v361-provider','exact','v396-pool-a','openai','chat','passthrough','active',10,1),
   ('v396-route-beta','v396-beta','v361-provider','beta','v396-pool-beta','openai','chat','passthrough','active',10,1);`).simple();
 for(const [target,model] of [['a','alpha'],['y','alpha'],['z','alpha'],['beta','beta']]){
  await migrator.unsafe(`INSERT INTO ${g}.model_endpoints(id,model_id,provider_id,provider_slug,tag,endpoint_class,context_length,max_completion_tokens,pricing,
   supports_implicit_caching,supports_voice_cloning,supports_tool_choice,evidence_url,verified_by,verified_at,expires_at,status)
   VALUES($1,$2,'v361-provider','v361-provider',$3,'standard',1000,1000,'{"currency":"USD","prompt":"0.000002","completion":"0.000004"}',false,false,
    '{"auto":false,"function":false,"none":false,"required":false}','https://evidence.invalid/v396','fixture',now()-interval '1 minute',now()+interval '5 minutes','verified')`,[`v396-endpoint-${target}`,`v396-${model}`,target]);
  await migrator.unsafe(`INSERT INTO ${g}.model_endpoint_routes(endpoint_id,route_target_id) VALUES($1,$2)`,[`v396-endpoint-${target}`,`v396-route-${target}`]);
 }
 await migrator.unsafe(`UPDATE ${g}.model_endpoints SET pricing='{"currency":"USD","prompt":"0.000018","completion":"0.000036"}' WHERE id='v396-endpoint-y'`);
 const attestSources=async()=>{
  for(const target of ['a','y','z','beta']){
   const [route]=await migrator.unsafe(`SELECT * FROM ${g}.model_routes WHERE id=$1`,[`v396-route-${target}`]);
   const [provider]=await migrator.unsafe(`SELECT * FROM ${g}.providers WHERE id=$1`,['v361-provider']);
   const fingerprint=await computeRouteDataPolicySubjectFingerprintFromRows(route,provider);
   await migrator.unsafe(`UPDATE ${g}.model_endpoint_routes SET subject_fingerprint=$1 WHERE route_target_id=$2`,[fingerprint,route.id]);
   const [f]=await verifier.unsafe(`SELECT generation::text AS generation FROM ${g}.route_source_generations_v359 WHERE route_target_id=$1`,[route.id]);
   const [r]=await verifier.unsafe(`SELECT ${g}.attest_text_route_source_v359($1,$2,$3) AS value`,[route.id,f.generation,fingerprint]);assert.equal(r.value.status,'attested');
  }
 };
 await attestSources();
 const storage=await createPostgresStorageContext(urls.runtime,{max:1,prepare:false,fetch_types:false,connect_timeout:3,idle_timeout:0,max_lifetime:0,backoff:false,onnotice(){}});
 clients.push(storage.client.raw);const repos=storage.repositories;
 const make=async()=>{
  const body={model:'v396-alpha',models:['v396-alpha','v396-beta'],messages:[{role:'user',content:'hello'}],max_completion_tokens:300};
  const parsed=parseOpenAiModelFallbacks(body);assert.equal(parsed.ok,true);
  const input=await createFinalChatQuoteSnapshot({requestId:`v396-${randomUUID()}`,originalBodySha256:sha(JSON.stringify(body)),finalBody:body,parsed:parsed.value});
  const [issued]=await cap.unsafe(`SELECT ${g}.issue_request_capability_v356($1,$2,$3) AS value`,[input.requestId,bearer,input.originalBodySha256]);assert.equal(issued.value.status,'issued');
  const [q]=await complete.unsafe(`SELECT ${g}.issue_complete_flat_text_quote_v360($1,$2,$3,$4) AS value`,[input.requestId,issued.value.capability,input.originalBodySha256,input.finalBodyUtf8]);
  assert.equal(q.value.status,'quoted_complete_subset');assert.equal(q.value.routeCount,4);
  const quote=q.value;
  return {body,input,quote};
 };
 const project=async(f,connection=urls.projector)=>readPostgresCompleteTextRoutingProjectionV396({projectorConnectionString:connection,quote:f.quote,finalQuoteInput:f.input});
 const attest=()=>attestCompleteTextRoutingV396({verifierConnectionString:urls.verifier,modelIds:['v396-alpha','v396-beta']});
 const actual=async()=>Promise.all(['v396-alpha','v396-beta'].map(modelId=>resolveRoutesForSurface(repos,{modelId,routeGroup:'default',requestProtocol:'openai',requestOperation:'chat'})));
 await attest();const first=await make();const projection=await project(first);const oracle=await actual();
 assert.deepEqual(projection.candidates.map(c=>c.routes.map(r=>r.targetId)),oracle.map(c=>c.routes.map(r=>r.targetId)));
 assert.deepEqual(projection.candidates.map(c=>c.routes.map(r=>r.targetId)),[['v396-route-y','v396-route-z'],['v396-route-beta']]);
 assert.equal(projection.candidates[0].surface.match,'exact');assert.equal(projection.candidates[1].surface.match,'wildcard');
 for(const forbidden of ['enc:v2:','v367-local.invalid','upstream-v361','providerModelName','providerEndpoints','route_policy','evidence_url'])assert.equal(JSON.stringify(projection).includes(forbidden),false,forbidden);
 stage('v396-real-multimodel-repository-oracle-excludes-v393-manifest-first-counterexample',{candidates:projection.candidates.map(c=>({model:c.modelId,eligible:c.routes.map(r=>r.targetId)}))});
 await exerciseCompleteTextRoutePreparationV398({projection,finalQuoteInput:first.input,runtimeConnectionString:urls.runtime,stickyConnectionString:urls.sticky,auditor:migrator,stage,label:'multimodel-exact'});
 for(const strategy of ['hash_affinity','weighted_random','weight_priority','weighted_round_robin']){
  await migrator.unsafe(`UPDATE ${g}.models SET route_policy=$1 WHERE id='v396-alpha'`,[JSON.stringify({strategy:'weight_priority',rules:{' OPENAI.CHAT : DEFAULT ':{strategy:strategy.toUpperCase()}}})]);
  await migrator.unsafe(`UPDATE ${g}.route_pools SET tier_strategies=$1 WHERE id='v396-pool-a'`,[JSON.stringify({'20':'weighted_random','bad':'ignored',' 10 ':'hash_affinity'})]);
  await attestSources();await attest();const f=await make(),p=await project(f);resetRouteStrategyCacheForTests();
  const legacy=await buildModelFallbackPlan(repos,{modelIds:['v396-alpha','v396-beta'],body:f.body,requestProtocol:'openai',requestOperation:'chat'});assert.equal(legacy.ok,true,JSON.stringify(legacy));
  assert.equal(p.candidates[0].strategy.base,legacy.candidates[0].strategy.base);assert.equal(p.candidates[0].strategy.base,strategy);
  assert.deepEqual(p.candidates[0].strategy.tierOverrides,[...legacy.candidates[0].strategy.tierOverrides].map(([priority,strategy])=>({priority,strategy})));
  stage(`v396-actual-policy-parser-and-tier-oracle-${strategy}`);
  await exerciseCompleteTextRoutePreparationV398({projection:p,finalQuoteInput:f.input,runtimeConnectionString:urls.runtime,stickyConnectionString:urls.sticky,auditor:migrator,stage,label:`strategy-${strategy}`});
 }
 for(const kind of ['capacity-filter','default-endpoint-filter']){
  await migrator.unsafe(`UPDATE ${g}.model_endpoints SET endpoint_class=$1,max_completion_tokens=$2 WHERE id='v396-endpoint-y'`,[kind==='default-endpoint-filter'?null:'standard',kind==='capacity-filter'?200:1000]);
  await attestSources();await attest();const f=await make(),p=await project(f);
  await exerciseCompleteTextRoutePreparationV398({projection:p,finalQuoteInput:f.input,runtimeConnectionString:urls.runtime,stickyConnectionString:urls.sticky,auditor:migrator,stage,label:kind});
 }
 await migrator.unsafe(`UPDATE ${g}.model_endpoints SET endpoint_class='standard',max_completion_tokens=1000 WHERE id='v396-endpoint-y'`);await attestSources();
 // Wildcard wins after exact removal; with both removed the unchanged runtime uses legacy model/group routes.
 await migrator.unsafe(`UPDATE ${g}.model_surfaces SET status='disabled' WHERE id='v396-exact'`);await attest();let f=await make(),p=await project(f);
 assert.equal(p.candidates[0].surface.match,'wildcard');assert.deepEqual(p.candidates[0].routes.map(r=>r.targetId),(await actual())[0].routes.map(r=>r.targetId));stage('v396-wildcard-fallback-matches-real-repository');
 await migrator.unsafe(`UPDATE ${g}.model_surfaces SET status='disabled' WHERE id='v396-wild'`);await attest();f=await make();p=await project(f);
 assert.equal(p.candidates[0].surface,null);assert.deepEqual(p.candidates[0].routes.map(r=>r.targetId),(await actual())[0].routes.map(r=>r.targetId));stage('v396-legacy-model-group-eligibility-matches-real-repository');
 await exerciseCompleteTextRoutePreparationV398({projection:p,finalQuoteInput:f.input,runtimeConnectionString:urls.runtime,stickyConnectionString:urls.sticky,auditor:migrator,stage,label:'priced-mixed-pool-legacy-namespace'});
 await migrator.unsafe(`UPDATE ${g}.model_surfaces SET status='active' WHERE id IN('v396-exact','v396-wild')`);
 await migrator.unsafe(`UPDATE ${g}.model_endpoints SET tag='INVALID ?' WHERE id='v396-endpoint-y'`);await attestSources();await attest();f=await make();p=await project(f);
 assert.deepEqual(p.candidates[0].routes.map(r=>r.targetId),['v396-route-z']);assert.deepEqual(p.candidates[0].routes.map(r=>r.targetId),(await actual())[0].routes.map(r=>r.targetId));stage('v396-invalid-endpoint-is-omitted-by-the-actual-parser');
 const image={provider_slug:'v361-provider',provider_tag:'y',supports_streaming:false,supported_parameters:{},allowed_passthrough_parameters:[],pricing:[{billable:'output_image',unit:'image',cost_usd:'0.04'}]};
 const audio={v:1,pricing_by_operation:{'audio.speech':{currency:'USD',meter:{kind:'characters',unit:'unicode_code_point',price:'0.000015',minimum_units:0,increment_units:1}}},speech_by_operation:{'audio.speech':{supports_default_voice:true,reference_audio_media_types:[],reference_audio_default_media_type:null}}};
 await migrator.unsafe(`UPDATE ${g}.model_endpoints SET tag='y',image_capabilities=$1,audio_capabilities=$2 WHERE id='v396-endpoint-y'`,[JSON.stringify(image),JSON.stringify(audio)]);await attestSources();await attest();f=await make();p=await project(f);
 assert.deepEqual(p.candidates[0].routes.map(r=>r.targetId),['v396-route-y','v396-route-z']);assert.deepEqual(p.candidates[0].routes.map(r=>r.targetId),(await actual())[0].routes.map(r=>r.targetId));stage('v396-valid-image-and-audio-additional-evidence-remains-chat-eligible');
 for(const [name,sql] of [['model-policy',`UPDATE ${g}.models SET route_policy=route_policy WHERE id='v396-alpha'`],['surface',`UPDATE ${g}.model_surfaces SET status=status WHERE id='v396-exact'`],['global-config',`INSERT INTO ${g}.system_config(key,value) VALUES('ROUTE_STRATEGY','weighted_random') ON CONFLICT(key) DO UPDATE SET value=excluded.value`]]){
  await attest();const current=await make();const prior=await project(current);await migrator.unsafe(sql);
  await assert.rejects(project(current),e=>e.status==='stale_projection');
  await assert.rejects(migrator.unsafe(`SELECT ${g}.require_current_routing_projection_v396($1,$2,0)`,[prior.quoteId,prior.routingEpoch]),e=>e.constraint_name==='complete_text_routing_freshness_v396');stage(`v396-noop-ABA-${name}-invalidates-bound-projection`);
 }
 await attest();const current=await make();const proxy=await startJournalCommitAckDropProxyV381({upstreamPort:cluster.port});
 try{
  const conn=new URL(urls.projector);conn.port=String(proxy.port);
  const rejected=assert.rejects(project(current,conn.href));await proxy.waitForDrop();await rejected;
  assert.equal(proxy.facts.backendCommitCompletes,1);assert.equal(proxy.facts.droppedCommitAcks,1);
  const [stored]=await migrator.unsafe(`SELECT count(*)::integer AS n FROM ${g}.complete_text_routing_projections_v396 WHERE quote_id=$1`,[current.quote.quoteId]);assert.equal(stored.n,1);
  const recovered=await project(current);assert.equal(recovered.quoteId,current.quote.quoteId);stage('v396-real-projection-COMMIT-response-loss-returns-no-plan-and-recovers-same-stored-projection',{proxyFacts:{...proxy.facts}});
 }finally{await proxy.close();}
}
