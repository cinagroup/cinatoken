import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID,createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createSqliteD1 } from '../../src/test-support/sqlite-d1.ts';
import { createImagesUndeliveredGateway,UNDELIVERED_IMAGE_GATE_MS } from './images-undelivered-handler.ts';
import { imageSuccessFixture,successMultipartWire } from '../../../../scripts/deploy/staging-image-success-fixture.mjs';
import { imageStorageFaultHeader,imageStorageFaultRow,IMAGE_STORAGE_FAULT_HEADER } from './images-storage-fault-contract.ts';
import upstream from './images-upstream.ts';
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};

for(const operation of ['generations','edits'])for(const mode of ['normal','before-abort','after-abort'])test('real route '+operation+' / '+mode+' withholds success on a returning (non-native) abort shim',async t=>{
  t.mock.method(globalThis,'fetch',async()=>{throw Error('External network forbidden');});
  const messages=[];
  for(const method of ['log','warn','error'])t.mock.method(console,method,(...args)=>messages.push(args.map(x=>x instanceof Error?x.message:String(x)).join(' ')));
  const db=createSqliteD1(),key='synthetic-undelivered-'+randomUUID(),tasks=[];
  const f=await imageSuccessFixture('c02-success-'+randomUUID(),'sha256:'+createHash('sha256').update(key).digest('hex'),new Date(Date.now()+3600000).toISOString());
  const probe=mode==='normal'?null:{runId:f.ids.runId,probeId:randomUUID(),mode},row=probe?imageStorageFaultRow(probe):null;
  let sends=0,aborts=0,returned=false,responseTask;
  const ctx={waitUntil(p){assert.equal(this,ctx);tasks.push(p);p.catch(()=>undefined);},abort(){assert.equal(this,ctx);aborts++; /* returning shim must fail, not count as platform termination */}};
  const env={DB:db.binding,DATABASE_DRIVER:'d1',SHARED_KEY_ENCRYPTION_SECRET:'synthetic-encryption-material-not-for-real-secrets',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false'};
  const handler=createImagesUndeliveredGateway(async(input,init)=>{sends++;return upstream.fetch(new Request(input,init));});
  try {
    for(const name of ['request-dispatch-intents.sql','request-usage-settlements.sql','request-usage-recovery-jobs.sql'])db.sqlite.exec(readFileSync(new URL('../../../core/migrations-proposals/d1/'+name,import.meta.url),'utf8'));
    for(const s of f.seed)db.sqlite.prepare(s.sql).run(...s.params);
    db.sqlite.prepare('UPDATE users SET budget_max=1 WHERE id=?').run(f.ids.user);
    db.sqlite.prepare('UPDATE api_keys SET limit_micros=NULL WHERE id=?').run(f.ids.key);
    for(const id of f.ids.endpoints)db.sqlite.prepare("UPDATE model_endpoints SET image_capabilities=json_set(image_capabilities,'$.pricing[0].cost_usd','0.1') WHERE id=?").run(id);
    if(row)db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(row.key,row.value,row.description);
    t.mock.timers.enable({apis:['setTimeout']});
    const model=f.cases['small-'+operation].model,wire=operation==='edits'?successMultipartWire(model):null;
    responseTask=handler.fetch(new Request('https://example.invalid/v1/images/'+operation,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':wire?.type??'application/json',...(probe?{[IMAGE_STORAGE_FAULT_HEADER]:imageStorageFaultHeader(probe)}:{})},body:wire?Buffer.concat([...wire.chunks()]):JSON.stringify({model,prompt:'synthetic'})}),env,ctx).then(r=>{returned=true;return r;});
    if(probe){
      const until=performance.now()+5000;
      while(aborts===0&&performance.now()<until)await new Promise(done=>setImmediate(done));
      assert.equal(aborts,1);await flush();assert.equal(returned,false);
      assert.equal(JSON.parse(db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(row.key).value).phase,'abort-requested-'+(mode==='before-abort'?'before':'after')+'-commit');
      t.mock.timers.tick(UNDELIVERED_IMAGE_GATE_MS);
    }
    const response=await responseTask;assert.equal(response.status,probe?503:200,JSON.stringify(messages).slice(0,2000));
    if(probe){assert.equal(response.headers.get('X-Generation-Id'),null);assert.equal(await response.text(),'C02_STAGING_DELIVERY_GATE_EXPIRED');}
    else {assert.equal((await response.json()).data[0].b64_json,'AQID');assert.equal(aborts,0);}
    for(let i=0;i<tasks.length;i++)await tasks[i];
    assert.equal(sends,1);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM request_dispatch_intents').get().n,1);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM request_usage_settlements').get().n,1);
    const committed=mode!=='before-abort';
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM request_usage_commit_receipts').get().n,committed?1:0);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM api_key_request_logs').get().n,committed?1:0);
    const account=db.sqlite.prepare('SELECT budget_spent_micros,budget_reserved_micros FROM users WHERE id=?').get(f.ids.user);
    assert.equal(account.budget_spent_micros,committed?100000:0);assert.equal(account.budget_reserved_micros,committed?0:100000);
    // A returning shim follows an ordinary caught error, NOT the leased native-abort state.
    const job=db.sqlite.prepare('SELECT state,last_error FROM request_usage_recovery_jobs').get();
    assert.equal(job.state,committed?'committed':'pending');assert.equal(job.last_error,committed?null:'execution_error');
  } finally {
    t.mock.timers.tick(UNDELIVERED_IMAGE_GATE_MS);await responseTask?.catch(()=>{});
    for(let i=0;i<tasks.length;i++)await tasks[i].catch(()=>{});db.sqlite.close();
  }
});
