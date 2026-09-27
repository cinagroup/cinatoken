import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {byokMaintenanceFixture,TOKEN} from './byok-d1-maintenance-fixture.mjs';
import {runByokD1Maintenance} from './byok-d1-maintenance-host.ts';
import controlWorker from './byok-d1-maintenance-control-worker.ts';
import {BYOK_MAINTENANCE_ORIGIN,BYOK_MAINTENANCE_PATH} from './byok-d1-maintenance-contract.ts';
import {readJsonc} from '../../../../scripts/deploy/prepare-proxy-staging.mjs';

test('real receiver entrypoint wiring rejects HTTP/extra arguments and owns its bound DB',async t=>{
  const f=await byokMaintenanceFixture(t),source=readFileSync(new URL('./byok-d1-maintenance-worker.ts',import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const exports={};new Function('require','exports',code)(name=>{
    // A Node constructor shim, NOT native Workers RPC behavior or authorization.
    if(name==='cloudflare:workers')return {WorkerEntrypoint:class{constructor(ctx,env){this.ctx=ctx;this.env=env;}}};
    if(name==='./byok-d1-maintenance-host')return {runByokD1Maintenance};throw Error('Unexpected import');
  },exports);
  assert.deepEqual(Object.keys(exports).sort(),['UsageRecovery','default']);
  const env={RECOVERY_DB:f.raw,BYOK_MAINTENANCE_ENVIRONMENT:'staging',BYOK_MAINTENANCE_ENABLED:'true'},entry=new exports.UsageRecovery(f.ctx,env);
  const before=f.calls.length;
  for(const args of [[],[TOKEN,{}],[undefined]])assert.equal((await entry.run(...args)).status,'invalid_arguments');
  for(const handler of [exports.default,entry])for(const method of ['GET','POST','OPTIONS'])
    assert.equal((await handler.fetch(new Request('https://private.invalid/',{method}))).status,404);
  env.BYOK_MAINTENANCE_ENABLED='false';assert.equal((await entry.run(TOKEN)).status,'disabled');
  env.BYOK_MAINTENANCE_ENABLED='true';env.BYOK_MAINTENANCE_ENVIRONMENT='production';assert.equal((await entry.run(TOKEN)).status,'disabled');
  assert.equal(f.calls.length,before);env.BYOK_MAINTENANCE_ENVIRONMENT='staging';assert.equal((await entry.run(TOKEN)).status,'cleaned');
});
test('real controller Worker delegates to service, never accepts a DB binding',async t=>{
  const f=await byokMaintenanceFixture(t),aud='a'.repeat(64);f.ctx.access={aud};let calls=0;
  const env={BYOK_MAINTENANCE_CONTROL_ENVIRONMENT:'staging',BYOK_MAINTENANCE_CONTROL_ENABLED:'true',BYOK_MAINTENANCE_ACCESS_AUD:aud,
    USAGE_RECOVERY:{run(token){calls++;return runByokD1Maintenance(f.raw,true,token,f.ctx);}},get RECOVERY_DB(){assert.fail('No direct controller D1');}};
  assert.deepEqual(Object.keys(controlWorker),['fetch']);
  const r=await controlWorker.fetch(new Request(BYOK_MAINTENANCE_ORIGIN+BYOK_MAINTENANCE_PATH,{method:'POST',
    headers:{Authorization:'Bearer '+TOKEN,'X-CinaToken-BYOK-Command':'cleanup-once-v1'}}),env,f.ctx);
  assert.equal(r.status,200);assert.equal(calls,1);assert.equal(f.getPermit().state,'finished');
});
test('candidate configs stay closed on the existing staging resources without provisioning',()=>{
  const base=new URL('./',import.meta.url),receiver=readJsonc(fileURLToPath(new URL('wrangler.byok-d1-maintenance.jsonc',base))),control=readJsonc(fileURLToPath(new URL('wrangler.byok-d1-maintenance-control.jsonc',base)));
  for(const c of [receiver,control]){
    assert.equal(c.account_id,'7ea8e46d8210bad342fa7595f7935fea');assert.equal(c.workers_dev,false);assert.equal(c.preview_urls,false);
    assert.deepEqual(c.routes,[]);assert.deepEqual(c.triggers,{crons:[]});assert.deepEqual(c.compatibility_flags,['nodejs_compat']);
    assert.equal(c.compatibility_date,'2026-09-16');assert.equal(c.send_metrics,false);assert.equal(c.observability.logs.invocation_logs,false);
    for(const key of ['kv_namespaces','durable_objects','r2_buckets','queues','hyperdrive','ai','secrets'])assert.equal(key in c,false);
  }
  assert.equal(receiver.name,'cinatoken-staging-usage-recovery');assert.equal(control.name,'cinatoken-staging-recovery-control');
  assert.equal(receiver.main,'byok-d1-maintenance-worker.ts');assert.equal(control.main,'byok-d1-maintenance-control-worker.ts');
  assert.equal(control.d1_databases,undefined);assert.equal(receiver.services,undefined);
  assert.deepEqual(receiver.d1_databases,[{binding:'RECOVERY_DB',database_name:'cinatoken-staging',database_id:'6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1',remote:false}]);
  assert.deepEqual(control.services,[{binding:'USAGE_RECOVERY',service:receiver.name,entrypoint:'UsageRecovery',remote:false}]);
  assert.deepEqual(receiver.vars,{BYOK_MAINTENANCE_ENVIRONMENT:'staging',BYOK_MAINTENANCE_ENABLED:'false'});
  assert.deepEqual(control.vars,{BYOK_MAINTENANCE_CONTROL_ENVIRONMENT:'staging',BYOK_MAINTENANCE_CONTROL_ENABLED:'false',BYOK_MAINTENANCE_ACCESS_AUD:''});
});
