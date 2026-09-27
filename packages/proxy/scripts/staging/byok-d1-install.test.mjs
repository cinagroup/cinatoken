import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setImmediate as tick} from 'node:timers/promises';
import {byokCleanupFixture} from './byok-d1-cleanup-fixture.mjs';
import {BYOK_D1_FENCE_TRIGGERS,BYOK_D1_FENCE_KEY,BYOK_D1_FENCE_CLOSED} from './byok-d1-write-fence.ts';
import {BYOK_D1_CONTROL_KEY,BYOK_D1_ORIGIN} from './byok-d1-one-shot.ts';
import {parseByokD1InstallGrant,parseByokD1InstallReceipt} from './byok-d1-install-contract.ts';
import {captureByokD1CleanupBaseline} from './byok-d1-cleanup.ts';
import {createByokD1OperatorJournal,inspectByokD1OperatorJournal} from '../../../../scripts/deploy/byok-d1-operator-journal.mjs';
import {createByokD1Management} from '../../../../scripts/deploy/byok-d1-management.mjs';
const {createByokD1Gateway:create}=await import(process.env.BYOK_D1_GATEWAY_MODULE
  ?pathToFileURL(resolve(process.env.BYOK_D1_GATEWAY_MODULE)).href:new URL('./byok-d1-gateway.ts',import.meta.url).href);
const {createByokD1InstallDispatch:dispatch}=await import(process.env.BYOK_D1_INSTALL_DISPATCH_MODULE
  ?pathToFileURL(resolve(process.env.BYOK_D1_INSTALL_DISPATCH_MODULE)).href:new URL('../../../../scripts/deploy/byok-d1-install-dispatch.mjs',import.meta.url).href);
const sha=v=>createHash('sha256').update(v).digest('hex'),token='c1'.repeat(32),aud='a'.repeat(64);
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const headers=()=>({Authorization:'Bearer '+token,'X-CinaToken-BYOK-Command':'install-fence-once-v1'});
const command=init=>new Request(BYOK_D1_ORIGIN+'/__staging/byok-d1/install-fence',{method:'POST',headers:headers(),...init});
function fixture(t){
  const f=byokCleanupFixture(),tasks=[],ctx={access:{aud},waitUntil(p){assert.equal(this,ctx);tasks.push(p);}};
  const before=f.schema(),expected=[...before,...BYOK_D1_FENCE_TRIGGERS.map(r=>({type:'trigger',name:r.name,tbl_name:r.table,sql:r.sql}))]
    .sort((a,b)=>a.type<b.type?-1:a.type>b.type?1:a.name<b.name?-1:a.name>b.name?1:0);
  const now=Math.floor(Date.now()/1000),grant={version:1,runId:f.runId,tokenHash:sha(token),schemaSha256:sha(JSON.stringify(before)),
    fencedSchemaSha256:sha(JSON.stringify(expected)),issuedAt:now-1,expiresAt:now+899};
  const env={BYOK_DB:f.raw,BYOK_GATEWAY_ENVIRONMENT:'staging',BYOK_GATEWAY_ENABLED:'true',BYOK_GATEWAY_ACCESS_AUD:aud,BYOK_GATEWAY_INSTALL_GRANT:JSON.stringify(grant)};
  const gateway=create();t.after(async()=>{await Promise.all(tasks);await f.close();});
  return Object.assign(f,{grant,env,ctx,tasks,gateway,send:(init)=>gateway.fetch(command(init),env,ctx),
    installed:()=>f.db.prepare('SELECT value FROM system_config WHERE key=?').get(BYOK_D1_FENCE_KEY)?.value});
}
async function host(t,f,fetchImpl,options={}){
  const workspace=fs.mkdtempSync(resolve(process.env.BYOK_OPERATOR_TEST_ROOT??'.wrangler/staging','byok-install-test-'));
  const journal=createByokD1OperatorJournal(workspace,{runId:f.runId,candidateSha256:'a'.repeat(64),priorManifestSha256:'b'.repeat(64)});
  t.after(()=>journal.close());
  for(const step of ['preflight','closure-before','open-access','open-gateway'])await journal.attempt(step,async()=>{});
  const opts={journal,grant:f.grant,token,accessClientId:'SYNTHETIC-ACCESS-ID',accessClientSecret:'SYNTHETIC-ACCESS-SECRET',assertReady:()=>true,fetchImpl,...options};
  return {journal,workspace,options:opts,dispatch:dispatch(opts)};
}
function validReceipt(f){return {code:'fence_installed',runId:f.runId,schemaSha256:f.grant.schemaSha256,fencedSchemaSha256:f.grant.fencedSchemaSha256,
  triggerCount:15,installStatements:17,closed:true,counters:{statements:41,calls:9,active:0,peakActive:1,
    acknowledgedRowsRead:0,acknowledgedRowsWritten:0,callsWithoutRowMetadata:0,nativeRejectedCalls:0}};}
const receiptResponse=f=>Response.json(validReceipt(f),{headers:{'Cache-Control':'no-store'}});

test('native-shaped install uses one fixed 17-statement transaction then verifies closed schema and metadata',async t=>{
  const f=fixture(t),before=f.allRows(),schemaCount=f.schema().length,r=await f.send({body:''});assert.equal(r.status,200);
  const receipt=parseByokD1InstallReceipt(await r.json(),f.grant);assert.equal(receipt.counters.statements,41);assert.equal(receipt.counters.calls,9);
  assert.equal(f.installed(),BYOK_D1_FENCE_CLOSED);assert.equal(f.schema().length,schemaCount+15);
  const writes=f.batches.filter(b=>b.statements.some(s=>s.sql.startsWith('CREATE TRIGGER')));assert.equal(writes.length,1);assert.equal(writes[0].statements.length,17);
  assert.match(writes[0].statements[0].sql,/unixepoch\('now'\) >= \?/);assert.deepEqual(writes[0].statements[0].values.slice(0,2),[f.grant.issuedAt,f.grant.expiresAt]);
  const baseline=await captureByokD1CleanupBaseline(f.raw,f.grant.fencedSchemaSha256,'write-fence-v1');assert.equal(baseline.counts.system_config,13);
  const after=f.allRows();after.system_config=after.system_config.filter(v=>v.key!==BYOK_D1_FENCE_KEY);assert.deepEqual(after,before);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM system_config WHERE key=?').get(BYOK_D1_CONTROL_KEY).n,0);
});
for(const mode of ['disabled','production','missing-access','wrong-aud','forged-access','empty-grant','invalid-grant','nonempty','wrong-command','wrong-origin'])
test('gateway installation boundary rejects without SQL / '+mode,async t=>{
  const f=fixture(t);let req=command();
  if(mode==='disabled')f.env.BYOK_GATEWAY_ENABLED='false';if(mode==='production')f.env.BYOK_GATEWAY_ENVIRONMENT='production';
  if(mode==='missing-access'||mode==='forged-access')delete f.ctx.access;if(mode==='wrong-aud')f.ctx.access.aud='b'.repeat(64);
  if(mode==='forged-access')req=command({headers:{...headers(),'Cf-Access-Jwt-Assertion':'forged'}});
  if(mode==='empty-grant')f.env.BYOK_GATEWAY_INSTALL_GRANT='';if(mode==='invalid-grant')f.env.BYOK_GATEWAY_INSTALL_GRANT='{}';
  if(mode==='nonempty')req=command({body:'SQL'});if(mode==='wrong-command')req=command({headers:{...headers(),'X-CinaToken-BYOK-Command':'case-once-v1'}});
  if(mode==='wrong-origin')req=new Request(req.url.replace('-staging',''),{method:'POST',headers:headers()});
  assert.ok((await f.gateway.fetch(req,f.env,f.ctx)).status>=400);assert.equal(f.calls.length,0);assert.equal(f.installed(),undefined);
});
test('a valid case bearer cannot substitute for independently hashed install credential',async t=>{
  const f=fixture(t);assert.equal((await f.send({headers:{...headers(),Authorization:'Bearer '+'a1'.repeat(32)}})).status,403);assert.equal(f.calls.length,0);
});
for(const stage of [1,2])test('waitUntil rejection is zero native SQL / registration '+stage,async t=>{
  const f=fixture(t);let count=0;f.ctx.waitUntil=p=>{if(++count===stage)throw Error('private');f.tasks.push(p);};
  assert.equal((await f.send()).status,503);assert.equal(f.calls.length,0);
});
for(const mode of ['expired','future','wrong-pre-schema','wrong-post-schema','foreign-data','existing-control'])
test('fixed grant and clean baseline before mutation / '+mode,async t=>{
  const f=fixture(t),grant={...f.grant};
  if(mode==='expired'){grant.issuedAt-=1000;grant.expiresAt-=1000;}if(mode==='future'){grant.issuedAt+=1000;grant.expiresAt+=1000;}
  if(mode==='wrong-pre-schema')grant.schemaSha256='f'.repeat(64);if(mode==='wrong-post-schema')grant.fencedSchemaSha256='e'.repeat(64);
  if(mode==='foreign-data')f.db.exec("INSERT INTO users(id,email) VALUES('foreign','foreign@example.invalid')");if(mode==='existing-control')f.arm();
  f.env.BYOK_GATEWAY_INSTALL_GRANT=JSON.stringify(grant);assert.ok((await f.send()).status>=400);
  assert.equal(f.installed(),undefined);assert.equal(f.batches.some(b=>b.statements.some(s=>s.sql.startsWith('CREATE TRIGGER'))),false);
});
for(const mode of ['clock-expiry','schema-drift','owned-row','ddl-failure','marker-failure'])test('native transaction guard or failure leaves no partial fence / '+mode,async t=>{
  const f=fixture(t),before=f.schema();let hit=false;
  f.hooks.beforeBatch=items=>{
    if(!items.some(s=>s.sql.startsWith('CREATE TRIGGER')))return;hit=true;
    if(mode==='clock-expiry')f.db.function('unixepoch',_argument=>f.grant.expiresAt);
    if(mode==='schema-drift')f.db.exec('CREATE TABLE injected(id TEXT)');
    if(mode==='owned-row')f.db.exec("INSERT INTO users(id,email) VALUES('late','late@example.invalid')");
  };
  f.hooks.beforeStatement=s=>{
    if(mode==='ddl-failure'&&s.sql.startsWith('CREATE TRIGGER')&&s.sql.includes('workspaces_update'))throw Error('DDL rejected');
    if(mode==='marker-failure'&&s.sql.startsWith('INSERT INTO system_config'))throw Error('insert rejected');
  };
  assert.equal((await f.send()).status,503);assert.equal(hit,true);assert.equal(f.installed(),undefined);
  assert.equal(f.schema().filter(s=>s.name.startsWith('c02_byok_fence')).length,0);
  if(!['schema-drift','owned-row'].includes(mode))assert.deepEqual(f.schema(),before);
  assert.equal(f.batches.at(-1).state,'ROLLED_BACK');
});
for(const mode of ['batch-ack-lost','post-read-fails','metadata-missing'])test('post-dispatch unknown retains installed closed fence and cannot reinstall / '+mode,async t=>{
  const f=fixture(t);let installed=false;
  f.hooks.afterBatch=(items,results)=>{if(items.some(s=>s.sql.startsWith('CREATE TRIGGER'))){installed=true;
    if(mode==='batch-ack-lost')throw Error('secret');if(mode==='metadata-missing')delete results[0].meta;}};
  f.hooks.beforeStatement=s=>{if(mode==='post-read-fails'&&installed&&s.sql.includes('sql_bytes'))throw Error('secret');};
  const r=await f.send();assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/secret|SELECT|CREATE/);assert.equal(f.installed(),BYOK_D1_FENCE_CLOSED);
  delete f.hooks.beforeStatement;delete f.hooks.afterBatch;const writes=f.batches.filter(b=>b.statements.length===17).length;
  assert.equal((await create().fetch(command(),f.env,f.ctx)).status,503);assert.equal(f.batches.filter(b=>b.statements.length===17).length,writes);
});
test('disconnect before batch prevents install; disconnect after dispatch drains and confirms it',async t=>{
  for(const after of [false,true]){
    const f=fixture(t),ac=new AbortController();let hit=false;
    if(after)f.hooks.beforeBatch=items=>{if(items.length===17){hit=true;ac.abort();}};
    else f.hooks.afterStatement=s=>{if(s.sql.includes('sql_bytes')&&f.calls.length>20){hit=true;ac.abort();}};
    const r=await f.send({signal:ac.signal});assert.equal(hit,true);assert.equal(r.status,after?200:409);assert.equal(f.installed(),after?BYOK_D1_FENCE_CLOSED:undefined);
  }
});
test('two gateway instances race installation: one batch commits; the other cannot reset or recreate it',async t=>{
  const f=fixture(t),both=deferred(),release=deferred();let arrived=0;
  f.hooks.beforeBatch=async items=>{if(items.length===17){if(++arrived===2)both.resolve();await release.promise;}};
  const first=f.send(),second=create().fetch(command(),f.env,f.ctx);await both.promise;release.resolve();
  const statuses=(await Promise.all([first,second])).map(r=>r.status).sort();assert.deepEqual(statuses,[200,503]);
  assert.equal(f.batches.filter(b=>b.statements.length===17&&b.state==='COMMITTED').length,1);assert.equal(f.installed(),BYOK_D1_FENCE_CLOSED);
});
test('install shares the case load lane but cannot block the independent STOP lane',async t=>{
  const f=fixture(t),ac=new AbortController(),body=new ReadableStream({type:'bytes',pull(){}},{highWaterMark:0});
  const pending=f.send({body,duplex:'half',signal:ac.signal});await tick();
  assert.equal((await f.send()).status,503);
  const stop=new Request(BYOK_D1_ORIGIN+'/__staging/byok-d1/stop',{method:'POST',headers:{Authorization:'Bearer '+token,'X-CinaToken-BYOK-Command':'stop-once-v1'}});
  assert.equal((await f.gateway.fetch(stop,f.env,f.ctx)).status,404);ac.abort();assert.equal((await pending).status,409);
});
test('grant parser rejects extra fields, plaintext credential, unbounded/invalid lifetime',()=>{
  const base={version:1,runId:'c02-byok-a1b2c3d4e5f6',tokenHash:'a'.repeat(64),schemaSha256:'b'.repeat(64),fencedSchemaSha256:'c'.repeat(64),issuedAt:1,expiresAt:901};
  for(const change of [{token:'private'},{expiresAt:902},{expiresAt:1},{issuedAt:-1},{tokenHash:'bad'},{fencedSchemaSha256:base.schemaSha256}])
    assert.throws(()=>parseByokD1InstallGrant(JSON.stringify({...base,...change})));
  assert.throws(()=>parseByokD1InstallGrant(' '.repeat(1025)));assert.throws(()=>parseByokD1InstallGrant('é'));
});
test('host journal -> installed gateway -> closed baseline usable by existing management adapter (all local)',async t=>{
  const f=fixture(t);let calls=0;
  const h=await host(t,f,async(url,init)=>{
    calls++;assert.equal(inspectByokD1OperatorJournal(resolve(h.journal.directory,'journal.jsonl')).attempts['install-fence'],'PENDING');
    assert.equal(url,command().url);assert.equal(init.body,undefined);assert.equal(init.redirect,'error');assert.equal(init.headers['Content-Length'],'0');
    return f.gateway.fetch(new Request(url,init),f.env,f.ctx);
  });
  const r=await h.dispatch.run();assert.equal(r.closed,true);assert.equal(calls,1);assert.equal(h.journal.snapshot().attempts['install-fence'],'ACK');
  const m=createByokD1Management({journal:h.journal,expectedSchemaSha256:r.fencedSchemaSha256,apiToken:'synthetic',assertWriteReady:()=>true,
    fetchImpl:async(url,init)=>{
      assert.equal(url,'https://api.cloudflare.com/client/v4/accounts/7ea8e46d8210bad342fa7595f7935fea/d1/database/6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1'+(init.method==='POST'?'/query':''));
      const q=init.body&&JSON.parse(init.body),result=q?(q.batch??[q]).map(s=>({success:true,results:f.db.prepare(s.sql).all(...s.params),meta:{rows_read:0,rows_written:0}}))
        :{uuid:'6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1',name:'cinatoken-staging'};
      return Response.json({success:true,errors:[],result});
    }});
  assert.equal((await m.captureBaseline()).counts.system_config,13);await m.arm(sha('a1'.repeat(32)));await m.openFence();
  const req=new Request(BYOK_D1_ORIGIN+'/__staging/byok-d1/changes-contract',{method:'POST',headers:{Authorization:'Bearer '+'a1'.repeat(32),'X-CinaToken-BYOK-Command':'case-once-v1'}});
  assert.equal((await f.gateway.fetch(req,f.env,f.ctx)).status,200);
  await assert.rejects(h.dispatch.run());await assert.rejects(dispatch(h.options).run());assert.equal(calls,1);
  const text=fs.readFileSync(resolve(h.journal.directory,'journal.jsonl'),'utf8');for(const s of [token,h.options.accessClientId,h.options.accessClientSecret])assert.ok(!text.includes(s));
});
for(const mode of ['guard','pre-abort','after-arm','wrong-token','wrong-scope'])test('host validation or admission rejects before HTTP / '+mode,async t=>{
  const f=fixture(t);let calls=0;const h=await host(t,f,async()=>{calls++;return receiptResponse(f);});
  if(mode==='wrong-token'||mode==='wrong-scope'){
    assert.throws(()=>dispatch({...h.options,...(mode==='wrong-token'?{token:'d1'.repeat(32)}:{origin:'https://untrusted.invalid'})}));
  }else{
    if(mode==='after-arm')await h.journal.attempt('arm',async()=>{});
    if(mode==='guard')h.options.assertReady=()=>false;
    await assert.rejects(dispatch(h.options).run(mode==='pre-abort'?{signal:AbortSignal.abort()}:{}));
  }assert.equal(calls,0);
});
for(const mode of ['http','redirect','mime','cache','large','malformed','length','wrong-schema','extra-field','wrong-count','active-counter','unknown-ack'])
test('host unconfirmed install is consumed without replay / '+mode,async t=>{
  const f=fixture(t);let calls=0;
  const h=await host(t,f,async(url,init)=>{
    calls++;
    if(mode==='unknown-ack'){assert.equal((await f.gateway.fetch(new Request(url,init),f.env,f.ctx)).status,200);throw Error('SYNTHETIC-ACCESS-SECRET');}
    if(mode==='http')return new Response('private',{status:503});if(mode==='redirect')return new Response(null,{status:302});
    if(mode==='large'||mode==='malformed')return new Response(mode==='large'?' '.repeat(2049):'{',{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
    const value=validReceipt(f);if(mode==='wrong-schema')value.fencedSchemaSha256='b'.repeat(64);if(mode==='extra-field')value.retry_safe=true;
    if(mode==='wrong-count')value.installStatements=16;if(mode==='active-counter')value.counters.active=1;
    const r=Response.json(value,{headers:{'Cache-Control':'no-store'}});if(mode==='mime')r.headers.set('Content-Type','text/html');
    if(mode==='cache')r.headers.delete('Cache-Control');if(mode==='length')r.headers.set('Content-Length','1');return r;
  });
  await assert.rejects(h.dispatch.run(),/^Error: byok_install_dispatch_unconfirmed$/);await assert.rejects(h.dispatch.run());await assert.rejects(dispatch(h.options).run());
  assert.equal(calls,1);assert.equal(h.journal.snapshot().poisoned,true);if(mode==='unknown-ack')assert.equal(f.installed(),BYOK_D1_FENCE_CLOSED);
});
test('host response read bound and deadline cancel unfinished body without a second dispatch',async t=>{
  for(const mode of ['chunks','late']){
    const f=fixture(t);let cancelled=0,resolveResponse,pulls=0;
    const h=await host(t,f,async()=>mode==='late'?new Promise(r=>{resolveResponse=r;}):new Response(new ReadableStream({
      pull(c){pulls++;c.enqueue(new Uint8Array());},cancel(){cancelled++;}},{highWaterMark:0}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}}),
      {timeoutMs:mode==='late'?10:30000});
    await assert.rejects(h.dispatch.run());if(mode==='late')resolveResponse(new Response(new ReadableStream({cancel(){cancelled++;}})));
    await tick();assert.equal(cancelled,1);if(mode==='chunks')assert.equal(pulls,128);await assert.rejects(h.dispatch.run());
  }
});
test('post-install schema must fit the verifier bounds before any DDL is submitted',async t=>{
  const f=fixture(t),count=f.schema().length;
  for(let i=count;i<500;i++)f.db.exec(`CREATE INDEX install_boundary_${i} ON users(email)`);
  const before=f.schema(),expected=[...before,...BYOK_D1_FENCE_TRIGGERS.map(r=>({type:'trigger',name:r.name,tbl_name:r.table,sql:r.sql}))]
    .sort((a,b)=>a.type<b.type?-1:a.type>b.type?1:a.name<b.name?-1:a.name>b.name?1:0);
  f.env.BYOK_GATEWAY_INSTALL_GRANT=JSON.stringify({...f.grant,schemaSha256:sha(JSON.stringify(before)),fencedSchemaSha256:sha(JSON.stringify(expected))});
  assert.equal((await f.send()).status,503);assert.equal(f.installed(),undefined);assert.deepEqual(f.schema(),before);
  assert.equal(f.batches.some(b=>b.statements.length===17),false);
});
