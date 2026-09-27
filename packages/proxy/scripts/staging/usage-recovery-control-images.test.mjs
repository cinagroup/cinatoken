import assert from 'node:assert/strict';
import test from 'node:test';
import { createUsageRecoveryControl } from '../../src/runtime/usage-recovery-control.ts';
import { createUsageRecoveryHost } from '../../src/runtime/usage-recovery-host.ts';
import { setup } from './images-recovery-test-support.mjs';
const aud='a'.repeat(64);
const settings={RECOVERY_CONTROL_ENVIRONMENT:'staging',RECOVERY_CONTROL_ENABLED:'true',RECOVERY_CONTROL_ACCESS_AUD:aud};
const hostSettings={RECOVERY_ENVIRONMENT:'staging',RECOVERY_ENABLED:'true',RECOVERY_MAX_ITEMS:'5',RECOVERY_CONCURRENCY:'1',RECOVERY_LEASE_SECONDS:'30',RECOVERY_RUN_BUDGET_MS:'5000',RECOVERY_RESERVED_BYTES:'1024',RECOVERY_INSTANCE_BYTES:'1024'};
const request=()=>new Request('https://control.example.invalid/_control/usage-recovery/run',{method:'POST',headers:{'X-CinaToken-Recovery-Command':'run-once-v1'}});
function context(){const tasks=[];return {access:{aud,getIdentity(){assert.fail('No identity lookup');}},tasks,waitUntil(task){tasks.push(task);}};}
// SQLite emits asynchronous runtime warnings during import. Keep this integration
// fixture out of the unit-test process that forbids every console call.
for(const operation of ['generations','edits'])for(const cost of [0,0.1])test(`authenticated control to actual host restores Images ${operation}, cost=${cost}`,async t=>{
  let fault=true;
  const f=await setup(t,{cost,hooks:{beforeStatement(sql){if(fault&&sql.startsWith('INSERT INTO api_key_request_logs'))throw new Error('Synthetic ledger unavailable');}}});
  const original=await f.request(operation);assert.equal(original.status,200);await original.json();await f.drain();assert.equal(f.sends,1);
  assert.equal(f.row('SELECT COUNT(*) AS n FROM api_key_request_logs').n,0);fault=false;f.advance(6);
  const host=createUsageRecoveryHost(),hostCtx=context(),control=createUsageRecoveryControl();let calls=0;
  const env={...settings,USAGE_RECOVERY:{async run(...args){assert.deepEqual(args,[]);calls++;return host.run(f.db.binding,hostSettings,hostCtx);}}};
  const denied=context();denied.access=undefined;assert.equal((await control.fetch(request(),env,denied)).status,403);assert.equal(calls,0);
  const ctx=context(),response=await control.fetch(request(),env,ctx);assert.equal(response.status,200);assert.equal((await response.json()).result.committed,1);await Promise.all([...hostCtx.tasks,...ctx.tasks]);
  assert.equal(f.sends,1);assert.equal(f.row('SELECT COUNT(*) AS n FROM api_key_request_logs').n,1);
  assert.equal(f.row('SELECT budget_spent_micros FROM users').budget_spent_micros,cost*1e6);
  const nextCtx=context(),again=await control.fetch(request(),env,nextCtx);assert.equal((await again.json()).result.claimed,0);assert.equal(f.sends,1);await Promise.all([...hostCtx.tasks,...nextCtx.tasks]);
});
