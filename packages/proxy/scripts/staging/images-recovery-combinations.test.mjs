import assert from 'node:assert/strict';
import test from 'node:test';
import { computeRouteDataPolicySubjectFingerprintFromRows,encryptSharedKeySecret } from '@octafuse/core';
import { setup } from './images-recovery-test-support.mjs';

const success=()=>Response.json({created:1,data:[{b64_json:'AQID'}]});
async function addFallback(f,operation) {
  const primary=f.fixture.cases['small-'+operation],provider=f.fixture.cases['limit-generations'].provider;
  f.db.sqlite.prepare('UPDATE model_routes SET priority=2 WHERE id=?').run(primary.route);
  const route={...f.row('SELECT * FROM model_routes WHERE id=?',primary.route),id:primary.route+'-fallback',provider_id:provider,priority:1};
  const endpoint={...f.row('SELECT * FROM model_endpoints WHERE id=?',primary.endpoint),id:primary.endpoint+'-fallback',provider_id:provider};
  // Fixture-owned identifiers only, not a request-controlled dynamic SQL surface.
  for(const [table,row] of [['model_routes',route],['model_endpoints',endpoint]]) {
    const fields=Object.keys(row);f.db.sqlite.prepare(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`).run(...Object.values(row));
  }
  for(const current of await f.storage.repositories.modelRouting.getModelRoutesByModelId(primary.model)) {
    const providerRow=await f.storage.repositories.providers.getProviderById(current.provider_id);
    const fingerprint=await computeRouteDataPolicySubjectFingerprintFromRows(current,providerRow);
    if(current.id===primary.route)f.db.sqlite.prepare('UPDATE model_endpoint_routes SET subject_fingerprint=? WHERE route_target_id=?').run(fingerprint,current.id);
    else f.db.sqlite.prepare('INSERT INTO model_endpoint_routes(endpoint_id,route_target_id,subject_fingerprint) VALUES(?,?,?)').run(endpoint.id,current.id,fingerprint);
  }
  return {primary,route,endpoint};
}

for(const operation of ['generations','edits']) {
  test(`provider fallback ${operation} freezes the final route and both attempt facts`,async t=>{
    let calls=0;
    const f=await setup(t,{cost:0.1,transport:async()=>++calls===1?Response.json({error:{message:'Synthetic explicit rejection'}},{status:503}):success()});
    const chosen=await addFallback(f,operation);
    const response=await f.request(operation);assert.equal(response.status,200,JSON.stringify(f.messages));await response.body.cancel();await f.drain();
    assert.equal(f.sends,2);
    const payload=JSON.parse(f.row('SELECT payload_json FROM request_usage_settlements').payload_json);
    assert.equal(payload.intent.attemptIndex,2);assert.equal(payload.params.requestLog.routeTargetId,chosen.route.id);
    assert.equal(payload.params.requestLog.providerId,chosen.route.provider_id);
    assert.deepEqual(payload.params.requestLog.providerAttempts.map(a=>[a.attemptIndex,a.outcome]),[[1,'unavailable'],[2,'available']]);
    assert.equal(f.row('SELECT COUNT(*) AS n FROM request_dispatch_intents').n,2);
    assert.equal(f.row('SELECT COUNT(*) AS n FROM provider_attempt_availability').n,2);
    assert.equal(f.row('SELECT COUNT(*) AS n FROM api_key_request_logs').n,1);
    assert.equal(f.row('SELECT charged_cost FROM api_key_request_logs').charged_cost,0.1);
    assert.equal((await f.recover()).claimed,0);
  });
}

for(const operation of ['generations','edits'])for(const credential of ['platform','private-byok','paid-fallback'])for(const included of [false,true]) {
  test(`${operation} recovery ${credential}, key includes BYOK=${included}, nonempty budget scopes`,async t=>{
    let fault=true;const credentials=[];
    const f=await setup(t,{cost:0.1,hooks:{beforeStatement(sql){if(fault&&sql.startsWith('INSERT INTO api_key_request_logs'))throw new Error('Synthetic ledger unavailable');}},transport:async(input,init)=>{
      const byok=new Request(input,init).headers.get('authorization')==='Bearer synthetic-private-byok';
      credentials.push(byok?'byok':'platform');
      if(credential==='paid-fallback'&&byok)return Response.json({error:{message:'Synthetic explicit rejection'}},{status:503});
      return success();
    }});
    const run=(sql,...args)=>f.db.sqlite.prepare(sql).run(...args);
    run('UPDATE api_keys SET limit_micros=1000000,include_byok_in_limit=? WHERE id=?',Number(included),f.fixture.ids.key);
    run("INSERT INTO workspace_budgets(id,workspace_id,reset_interval,limit_micros) VALUES(?,?,'lifetime',1000000)",f.fixture.ids.runId+'-budget',f.fixture.ids.workspace);
    if(credential!=='platform') {
      const id=f.fixture.ids.runId+'-byok';
      run('INSERT INTO byok_keys(id,workspace_id,provider,api_key_encrypted,label,sort_order,always_use_for_matching_models) VALUES(?,?,?,? ,?,0,?)',
        id,f.fixture.ids.workspace,'test',await encryptSharedKeySecret('synthetic-private-byok','synthetic-material-not-for-real-secrets',`cinatoken:byok-key:${id}:${f.fixture.ids.workspace}:test`),'synthetic-label',Number(credential==='private-byok'));
      if(credential==='private-byok')run('UPDATE users SET budget_max=0 WHERE id=?',f.fixture.ids.user);
    }
    const response=await f.request(operation);assert.equal(response.status,200,JSON.stringify(f.messages));await response.body.cancel();await f.drain();
    assert.deepEqual(credentials,credential==='platform'?['platform']:credential==='private-byok'?['byok']:['byok','platform']);
    assert.equal(f.row('SELECT COUNT(*) AS n FROM api_key_request_logs').n,0);
    assert.equal(f.row('SELECT state FROM request_usage_recovery_jobs').state,'pending');
    const privateOnly=credential==='private-byok',expectedCharge=privateOnly?0:100000,expectedScopes=privateOnly?Number(included):2;
    assert.equal(f.row('SELECT COUNT(*) AS n FROM guardrail_budget_reservations').n,expectedScopes);
    fault=false;f.advance(6);
    assert.equal((await f.recover()).committed,1);assert.equal((await f.recover()).claimed,0);
    assert.equal(f.row('SELECT budget_spent_micros FROM users WHERE id=?',f.fixture.ids.user).budget_spent_micros,expectedCharge);
    assert.equal(f.row('SELECT budget_reserved_micros FROM users WHERE id=?',f.fixture.ids.user).budget_reserved_micros,0);
    for(const window of f.db.sqlite.prepare('SELECT reserved_micros,settled_micros FROM guardrail_budget_windows').all())assert.deepEqual({...window},{reserved_micros:0,settled_micros:100000});
    const log=f.row('SELECT charged_cost,is_byok,provider_key_id FROM api_key_request_logs');
    assert.equal(log.charged_cost,expectedCharge/1000000);assert.equal(log.is_byok,Number(privateOnly));
    if(privateOnly)assert.match(log.provider_key_id,/^byok:/);
    assert.equal(f.row('SELECT COUNT(*) AS n FROM api_key_request_logs').n,1);
    assert.equal(f.row('SELECT COUNT(*) AS n FROM provider_attempt_availability').n,credentials.length);
    assert.equal(f.sends,credentials.length,'settlement never sends another inference');
  });
}
