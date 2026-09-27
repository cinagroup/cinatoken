import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import * as fs from 'node:fs';
import {resolve} from 'node:path';
import {createByokD1OperatorJournal,inspectByokD1OperatorJournal} from './byok-d1-operator-journal.mjs';
import {createByokD1MaintenanceDispatch as create} from './byok-d1-maintenance-dispatch.mjs';
import {byokMaintenanceFixture,TOKEN} from '../../packages/proxy/scripts/staging/byok-d1-maintenance-fixture.mjs';
import {createByokD1MaintenanceControl} from '../../packages/proxy/scripts/staging/byok-d1-maintenance-control.ts';
import {runByokD1Maintenance} from '../../packages/proxy/scripts/staging/byok-d1-maintenance-host.ts';
import {BYOK_MAINTENANCE_ORIGIN,BYOK_MAINTENANCE_PATH} from '../../packages/proxy/scripts/staging/byok-d1-maintenance-contract.ts';
const runId='c02-byok-a1b2c3d4e5f6',aud='a'.repeat(64),clientId='synthetic-client.access',secret='synthetic-access-secret';
const receipt={runId,removedRows:7,statementCount:143};
const good=()=>Response.json({status:'cleaned',retry_safe:false,receipt},{headers:{'Cache-Control':'no-store'}});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function setup(t,fetchImpl,io){
  const workspace=fs.mkdtempSync(resolve(process.env.BYOK_OPERATOR_TEST_ROOT??'.wrangler/staging','byok-dispatch-test-'));
  const journal=createByokD1OperatorJournal(workspace,{runId,candidateSha256:'a'.repeat(64),priorManifestSha256:'b'.repeat(64)},io?{io}:{});
  t.after(()=>journal.close());
  const path=resolve(journal.directory,'journal.jsonl'),options={journal,runId,token:TOKEN,accessClientId:clientId,accessClientSecret:secret,expectedRemovedRows:7,fetchImpl,assertReady:()=>true};
  return {journal,path,options,read:()=>inspectByokD1OperatorJournal(path)};
}
test('host journals before fixed-target HTTP and stores only bounded receipt digest',async t=>{
  let calls=0;const f=setup(t,async(url,init)=>{
    calls++;assert.equal(f.read().attempts.cleanup,'PENDING');assert.equal(url,BYOK_MAINTENANCE_ORIGIN+BYOK_MAINTENANCE_PATH);
    assert.equal(init.method,'POST');assert.equal(init.redirect,'error');assert.equal(init.body,undefined);
    assert.equal(init.headers.Authorization,'Bearer '+TOKEN);assert.equal(init.headers['CF-Access-Client-Secret'],secret);
    return good();
  });
  const invoke=create(f.options);assert.deepEqual(await invoke.run(),receipt);assert.equal(f.read().attempts.cleanup,'ACK');
  await assert.rejects(invoke.run());await assert.rejects(create(f.options).run());assert.equal(calls,1);
  const text=fs.readFileSync(f.path,'utf8');for(const value of [TOKEN,clientId,secret,'Authorization'])assert.ok(!text.includes(value));
});
test('invalid credentials and local options fail without leaking secrets or consuming HTTP',t=>{
  let calls=0;const f=setup(t,async()=>{calls++;return good();});
  for(const changed of [{token:secret},{accessClientSecret:secret+'\n'},{timeoutMs:30001},{expectedRemovedRows:0}]){
    assert.throws(()=>create({...f.options,...changed}),error=>!String(error).includes(secret));
  }
  assert.equal(calls,0);assert.deepEqual(f.read().attempts,{});
});
for(const mode of ['http-error','redirect','wrong-type','declared-large','actual-large','invalid-json','wrong-run','wrong-count','extra-field','retry-safe','transport-error'])
test('uncertain host response is consumed without replay / '+mode,async t=>{
  let calls=0;const f=setup(t,async()=>{calls++;
    if(mode==='transport-error')throw Error(secret);
    if(mode==='http-error')return new Response(secret,{status:503});
    if(mode==='redirect')return new Response(null,{status:302,headers:{Location:'https://untrusted.invalid/'}});
    if(mode==='wrong-type')return new Response(secret,{headers:{'Content-Type':'text/html'}});
    if(mode==='declared-large')return new Response('',{headers:{'Content-Type':'application/json','Cache-Control':'no-store','Content-Length':'1025'}});
    if(mode==='actual-large'||mode==='invalid-json')return new Response(mode==='actual-large'?' '.repeat(1025):'{',{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
    const value={status:'cleaned',retry_safe:false,receipt:{...receipt}};
    if(mode==='wrong-run')value.receipt.runId='c02-byok-000000000001';if(mode==='wrong-count')value.receipt.removedRows=8;
    if(mode==='extra-field')value.private=secret;if(mode==='retry-safe')value.retry_safe=true;
    return Response.json(value,{headers:{'Cache-Control':'no-store'}});
  });
  await assert.rejects(create(f.options).run(),/^Error: byok_operator_attempt_failed$/);
  await assert.rejects(create(f.options).run());assert.equal(calls,1);assert.equal(f.read().attempts.cleanup,'FAILED_OR_UNCERTAIN');
  assert.ok(!fs.readFileSync(f.path,'utf8').includes(secret));
});
test('PENDING fsync failure prevents HTTP dispatch',async t=>{
  let calls=0,syncs=0;const f=setup(t,async()=>{calls++;return good();},{...fs,fsyncSync(fd){if(++syncs===2)throw Error('disk');return fs.fsyncSync(fd);}});
  await assert.rejects(create(f.options).run());assert.equal(calls,0);assert.equal(f.journal.snapshot().attempts.cleanup,'NOT_INVOKED');
});
test('readiness is checked after durable PENDING; a delayed journal cannot send stale cleanup',async t=>{
  let calls=0,syncs=0,ready=true;const f=setup(t,async()=>{calls++;return good();},{...fs,fsyncSync(fd){if(++syncs===2)ready=false;return fs.fsyncSync(fd);}});
  const invoke=create({...f.options,assertReady:()=>ready});await assert.rejects(invoke.run());assert.equal(calls,0);
  assert.equal(f.read().attempts.cleanup,'FAILED_OR_UNCERTAIN');await assert.rejects(invoke.run());assert.equal(calls,0);
});
test('asynchronous or absent readiness cannot authorize HTTP',async t=>{
  let calls=0;const f=setup(t,async()=>{calls++;return good();});assert.throws(()=>create({...f.options,assertReady:undefined}));
  await assert.rejects(create({...f.options,assertReady:async()=>true}).run());assert.equal(calls,0);
});
test('receipt ACK fsync failure never repeats successful remote effect',async t=>{
  let calls=0,syncs=0;const f=setup(t,async()=>{calls++;return good();},{...fs,fsyncSync(fd){if(++syncs===3)throw Error('disk');return fs.fsyncSync(fd);}});
  await assert.rejects(create(f.options).run());await assert.rejects(create(f.options).run());assert.equal(calls,1);assert.equal(f.journal.snapshot().poisoned,true);
});
for(const mode of ['pre-abort','after-dispatch','timeout-late-response','timeout-body'])test('cancelled host wait never means remote cancellation / '+mode,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const abort=new AbortController(),pending=deferred();let calls=0,cancels=0;
  const f=setup(t,async()=>{calls++;
    if(mode==='timeout-body')return new Response(new ReadableStream({pull(){},cancel(){cancels++;}}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
    return pending.promise;
  });
  if(mode==='pre-abort')abort.abort();
  const job=create({...f.options,signal:abort.signal}).run(),rejected=assert.rejects(job);
  await tick();if(mode==='after-dispatch')abort.abort();else if(mode!=='pre-abort')t.mock.timers.tick(30000);
  await rejected;assert.equal(calls,mode==='pre-abort'?0:1);assert.equal(f.journal.snapshot().poisoned,true);
  if(mode==='timeout-late-response'){pending.resolve(new Response(new ReadableStream({cancel(){cancels++;}})));await tick();assert.equal(cancels,1);}
  if(mode==='timeout-body')assert.equal(cancels,1);
  if(mode==='after-dispatch')pending.resolve(good());
  await assert.rejects(create(f.options).run());assert.equal(f.read().attempts.cleanup,'FAILED_OR_UNCERTAIN');
});
for(const mode of ['success','claim-before','lost-http-ack'])test('host journal -> controller -> receiver -> SQLite / '+mode,async t=>{
  const db=await byokMaintenanceFixture(t),controller=createByokD1MaintenanceControl();db.ctx.access={aud};let calls=0,reached=false;
  const expected=db.counts().users+db.counts().workspaces+db.counts().management_api_keys+db.counts().byok_keys+db.counts().user_audit_logs+1;
  const env={BYOK_MAINTENANCE_CONTROL_ENVIRONMENT:'staging',BYOK_MAINTENANCE_CONTROL_ENABLED:'true',BYOK_MAINTENANCE_ACCESS_AUD:aud,
    USAGE_RECOVERY:{run(token){return runByokD1Maintenance(db.raw,true,token,db.ctx);}}};
  if(mode==='claim-before')db.hooks.beforeStatement=s=>{if(s.sql.startsWith('UPDATE system_config SET value = ? WHERE key = ? AND value = ?')){reached=true;throw Error('claim did not commit');}};
  const f=setup(t,async(url,init)=>{calls++;assert.equal(f.read().attempts.cleanup,'PENDING');
    const r=await controller.fetch(new Request(url,init),env,db.ctx);if(mode==='lost-http-ack')throw Error('response lost');return r;});
  const invoke=create({...f.options,expectedRemovedRows:expected});
  if(mode==='success'){assert.equal((await invoke.run()).removedRows,expected);assert.equal(f.read().attempts.cleanup,'ACK');}
  else {await assert.rejects(invoke.run());assert.equal(f.read().attempts.cleanup,'FAILED_OR_UNCERTAIN');}
  if(mode==='claim-before'){assert.equal(reached,true);assert.equal(db.getPermit().state,'ready');}
  else {assert.equal(db.getPermit().state,'finished');assert.deepEqual(db.restoreRows(),db.before);}
  for(const key of Object.keys(db.hooks))delete db.hooks[key];
  await assert.rejects(create({...f.options,expectedRemovedRows:expected}).run());assert.equal(calls,1);
});
