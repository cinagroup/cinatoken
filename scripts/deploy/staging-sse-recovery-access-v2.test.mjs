import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {SSE_STAGING_SCOPE} from './staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE,closeSseRecoveryAccess} from './staging-sse-recovery-access-v2.mjs';

function fixture({failWrite=0,failure='before',closed=false}={}){
  const journal={runId:'c02-success-'+randomUUID(),tokenId:randomUUID(),tokenName:'cinatoken-sse-v194-'+randomUUID(),requests:[{id:null}]};
  const scopes=[SSE_RECOVERY_ACCESS_SCOPE,SSE_STAGING_SCOPE];
  const apps=scopes.map(s=>({id:s.app,type:'self_hosted',domain:s.domain,aud:s.audience,
    destinations:[{type:'public',uri:s.domain}],service_auth_401_redirect:!closed,unrelated:'preserve',
    policies:[{id:s.policy,name:s===SSE_RECOVERY_ACCESS_SCOPE?'CinaToken recovery staging closed':'CinaToken staging closed',precedence:1,decision:closed?'deny':'non_identity',
      include:closed?[{everyone:{}}]:[{service_token:{token_id:journal.tokenId}}],exclude:[],require:[]}]}));
  const other={id:randomUUID(),name:'unrelated-token',enabled:true};
  const state={apps,ingress:scopes.map(()=>({enabled:!closed,previews_enabled:!closed})),
    tokens:closed?[other]:[{id:journal.tokenId,name:journal.tokenName,enabled:true,client_secret:'MUST_NOT_PERSIST'},other],calls:[],writes:[]};
  let count=0,failed=false;
  const api=async(path,method='GET',body)=>{
    state.calls.push({path,method});assert.ok(state.calls.length<=150,'Bounded test adapter');
    const write=method!=='GET';if(write){count++;if(!failed&&count===failWrite&&failure==='before'){failed=true;throw Error('Before write');}}
    let result,matched=false;
    for(let i=0;i<scopes.length;i++){
      const s=scopes[i];
      if(path===`/workers/scripts/${s.worker}/subdomain`){
        matched=true;if(write){assert.equal(method,'POST');assert.deepEqual(body,{enabled:false,previews_enabled:false});state.ingress[i]=structuredClone(body);}result=state.ingress[i];
      }else if(path===`/access/apps/${s.app}`){
        matched=true;if(write){assert.equal(method,'PUT');assert.equal(body.service_auth_401_redirect,false);state.apps[i]=structuredClone(body);}result=state.apps[i];
      }else if(path===`/access/apps/${s.app}/policies/${s.policy}`){
        matched=true;assert.equal(method,'PUT');assert.notEqual(state.apps[i].service_auth_401_redirect,true,'12130: redirect still enabled');
        state.apps[i].policies=[{id:s.policy,...structuredClone(body)}];result=state.apps[i].policies[0];
      }
    }
    if(path==='/access/service_tokens'){matched=true;assert.equal(method,'GET');result=state.tokens;}
    else if(path===`/access/service_tokens/${journal.tokenId}`){
      matched=true;const token=state.tokens.find(t=>t.id===journal.tokenId);assert.ok(token);
      if(method==='PUT'){assert.deepEqual(body,{name:journal.tokenName,enabled:false});token.enabled=false;result=token;}
      else {assert.equal(method,'DELETE');assert.ok(state.apps.every(a=>a.policies[0].decision==='deny'),'12139: token still referenced');
        state.tokens=state.tokens.filter(t=>t.id!==journal.tokenId);result={id:journal.tokenId};}
    }
    assert.ok(matched,'Unexpected target '+path);
    if(write){state.writes.push({path,method,body:structuredClone(body)});if(!failed&&count===failWrite&&failure==='after'){failed=true;throw Error('Committed; ACK lost');}}
    return structuredClone(result);
  };
  const saved=[],run=(persist=async s=>saved.push(s))=>closeSseRecoveryAccess({api,journal,persist});
  const assertClosed=()=>{
    assert.ok(state.ingress.every(i=>i.enabled===false&&i.previews_enabled===false));
    assert.ok(state.apps.every(a=>a.policies[0].decision==='deny'&&a.service_auth_401_redirect===false&&a.unrelated==='preserve'));
    assert.deepEqual(state.tokens,[other]);assert.doesNotMatch(JSON.stringify(saved),/MUST_NOT_PERSIST|client_secret/);
  };
  return {state,journal,saved,api,run,assertClosed};
}
test('Dual Access closes both ingress first, removes both references before deletion; repeat is read-only',async()=>{
  const f=fixture(),result=await f.run();f.assertClosed();assert.equal(result.sharedTokenAbsent,true);
  assert.deepEqual(f.state.writes.map(w=>w.method),['POST','POST','PUT','PUT','PUT','PUT','PUT','DELETE']);
  assert.ok(f.state.calls.length<=35);const writes=f.state.writes.length;await f.run();f.assertClosed();assert.equal(f.state.writes.length,writes);
});
test('Controller and gateway retain their distinct deployed policy names',async()=>{
  const f=fixture();await f.run();assert.deepEqual(f.state.apps.map(a=>a.policies[0].name),['CinaToken recovery staging closed','CinaToken staging closed']);
});
for(const failure of ['before','after'])for(let failWrite=1;failWrite<=8;failWrite++)test(`Dual Access resumes ${failure} write ${failWrite}`,async()=>{
  const f=fixture({failure,failWrite});await assert.rejects(f.run());await f.run();f.assertClosed();
});
for(let failAt=1;failAt<=10;failAt++)test(`Dual Access resumes after checkpoint ${failAt} persistence fails`,async()=>{
  const f=fixture();let checkpoints=0;await assert.rejects(f.run(async()=>{if(++checkpoints===failAt)throw Error('Disk full');}));
  await f.run();f.assertClosed();
});
for(const [name,mutate] of [
  ['controller domain',f=>f.state.apps[0].domain='production.invalid'],
  ['controller audience',f=>f.state.apps[0].aud='other'],
  ['controller type',f=>f.state.apps[0].type='other'],
  ['controller destination',f=>f.state.apps[0].destinations[0].uri='production.invalid'],
  ['controller policy ID',f=>f.state.apps[0].policies[0].id=randomUUID()],
  ['controller policy name',f=>f.state.apps[0].policies[0].name='different-owner'],
  ['controller extra policy',f=>f.state.apps[0].policies.push({...f.state.apps[0].policies[0]})],
  ['controller foreign token',f=>f.state.apps[0].policies[0].include=[{service_token:{token_id:randomUUID()}}]],
  ['duplicate token name',f=>f.state.tokens.push({...f.state.tokens[0],id:randomUUID()})],
  ['renamed token',f=>f.state.tokens[0].name='other-owner'],
  ['token ID disagreement',f=>f.state.tokens[0].id=randomUUID()],
])test('Dual Access refuses '+name+' after closing both fixed ingress',async()=>{
  const f=fixture();mutate(f);await assert.rejects(f.run());assert.equal(f.state.writes.length,2);
  assert.ok(f.state.ingress.every(i=>!i.enabled&&!i.previews_enabled));assert.ok(f.state.tokens[0].enabled);
});
test('Gateway drift leaves shared token disabled, controller deny-all, both ingress closed; never deletes identity',async()=>{
  const f=fixture();f.state.apps[1].aud='other';await assert.rejects(f.run());
  assert.equal(f.state.apps[0].policies[0].decision,'deny');assert.equal(f.state.tokens[0].enabled,false);
  assert.ok(f.state.ingress.every(i=>!i.enabled));assert.ok(f.state.writes.every(w=>w.method!=='DELETE'));
});
test('Lost token-create ACK uses exact name and tolerates missing inference metadata',async()=>{
  const f=fixture(),journal={...f.journal};delete journal.tokenId;
  await closeSseRecoveryAccess({api:f.api,journal,persist:async s=>f.saved.push(s)});f.assertClosed();
});
test('No identity ever created: already-closed apps require no writes',async()=>{
  const f=fixture({closed:true});delete f.journal.tokenId;delete f.journal.tokenName;
  await f.run();f.assertClosed();assert.equal(f.state.writes.length,0);
});
test('Missing token but stale exact references can still be safely removed',async()=>{
  const f=fixture();f.state.tokens.shift();await f.run();f.assertClosed();assert.ok(f.state.writes.every(w=>w.method!=='DELETE'));
});
test('Failure closing controller still attempts gateway closure, without token or policy mutation',async()=>{
  const f=fixture({failWrite:1});await assert.rejects(f.run());
  assert.equal(f.state.ingress[1].enabled,false);assert.equal(f.state.writes.length,1);assert.equal(f.state.tokens[0].enabled,true);
});

for(const [name,mutate] of [
  ['invalid run',j=>j.runId='production'],
  ['clock-suffixed token',j=>j.tokenName='cinatoken-sse-v201-clock-'+randomUUID()],
  ['invalid token id',j=>j.tokenId='unknown'],
  ['missing token name',j=>delete j.tokenName],
])test('Malformed '+name+' still closes both fixed ingress without identity writes',async()=>{
  const f=fixture();mutate(f.journal);await assert.rejects(f.run());
  assert.ok(f.state.ingress.every(i=>!i.enabled&&!i.previews_enabled));
  assert.equal(f.state.writes.length,2);assert.ok(f.state.calls.every(c=>c.path.includes('/subdomain')));
  assert.equal(f.state.tokens.length,2);assert.equal(f.state.tokens[0].enabled,true);
});
test('Null journal still closes both ingress and refuses token operations',async()=>{
  const f=fixture();await assert.rejects(closeSseRecoveryAccess({api:f.api,journal:null,persist:async()=>{}}));
  assert.ok(f.state.ingress.every(i=>!i.enabled&&!i.previews_enabled));assert.equal(f.state.writes.length,2);
});
test('Malformed journal plus failed controller closure still attempts gateway',async()=>{
  const f=fixture({failWrite:1});f.journal.tokenName='bad';
  await assert.rejects(f.run(),AggregateError);assert.equal(f.state.ingress[1].enabled,false);
  assert.ok(f.state.calls.every(c=>c.path.includes('/subdomain')));
});
test('Omitted false redirect is accepted as closed (Cloudflare default)',async()=>{
  const f=fixture({closed:true});for(const a of f.state.apps)delete a.service_auth_401_redirect;
  const result=await f.run();assert.equal(result.sharedTokenAbsent,true);assert.equal(f.state.writes.length,0);
});
test('Journal mutation at persist cannot redirect an owned token operation',async()=>{
  const f=fixture();const originalId=f.journal.tokenId;
  // The fixture adapter owns the original mutable journal: preserve its lookup while mutating the caller copy.
  const input=structuredClone(f.journal);
  await closeSseRecoveryAccess({api:f.api,journal:input,persist:async()=>{
    input.tokenId=randomUUID();input.tokenName='cinatoken-sse-v999-'+randomUUID();
  }});
  f.assertClosed();assert.ok(f.state.writes.filter(w=>w.path.startsWith('/access/service_tokens/')).every(w=>w.path.endsWith(originalId)));
});
