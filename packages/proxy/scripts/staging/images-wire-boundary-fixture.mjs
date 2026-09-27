// Local-only wire fixture; real authentication/Worker handler and SQLite transactions.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setup } from './images-recovery-test-support.mjs';
import { createWorkerHandler } from '../../src/runtime/worker-handler.ts';
import { drainNodeBackgroundWork } from '../../src/runtime/schedule-background-work.ts';
import { decodeUsageSettlement } from '../../../core/src/storage/recovery/usage-settlement-codec.ts';
import { createUsageSettlementRepositoryD1 } from '../../../core/src/storage/recovery/usage-settlement-d1.ts';

const tables=['request_dispatch_intents','request_usage_settlements','request_usage_recovery_jobs','request_usage_commit_receipts',
  'api_key_request_logs','provider_attempt_availability','user_audit_logs','public_model_daily_stats'];
export async function wireFixture(t,{upstreamBody,upstreamStatus=200,hooks={}}={}) {
  t.mock.method(globalThis,'fetch',async()=>{throw Error('External network forbidden');});
  for(const method of ['log','warn','error'])t.mock.method(console,method,()=>{});
  const base=await setup(undefined,{cost:0.1,hooks,composition:'worker'});
  let cleanup=()=>base.close();t.after(()=>cleanup());
  const key='synthetic-wire-'+randomUUID(),hash='sha256:'+createHash('sha256').update(key).digest('hex');
  assert.equal(base.db.sqlite.prepare('UPDATE api_keys SET key=?,key_hash=? WHERE id=?').run('hashref:'+hash,hash,base.fixture.ids.key).changes,1);
  const env={DB:base.db.binding,DATABASE_DRIVER:'d1',SHARED_KEY_ENCRYPTION_SECRET:'synthetic-material-not-for-real-secrets',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false'};
  const tasks=[];let sends=0,closed=false;
  const context={waitUntil(p){assert.equal(this,context);tasks.push(p);p.catch(()=>undefined);}};
  const app=createWorkerHandler({imageUsageRecovery:{settlementLeaseSeconds:5},imageFetch:async(input,init)=>{
    sends++;
    assert.equal(base.row("SELECT COUNT(*) AS n FROM request_dispatch_intents WHERE state='dispatch_claimed'").n,sends);
    const request=new Request(input,init);let bytes=0;
    for await(const chunk of request.body){bytes+=chunk.byteLength;assert.ok(bytes<=512*1024);}
    assert.equal(Number(request.headers.get('Content-Length')),bytes);
    const body=upstreamBody??{data:[{b64_json:'AQID'}],usage:{input_tokens:3,output_tokens:7,total_tokens:10}};
    const json=JSON.stringify(body);assert.ok(Buffer.byteLength(json)<=256*1024);
    return new Response(json,{status:upstreamStatus,headers:{'Content-Type':'application/json','X-Request-ID':'c02-wire-boundary'}});
  }});
  async function drain(){for(let i=0;i<tasks.length;i++)await tasks[i];await drainNodeBackgroundWork();}
  async function close(){if(closed)return;try{await drain();}finally{await base.close();closed=true;}}
  cleanup=close;
  function fields(operation){return {model:base.fixture.cases['small-'+operation].model,prompt:'private-wire-prompt'};}
  async function send(operation,body,type){
    assert.ok(['generations','edits'].includes(operation));assert.ok(Buffer.byteLength(body)<=512*1024);
    return app.fetch(new Request('https://example.invalid/v1/images/'+operation,{method:'POST',
      headers:{Authorization:'Bearer '+key,'Content-Type':type},body}),env,context);
  }
  return {db:base.db,storage:base.storage,fixture:base.fixture,row:base.row,recover:base.recover,drain,close,get sends(){return sends;},
    counts(){return Object.fromEntries(tables.map(table=>[table,base.row('SELECT COUNT(*) AS n FROM '+table).n]));},
    account(){return JSON.parse(JSON.stringify(base.row('SELECT budget_spent_micros,budget_reserved_micros FROM users WHERE id=?',base.fixture.ids.user)));},
    async snapshot(){const s=base.row('SELECT payload_json,payload_sha256 FROM request_usage_settlements');assert.ok(s);
      return {...s,value:await decodeUsageSettlement(s.payload_json,s.payload_sha256)};},
    json(patch={}){const body=fields('generations');return send('generations',typeof patch==='function'?patch(body):JSON.stringify({...body,...patch}),'application/json');},
    multipart(extra=[]){
      const boundary='cinatoken-wire-boundary';
      const entries=[...Object.entries(fields('edits')),...(typeof extra==='function'?extra(fields('edits')):extra)];
      const chunks=entries.map(([name,value])=>{
        assert.match(name,/^[A-Za-z0-9_-]{1,300}$/);assert.equal(typeof value,'string');
        return Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
      });
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="test.png"\r\nContent-Type: image/png\r\n\r\n`),Buffer.alloc(16,1),Buffer.from(`\r\n--${boundary}--\r\n`));
      return send('edits',Buffer.concat(chunks),'multipart/form-data; boundary='+boundary);
    },
    async response(response){const body=await response.json();await drain();return{status:response.status,body};},
  };
}

export async function assertNoDispatch(f,response,status,message){
  const observed=await f.response(response);assert.equal(observed.status,status,JSON.stringify(observed.body));
  assert.match(observed.body.error.message,message);
  assert.equal(f.sends,0);assert.ok(Object.values(f.counts()).every(n=>n===0));
  assert.deepEqual(f.account(),{budget_spent_micros:0,budget_reserved_micros:0});
  assert.equal(f.row('SELECT COUNT(*) AS n FROM user_budget_reservations').n,0);
  assert.ok(Object.values(await f.recover()).every(v=>v===0||v===false));
  return observed;
}

export async function assertWireSettled(f,response,status=200){
  const observed=await f.response(response);assert.equal(observed.status,status,JSON.stringify(observed.body));
  if(status===200)assert.equal(observed.body.data[0].b64_json,'AQID');
  assert.equal(f.sends,1);assert.ok(Object.values(f.counts()).every(n=>n===1));
  assert.deepEqual(f.account(),{budget_spent_micros:100000,budget_reserved_micros:0});
  const snapshot=await f.snapshot(),log=snapshot.value.params.requestLog;
  const unknown=status!==200,nominalCharge=unknown?0:0.1;
  assert.equal(log.status,unknown?'error':'success');assert.equal(log.chargedCost,nominalCharge);
  assert.equal(snapshot.value.params.shouldChargeBudget,!unknown);
  assert.equal(snapshot.value.params.userBudgetSettlement.mode,unknown?'reserved':'actual');
  assert.equal(f.row('SELECT charged_cost,budget_charged_micros FROM api_key_request_logs').charged_cost,nominalCharge);
  assert.equal(f.row('SELECT budget_charged_micros FROM api_key_request_logs').budget_charged_micros,unknown?0:100000);
  const reservation=f.row('SELECT state,reserved_micros,settled_micros FROM user_budget_reservations');
  assert.equal(reservation.state,unknown?'expired':'settled');assert.equal(reservation.reserved_micros,100000);assert.equal(reservation.settled_micros,100000);
  const stats=f.row('SELECT SUM(success_count) AS successes,SUM(error_count) AS errors,SUM(request_count) AS requests FROM public_model_daily_stats');
  assert.equal(stats.requests,1);assert.equal(stats.successes,unknown?0:1);assert.equal(stats.errors,unknown?1:0);
  assert.equal(f.row('SELECT pricing_audit FROM api_key_request_logs').pricing_audit,log.pricingAudit);
  assert.equal(f.row('SELECT state FROM request_usage_recovery_jobs').state,'committed');
  assert.equal(snapshot.payload_json.includes('private-wire-'),false);
  assert.ok(Object.values(await f.recover()).every(v=>v===0||v===false));
  assert.equal(f.sends,1);assert.deepEqual(await f.snapshot(),snapshot);
  const i=snapshot.value.intent,ref={requestId:i.requestId,userId:i.userId,apiKeyId:i.apiKeyId,workspaceId:i.workspaceId,payloadSha256:snapshot.payload_sha256};
  const before={counts:f.counts(),account:f.account()};
  assert.equal(await createUsageSettlementRepositoryD1(f.storage.client).commit(ref),'committed');
  assert.deepEqual({counts:f.counts(),account:f.account()},before);
  return{...observed,snapshot};
}
