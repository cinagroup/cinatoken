import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createSqliteD1 } from '../../src/test-support/sqlite-d1.ts';
import { createImagesHostExpiryGateway } from './images-host-expiry-handler.ts';
import { IMAGE_WAIT_UNTIL_EXPIRY_MS } from './images-storage-fault.ts';
import { imageSuccessFixture, successMultipartWire } from '../../../../scripts/deploy/staging-image-success-fixture.mjs';
import { imageStorageFaultHeader, imageStorageFaultRow, IMAGE_STORAGE_FAULT_HEADER } from './images-storage-fault-contract.ts';
import upstream from './images-upstream.ts';
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};

for(const operation of ['generations','edits'])for(const mode of ['normal','before-release','after-release'])test('real route '+operation+' / '+mode+': successful EOF precedes fixed background expiry fallback (not host proof)',async t=>{
  t.mock.method(globalThis,'fetch',async()=>{throw Error('External network forbidden');});
  const messages=[];
  for(const method of ['log','warn','error'])t.mock.method(console,method,(...args)=>messages.push(args.map(x=>x instanceof Error?x.message:String(x)).join(' ')));
  const db=createSqliteD1(),key='synthetic-host-expiry-'+randomUUID(),tasks=[];
  const f=await imageSuccessFixture('c02-success-'+randomUUID(),'sha256:'+createHash('sha256').update(key).digest('hex'),new Date(Date.now()+3600000).toISOString());
  const probe=mode==='normal'?null:{runId:f.ids.runId,probeId:randomUUID(),mode},row=probe?imageStorageFaultRow(probe):null;
  let sends=0,aborts=0;
  const ctx={waitUntil(p){assert.equal(this,ctx);const task={p,settled:false};tasks.push(task);p.finally(()=>{task.settled=true;}).catch(()=>{});},abort(){aborts++;throw Error('Native abort forbidden');}};
  const env={DB:db.binding,DATABASE_DRIVER:'d1',SHARED_KEY_ENCRYPTION_SECRET:'synthetic-encryption-material-not-for-real-secrets',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false'};
  const handler=createImagesHostExpiryGateway(async(input,init)=>{sends++;return upstream.fetch(new Request(input,init));});
  const phase=()=>row?JSON.parse(db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(row.key).value).phase:null;
  const job=()=>db.sqlite.prepare('SELECT state,revision,attempts,last_error FROM request_usage_recovery_jobs').get();
  const snapshot=()=>db.sqlite.prepare('SELECT payload_sha256,recorded_at FROM request_usage_settlements').get();
  try {
    for(const name of ['request-dispatch-intents.sql','request-usage-settlements.sql','request-usage-recovery-jobs.sql'])db.sqlite.exec(readFileSync(new URL('../../../core/migrations-proposals/d1/'+name,import.meta.url),'utf8'));
    for(const s of f.seed)db.sqlite.prepare(s.sql).run(...s.params);
    db.sqlite.prepare('UPDATE users SET budget_max=1 WHERE id=?').run(f.ids.user);
    db.sqlite.prepare('UPDATE api_keys SET limit_micros=NULL WHERE id=?').run(f.ids.key);
    for(const id of f.ids.endpoints)db.sqlite.prepare("UPDATE model_endpoints SET image_capabilities=json_set(image_capabilities,'$.pricing[0].cost_usd','0.1') WHERE id=?").run(id);
    if(row)db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(row.key,row.value,row.description);
    t.mock.timers.enable({apis:['setTimeout']});
    const model=f.cases['small-'+operation].model,wire=operation==='edits'?successMultipartWire(model):null;
    const response=await handler.fetch(new Request('https://example.invalid/v1/images/'+operation,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':wire?.type??'application/json',...(probe?{[IMAGE_STORAGE_FAULT_HEADER]:imageStorageFaultHeader(probe)}:{})},body:wire?Buffer.concat([...wire.chunks()]):JSON.stringify({model,prompt:'synthetic'})}),env,ctx);
    assert.equal(response.status,200,JSON.stringify(messages).slice(0,2000));assert.equal((await response.json()).data[0].b64_json,'AQID');
    let heldSnapshot;
    if(probe){
      const expected='awaiting-host-expiry-'+(mode==='before-release'?'before':'after')+'-commit';
      const until=performance.now()+5000;
      while(phase()!==expected&&performance.now()<until)await new Promise(done=>setImmediate(done));
      assert.equal(phase(),expected);assert.ok(tasks.some(task=>!task.settled),'host hold survives response EOF');
      assert.deepEqual({...job()},mode==='before-release'?{state:'leased',revision:1,attempts:1,last_error:null}:{state:'committed',revision:2,attempts:1,last_error:null});
      heldSnapshot={...snapshot()};
      t.mock.timers.tick(IMAGE_WAIT_UNTIL_EXPIRY_MS-1);await flush();assert.equal(phase(),expected);assert.ok(tasks.some(task=>!task.settled));
      t.mock.timers.tick(1);
    }
    for(let i=0;i<tasks.length;i++)await tasks[i].p;
    assert.equal(sends,1);assert.equal(aborts,0);
    if(probe){assert.equal(phase(),'host-expiry-not-observed');assert.deepEqual({...snapshot()},heldSnapshot);}
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM request_dispatch_intents').get().n,1);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM request_usage_settlements').get().n,1);
    const committed=mode!=='before-release';
    for(const table of ['request_usage_commit_receipts','api_key_request_logs'])assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM '+table).get().n,committed?1:0);
    const account=db.sqlite.prepare('SELECT budget_spent_micros,budget_reserved_micros FROM users WHERE id=?').get(f.ids.user);
    assert.equal(account.budget_spent_micros,committed?100000:0);assert.equal(account.budget_reserved_micros,committed?0:100000);
    // Mock timers survive forever; their fallback is an ordinary caught error, not platform cancellation.
    assert.equal(job().state,committed?'committed':'pending');assert.equal(job().last_error,committed?null:'execution_error');
  }finally{
    t.mock.timers.tick(IMAGE_WAIT_UNTIL_EXPIRY_MS);
    for(let i=0;i<tasks.length;i++)await tasks[i].p.catch(()=>{});db.sqlite.close();
  }
});
