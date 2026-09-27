import assert from 'node:assert/strict';
import test from 'node:test';
import { setup } from './images-recovery-test-support.mjs';
import { RECOVERY_SCHEMA_ARTIFACT as artifact } from '../../../core/src/storage/recovery/usage-recovery-schema-artifact.ts';

for(const operation of ['generations','edits'])for(const item of artifact.objects.filter(x=>x.type==='trigger'))test(`${operation} rejects same-name trigger drift before inference: ${item.name}`,async t=>{
  const f=await setup(t,{cost:0.1});
  f.db.sqlite.exec(`DROP TRIGGER ${item.name}; CREATE TRIGGER ${item.name} BEFORE INSERT ON ${item.table} BEGIN SELECT 1; END`);
  const response=await f.request(operation);assert.notEqual(response.status,200);await response.body.cancel();await f.drain();
  assert.equal(f.sends,0);
  for(const table of ['request_dispatch_intents','request_usage_settlements','request_usage_recovery_jobs','api_key_request_logs','user_budget_reservations']) {
    assert.equal(f.row(`SELECT COUNT(*) AS n FROM ${table}`).n,0,table);
  }
  assert.equal(f.row('SELECT budget_spent_micros FROM users').budget_spent_micros,0);
});
for(const operation of ['generations','edits'])test(`${operation} fast path rechecks definitions before claims and can recover after exact restore`,async t=>{
  let f,armed=true,original;
  f=await setup(t,{cost:0.1,hooks:{afterStatement(sql){
    if(armed&&sql.startsWith('SELECT * FROM request_usage_recovery_jobs')){
      armed=false;original=f.row("SELECT sql FROM sqlite_master WHERE name='request_usage_recovery_fence'").sql;
      f.db.sqlite.exec('DROP TRIGGER request_usage_recovery_fence');
    }
  }}});
  const response=await f.request(operation);assert.equal(response.status,200);await response.body.cancel();await f.drain();
  assert.equal(armed,false);assert.equal(f.sends,1);assert.equal(f.row('SELECT attempts FROM request_usage_recovery_jobs').attempts,0);
  assert.equal(f.row('SELECT COUNT(*) AS n FROM request_usage_settlements').n,1);assert.equal(f.row('SELECT COUNT(*) AS n FROM api_key_request_logs').n,0);
  assert.equal(f.row('SELECT budget_spent_micros FROM users').budget_spent_micros,0);
  f.db.sqlite.exec(original);assert.equal((await f.recover()).committed,1);assert.equal(f.sends,1);
  assert.equal(f.row('SELECT budget_spent_micros FROM users').budget_spent_micros,100000);assert.equal((await f.recover()).claimed,0);
});
