import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createSqliteD1 } from '../../src/test-support/sqlite-d1.ts';
import { createProxyApp } from '../../src/app.ts';
import { resolveWorkerStorageFromBindings } from '../../src/runtime/workers.ts';
import { createWorkerHandler } from '../../src/runtime/worker-handler.ts';
import { createImagesStagingGateway } from './images-gateway-handler.ts';
import { createImagesFencingGateway } from './images-fencing-handler.ts';
import { drainNodeBackgroundWork } from '../../src/runtime/schedule-background-work.ts';
import { runUsageRecoveryD1 } from '../../../core/src/storage/recovery/run-usage-recovery-d1.ts';
import { imageSuccessFixture, successMultipartWire } from '../../../../scripts/deploy/staging-image-success-fixture.mjs';
import upstream from './images-upstream.ts';
const proposalNames = ['request-dispatch-intents.sql','request-usage-settlements.sql','request-usage-recovery-jobs.sql'];
const proposals = proposalNames.map(name => readFileSync(new URL('../../../core/migrations-proposals/d1/'+name,import.meta.url),'utf8'));

export async function setup(t, {cost=0,hooks={},schema=3,enabled=true,expectIntent=true,transport,filename,composition='app',recoveryOptions={settlementLeaseSeconds:10},envPatch={}}={}) {
  assert.ok(['app','worker','staging','fencing'].includes(composition));
  t?.mock.method(globalThis,'fetch',async()=>{throw new Error('External network forbidden');});
  const messages=[];
  for(const method of ['log','warn','error'])t?.mock.method(console,method,(...args)=>messages.push(args));
  const db=createSqliteD1(hooks,{filename}),tasks=[];
  let seconds=Math.floor(Date.now()/1000),sends=0;
  db.sqlite.function('unixepoch',{varargs:true},()=>seconds);
  const key='synthetic-recovery-client-'+randomUUID();
  const fixture=await imageSuccessFixture('c02-success-'+randomUUID(),'sha256:'+createHash('sha256').update(key).digest('hex'),new Date(Date.now()+3600000).toISOString());
  for(const sql of proposals.slice(0,schema))db.sqlite.exec(sql);
  for(const statement of fixture.seed)db.sqlite.prepare(statement.sql).run(...statement.params);
  db.sqlite.prepare('UPDATE users SET budget_max=1 WHERE id=?').run(fixture.ids.user);
  db.sqlite.prepare('UPDATE api_keys SET limit_micros=NULL WHERE id=?').run(fixture.ids.key);
  for(const endpoint of fixture.ids.endpoints) {
    const caps=JSON.parse(db.sqlite.prepare('SELECT image_capabilities FROM model_endpoints WHERE id=?').get(endpoint).image_capabilities);
    caps.pricing[0].cost_usd=String(cost);
    db.sqlite.prepare('UPDATE model_endpoints SET image_capabilities=? WHERE id=?').run(JSON.stringify(caps),endpoint);
  }
  const env={DB:db.binding,DATABASE_DRIVER:'d1',SHARED_KEY_ENCRYPTION_SECRET:'synthetic-material-not-for-real-secrets',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false'};
  const storage=await resolveWorkerStorageFromBindings(env);
  Object.assign(env,envPatch);
  const options={
    ...(enabled?{imageUsageRecovery:recoveryOptions}:{}),
    imageFetch:async(input,init)=>{
      sends++;
      if(enabled&&expectIntent)assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM request_dispatch_intents WHERE state='dispatch_claimed'").get().n,sends,'claim must precede provider send');
      return transport ? transport(input,init) : upstream.fetch(new Request(input,init));
    },
  };
  const app=composition==='worker'?createWorkerHandler(options):composition==='staging'?createImagesStagingGateway(options.imageFetch,options):composition==='fencing'?createImagesFencingGateway(options.imageFetch):createProxyApp(async()=>storage,options);
  const context={waitUntil(p){assert.equal(this,context);tasks.push(p);p.catch(()=>undefined);}};
  async function drain(){for(let i=0;i<tasks.length;i++)await tasks[i];await drainNodeBackgroundWork();}
  async function close(){await drain();db.sqlite.close();}
  t?.after(close);
  return {
    db,fixture,storage,messages,drain,close,get sends(){return sends;},get holds(){return tasks.length;},
    advance(n){seconds+=n;},
    row(sql,...args){return db.sqlite.prepare(sql).get(...args);},
    async request(operation='generations', patch={}, signal, headers={}) {
      const model=fixture.cases['small-'+operation].model;
      const wire=operation==='edits'?successMultipartWire(model):null;
      return app.fetch(new Request('https://example.invalid/v1/images/'+operation,{
        method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':wire?.type??'application/json',...headers},
        body:wire?Buffer.concat([...wire.chunks()]):JSON.stringify({model,prompt:'private-prompt-marker',...patch}),signal,
      }),env,context);
    },
    async recover(){return runUsageRecoveryD1(storage.client,{scope:{kind:'all'},maxItems:5,concurrency:1,leaseSeconds:10,runBudgetMs:5000,reservedBytesPerConsumer:1024},{tryAcquire(){return{release(){}};}});},
  };
}
