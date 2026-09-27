import assert from 'node:assert/strict';
import { writeSync } from 'node:fs';
import { setup } from './images-recovery-test-support.mjs';
import { createSqliteD1 } from '../../src/test-support/sqlite-d1.ts';
import { createD1DatabaseClient } from '../../../core/src/storage/database-client.ts';
import { runUsageRecoveryD1 } from '../../../core/src/storage/recovery/run-usage-recovery-d1.ts';
import { createRequestCapacityPool } from '../../src/services/request-capacity.ts';
import upstream from './images-upstream.ts';

// Test-only subprocess. Consumer receives a database filename and a clock, never
// an original request, API key, settlement DTO or selected-event reference.
const [filename,mode,arg,price] = process.argv.slice(2);
globalThis.fetch=async()=>{throw new Error('External network forbidden');};
for(const method of ['log','warn','error'])console[method]=()=>{};
const emit=value=>writeSync(1,JSON.stringify(value)+'\n');
if(mode==='recover') {
  assert.ok(Number.isSafeInteger(Number(arg))&&Number(arg)>0);
  const db=createSqliteD1({}, {filename,applyMigrations:false});
  db.sqlite.function('unixepoch',{varargs:true},()=>Number(arg));
  try {
    const result=await runUsageRecoveryD1(createD1DatabaseClient(db.binding),{
      scope:{kind:'all'},maxItems:5,concurrency:1,leaseSeconds:10,runBudgetMs:10000,reservedBytesPerConsumer:1024,
    },createRequestCapacityPool({maxRequests:1,maxReservedBytes:1024}));
    emit({...result,testClockSeconds:Number(arg),sqlClockSeconds:db.sqlite.prepare("SELECT unixepoch('now') AS n").get().n,
      diagnosticJobs:db.sqlite.prepare('SELECT state,attempts,last_error,lease_expires_at,available_at FROM request_usage_recovery_jobs LIMIT 5').all()});
  } finally {db.sqlite.close();}
} else {
  assert.ok(['claim-after','snapshot-before','snapshot-after','batch-before','batch-after','delivery-after'].includes(mode));
  assert.ok(['generations','edits'].includes(arg));assert.ok(['0','0.1'].includes(price));
  let f;
  const stop=()=>{emit({boundary:mode,sends:f.sends});process.exit(73);};
  const isLease=sql=>sql.startsWith('UPDATE request_usage_recovery_jobs SET')&&sql.includes('attempts=MIN');
  f=await setup(null,{filename,cost:Number(price),hooks:{
    beforeStatement(sql){
      if(mode==='snapshot-before'&&sql.startsWith('INSERT INTO request_usage_settlements'))stop();
      if(mode==='batch-before'&&sql.startsWith('INSERT INTO request_usage_commit_receipts'))stop();
    },
    async afterStatement(sql){
      if(mode==='claim-after'&&sql.startsWith('UPDATE request_dispatch_intents'))stop();
      if(mode==='snapshot-after'&&sql.startsWith('INSERT INTO request_usage_settlements'))stop();
      // Keep the background fast path suspended until the client has read EOF.
      if(mode==='delivery-after'&&isLease(sql))await new Promise(()=>{});
    },
    afterBatch(sql){if(mode==='batch-after'&&sql.some(s=>s.startsWith('INSERT INTO api_key_request_logs')))stop();},
  },transport:async(input,init)=>upstream.fetch(new Request(input,init))});
  const response=await f.request(arg);
  assert.equal(response.status,200);assert.equal((await response.json()).data[0].b64_json,'AQID');
  emit({deliveredStatus:response.status,eof:true});
  if(mode==='delivery-after')stop();
  await f.drain();throw new Error('Expected process boundary was not reached');
}
