import assert from 'node:assert/strict';
import test from 'node:test';
import { readPostgresCompleteTextRoutingProjectionV396 as read, parseCredentialFreeRoutingProjectionV396 as parse } from './postgres-complete-text-routing-projection-v396';
const login='cinatoken_gateway_complete_text_routing_projector';
function setup(options: {role?:string;isolation?:string;commit?:()=>Promise<void>;close?:()=>Promise<void>|undefined}={}) {
 const expiresAt=new Date(Date.now()+60000).toISOString();
 const input=Object.freeze({requestId:'v396-local',finalBodySha256:'a'.repeat(64),modelIds:Object.freeze(['alpha','beta'])});
 const quote={...input,quoteId:'11111111-1111-4111-8111-111111111111',credentialClass:'platform',routeCount:3,expiresAt};
 const route={targetId:'eligible',providerId:'provider',routePoolId:'pool',routePriority:20,routeWeight:0.5,
  sourceGeneration:'3',attestedSourceSha256:'b'.repeat(64),endpointId:'endpoint',endpointClass:'standard',maxCompletionTokens:1000,
  priceScore:6,beneficialCacheReadPricing:true,defaultEndpointEligible:true};
 const row={status:'routing_projected',requestId:input.requestId,quoteId:quote.quoteId,finalBodySha256:input.finalBodySha256,
  modelIds:['alpha','beta'],expiresAt,routingEpoch:'17',candidates:[
   {candidateIndex:0,modelId:'alpha',routeGroup:'default',requestProtocol:'openai',requestOperation:'chat',surface:{id:'surface',poolId:'pool',match:'exact',sticky:{enabled:true,idleTtlSeconds:600,epoch:1}},
    strategy:{base:'weight_priority',tierOverrides:[{priority:20,strategy:'hash_affinity'}]},routes:[route]},
   {candidateIndex:1,modelId:'beta',routeGroup:'default',requestProtocol:'openai',requestOperation:'chat',surface:null,strategy:{base:'weighted_random',tierOverrides:[]},routes:[]}],};
 const events:string[]=[];
 const factory=()=>({async begin(work:(tx:unknown)=>Promise<unknown>){events.push('begin');const result=await work({async unsafe(sql:string){
  if(sql.includes('current_user'))return [{current_role:options.role??login,session_role:login,isolation:options.isolation??'read committed'}];
  if(sql.startsWith('SET LOCAL'))return [];events.push('query');return [{value:row}];}});
  if(options.commit)await options.commit();events.push('commit');return result;},end(){events.push('close');return options.close?options.close():Promise.resolve();}});
 return {row,quote,input,events,factory,params:{projectorConnectionString:`postgres://${login}:fixture@127.0.0.1/db`,quote,finalQuoteInput:input}};
}
test('returns deeply frozen exact safe projection after acknowledged COMMIT and close',async()=>{
 const f=setup();const result=await read(f.params as never,f.factory as never);
 assert.deepEqual(f.events,['begin','query','commit','close']);assert.equal(result.candidates.length,2);
 assert.equal(result.candidates[0]!.routes[0]!.routeWeight,0.5);assert.ok(Object.isFrozen(result.candidates[0]!.surface!.sticky));
 assert.ok(Object.isFrozen(result.candidates[0]!.strategy.tierOverrides));assert.ok(Object.isFrozen(result.candidates[0]!.routes[0]));
});
test('rejects unknown JSON and source/identity/number drift without exposing it',()=>{
 const changes=[(r:any)=>r.providerUrl='https://private.invalid',(r:any)=>r.candidates[0].routes[0].ciphertext='secret',
  (r:any)=>r.modelIds.reverse(),(r:any)=>r.routingEpoch='01',(r:any)=>r.routingEpoch='9223372036854775808',
  (r:any)=>r.candidates[0].strategy.tierOverrides.push({priority:20,strategy:'weighted_random'}),
  (r:any)=>r.candidates[0].routes[0].routeWeight=Infinity,(r:any)=>r.candidates[0].routes[0].priceScore=-1,
  (r:any)=>r.candidates[0].routes[0].defaultEndpointEligible='true',(r:any)=>r.candidates[0].routes[0].maxCompletionTokens=0,
  (r:any)=>r.candidates[0].routes[0].sourceGeneration='0',(r:any)=>r.candidates[0].surface.sticky.enabled=1,
  (r:any)=>r.candidates[0].strategy.base='secret-policy',(r:any)=>r.candidates[1].candidateIndex=0,
  (r:any)=>r.candidates[1].routes.push({...r.candidates[0].routes[0]})];
 for(const change of changes){const f=setup();change(f.row);assert.throws(()=>parse(f.row,f.quote),TypeError);}
});
test('actual LOGIN/isolation checks precede query',async()=>{
 for(const options of [{role:'cinatoken_gateway_runtime'},{isolation:'repeatable read'}]){
  const f=setup(options);await assert.rejects(read(f.params as never,f.factory as never));assert.deepEqual(f.events,['begin','close']);
 }
});
test('lost COMMIT or missing close acknowledgement releases no projection',async()=>{
 for(const options of [{commit:async()=>{throw new Error('COMMIT lost');}},{close:()=>undefined}]){
  const f=setup(options);await assert.rejects(read(f.params as never,f.factory as never));assert.equal(f.events.at(-1),'close');
 }
});
test('captures mutable quote before asynchronous role read',async()=>{
 const f=setup();let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let opened=false;
 const base=f.factory();const factory=()=>({...base,async begin(work:Parameters<typeof base.begin>[0]){opened=true;await gate;return base.begin(work);}});
 const pending=read(f.params as never,factory as never);assert.equal(opened,true);f.quote.modelIds=['changed'] as never;f.quote.requestId='changed';release();
 const result=await pending;assert.deepEqual(result.modelIds,['alpha','beta']);assert.equal(result.requestId,'v396-local');
});
