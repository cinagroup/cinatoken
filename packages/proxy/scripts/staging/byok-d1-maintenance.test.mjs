import assert from 'node:assert/strict';
import test from 'node:test';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {byokMaintenanceFixture,context,TOKEN,deferred,destructive} from './byok-d1-maintenance-fixture.mjs';
import {BYOK_D1_MAINTENANCE_KEY as KEY} from './byok-d1-cleanup.ts';
import {BYOK_D1_CONTROL_KEY} from './byok-d1-one-shot.ts';
import {BYOK_D1_FENCE_KEY,BYOK_D1_FENCE_CLOSED} from './byok-d1-write-fence.ts';
const moduleUrl=(name,file)=>process.env[name]?pathToFileURL(resolve(process.env[name])).href:new URL(file,import.meta.url).href;
const {runByokD1Maintenance:run}=await import(moduleUrl('BYOK_MAINTENANCE_HOST_MODULE','./byok-d1-maintenance-host.ts'));
const {parseByokMaintenancePermit:parse}=await import('./byok-d1-maintenance-contract.ts');

for(const n of [0,1,3,10])test('receiver claims once, cleans exact prefix, retains durable receipt / '+n,async t=>{
  const f=await byokMaintenanceFixture(t,n),before=f.calls.length;
  f.hooks.beforeStatement=()=>assert.equal(f.ctx.tasks.length,1,'waitUntil before first D1 I/O');
  const r=await run(f.raw,true,TOKEN,f.ctx);assert.equal(r.status,'cleaned');assert.equal(r.runId,f.runId);
  assert.equal(r.statementCount,143);assert.equal(f.getPermit().state,'finished');assert.equal(f.getPermit().receipt.removedRows,r.removedRows);
  assert.deepEqual(f.restoreRows(),f.before);assert.equal(f.counts().system_config,14);
  const operations=f.calls.slice(before),claim=operations.findIndex(s=>s.sql.startsWith('UPDATE system_config SET value = ? WHERE key = ? AND value = ?'));
  assert.ok(claim>=0);assert.ok(operations.findIndex(s=>s.sql.startsWith('DELETE '))>claim);
  f.hooks.beforeStatement=undefined;
  assert.equal((await run(f.raw,true,TOKEN,context())).status,'not_admissible');assert.equal(f.batches.filter(b=>destructive(b.statements)).length,1);
  if(n===10)assert.equal(r.removedRows,664);
});
for(const [name,enabled,token] of [['disabled',false,TOKEN],['empty',true,''],['wrong-type',true,{}],['oversize',true,'a'.repeat(65)]])test('receiver no I/O / '+name,async t=>{
  const f=await byokMaintenanceFixture(t,0),before=f.calls.length;
  assert.equal((await run(f.raw,enabled,token,f.ctx)).status,name==='disabled'?'disabled':'invalid_arguments');
  assert.equal(f.calls.length,before);assert.equal(f.ctx.tasks.length,0);
});
test('receiver lifetime registration failure forbids even authorization read',async t=>{
  const f=await byokMaintenanceFixture(t,0),before=f.calls.length;
  assert.equal((await run(f.raw,true,TOKEN,{waitUntil(){throw Error('host rejected');}})).status,'host_rejected');assert.equal(f.calls.length,before);
});
test('wrong bearer cannot consume a ready permit',async t=>{
  const f=await byokMaintenanceFixture(t);const before=f.allRows();
  assert.equal((await run(f.raw,true,'11'.repeat(32),f.ctx)).status,'not_authorized');assert.deepEqual(f.allRows(),before);
});

for(const name of ['expired','future','stale-closure','pending','finished','malformed','oversized','extra-field','foreign-baseline','wrong-state-type'])test('receiver rejects invalid or non-admissible permit / '+name,async t=>{
  const f=await byokMaintenanceFixture(t),p=structuredClone(f.permit),now=Math.floor(Date.now()/1000);
  if(name==='expired'){p.issuedAt=now-70;p.expiresAt=now-10;p.closure.observedAt=p.issuedAt;}
  if(name==='future'){p.issuedAt=now+30;p.expiresAt=now+90;p.closure.observedAt=p.issuedAt;}
  if(name==='stale-closure'){p.issuedAt=now-16;p.expiresAt=now+44;p.closure.observedAt=p.issuedAt;}
  if(name==='pending')p.state='pending';
  if(name==='finished'){p.state='finished';p.receipt={removedRows:1,statementCount:143,statementBytes:1};}
  if(name==='extra-field')p.sql='DELETE FROM users';
  if(name==='foreign-baseline')p.baseline.counts.users=1;
  if(name==='wrong-state-type')p.state=['ready'];
  f.setPermit(name==='malformed'?'{':name==='oversized'?JSON.stringify(p)+' '.repeat(16385):p);
  const before=f.allRows(),r=await run(f.raw,true,TOKEN,f.ctx);assert.notEqual(r.status,'cleaned');
  assert.deepEqual(f.allRows(),before);assert.equal(f.batches.filter(b=>destructive(b.statements)).length,0);
});

test('independent receiver contexts race on durable CAS; only one deletes',async t=>{
  const f=await byokMaintenanceFixture(t),ctx2=context(),entered=deferred(),release=deferred();t.after(()=>release.resolve());
  f.hooks.beforeBatch=async items=>{if(destructive(items)){entered.resolve();await release.promise;}};
  const first=run(f.raw,true,TOKEN,f.ctx);await entered.promise;
  assert.equal(f.getPermit().state,'pending');assert.equal((await run(f.raw,true,TOKEN,ctx2)).status,'not_admissible');
  release.resolve();assert.equal((await first).status,'cleaned');await Promise.all(ctx2.tasks);assert.equal(f.batches.filter(b=>destructive(b.statements)).length,1);
});

for(const fault of ['claim-before','claim-after','delete-before','delete-after','receipt-before','receipt-after','baseline-drift','permit-drift','fence-open','unresolved-case'])test('uncertainty never authorizes receiver replay / '+fault,async t=>{
  const f=await byokMaintenanceFixture(t);let reached=false;
  const permitWrite=s=>s.sql.startsWith('UPDATE system_config SET value = ? WHERE key = ? AND value = ?')&&s.values[1]===KEY;
  const phase=s=>permitWrite(s)?JSON.parse(s.values[0]).state:null;
  f.hooks.beforeStatement=s=>{if(reached)return;
    if(fault==='claim-before'&&phase(s)==='pending'||fault==='receipt-before'&&phase(s)==='finished'){reached=true;throw Error('synthetic before write');}};
  f.hooks.afterStatement=s=>{if(reached)return;
    if(fault==='claim-after'&&phase(s)==='pending'||fault==='receipt-after'&&phase(s)==='finished'){reached=true;throw Error('synthetic acknowledgement loss');}};
  f.hooks.beforeBatch=async items=>{if(!destructive(items))return;
    if(fault==='delete-before'){reached=true;throw Error('synthetic delete binding rejection');}
    if(fault==='permit-drift'){reached=true;f.setPermit({...f.getPermit(),tokenHash:'c'.repeat(64)});}
  };
  f.hooks.afterBatch=async items=>{if(fault==='delete-after'&&destructive(items)){reached=true;throw Error('synthetic delete ACK lost');}};
  if(fault==='baseline-drift'){reached=true;f.db.exec("UPDATE admin_api_keys SET description='foreign'");}
  if(fault==='fence-open'){reached=true;f.db.prepare('UPDATE system_config SET value=? WHERE key=?').run('{"version":1,"state":"open","runId":"'+f.runId+'"}',BYOK_D1_FENCE_KEY);}
  if(fault==='unresolved-case'){reached=true;const c=JSON.parse(f.db.prepare('SELECT value FROM system_config WHERE key=?').get(BYOK_D1_CONTROL_KEY).value);
    c.pendingCase='compact-management';f.db.prepare('UPDATE system_config SET value=? WHERE key=?').run(JSON.stringify(c),BYOK_D1_CONTROL_KEY);}
  const r=await run(f.raw,true,TOKEN,f.ctx);assert.equal(r.status,'outcome_unknown');assert.equal(reached,true);
  const state=f.getPermit().state;assert.equal(state,fault==='claim-before'?'ready':fault==='receipt-after'?'finished':'pending');
  const deletes=f.batches.filter(b=>destructive(b.statements)).length;
  for(const k of Object.keys(f.hooks))delete f.hooks[k];
  if(state!=='ready'){assert.notEqual((await run(f.raw,true,TOKEN,context())).status,'cleaned');assert.equal(f.batches.filter(b=>destructive(b.statements)).length,deletes);}
  // A true pre-claim failure remains ready: the HOST journal must quarantine the
  // uncertain request, even though DB alone cannot prove that request happened.
  if(['delete-after','receipt-before','receipt-after'].includes(fault))assert.deepEqual(f.restoreRows(),f.before);
  if(fault!=='fence-open')assert.equal(f.db.prepare('SELECT value FROM system_config WHERE key=?').get(BYOK_D1_FENCE_KEY).value,BYOK_D1_FENCE_CLOSED);
});

test('one-row maintenance exception is never an arbitrary baseline exclusion',async t=>{
  const f=await byokMaintenanceFixture(t);f.db.prepare('INSERT INTO system_config(key,value) VALUES(?,?)').run('foreign','1');
  const before=f.allRows();assert.equal((await run(f.raw,true,TOKEN,f.ctx)).status,'outcome_unknown');
  assert.equal(f.batches.filter(b=>destructive(b.statements)).length,0);assert.equal(f.counts().users,1);
  assert.deepEqual(f.allRows().system_config.filter(r=>r.key!==KEY),before.system_config.filter(r=>r.key!==KEY));
});
test('permit parser owns the baseline object and rejects unbounded invalid versions',async t=>{
  const f=await byokMaintenanceFixture(t,0),parsed=parse(JSON.stringify(f.permit));
  parsed.baseline.counts.users=999;assert.equal(f.permit.baseline.counts.users,0);
  for(const v of [{...f.permit,version:2},{...f.permit,receipt:{}},{...f.permit,closure:{...f.permit.closure,observedAt:f.permit.issuedAt-6}}])
    assert.throws(()=>parse(JSON.stringify(v)));
});

for(const boundary of ['before-plan','after-delete'])test('closure attestation expiry during cleanup stays quarantined / '+boundary,async t=>{
  const f=await byokMaintenanceFixture(t),now=f.permit.issuedAt;let clock=now,reached=false;
  f.db.function('unixepoch',{varargs:true},()=>clock);
  if(boundary==='before-plan')f.hooks.afterStatement=s=>{
    if(!reached&&s.sql.startsWith('UPDATE system_config SET value = ? WHERE key = ? AND value = ?')&&s.values[1]===KEY){
      reached=true;clock=now+16;
    }
  };
  else f.hooks.afterBatch=async items=>{if(destructive(items)){reached=true;clock=now+16;}};
  assert.equal((await run(f.raw,true,TOKEN,f.ctx)).status,'outcome_unknown');assert.equal(reached,true);
  assert.equal(f.getPermit().state,'pending');
  assert.equal(f.batches.filter(b=>destructive(b.statements)).length,boundary==='before-plan'?0:1);
  if(boundary==='after-delete')assert.deepEqual(f.restoreRows(),f.before);
  clock=now;for(const k of Object.keys(f.hooks))delete f.hooks[k];
  assert.equal((await run(f.raw,true,TOKEN,context())).status,'not_admissible');
});
