import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const {createByokD1IngressClosure,journalByokD1IngressClosure}=await import(process.env.BYOK_CLOSURE_MODULE
  ?pathToFileURL(resolve(process.env.BYOK_CLOSURE_MODULE)).href:new URL('./byok-d1-ingress-closure.mjs',import.meta.url).href);
import {createByokD1OperatorJournal,inspectByokD1OperatorJournal} from './byok-d1-operator-journal.mjs';
import {createSseOperatorClock} from './staging-sse-operator-clock.mjs';
import {SSE_STAGING_SCOPE as g} from './staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as c} from './staging-sse-recovery-access-v2.mjs';
import {createSseCapacityPeerTransport} from './staging-sse-capacity-peer-transport.mjs';
import {setImmediate as tick} from 'node:timers/promises';
const sha=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
function fixture(){
  const data=new Map(),calls=[],hooks={};let ns=0n;
  const clock=createSseOperatorClock({readNs:()=>ns});
  const workers=[g.worker,c.worker,'cinatoken-staging-images-upstream','cinatoken-staging-usage-recovery'].map((name,i)=>{
    const settings={name,bindings:[]},versions=[{version_id:id(i+1),percentage:100}];
    data.set(`/workers/scripts/${name}/settings`,settings);data.set(`/workers/scripts/${name}/deployments`,{deployments:[{versions:structuredClone(versions)}]});
    data.set(`/workers/scripts/${name}/subdomain`,{enabled:false,previews_enabled:false});data.set('/workers/domains?service='+name,[]);
    data.set(`/workers/scripts/${name}/schedules`,{schedules:[]});return {name,settingsSha256:sha(settings),versions};
  });
  const production=['cinatoken-proxy','cinatoken-admin','cinatoken-chain-worker'].map(name=>{const settings={name};data.set(`/workers/scripts/${name}/settings`,settings);return {name,settingsSha256:sha(settings)};});
  const access=[g,c].map(t=>{const app={id:t.app,type:'self_hosted',domain:t.domain,aud:t.audience,destinations:[{type:'public',uri:t.domain}],
    service_auth_401_redirect:false,policies:[{id:t.policy,precedence:1,decision:'deny',include:[{everyone:{}}],exclude:[],require:[]}]};
    data.set('/access/apps/'+t.app,app);return {id:t.app,sha256:sha(app)};});
  data.set('/access/service_tokens',[]);data.set(`/workers/scripts/${g.worker}/tails`,[]);data.set('/d1/database/'+g.database,{uuid:g.database,name:'cinatoken-staging'});
  const api=async(path,method,body,options)=>{assert.equal(method,'GET');assert.equal(body,undefined);assert.ok(options.signal instanceof AbortSignal);
    calls.push(path);await hooks.get?.(path,calls.length);assert.ok(data.has(path));return structuredClone(data.get(path));};
  const expected={workers,production,access,previousTokenIds:[id(77)]};
  return {api,expected,clock,calls,data,hooks,advance(ms){ns+=BigInt(ms)*1000000n;},check:options=>createByokD1IngressClosure({api,expected,clock,...options})};
}
test('two complete fresh fixed-target sweeps, but no quiescence or delete authority',async()=>{
  const f=fixture(),check=f.check(),p=check.run();assert.equal(check.run(),p);const r=await p;
  assert.equal(r.result,'CLOSED');assert.equal(r.logicalApiReads,55);assert.equal(r.knownIngressClosed,true);
  assert.equal(r.databaseQuiescenceProved,false);assert.equal(r.cleanupAuthorized,false);assert.equal(check.assertFreshIngressClosed().result,'CLOSED');
  assert.equal(f.calls.filter(p=>p==='/access/service_tokens').length,2);f.advance(5001);assert.throws(()=>check.assertFreshIngressClosed());
  assert.equal(r.completedSweeps,2);assert.equal(r.peakLogicalReads,4);assert.equal(r.activeLogicalReads,0);
});

function maintenanceFixture(){const f=fixture(),maintenance={runId:'c02-byok-a1b2c3d4e5f6',tokenId:id(80)};
  const settings=f.data.get(`/workers/scripts/${c.worker}/settings`);settings.bindings=[
    ...Object.entries({BYOK_MAINTENANCE_CONTROL_ENVIRONMENT:'staging',BYOK_MAINTENANCE_CONTROL_ENABLED:'true',BYOK_MAINTENANCE_ACCESS_AUD:c.audience})
      .map(([name,text])=>({name,type:'plain_text',text})),
    {name:'USAGE_RECOVERY',type:'service',service:'cinatoken-staging-usage-recovery',entrypoint:'UsageRecovery'}];
  f.data.get(`/workers/scripts/${c.worker}/subdomain`).enabled=true;
  const policy=f.data.get('/access/apps/'+c.app).policies[0];policy.decision='non_identity';policy.include=[{service_token:{token_id:maintenance.tokenId}}];
  f.data.set('/access/service_tokens',[{id:maintenance.tokenId,name:maintenance.runId+'-access'}]);
  function pin(){f.expected.workers.find(w=>w.name===c.worker).settingsSha256=sha(settings);
    for(const row of f.expected.access)row.sha256=sha(f.data.get('/access/apps/'+row.id));}
  pin();return {...f,maintenance,pin,settings};
}
test('maintenance mode proves only producers closed, pins owned token and no-DB controller, expires in five seconds',async()=>{
  const f=maintenanceFixture(),check=f.check({maintenance:f.maintenance}),r=await check.run();
  assert.equal(r.result,'MAINTENANCE_READY');assert.equal(r.logicalApiReads,55);assert.equal(r.knownIngressClosed,false);
  assert.equal(r.knownProducerIngressClosed,true);assert.equal(r.maintenanceOnlyConfigured,true);assert.equal(r.cleanupAuthorized,false);
  assert.throws(()=>check.assertFreshIngressClosed());assert.deepEqual(check.assertFreshMaintenanceIngress().maintenance,f.maintenance);
  f.advance(5001);assert.throws(()=>check.assertFreshMaintenanceIngress());
});
for(const mode of ['producer-open','controller-closed','preview-open','public-allow','wrong-token','extra-token-policy','missing-token','duplicate-token','wrong-name',
  'database-binding','wrong-service','wrong-entrypoint','wrong-environment','disabled-controller','tail'])test('maintenance exception fails closed even with matching settings/Access hash / '+mode,async()=>{
  const f=maintenanceFixture(),policy=f.data.get('/access/apps/'+c.app).policies[0];
  if(mode==='producer-open')f.data.get(`/workers/scripts/${g.worker}/subdomain`).enabled=true;
  if(mode==='controller-closed')f.data.get(`/workers/scripts/${c.worker}/subdomain`).enabled=false;
  if(mode==='preview-open')f.data.get(`/workers/scripts/${c.worker}/subdomain`).previews_enabled=true;
  if(mode==='public-allow')policy.decision='allow';if(mode==='wrong-token')policy.include=[{service_token:{token_id:id(99)}}];
  if(mode==='extra-token-policy')policy.include.push({service_token:{token_id:id(99)}});
  if(mode==='missing-token')f.data.set('/access/service_tokens',[]);
  if(mode==='duplicate-token')f.data.get('/access/service_tokens').push({...f.data.get('/access/service_tokens')[0]});
  if(mode==='wrong-name')f.data.get('/access/service_tokens')[0].name='other-run-access';
  if(mode==='database-binding')f.settings.bindings.push({type:'d1',name:'DB',id:g.database});
  if(mode==='wrong-service')f.settings.bindings[3].service='other';if(mode==='wrong-entrypoint')f.settings.bindings[3].entrypoint='Default';
  if(mode==='wrong-environment')f.settings.bindings[3].environment='other';if(mode==='disabled-controller')f.settings.bindings[1].text='false';
  if(mode==='tail')f.settings.tail_consumers=[{service:'other'}];f.pin();
  const check=f.check({maintenance:f.maintenance});assert.equal((await check.run()).result,'FAIL');assert.throws(()=>check.assertFreshMaintenanceIngress());
});
test('default mode rejects a prepared maintenance entrance; maintenance input cannot name a revoked token',async()=>{
  const f=maintenanceFixture();assert.equal((await f.check().run()).result,'FAIL');
  for(const maintenance of [null,{...f.maintenance,worker:'other'},{...f.maintenance,tokenId:id(77)},{...f.maintenance,runId:'wrong'}])assert.throws(()=>f.check({maintenance}));
});
for(const [name,mutate] of [
  ['database identity',f=>f.data.get('/d1/database/'+g.database).uuid=id(99)],
  ['public ingress',f=>f.data.get(`/workers/scripts/${g.worker}/subdomain`).enabled=true],
  ['preview ingress',f=>f.data.get(`/workers/scripts/${g.worker}/subdomain`).previews_enabled=true],
  ['side worker ingress',f=>f.data.get('/workers/scripts/cinatoken-staging-usage-recovery/subdomain').enabled=true],
  ['custom domain',f=>f.data.set('/workers/domains?service='+g.worker,[{hostname:'unexpected.example'}])],
  ['schedule',f=>f.data.set(`/workers/scripts/${g.worker}/schedules`,{schedules:[{cron:'* * * * *'}]})],
  ['deployment split',f=>f.data.get(`/workers/scripts/${g.worker}/deployments`).deployments[0].versions.push({version_id:id(99),percentage:1})],
  ['settings drift',f=>f.data.get(`/workers/scripts/${g.worker}/settings`).unexpected=true],
  ['production settings drift',f=>f.data.get('/workers/scripts/cinatoken-proxy/settings').unexpected=true],
  ['old token present',f=>f.data.set('/access/service_tokens',[{id:id(77)}])],
  ['tail present',f=>f.data.set(`/workers/scripts/${g.worker}/tails`,[{id:'unexpected'}])],
])test('unsafe observed cloud state rejected / '+name,async()=>{
  const f=fixture();mutate(f);const check=f.check(),r=await check.run();assert.equal(r.result,'FAIL');assert.equal(r.knownIngressClosed,false);assert.throws(()=>check.assertFreshIngressClosed());
});

test('virtual 1500ms RTT: 55 reads complete in 15 bounded waves, not 55 serial RTTs',async()=>{
  const f=fixture(),pending=[];let now=0,done=false;
  f.hooks.get=()=>new Promise(resolve=>pending.push({at:now+1500,resolve}));
  const p=f.check().run().then(r=>{done=true;return r;});
  for(let i=0;!done&&i<100;i++){
    await tick();if(!pending.length)continue;const at=Math.min(...pending.map(r=>r.at));f.advance(at-now);now=at;
    for(let k=pending.length-1;k>=0;k--)if(pending[k].at===at)pending.splice(k,1)[0].resolve();
  }
  const r=await p;assert.equal(r.result,'CLOSED');assert.equal(r.logicalApiReads,55);assert.equal(r.peakLogicalReads,4);
  assert.equal(r.elapsedMs,22500);assert.equal(55*1500,82500);
});
test('the second sweep waits for every first-sweep lane',async()=>{
  const f=fixture();let release,held=false;
  f.hooks.get=path=>{if(path.endsWith('/tails')&&!held){held=true;return new Promise(r=>release=r);}};
  const p=f.check().run();await tick();assert.equal(f.calls.length,28);assert.ok(release);
  release();assert.equal((await p).completedSweeps,2);
});
test('one lane failure stops admissions; late noncooperative results cannot publish CLOSED',async()=>{
  const f=fixture(),releases=[];
  f.hooks.get=async(path,n)=>{
    if(n===2)throw Error('private detail');if(n>2)return new Promise(r=>releases.push(r));
  };
  const check=f.check(),r=await check.run();assert.equal(r.result,'FAIL');assert.equal(r.completedSweeps,0);
  assert.equal(r.activeLogicalReads,0);assert.ok(r.logicalApiReads<=5);const count=f.calls.length;
  for(const release of releases)release();await tick();assert.equal(check.report().result,'FAIL');assert.equal(f.calls.length,count);
});
test('caller cancellation before and during parallel observation never passes',async()=>{
  const a=fixture(),ac=new AbortController();ac.abort();assert.equal((await a.check({signal:ac.signal}).run()).logicalApiReads,0);
  const f=fixture(),signal=new AbortController();f.hooks.get=async(path,n)=>{if(n===3)signal.abort();};
  const r=await f.check({signal:signal.signal}).run();assert.equal(r.result,'FAIL');assert.equal(r.activeLogicalReads,0);assert.equal(r.completedSweeps,0);
});
for(const [name,mutate] of [
  ['allow',a=>a.policies[0].decision='allow'],['excluded identity',a=>a.policies[0].exclude=[{everyone:{}}]],
  ['wrong audience',a=>a.aud='wrong'],['extra destination',a=>a.destinations.push({type:'public',uri:'unexpected.example'})],
  ['redirect enabled',a=>a.service_auth_401_redirect=true],['policy removed',a=>a.policies=[]],
])test('matching baseline hash cannot authorize unsafe Access semantics / '+name,async()=>{
  const f=fixture(),app=f.data.get('/access/apps/'+g.app);mutate(app);f.expected.access[0].sha256=sha(app);
  assert.equal((await f.check().run()).result,'FAIL');
});
for(const mutation of ['token','gateway'])test('second sweep detects state reopened after first / '+mutation,async()=>{
  const f=fixture();f.hooks.get=async(path,n)=>{if(n===29){if(mutation==='token')f.data.set('/access/service_tokens',[{id:id(77)}]);
    else f.data.get(`/workers/scripts/${g.worker}/subdomain`).enabled=true;}};
  const r=await f.check().run();assert.equal(r.result,'FAIL');assert.ok(r.logicalApiReads>28);
});
test('scope input frozen; arbitrary worker names never become request targets',async()=>{
  const f=fixture(),check=f.check();f.expected.workers[0].name='production-other';
  assert.equal((await check.run()).result,'CLOSED');assert.ok(!f.calls.some(p=>p.includes('production-other')));
  assert.throws(()=>f.check());
});
test('missing or duplicate expected identities rejected before any GET',()=>{
  const f=fixture();f.expected.workers[1]=f.expected.workers[0];assert.throws(()=>f.check());assert.equal(f.calls.length,0);
});
test('failed GET is not retried and original run promise remains terminal',async()=>{
  const f=fixture();f.hooks.get=async()=>{throw Error('private-response-details');};const check=f.check();
  const r=await check.run();assert.equal(r.result,'FAIL');assert.equal(r.logicalApiReads,1);await check.run();assert.equal(f.calls.length,1);
  assert.ok(!JSON.stringify(r).includes('private-response-details'));
});
test('monotonic deadline cannot be bypassed by successful late response',async()=>{
  const f=fixture();f.hooks.get=async()=>f.advance(60001);assert.equal((await f.check().run()).result,'FAIL');assert.equal(f.calls.length,1);
});
test('noncooperative pending GET times out; late reply cannot change failure',async()=>{
  const f=fixture();let release;f.hooks.get=()=>new Promise(r=>release=r);const check=f.check({timeoutMs:30});
  assert.equal((await check.run()).result,'FAIL');release();await new Promise(r=>setImmediate(r));assert.equal(check.report().result,'FAIL');assert.equal(f.calls.length,1);
});
test('closure result is connected to real exclusive append-only host journal',async()=>{
  const f=fixture(),workspace=mkdtempSync(resolve(process.env.BYOK_OPERATOR_TEST_ROOT??'.wrangler/staging','byok-closure-journal-'));
  const j=createByokD1OperatorJournal(workspace,{runId:'c02-byok-a1b2c3d4e5f6',candidateSha256:'a'.repeat(64),priorManifestSha256:'b'.repeat(64)});
  const result=await journalByokD1IngressClosure({journal:j,phase:'before',api:f.api,expected:f.expected,clock:f.clock});assert.equal(result.result,'CLOSED');
  await assert.rejects(journalByokD1IngressClosure({journal:j,phase:'before',api:f.api,expected:f.expected,clock:f.clock}));assert.equal(f.calls.length,55);
  j.close();assert.equal(inspectByokD1OperatorJournal(resolve(j.directory,'journal.jsonl')).attempts['closure-before'],'ACK');
});
for(const oldToken of [false,true])test('actual bounded transport consumes all token pages / old token '+oldToken,async()=>{
  const f=fixture(),requests=[],events=[];
  const session={clock:f.clock,plan:{scope:{account:g.account,database:g.database,gateway:g.worker,controller:c.worker},tokenName:'synthetic-byok-v260'},
    assertWriteReady(){assert.fail('read-only closure cannot mutate');}};
  const fetchImpl=async(url,init)=>{
    const u=new URL(url);assert.equal(u.origin,'https://api.cloudflare.com');assert.equal(init.method,'GET');assert.equal(init.redirect,'error');
    const prefix='/client/v4/accounts/'+g.account;assert.ok(u.pathname.startsWith(prefix+'/'));const path=u.pathname.slice(prefix.length);requests.push(path+u.search);
    if(path==='/access/service_tokens'){
      const page=Number(u.searchParams.get('page'));assert.ok([1,2].includes(page));assert.equal(u.searchParams.get('per_page'),'1000');
      const result=page===1?Array.from({length:1000},(_,i)=>({id:id(100+i),name:'unrelated-synthetic-token'})):[{id:oldToken?id(77):id(9999),name:'unrelated-synthetic-token'}];
      return Response.json({success:true,result,result_info:{page,per_page:1000,count:result.length,total_count:1001,total_pages:2}});
    }
    assert.ok(f.data.has(path+u.search));return Response.json({success:true,result:structuredClone(f.data.get(path+u.search))});
  };
  const transport=createSseCapacityPeerTransport({session,apiToken:'synthetic-offline-token-only',fetchImpl,persist:e=>events.push(e)});
  const r=await createByokD1IngressClosure({api:transport.api,expected:f.expected,clock:f.clock}).run();
  assert.equal(r.result,oldToken?'FAIL':'CLOSED');assert.equal(r.cleanupAuthorized,false);
  assert.equal(requests.filter(p=>p.includes('service_tokens?')).length,oldToken?2:4);
  if(!oldToken){assert.equal(r.logicalApiReads,55);assert.equal(transport.report().operations.length,57);}
  assert.equal(transport.report().cloudMutationAttempted,false);assert.equal(transport.report().productionWrites,0);
  assert.ok(!JSON.stringify(events).includes('synthetic-offline-token-only'));
});
