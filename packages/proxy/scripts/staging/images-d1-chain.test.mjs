import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createSqliteD1 } from '../../src/test-support/sqlite-d1.ts';
import { createWorkerApp } from '../../src/runtime/workers.ts';
import { drainNodeBackgroundWork } from '../../src/runtime/schedule-background-work.ts';
import { imageSuccessFixture,successJsonWire,successMultipartWire } from '../../../../scripts/deploy/staging-image-success-fixture.mjs';
import upstream from './images-upstream.ts';

test('staging fixture traverses real auth, encrypted D1 repositories, endpoint selection and zero-price accounting',async t=>{
	// Let Node emit its module-load SQLite experimental warning before capturing application errors.
	await new Promise(resolve=>setImmediate(resolve));
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('Native network forbidden');});
  const errors=[];t.mock.method(console,'error',(...args)=>errors.push(args));
  const db=createSqliteD1(),key='synthetic-client-only';
  const fixture=await imageSuccessFixture('c02-success-aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa','sha256:'+createHash('sha256').update(key).digest('hex'),new Date(Date.now()+3600000).toISOString());
  const env={DB:db.binding,DATABASE_DRIVER:'d1',SHARED_KEY_ENCRYPTION_SECRET:'synthetic-encryption-material-not-for-real-secrets',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false'};
  let sends=0;
  const app=createWorkerApp({imageFetch:async(input,init)=>{sends++;return upstream.fetch(new Request(input,init));}});
  try {
    for(const s of fixture.seed)db.sqlite.prepare(s.sql).run(...s.params);
    const catalog=await app.request('/v1/models?kind=image',{headers:{Authorization:'Bearer '+key}},env);
    assert.equal(catalog.status,200);assert.equal((await catalog.json()).data.length,5);
    for(const operation of ['generations','edits']) {
      const model=fixture.cases['small-'+operation].model,wire=operation==='edits'?successMultipartWire(model):successJsonWire(model);
      const body=Buffer.concat([...wire.chunks()]);
      const response=await app.request('/v1/images/'+operation,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':wire.type},body},env);
      const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.data[0].b64_json,'AQID');assert.equal(result.usage.total_tokens,10);
    }
    await drainNodeBackgroundWork();assert.equal(sends,2);assert.deepEqual(errors,[]);
    const logs=db.sqlite.prepare('SELECT status,charged_cost,budget_charged_micros,upstream_attempt_count,request_body,upstream_request_body,output_image_count FROM api_key_request_logs WHERE api_key_id=?').all(fixture.ids.key);
    assert.equal(logs.length,2);
    for(const log of logs)assert.deepEqual({...log},{status:'success',charged_cost:0,budget_charged_micros:0,upstream_attempt_count:1,request_body:null,upstream_request_body:null,output_image_count:1});
  } finally {await drainNodeBackgroundWork();for(const s of fixture.cleanup)db.sqlite.prepare(s.sql).run(...s.params);db.sqlite.close();}
});
