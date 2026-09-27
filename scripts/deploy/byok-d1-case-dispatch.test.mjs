import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setImmediate as tick} from 'node:timers/promises';
import {createByokD1OperatorJournal,inspectByokD1OperatorJournal} from './byok-d1-operator-journal.mjs';
import {BYOK_D1_CASES} from '../../packages/proxy/scripts/staging/byok-d1-acceptance.ts';
import {BYOK_D1_ORIGIN,BYOK_D1_CONTROL_KEY} from '../../packages/proxy/scripts/staging/byok-d1-one-shot.ts';
import {byokCleanupFixture} from '../../packages/proxy/scripts/staging/byok-d1-cleanup-fixture.mjs';
import {byokD1FenceInstallPlan,byokD1FenceTransition,BYOK_D1_FENCE_KEY,BYOK_D1_FENCE_CLOSED} from '../../packages/proxy/scripts/staging/byok-d1-write-fence.ts';
import {captureByokD1CleanupBaseline,BYOK_D1_MAINTENANCE_KEY} from '../../packages/proxy/scripts/staging/byok-d1-cleanup.ts';
import {createByokD1Gateway} from '../../packages/proxy/scripts/staging/byok-d1-gateway.ts';
import {createByokD1MaintenanceDispatch} from './byok-d1-maintenance-dispatch.mjs';
import {createByokD1MaintenanceControl} from '../../packages/proxy/scripts/staging/byok-d1-maintenance-control.ts';
import {runByokD1Maintenance} from '../../packages/proxy/scripts/staging/byok-d1-maintenance-host.ts';
const {createByokD1CaseDispatch:create}=await import(process.env.BYOK_D1_CASE_DISPATCH_MODULE
  ?pathToFileURL(resolve(process.env.BYOK_D1_CASE_DISPATCH_MODULE)).href:new URL('./byok-d1-case-dispatch.mjs',import.meta.url).href);
const runId='c02-byok-a1b2c3d4e5f6',token='a1'.repeat(32),aud='a'.repeat(64),clientId='synthetic.access',secret='synthetic-access-secret';
const hash=v=>createHash('sha256').update(v).digest('hex');
const initial=()=>{const now=Math.floor(Date.now()/1000);return {version:1,runId,tokenHash:hash(token),issuedAt:now-1,expiresAt:now+899,state:'ready',cursor:0,pendingCase:null,receipts:[]};};
const receipt=(caseId=BYOK_D1_CASES[0])=>({caseId,outcome:'PASS',completedAt:Math.floor(Date.now()/1000),
  result:{caseId,result:'PASS',expectedAudits:0,batches:[],midBatchWallClockExpiryVerified:false},
  counters:{statements:8,calls:4,active:0,peakActive:1,acknowledgedRowsRead:0,acknowledgedRowsWritten:4,callsWithoutRowMetadata:0,nativeRejectedCalls:0}});
const response=value=>Response.json(value,{headers:{'Cache-Control':'no-store'}});
const good=(caseId)=>response({code:'case_pass',receipt:receipt(caseId)}),stopGood=()=>response({code:'admissions_stopped'});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function setup(t,fetchImpl,io){
  const workspace=fs.mkdtempSync(resolve(process.env.BYOK_OPERATOR_TEST_ROOT??'.wrangler/staging','byok-cases-test-'));
  const journal=createByokD1OperatorJournal(workspace,{runId,candidateSha256:'a'.repeat(64),priorManifestSha256:'b'.repeat(64)},io?{io}:{});
  t.after(()=>journal.close());const path=resolve(journal.directory,'journal.jsonl');
  const options={journal,control:initial(),token,accessClientId:clientId,accessClientSecret:secret,fetchImpl};
  return {workspace,journal,path,options,read:()=>inspectByokD1OperatorJournal(path)};
}
async function integrated(t,transport){
  const db=byokCleanupFixture(),tasks=[],ctx={access:{aud},waitUntil(p){assert.equal(this,ctx);tasks.push(p);}};
  t.after(async()=>{await Promise.all(tasks);await db.close();});
  await db.raw.batch(byokD1FenceInstallPlan(JSON.stringify(db.schema())).map(q=>db.raw.prepare(q.sql).bind(...q.params)));
  const baseline=await captureByokD1CleanupBaseline(db.raw,hash(JSON.stringify(db.schema())),'write-fence-v1'),before=db.allRows();
  db.arm();const open=byokD1FenceTransition(runId,true);assert.equal((await db.raw.prepare(open.sql).bind(...open.params).run()).meta.changes,1);
  const read=()=>JSON.parse(db.db.prepare('SELECT value FROM system_config WHERE key=?').get(BYOK_D1_CONTROL_KEY).value);
  const gateway=createByokD1Gateway(),env={BYOK_DB:db.raw,BYOK_GATEWAY_ENVIRONMENT:'staging',BYOK_GATEWAY_ENABLED:'true',BYOK_GATEWAY_ACCESS_AUD:aud};
  let http=0;const fetchImpl=async(url,init)=>{http++;return transport?transport({url,init,db,ctx,env,gateway,read}):gateway.fetch(new Request(url,init),env,ctx);};
  const f=setup(t,fetchImpl);f.options.control=read();
  return {...f,db,ctx,tasks,baseline,before,control:read,dispatch:create(f.options),get http(){return http;}};
}

test('fixed ordered HTTP commands are journaled before send; receipts are independent copies',async t=>{
  let count=0;const f=setup(t,async(url,init)=>{
    const id=BYOK_D1_CASES[count];assert.equal(f.read().attempts['case-'+count],'PENDING');count++;
    assert.equal(url,BYOK_D1_ORIGIN+'/__staging/byok-d1/'+id);assert.equal(init.method,'POST');assert.equal(init.redirect,'error');assert.equal(init.body,undefined);
    assert.equal(init.headers.Authorization,'Bearer '+token);assert.equal(init.headers['CF-Access-Client-Secret'],secret);
    assert.equal(init.headers['X-CinaToken-BYOK-Command'],'case-once-v1');assert.equal(init.headers['Content-Length'],'0');return good(id);
  });
  const d=create(f.options);
  for(const [i,id] of BYOK_D1_CASES.entries()){
    const r=await d.runNext();assert.equal(r.caseId,id);assert.equal(f.read().attempts['case-'+i],'ACK');r.counters.active=999;
    assert.equal(d.snapshot().completedCases,i+1);
  }
  await assert.rejects(d.runNext());await assert.rejects(create(f.options).runNext());assert.equal(count,10);
  const text=fs.readFileSync(f.path,'utf8');for(const value of [token,clientId,secret,'Authorization'])assert.ok(!text.includes(value));
});
test('initial state, credentials and journal identity are validated without echo or I/O',t=>{
  let calls=0;const f=setup(t,async()=>{calls++;return good();});
  for(const change of [{token:secret},{accessClientSecret:secret+'\n'},{accessClientId:''},{timeoutMs:30001},
    {control:{...initial(),state:'pending'}},{control:{...initial(),cursor:1}},{control:{...initial(),runId:'c02-byok-111111111111'}},
    {control:{...initial(),tokenHash:'b'.repeat(64)}},{control:{...initial(),extra:secret}}])
    assert.throws(()=>create({...f.options,...change}),e=>!String(e).includes(secret));
  assert.equal(Object.isFrozen(f.journal.identity),true);assert.equal(calls,0);assert.deepEqual(f.read().attempts,{});
});
for(const mode of ['http','redirect','redirected','content-type','cache','length','length-mismatch','large-body','invalid-json','utf8','extra-field',
  'wrong-case','fail-receipt','active','excess-statements','missing-metadata','false-native-proof','extra-nested-field','stale-time','transport'])
test('invalid or unknown outcome consumes the case and blocks every later case / '+mode,async t=>{
  let calls=0;const f=setup(t,async()=>{calls++;
    if(mode==='transport')throw Error(secret);if(mode==='http')return new Response(secret,{status:503});
    if(mode==='redirect')return new Response(null,{status:302,headers:{Location:'https://untrusted.invalid'}});
    if(mode==='redirected'){const r=good();Object.defineProperty(r,'redirected',{value:true});return r;}
    if(mode==='large-body')return new Response(' '.repeat(8193),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
    if(mode==='invalid-json'||mode==='utf8')return new Response(mode==='utf8'?new Uint8Array([0xff]):'{',{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
    const v={code:'case_pass',receipt:receipt()};
    if(mode==='extra-field')v.private=secret;if(mode==='wrong-case')v.receipt.caseId=BYOK_D1_CASES[1];
    if(mode==='fail-receipt')v.receipt.outcome='FAIL';if(mode==='active')v.receipt.counters.active=1;
    if(mode==='excess-statements')v.receipt.counters.statements=201;if(mode==='missing-metadata')delete v.receipt.counters.calls;
    if(mode==='false-native-proof')v.receipt.result.midBatchWallClockExpiryVerified=true;
    if(mode==='extra-nested-field')v.receipt.result.private=secret;if(mode==='stale-time')v.receipt.completedAt=0;
    const r=response(v);if(mode==='content-type')r.headers.set('Content-Type','text/html');if(mode==='cache')r.headers.delete('Cache-Control');
    if(mode==='length')r.headers.set('Content-Length','8193');if(mode==='length-mismatch')r.headers.set('Content-Length','1');return r;
  });
  const d=create(f.options);await assert.rejects(d.runNext(),/^Error: byok_case_dispatch_unconfirmed$/);
  await assert.rejects(d.runNext());await assert.rejects(create(f.options).runNext());assert.equal(calls,1);
  assert.equal(d.snapshot().completedCases,0);assert.equal(f.read().attempts['case-0'],'FAILED_OR_UNCERTAIN');assert.ok(!fs.readFileSync(f.path,'utf8').includes(secret));
});
test('read-count budget rejects many tiny/empty chunks without unbounded accumulation',async t=>{
  let pulls=0,cancelled=0;const f=setup(t,async()=>new Response(new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array());},cancel(){cancelled++;}},
    {highWaterMark:0}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}}));
  await assert.rejects(create(f.options).runNext());await tick();assert.equal(pulls,256);assert.equal(cancelled,1);
});
test('concurrent runNext cannot start another case or consume another journal step',async t=>{
  const entered=deferred(),release=deferred();let calls=0;
  const f=setup(t,async()=>{calls++;entered.resolve();await release.promise;return good();}),d=create(f.options);
  const running=d.runNext();await entered.promise;await assert.rejects(d.runNext());assert.equal(calls,1);assert.equal(d.snapshot().failed,false);
  release.resolve();await running;assert.equal(d.snapshot().completedCases,1);assert.deepEqual(f.read().attempts,{'case-0':'ACK'});
});
for(const mode of ['pre-abort','after-dispatch','timeout-late-response','timeout-body'])test('host deadline/abort never authorizes retry / '+mode,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const ac=new AbortController(),late=deferred();let calls=0,cancels=0;
  const f=setup(t,async()=>{calls++;if(mode==='timeout-body')return new Response(new ReadableStream({pull(){},cancel(){cancels++;}}),
    {headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});return late.promise;});
  const d=create(f.options);if(mode==='pre-abort')ac.abort();const running=d.runNext({signal:ac.signal}),rejected=assert.rejects(running);
  await tick();if(mode==='after-dispatch')ac.abort();else if(mode!=='pre-abort')t.mock.timers.tick(30000);await rejected;
  assert.equal(calls,mode==='pre-abort'?0:1);assert.equal(d.snapshot().failed,true);assert.equal(d.snapshot().completedCases,0);
  if(mode==='timeout-late-response'){late.resolve(new Response(new ReadableStream({cancel(){cancels++;}})));await tick();assert.equal(cancels,1);}
  if(mode==='timeout-body')assert.equal(cancels,1);if(mode==='after-dispatch')late.resolve(good());
  await assert.rejects(d.runNext());await assert.rejects(create(f.options).runNext());
});
for(const phase of ['pending','ack'])test('disk fsync failure is not replayable / '+phase,async t=>{
  let syncs=0,calls=0;const f=setup(t,async()=>{calls++;return good();},{...fs,fsyncSync(fd){if(++syncs===(phase==='pending'?2:3))throw Error('disk');return fs.fsyncSync(fd);}});
  const d=create(f.options);await assert.rejects(d.runNext());await assert.rejects(create(f.options).runNext());assert.equal(calls,phase==='pending'?0:1);
  assert.equal(f.journal.snapshot().attempts['case-0'],phase==='pending'?'NOT_INVOKED':'FAILED_OR_UNCERTAIN');
});
test('after unknown case STOP and seal remain once-only containment; cleanup stays forbidden',async t=>{
  let calls=0,sealed=0;const f=setup(t,async(url,init)=>{calls++;
    if(url.endsWith('/stop')){assert.equal(f.read().attempts.stop,'PENDING');assert.equal(init.headers['X-CinaToken-BYOK-Command'],'stop-once-v1');return stopGood();}
    throw Error('unknown');
  }),d=create(f.options);
  await assert.rejects(d.runNext());assert.deepEqual(await d.stop(),{code:'admissions_stopped'});
  await f.journal.attempt('seal-fence',async()=>{sealed++;});await assert.rejects(f.journal.attempt('seal-fence',async()=>{sealed++;}));
  await assert.rejects(d.stop());await assert.rejects(create(f.options).stop());await assert.rejects(f.journal.attempt('cleanup',()=>assert.fail('forbidden')));
  assert.equal(sealed,1);assert.equal(calls,2);assert.equal(f.read().attempts.stop,'ACK');assert.equal(f.journal.snapshot().poisoned,true);
});
test('STOP can run while host is waiting on a case, and prevents later case dispatch',async t=>{
  const entered=deferred(),release=deferred();let calls=0;
  const f=setup(t,async url=>{calls++;if(url.endsWith('/stop'))return stopGood();entered.resolve();await release.promise;return good();}),d=create(f.options);
  const running=d.runNext();await entered.promise;await d.stop();assert.equal(d.snapshot().caseInFlight,true);
  release.resolve();await running;await assert.rejects(d.runNext());assert.equal(calls,2);assert.equal(d.snapshot().stopped,true);
});
for(const step of ['stop','seal-fence'])test('new dispatcher instance cannot start cases after containment / '+step,async t=>{
  let calls=0;const f=setup(t,async()=>{calls++;return good();});
  await f.journal.attempt(step,async()=>{});
  await assert.rejects(create(f.options).runNext());assert.equal(calls,0);assert.equal(f.read().attempts['case-0'],undefined);
});
test('failed STOP or failed containment journal never re-enables case flow',async t=>{
  let calls=0,armed=false;const f=setup(t,async()=>{calls++;return stopGood();},{...fs,fsyncSync(fd){if(armed)throw Error('disk');return fs.fsyncSync(fd);}});
  const d=create(f.options);armed=true;await assert.rejects(d.stop());assert.equal(calls,1);
  await assert.rejects(d.stop());await assert.rejects(d.runNext());await assert.rejects(create(f.options).stop());assert.equal(calls,1);assert.equal(f.journal.snapshot().poisoned,true);
});
for(const bad of [{code:'already_stopped'},{code:'admissions_stopped',quiescent:true},{code:'admissions_stopped',retry_safe:true}])
test('STOP accepts only the exact admission-stop acknowledgement / '+JSON.stringify(bad),async t=>{
  let calls=0;const f=setup(t,async()=>{calls++;return response(bad);}),d=create(f.options);
  await assert.rejects(d.stop());await assert.rejects(d.stop());assert.equal(calls,1);assert.equal(d.snapshot().stopped,true);
});
for(const mode of ['before-claim','claim-ack-lost','http-ack-lost'])test('host -> gateway -> actual SQLite unknown leaves state and forbids replay / '+mode,async t=>{
  let injected=false;const f=await integrated(t,async({url,init,db,ctx,env,gateway})=>{
    if(!url.endsWith('/stop')&&!injected){injected=true;
      if(mode==='before-claim')throw Error('never reached Worker');
      if(mode==='claim-ack-lost')db.hooks.afterStatement=s=>{if(s.sql.startsWith('UPDATE system_config')&&JSON.parse(s.values[0]).state==='pending')throw Error('claim ACK');};
    }
    const r=await gateway.fetch(new Request(url,init),env,ctx);if(!url.endsWith('/stop')&&mode==='http-ack-lost')throw Error('HTTP ACK');return r;
  });
  await assert.rejects(f.dispatch.runNext());assert.equal(f.control().state,mode==='claim-ack-lost'?'pending':'ready');
  assert.equal(f.control().cursor,mode==='http-ack-lost'?1:0);const before=f.http;
  await assert.rejects(create(f.options).runNext());assert.equal(f.http,before);
  delete f.db.hooks.afterStatement;await f.dispatch.stop();assert.equal(f.control().state,'stopped');
  await f.journal.attempt('seal-fence',async()=>{const q=byokD1FenceTransition(runId,false);assert.equal((await f.db.raw.prepare(q.sql).bind(...q.params).run()).meta.changes,1);});
  assert.equal(f.db.db.prepare('SELECT value FROM system_config WHERE key=?').get(BYOK_D1_FENCE_KEY).value,BYOK_D1_FENCE_CLOSED);
  await assert.rejects(f.journal.attempt('cleanup',()=>assert.fail('unknown cannot be cleaned')));
  assert.equal(f.db.counts().users,mode==='http-ack-lost'?1:0);
});
test('ten host-journaled calls -> gateway -> STOP/seal -> existing cleanup dispatch, all against SQLite',async t=>{
  const f=await integrated(t);
  for(const id of BYOK_D1_CASES){const r=await f.dispatch.runNext();assert.equal(r.caseId,id);assert.deepEqual(r,f.control().receipts.at(-1));}
  assert.equal(f.control().state,'done');assert.equal(f.dispatch.snapshot().completedCases,10);assert.equal(f.http,10);
  await f.dispatch.stop();await f.journal.attempt('seal-fence',async()=>{const q=byokD1FenceTransition(runId,false);
    assert.equal((await f.db.raw.prepare(q.sql).bind(...q.params).run()).meta.changes,1);});
  const maintenanceToken='b1'.repeat(32),now=Math.floor(Date.now()/1000);
  f.db.db.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(BYOK_D1_MAINTENANCE_KEY,
    JSON.stringify({version:1,runId,tokenHash:hash(maintenanceToken),issuedAt:now,expiresAt:now+60,state:'ready',baseline:f.baseline,
      closure:{observedAt:now,evidenceSha256:'c'.repeat(64)},receipt:null}),'local synthetic permit');
  const controller=createByokD1MaintenanceControl(),env={BYOK_MAINTENANCE_CONTROL_ENVIRONMENT:'staging',BYOK_MAINTENANCE_CONTROL_ENABLED:'true',BYOK_MAINTENANCE_ACCESS_AUD:aud,
    USAGE_RECOVERY:{run:t=>runByokD1Maintenance(f.db.raw,true,t,f.ctx)}};
  const cleanup=createByokD1MaintenanceDispatch({journal:f.journal,runId,token:maintenanceToken,accessClientId:clientId,accessClientSecret:secret,expectedRemovedRows:664,assertReady:()=>true,
    fetchImpl:(url,init)=>controller.fetch(new Request(url,init),env,f.ctx)});
  assert.equal((await cleanup.run()).removedRows,664);assert.equal(f.read().attempts.cleanup,'ACK');assert.equal(f.read().attempts.stop,'ACK');
  const after=f.db.allRows();after.system_config=after.system_config.filter(r=>r.key!==BYOK_D1_MAINTENANCE_KEY);assert.deepEqual(after,f.before);
  for(const id of ['stop','seal-fence','cleanup'])await assert.rejects(f.journal.attempt(id,()=>assert.fail('not replayable')));
});
