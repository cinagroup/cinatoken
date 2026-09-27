import assert from 'node:assert/strict';
import test from 'node:test';
import {readPostgresCompleteTextSecretlessPlanV391 as readPlan,
  selectCompleteTextPlanRouteV391 as selectRoute} from './postgres-complete-text-secretless-plan-v391.ts';

const login='cinatoken_gateway_complete_text_ingress_planner';
function setup(change=()=>{},options={}){
  const expiresAt=new Date(Date.now()+60000).toISOString();
  const input=Object.freeze({requestId:'v391-local',finalBodySha256:'a'.repeat(64),modelIds:Object.freeze(['model'])});
  const quote=Object.freeze({...input,quoteId:'11111111-1111-4111-8111-111111111111',credentialClass:'platform',routeCount:1,expiresAt});
  const row={status:'planned_complete_subset',requestId:input.requestId,quoteId:quote.quoteId,
    finalBodySha256:input.finalBodySha256,orderedModelIds:['model'],candidateCount:1,routeCount:1,
    expiresAt,routes:[{candidateIndex:0,modelId:'model',routeTargetId:'route',sourceGeneration:'15',attestedSourceSha256:'b'.repeat(64)}]};
  change(row);const events=[];
  const factory=()=>({
    async begin(work){events.push('begin');const value=await work({async unsafe(sql){
      if(sql.includes('current_user')){events.push('role');return [{current_role:options.role??login,session_role:options.session??login,
        transaction_isolation:options.isolation??'read committed'}];}
      if(sql.startsWith('SET LOCAL')){events.push(sql);return [];}
      events.push('plan');if(options.query)await options.query();return [{value:row}];
    }});if(options.commit)await options.commit();events.push('commit');return value;},
    end(){events.push('close');return options.close?options.close():Promise.resolve();},
  });
  return {quote,input,row,events,factory,params:{plannerConnectionString:`postgres://${login}:local@127.0.0.1/db`,quote,finalQuoteInput:input}};
}

test('v391 returns only a frozen current quote projection after COMMIT and close ACK',async()=>{
  const f=setup();const result=await readPlan(f.params,f.factory);
  assert.deepEqual(f.events,['begin','role',"SET LOCAL lock_timeout='2s'","SET LOCAL statement_timeout='15s'",'plan','commit','close']);
  assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result.routes));assert.ok(Object.isFrozen(result.routes[0]));
  assert.deepEqual(selectRoute(result,{candidateIndex:0,routeTargetId:'route'}),{
    targetId:'route',gatewayCandidateIndex:0,gatewayModelId:'model'});
  assert.throws(()=>selectRoute(result,{candidateIndex:0,routeTargetId:'foreign'}));
  assert.equal(JSON.stringify(result).includes('provider'),false);
});

test('v391 refuses malformed identity/source/coverage and extra secret fields',async()=>{
  const cases=[
    row=>{row.requestId='foreign';},row=>{row.quoteId='22222222-2222-4222-8222-222222222222';},
    row=>{row.finalBodySha256='c'.repeat(64);},row=>{row.orderedModelIds=['other'];},
    row=>{row.candidateCount=2;},row=>{row.routeCount=2;},
    row=>{row.expiresAt=new Date(Date.now()+30000).toISOString();},
    row=>{row.routes[0].candidateIndex=1;},row=>{row.routes[0].modelId='other';},
    row=>{row.routes[0].routeTargetId='';},row=>{row.routes[0].sourceGeneration='01';},
    row=>{row.routes[0].sourceGeneration='9223372036854775808';},
    row=>{row.routes[0].attestedSourceSha256='invalid';},
    row=>{row.providerCiphertext='enc:v2:should-never-cross';},
    row=>{row.routes[0].providerUrl='https://private.invalid';},
  ];
  for(const change of cases){const f=setup(change);await assert.rejects(readPlan(f.params,f.factory),TypeError);
    assert.equal(f.events.at(-1),'close');assert.equal(f.events.includes('commit'),false);}
});

test('v391 requires real planner current/session LOGIN and read committed before wrapper',async()=>{
  for(const options of [{role:'cinatoken_gateway_runtime'},{session:'cinatoken_gateway_migrator'},{isolation:'repeatable read'}]){
    const f=setup(undefined,options);await assert.rejects(readPlan(f.params,f.factory));
    assert.deepEqual(f.events,['begin','role','close']);
  }
});

test('v391 preserves every model candidate and rejects duplicate routes or missing coverage',async()=>{
  for(const mode of ['valid','duplicate','missing']){
    const f=setup();
    f.params.finalQuoteInput=Object.freeze({...f.input,modelIds:Object.freeze(['model','second'])});
    f.params.quote=Object.freeze({...f.quote,modelIds:Object.freeze(['model','second']),routeCount:2});
    f.row.orderedModelIds=['model','second'];f.row.candidateCount=2;f.row.routeCount=2;
    f.row.routes.push({candidateIndex:1,modelId:'second',routeTargetId:'second-route',sourceGeneration:'19',attestedSourceSha256:'c'.repeat(64)});
    if(mode==='duplicate')f.row.routes[1].routeTargetId='route';
    if(mode==='missing'){f.row.routes[1].candidateIndex=0;f.row.routes[1].modelId='model';}
    if(mode==='valid'){
      const result=await readPlan(f.params,f.factory);assert.deepEqual(result.modelIds,['model','second']);
      assert.equal(selectRoute(result,{candidateIndex:1,routeTargetId:'second-route'}).gatewayModelId,'second');
    }else await assert.rejects(readPlan(f.params,f.factory),TypeError);
  }
});

test('v391 known SQL stale statuses reject and unknown statuses or extra fields do not escape',async()=>{
  for(const status of ['not_found','stale','invalid_manifest','stale_manifest','unexpected']){
    const f=setup(row=>{for(const key of Object.keys(row))delete row[key];row.status=status;});
    await assert.rejects(readPlan(f.params,f.factory),error=>status==='unexpected'?error instanceof TypeError:error.status===status);
  }
});

test('v391 does not return a plan after unknown COMMIT or close acknowledgement',async()=>{
  for(const options of [{commit:async()=>{throw new Error('commit lost');}},
    {close:async()=>{throw new Error('close lost');}},{close:()=>undefined}]){
    const f=setup(undefined,options);await assert.rejects(readPlan(f.params,f.factory));
    assert.equal(f.events.at(-1),'close');
  }
});

test('v391 waits for an in-flight read and actual cleanup before returning cancellation',async()=>{
  const abort=new AbortController();let release;let closeRelease;
  const reading=new Promise(resolve=>{release=resolve;});const closing=new Promise(resolve=>{closeRelease=resolve;});
  const f=setup(undefined,{query:()=>reading,close:()=>closing});f.params.signal=abort.signal;
  let settled=false;const work=readPlan(f.params,f.factory).finally(()=>{settled=true;});
  await new Promise(resolve=>setTimeout(resolve,0));abort.abort();
  f.params.signal=new AbortController().signal;
  assert.equal(settled,false);release();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(settled,false);assert.equal(f.events.at(-1),'close');closeRelease();
  await assert.rejects(work);assert.equal(f.events.includes('commit'),false);
});
