import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {byokD1DeploymentFingerprint} from './byok-d1-deployment.mjs';
import {inspectByokD1OperatorJournal} from './byok-d1-operator-journal.mjs';
import {SSE_STAGING_SCOPE as g} from './staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as c} from './staging-sse-recovery-access-v2.mjs';
import {byokCleanupFixture} from '../../packages/proxy/scripts/staging/byok-d1-cleanup-fixture.mjs';
import {BYOK_D1_FENCE_TRIGGERS,BYOK_D1_FENCE_KEY,BYOK_D1_FENCE_CLOSED} from '../../packages/proxy/scripts/staging/byok-d1-write-fence.ts';
import {BYOK_D1_CONTROL_KEY} from '../../packages/proxy/scripts/staging/byok-d1-one-shot.ts';
import {BYOK_D1_MAINTENANCE_KEY} from '../../packages/proxy/scripts/staging/byok-d1-cleanup.ts';
import {createByokD1Gateway} from '../../packages/proxy/scripts/staging/byok-d1-gateway.ts';
import {createByokD1MaintenanceControl} from '../../packages/proxy/scripts/staging/byok-d1-maintenance-control.ts';
import {runByokD1Maintenance} from '../../packages/proxy/scripts/staging/byok-d1-maintenance-host.ts';
const {createByokD1Operator:create}=await import(process.env.BYOK_D1_OPERATOR_MODULE
  ?pathToFileURL(resolve(process.env.BYOK_D1_OPERATOR_MODULE)).href:new URL('./byok-d1-operator.mjs',import.meta.url).href);
const sha=v=>createHash('sha256').update(v).digest('hex'),hash=v=>sha(JSON.stringify(v));
const roles=['receiver','controller','gateway'],names=['cinatoken-staging-usage-recovery',c.worker,g.worker];
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const apiToken='synthetic-operator-api-secret',installToken='c1'.repeat(32),clientId='synthetic-access-id',clientSecret='synthetic-access-secret';
const response=result=>Response.json({success:true,errors:[],result});
const app=t=>({id:t.app,aud:t.audience,domain:t.domain,type:'self_hosted',destinations:[{type:'public',uri:t.domain}],service_auth_401_redirect:false,
  policies:[{id:t.policy,name:t===g?'CinaToken staging closed':'CinaToken recovery staging closed',precedence:1,decision:'deny',include:[{everyone:{}}],exclude:[],require:[]}]});

function setup(t,{failPhase,afterWrite=false,mutateProof,readyHook,hook,optionsChange}={}){
  const fixture=byokCleanupFixture(),tasks=[],workspace=fs.mkdtempSync(resolve(process.env.BYOK_OPERATOR_TEST_ROOT??'.wrangler/staging','byok-operator-test-'));
  const journalPath=resolve(workspace,'.wrangler/staging/byok-d1-execution-reservation/journal.jsonl');
  const ctx=t=>({access:{aud:t.audience},waitUntil:p=>tasks.push(p)});
  const gateway=createByokD1Gateway(),controller=createByokD1MaintenanceControl();
  const settings=new Map([...names,'cinatoken-staging-images-upstream','cinatoken-proxy','cinatoken-admin','cinatoken-chain-worker'].map(n=>[n,
    {bindings:[],compatibility_date:'2026-09-16',compatibility_flags:['nodejs_compat'],observability:{enabled:true,head_sampling_rate:1,logs:{invocation_logs:false}}}]));
  const versions=new Map([...settings.keys()].map((n,i)=>[n,id(i+1)]));
  const ingress=new Map([...settings.keys()].map(n=>[n,{enabled:false,previews_enabled:false}]));
  const apps=new Map([[g.app,app(g)],[c.app,app(c)]]),tokens=[],content=new Map(),calls=[];
  const now=Math.floor(Date.now()/1000),before=fixture.schema();
  const fenced=[...before,...BYOK_D1_FENCE_TRIGGERS.map(r=>({type:'trigger',name:r.name,tbl_name:r.table,sql:r.sql}))]
    .sort((a,b)=>a.type<b.type?-1:a.type>b.type?1:a.name<b.name?-1:a.name>b.name?1:0);
  const candidate={runId:fixture.runId,priorManifestSha256:'b'.repeat(64),grant:{version:1,runId:fixture.runId,tokenHash:sha(installToken),
    schemaSha256:hash(before),fencedSchemaSha256:hash(fenced),issuedAt:now-1,expiresAt:now+899},
    bundles:Object.fromEntries(roles.map(role=>{const code='export default {fetch(){return new Response("'+role+'");}};';return [role,{code,sha256:sha(code)}];})),
    priorWorkers:Object.fromEntries(roles.map((role,i)=>[role,{settingsSha256:hash(settings.get(names[i])),versionId:versions.get(names[i])}]))};
  const expected={workers:[...names,'cinatoken-staging-images-upstream'].map(name=>({name,settingsSha256:hash(settings.get(name)),versions:[{version_id:versions.get(name),percentage:100}]})),
    production:['cinatoken-proxy','cinatoken-admin','cinatoken-chain-worker'].map(name=>({name,settingsSha256:hash(settings.get(name))})),
    access:[g,c].map(t=>({id:t.app,sha256:hash(apps.get(t.app))})),previousTokenIds:[id(90)]};
  const ac=new AbortController();let injected=false,proofCalls=0;
  const phase=()=>{if(!fs.existsSync(journalPath))return 'none';const rows=fs.readFileSync(journalPath,'utf8').trim().split('\n').map(JSON.parse);
    return rows.at(-1).step;};
  const readValue=key=>fixture.db.prepare('SELECT value FROM system_config WHERE key=?').get(key)?.value;
  const api=async(path,method='GET',body)=>{
    if(path==='/d1/database/'+g.database){assert.equal(method,'GET');return {uuid:g.database,name:'cinatoken-staging'};}
    if(path==='/d1/database/'+g.database+'/query'){
      assert.equal(method,'POST');const data=JSON.parse(body),qs=data.batch??[data];
      if(qs.some(q=>!/^(SELECT|PRAGMA)/.test(q.sql)))assert.equal(qs.length,1);
      return qs.map(q=>{const results=fixture.db.prepare(q.sql).all(...q.params);return {success:true,results,
        meta:{rows_read:results.length,rows_written:/^(SELECT|PRAGMA)/.test(q.sql)?0:fixture.db.prepare('SELECT changes() n').get().n}};});
    }
    if(path==='/access/service_tokens'||path.startsWith('/access/service_tokens?')){
      if(method==='POST'){
        const p=JSON.parse(body),r={id:id(80),name:p.name,client_id:clientId,client_secret:clientSecret};tokens.push({id:r.id,name:r.name});return r;
      }assert.equal(method,'GET');return structuredClone(tokens);
    }
    if(path==='/access/service_tokens/'+id(80)){assert.equal(method,'DELETE');tokens.splice(0);return {id:id(80)};}
    for(const t of [g,c]){
      if(path==='/access/apps/'+t.app){assert.equal(method,'GET');return structuredClone(apps.get(t.app));}
      if(path==='/access/apps/'+t.app+'/policies/'+t.policy){assert.equal(method,'PUT');const p={id:t.policy,...JSON.parse(body)};
        apps.get(t.app).policies=[p];apps.get(t.app).updated_at=String(calls.length);return p;}
    }
    for(const [name,value] of settings){
      const base='/workers/scripts/'+name;
      if(path===base+'?excludeScript=true&bindings_inherit=strict'){
        assert.equal(method,'PUT');assert.ok(names.includes(name));const m=JSON.parse(body.get('metadata'));
        settings.set(name,{bindings:m.bindings,compatibility_date:m.compatibility_date,compatibility_flags:m.compatibility_flags,observability:m.observability,limits:m.limits});
        versions.set(name,id(100+names.indexOf(name)));content.set(name,await body.get(m.main_module).text());return {deployment_id:versions.get(name)};
      }
      if(path===base+'/settings')return structuredClone(value);
      if(path===base+'/deployments')return {deployments:[{versions:[{version_id:versions.get(name),percentage:100}]}]};
      if(path===base+'/subdomain'){
        if(method==='POST'){assert.ok([g.worker,c.worker].includes(name));ingress.set(name,JSON.parse(body));}
        return structuredClone(ingress.get(name));
      }
      if(path==='/workers/domains?service='+name||path===base+'/tails')return [];
      if(path===base+'/schedules')return {schedules:[]};
    }
    throw Error('unexpected synthetic path');
  };
  async function maybeFail(call,base){
    const p=phase();calls.push({...call,phase:p});
    const candidateFail=!injected&&p===failPhase&&(!afterWrite||call.method!=='GET');
    if(candidateFail&&!afterWrite){injected=true;throw Error('synthetic secret must not escape');}
    await hook?.({phase:p,call,fixture,readValue,ac,apps,tokens});
    const result=await base();
    if(candidateFail){injected=true;throw Error('synthetic lost acknowledgement');}
    return result;
  }
  const fetchImpl=async(url,init)=>{
    assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');
    const prefix='https://api.cloudflare.com/client/v4/accounts/'+g.account;
    if(url.startsWith(prefix)){
      const path=url.slice(prefix.length);assert.equal(init.headers.Authorization,'Bearer '+apiToken);
      return maybeFail({path,method:init.method},async()=>{
        for(const name of names)if(path==='/workers/scripts/'+name&&init.method==='GET')return new Response(content.get(name),{headers:{'Content-Type':'application/javascript+module'}});
        const value=await api(path,init.method,init.body);
        if(path.startsWith('/access/service_tokens?'))return Response.json({success:true,errors:[],result:value,
          result_info:{page:1,per_page:1000,count:value.length,total_count:value.length,total_pages:value.length?1:0}});
        if(path.startsWith('/workers/domains?service='))return Response.json({success:true,errors:null,messages:null,result:value,
          result_info:{page:1,per_page:0,count:0,total_count:0}});
        return response(value);
      });
    }
    const u=new URL(url),target=u.host===g.domain?g:c;assert.equal(u.host,target.domain);
    return maybeFail({path:u.pathname,method:init.method},async()=>{
      assert.equal(ingress.get(target.worker).enabled,true);assert.equal(apps.get(target.app).policies[0].decision,'non_identity');
      assert.equal(tokens.length,1);assert.equal(init.headers['CF-Access-Client-Id'],clientId);assert.equal(init.headers['CF-Access-Client-Secret'],clientSecret);
      if(target===g){
        const env=Object.fromEntries(settings.get(g.worker).bindings.filter(b=>b.type==='plain_text').map(b=>[b.name,b.text]));
        return gateway.fetch(new Request(url,init),{...env,BYOK_DB:fixture.raw},ctx(g));
      }
      return controller.fetch(new Request(url,init),{BYOK_MAINTENANCE_CONTROL_ENVIRONMENT:'staging',BYOK_MAINTENANCE_CONTROL_ENABLED:'true',
        BYOK_MAINTENANCE_ACCESS_AUD:c.audience,USAGE_RECOVERY:{run:token=>runByokD1Maintenance(fixture.raw,true,token,ctx(c))}},ctx(c));
    });
  };
  const options={workspace,candidate,expected,apiToken,installToken,fetchImpl,signal:ac.signal,
    preflight:async identity=>{
      proofCalls++;if(failPhase==='preflight')throw Error('private preflight data');
      const {signal,...rest}=identity;const proof={...rest,evidenceSha256:'e'.repeat(64),firstRoundUsdCap:2,capReset:false,
        sourcesFrozen:true,priorCodeComplete:true,exclusiveOwnership:true,allInvocationPathsInventoried:true,
        actualPaidPlanVerified:true,cumulativeBudgetReserved:true,maintenanceTimingQualified:true};mutateProof?.(proof);return proof;
    },assertReady:info=>readyHook?readyHook(info,{ac,fixture,readValue}):true};
  optionsChange?.(options);const operator=create(options);
  t.after(async()=>{await Promise.allSettled(tasks);await fixture.close();});
  return {fixture,options,operator,calls,tokens,apps,ingress,readValue,journalPath,ac,workspace,proofCalls:()=>proofCalls,
    inspected:()=>inspectByokD1OperatorJournal(journalPath)};
}

test('whole real adapter chain with synthetic cloud + SQLite, 93 records, fixed retained-closed exit',async t=>{
  const f=setup(t),before=f.fixture.allRows();assert.equal(fs.existsSync(f.journalPath),false);assert.equal(f.calls.length,0);
  const p=f.operator.run();assert.equal(f.operator.run(),p);const r=await p;
  assert.equal(r.result,'VERIFIED_RETAINED_CLOSED',JSON.stringify(r));assert.equal(r.completedCases,10);assert.equal(r.nativeAcceptanceProved,false);
  assert.equal(r.journal.sequence,93);assert.equal(r.journal.closed,true);assert.equal(f.inspected().records,93);assert.equal(f.tokens.length,0);assert.equal(f.proofCalls(),1);
  for(const v of f.ingress.values())assert.equal(v.enabled,false);
  for(const a of f.apps.values())assert.equal(a.policies[0].decision,'deny');
  assert.equal(f.readValue(BYOK_D1_CONTROL_KEY),undefined);assert.equal(f.readValue(BYOK_D1_FENCE_KEY),BYOK_D1_FENCE_CLOSED);
  const permit=JSON.parse(f.readValue(BYOK_D1_MAINTENANCE_KEY));assert.equal(permit.state,'finished');assert.equal(permit.receipt.removedRows,664);
  const after=f.fixture.allRows();after.system_config=after.system_config.filter(r=>![BYOK_D1_FENCE_KEY,BYOK_D1_MAINTENANCE_KEY].includes(r.key));assert.deepEqual(after,before);
  const count=f.calls.length;await f.operator.run();assert.equal(f.calls.length,count);
  assert.deepEqual(Object.keys(f.operator).sort(),['report','run']);
  const recorded=fs.readFileSync(f.journalPath,'utf8')+JSON.stringify(r);
  for(const v of [apiToken,installToken,clientId,clientSecret])assert.ok(!recorded.includes(v));
  assert.equal(r.final.tablesChecked,56);assert.equal(r.final.preservedTablesChecked,4);
  assert.equal(r.observations.httpAttempts,165);assert.equal(r.observations.httpAcknowledged,165);
  assert.equal(r.observations.journalRecords,331);assert.equal(r.observations.peakActive,4);assert.equal(r.observations.closed,true);
});

test('controller preparation with 18 seconds of virtual management latency precedes the fresh cleanup window',async t=>{
  const original=performance.now.bind(performance);let delay=0,activationCalls=0;
  t.mock.method(performance,'now',()=>original()+delay);
  const f=setup(t,{hook:({phase})=>{if(['open-controller-access','open-controller'].includes(phase)){delay+=1500;activationCalls++;}}});
  const r=await f.operator.run();assert.equal(r.result,'VERIFIED_RETAINED_CLOSED',JSON.stringify(r));
  assert.equal(activationCalls,12);assert.equal(delay,18000);
  const events=fs.readFileSync(f.journalPath,'utf8').trim().split('\n').map(JSON.parse).filter(e=>e.outcome==='PENDING').map(e=>e.step);
  for(const [a,b] of [['seal-fence','open-controller-access'],['close-access','open-controller-access'],['open-controller-access','open-controller'],
    ['open-controller','closure-fresh'],['closure-fresh','arm-maintenance'],['arm-maintenance','cleanup']])assert.ok(events.indexOf(a)<events.indexOf(b));
  assert.equal(r.nativeAcceptanceProved,false);
});

test('prepared controller has no permit before closure and cannot clean prematurely',async t=>{
  let checked=false;const f=setup(t,{hook:async({phase,fixture,readValue})=>{
    if(phase!=='closure-fresh'||checked)return;checked=true;
    assert.equal(readValue(BYOK_D1_FENCE_KEY),BYOK_D1_FENCE_CLOSED);assert.equal(JSON.parse(readValue(BYOK_D1_CONTROL_KEY)).state,'stopped');
    assert.equal(readValue(BYOK_D1_MAINTENANCE_KEY),undefined);const before=fixture.allRows(),tasks=[];
    const r=await runByokD1Maintenance(fixture.raw,true,'d1'.repeat(32),{waitUntil:p=>tasks.push(p)});await Promise.allSettled(tasks);
    assert.notEqual(r.status,'cleaned');assert.deepEqual(fixture.allRows(),before);
  }});assert.equal((await f.operator.run()).result,'VERIFIED_RETAINED_CLOSED');assert.equal(checked,true);
});

for(const failPhase of ['preflight','closure-before',...roles.map(r=>'deploy-'+r),'create-token','open-access','open-gateway','install-fence',
  'baseline','arm','open-fence','case-0','verify-case-0','case-9','verify-case-9','stop','seal-fence','close-gateway','close-access',
  'closure-fresh','arm-maintenance','open-controller-access','open-controller','cleanup','close-controller','close-controller-access','revoke-token','closure-after','final-verify'])
test('failure stops sequence, never replays or cleans uncertain fixtures / '+failPhase,async t=>{
  const f=setup(t,{failPhase}),r=await f.operator.run();assert.equal(r.result,'ATTENTION_REQUIRED');assert.equal(r.failedPhase,failPhase,JSON.stringify(r));
  assert.equal(r.nativeAcceptanceProved,false);assert.equal(r.mayReplay,false);
  const count=f.calls.length;await f.operator.run();assert.equal(f.calls.length,count);
  const attempts=f.inspected().attempts;
  if(!['cleanup','close-controller','close-controller-access','revoke-token','closure-after','final-verify'].includes(failPhase))assert.equal(attempts.cleanup,undefined);
  if(['preflight','closure-before'].includes(failPhase))assert.ok(f.calls.every(c=>c.method==='GET'));
  else for(const k of ['close-gateway','close-controller','close-access','close-controller-access','revoke-token'])assert.ok(attempts[k]);
  assert.ok(!JSON.stringify(r).includes('private preflight data'));
});

for(const failPhase of ['deploy-gateway','create-token','open-access','open-gateway','install-fence','arm','open-fence','case-0','stop','arm-maintenance','cleanup'])
test('committed operation but lost ACK cannot be retried / '+failPhase,async t=>{
  const f=setup(t,{failPhase,afterWrite:true}),r=await f.operator.run();assert.equal(r.result,'ATTENTION_REQUIRED');assert.equal(r.failedPhase,failPhase);
  const n=f.calls.length;await f.operator.run();assert.equal(f.calls.length,n);
  if(['open-fence','case-0','stop'].includes(failPhase))assert.equal(f.readValue(BYOK_D1_FENCE_KEY),BYOK_D1_FENCE_CLOSED);
  if(failPhase==='cleanup')assert.equal(JSON.parse(f.readValue(BYOK_D1_MAINTENANCE_KEY)).state,'finished');
  assert.equal(r.nativeAcceptanceProved,false);
});

for(const field of ['sourcesFrozen','priorCodeComplete','exclusiveOwnership','allInvocationPathsInventoried','actualPaidPlanVerified','cumulativeBudgetReserved',
  'maintenanceTimingQualified','firstRoundUsdCap','capReset','candidateSha256','priorManifestSha256','scopeSha256','runId'])
test('missing or conflicting admission proof is zero cloud I/O / '+field,async t=>{
  const f=setup(t,{mutateProof:p=>{p[field]=field==='capReset'?true:false;}}),r=await f.operator.run();
  assert.equal(r.result,'ATTENTION_REQUIRED');assert.equal(r.failedPhase,'preflight');assert.equal(f.calls.length,0);
});
test('asynchronous readiness is not proof and cannot activate',async t=>{
  const f=setup(t,{readyHook:async()=>true});assert.equal((await f.operator.run()).result,'ATTENTION_REQUIRED');assert.equal(f.calls.length,0);
});
test('already aborted run does not reserve or call proof providers',async t=>{
  const f=setup(t);f.ac.abort();assert.equal((await f.operator.run()).result,'ATTENTION_REQUIRED');assert.equal(f.proofCalls(),0);assert.equal(fs.existsSync(f.journalPath),false);
});
test('cancel after a verified case still performs STOP and seals with independent containment signals',async t=>{
  const f=setup(t,{readyHook:(info,{ac})=>{if(info.step==='case-1')ac.abort();return true;}});
  const r=await f.operator.run();assert.equal(r.result,'ATTENTION_REQUIRED');assert.equal(r.completedCases,1);
  assert.equal(f.inspected().attempts.stop,'ACK');assert.equal(f.inspected().attempts['seal-fence'],'ACK');assert.equal(f.inspected().attempts.cleanup,undefined);
  assert.equal(f.readValue(BYOK_D1_FENCE_KEY),BYOK_D1_FENCE_CLOSED);
});
for(const drift of ['preserved-row','oversize-row','permit','receipt','fence','schema','foreign-table'])
test('HTTP cleanup ACK cannot hide final database drift / '+drift,async t=>{
  let changed=false;
  const f=setup(t,{hook:({phase,fixture,readValue})=>{
    if(phase!=='final-verify'||changed)return;changed=true;
    if(drift==='preserved-row')fixture.db.exec("UPDATE admin_api_keys SET name='drift'");
    if(drift==='oversize-row')fixture.db.prepare('UPDATE admin_api_keys SET name=?').run('x'.repeat(9000));
    if(drift==='permit'){const p=JSON.parse(readValue(BYOK_D1_MAINTENANCE_KEY));p.tokenHash='f'.repeat(64);fixture.db.prepare('UPDATE system_config SET value=? WHERE key=?').run(JSON.stringify(p),BYOK_D1_MAINTENANCE_KEY);}
    if(drift==='receipt'){const p=JSON.parse(readValue(BYOK_D1_MAINTENANCE_KEY));p.receipt.removedRows=663;fixture.db.prepare('UPDATE system_config SET value=? WHERE key=?').run(JSON.stringify(p),BYOK_D1_MAINTENANCE_KEY);}
    if(drift==='fence')fixture.db.prepare('UPDATE system_config SET value=? WHERE key=?').run('{}',BYOK_D1_FENCE_KEY);
    if(drift==='schema')fixture.db.exec('CREATE TABLE unexpected(id TEXT)');
    if(drift==='foreign-table')fixture.db.exec("INSERT INTO system_config(key,value) VALUES('foreign','data')");
  }});const r=await f.operator.run();assert.equal(r.result,'ATTENTION_REQUIRED');assert.equal(r.failedPhase,'final-verify');assert.equal(f.inspected().attempts.cleanup,'ACK');
});
test('scope frozen and same workspace cannot acquire a second execution even with fresh object',async t=>{
  const f=setup(t);f.options.candidate.bundles.receiver.code='mutated';f.options.expected.workers[0].name='production-other';
  const r=await f.operator.run();assert.equal(r.result,'VERIFIED_RETAINED_CLOSED');
  assert.equal(r.journal.poisoned,false);assert.ok(f.calls.every(c=>!c.path.includes('production-other')));
  // Restore only caller-owned copies, never the reservation.
  f.options.candidate.bundles.receiver.code='export default {fetch(){return new Response("receiver");}};';
  f.options.expected.workers[0].name=names[0];
  const next=create(f.options),n=f.calls.length;assert.equal((await next.run()).result,'ATTENTION_REQUIRED');assert.equal(f.calls.length,n);
});
test('constructor rejects cross-candidate prior state before reservation',t=>{
  const f=setup(t);f.options.expected.workers[0].settingsSha256='a'.repeat(64);
  assert.throws(()=>create(f.options),/^Error: byok_operator_options_invalid$/);assert.equal(fs.existsSync(f.journalPath),false);
});
test('cleanup refuses an aged producer closure without extending native freshness',async t=>{
  const original=Date.now;let jumped=false;
  const f=setup(t,{readyHook:info=>{
    if(info.step==='cleanup'&&!jumped){jumped=true;Date.now=()=>original()+20000;}return true;
  }});
  try{
    const r=await f.operator.run();assert.equal(r.result,'ATTENTION_REQUIRED');assert.equal(r.failedPhase,'cleanup');
    assert.equal(f.inspected().attempts.cleanup,undefined);assert.equal(f.ingress.get(c.worker).enabled,false);
    assert.equal(f.readValue(BYOK_D1_FENCE_KEY),BYOK_D1_FENCE_CLOSED);
  }finally{Date.now=original;}
});
test('lost cleanup ACK is retained, despite later closing and finished durable permit',async t=>{
  const f=setup(t,{failPhase:'cleanup',afterWrite:true});const r=await f.operator.run();
  assert.equal(r.result,'ATTENTION_REQUIRED');assert.equal(r.journal.poisoned,true);
  assert.equal(JSON.parse(f.readValue(BYOK_D1_MAINTENANCE_KEY)).state,'finished');
  assert.equal(f.inspected().attempts['final-verify'],undefined);assert.equal(f.inspected().attempts['closure-after'],undefined);
  assert.equal(f.tokens.length,0);assert.equal(r.final,undefined);
});
test('monotonic elapsed time prevents stale maintenance even without a wall clock change',async t=>{
  const original=performance.now.bind(performance);let jumped=false;
  const f=setup(t,{readyHook:info=>{
    if(info.step==='cleanup'&&!jumped){jumped=true;t.mock.method(performance,'now',()=>original()+11000);}return true;
  }});
  const r=await f.operator.run();assert.equal(r.result,'ATTENTION_REQUIRED');assert.equal(r.failedPhase,'cleanup');
  assert.equal(f.inspected().attempts.cleanup,undefined);assert.equal(f.ingress.get(c.worker).enabled,false);
  assert.equal(f.readValue(BYOK_D1_FENCE_KEY),BYOK_D1_FENCE_CLOSED);
});
test('observer must have space to revoke and verify this run token before reservation',t=>{
  const f=setup(t);f.options.expected.previousTokenIds=Array.from({length:100},(_,i)=>id(300+i));
  assert.throws(()=>create(f.options),/^Error: byok_operator_options_invalid$/);assert.equal(fs.existsSync(f.journalPath),false);
});
