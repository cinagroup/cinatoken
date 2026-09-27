import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {byokCleanupFixture} from './byok-d1-cleanup-fixture.mjs';
import {BYOK_D1_CASES} from './byok-d1-acceptance.ts';
import {BYOK_D1_CONTROL_KEY} from './byok-d1-one-shot.ts';
const moduleUrl=(key,file)=>process.env[key]?pathToFileURL(resolve(process.env[key])).href:new URL(file,import.meta.url).href;
const {BYOK_D1_FENCE_KEY:KEY,BYOK_D1_FENCE_CLOSED:CLOSED,BYOK_D1_FENCE_TRIGGERS:TRIGGERS,
  byokD1FenceInstallPlan:installPlan,byokD1FenceTransition:transition,byokD1FenceValue:fenceValue,
  assertByokD1FenceInstalled:assertInstalled}=await import(moduleUrl('BYOK_D1_FENCE_MODULE','./byok-d1-write-fence.ts'));
const {captureByokD1CleanupBaseline:capture,createByokD1Cleanup:cleanup}=await import(moduleUrl('BYOK_D1_CLEANUP_MODULE','./byok-d1-cleanup.ts'));
const digest=f=>createHash('sha256').update(JSON.stringify(f.schema())).digest('hex');
const marker=f=>f.db.prepare('SELECT value FROM system_config WHERE key=?').get(KEY)?.value;
const control=f=>JSON.parse(f.db.prepare('SELECT value FROM system_config WHERE key=?').get(BYOK_D1_CONTROL_KEY).value);
const setControl=(f,v)=>f.db.prepare('UPDATE system_config SET value=? WHERE key=?').run(typeof v==='string'?v:JSON.stringify(v),BYOK_D1_CONTROL_KEY);
const destructive=items=>items.some(s=>s.sql.startsWith('DELETE '));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const runQuery=(f,q)=>f.raw.prepare(q.sql).bind(...q.params).run();
async function setup(t){
  t.mock.method(globalThis,'fetch',()=>{throw Error('External network forbidden');});
  const f=byokCleanupFixture();t.after(()=>f.close());
  const plan=installPlan(JSON.stringify(f.schema()));assert.equal(plan.length,17);
  await f.raw.batch(plan.map(q=>f.raw.prepare(q.sql).bind(...q.params)));
  const before=f.allRows(),baseline=await capture(f.raw,digest(f),'write-fence-v1');
  const task=()=>cleanup({db:f.raw,baseline,runId:f.runId,assertProducerClosed:f.assertProducerClosed,persist:f.persist});
  const arm=async()=>{f.arm();assert.equal((await runQuery(f,transition(f.runId,true))).meta.changes,1);};
  const seal=async()=>{assert.equal((await f.send('stop')).status,200);assert.equal((await runQuery(f,transition(f.runId,false))).meta.changes,1);};
  const complete=async(n=10)=>{await arm();for(const id of BYOK_D1_CASES.slice(0,n)){const r=await f.send(id);assert.equal(r.status,200,await r.text());}await seal();};
  return Object.assign(f,{before,baseline,task,armFence:arm,seal,completeFence:complete});
}
const insertUser=f=>f.db.prepare("INSERT INTO users(id,email,status) VALUES(?,?,'active')").run(f.runId+'-0-u','fenced@example.invalid');

for(const n of [0,1,3,10])test('fenced atomic cleanup restores persistent closed baseline / '+n,async t=>{
  const f=await setup(t);assert.equal(f.schema().length,307);assert.equal(f.baseline.counts.system_config,13);
  await f.completeFence(n);const task=f.task(),pending=task.run();assert.equal(task.run(),pending);const r=await pending;
  assert.equal(r.result,'CLEANED',JSON.stringify(r));assert.equal(r.statementCount,143);assert.equal(r.nativeAcceptanceProved,false);
  assert.equal(r.fixtureRemoved,true);assert.equal(marker(f),CLOSED);assert.deepEqual(f.allRows(),f.before);
  assert.equal(f.batches.filter(b=>destructive(b.statements)).length,1);assert.equal(f.closedCalls,3);
  assert.throws(()=>insertUser(f),/c02_byok_write_fenced/);
  if(n===10){assert.equal(r.removedRows,664);t.diagnostic(JSON.stringify({statementCount:r.statementCount,statementBytes:r.statementBytes,removedRows:r.removedRows,schemaObjects:f.schema().length}));}
});

for(const fault of ['missing-trigger','changed-trigger','extra-trigger','missing-marker','open-marker','description','legacy-mode'])test('fence baseline rejects '+fault,async t=>{
  const f=await setup(t);
  if(fault==='missing-trigger'||fault==='changed-trigger')f.db.exec('DROP TRIGGER '+TRIGGERS[0].name);
  if(fault==='changed-trigger')f.db.exec(`CREATE TRIGGER ${TRIGGERS[0].name} BEFORE INSERT ON users BEGIN SELECT 1; END`);
  if(fault==='extra-trigger')f.db.exec('CREATE TRIGGER c02_byok_fence_v1_extra BEFORE INSERT ON users BEGIN SELECT 1; END');
  if(fault==='missing-marker')f.db.prepare('DELETE FROM system_config WHERE key=?').run(KEY);
  if(fault==='open-marker')f.db.prepare('UPDATE system_config SET value=? WHERE key=?').run(fenceValue('open',f.runId),KEY);
  if(fault==='description')f.db.prepare("UPDATE system_config SET description='changed' WHERE key=?").run(KEY);
  await assert.rejects(capture(f.raw,digest(f),fault==='legacy-mode'?undefined:'write-fence-v1'),/byok_(?:fence|cleanup)_/);
});

for(const mutation of ['ready','stopped','expired','future','cursor','case','wrong-run','invalid-json','oversized-json','missing-control','missing-marker'])test('fixture insert fails closed / '+mutation,async t=>{
  const f=await setup(t);await f.armFence();const c={...control(f),state:'pending',pendingCase:BYOK_D1_CASES[0]};
  if(mutation==='ready'||mutation==='stopped')c.state=mutation;
  if(mutation==='expired')c.expiresAt=Math.floor(Date.now()/1000)-1;
  if(mutation==='future')c.issuedAt=Math.floor(Date.now()/1000)+600;
  if(mutation==='cursor')c.cursor='0';
  if(mutation==='case')c.pendingCase=BYOK_D1_CASES[1];
  if(mutation==='wrong-run')c.runId='c02-byok-111111111111';
  setControl(f,mutation==='invalid-json'?'{':mutation==='oversized-json'?JSON.stringify(c)+' '.repeat(32769):c);
  if(mutation==='missing-control')f.db.prepare('DELETE FROM system_config WHERE key=?').run(BYOK_D1_CONTROL_KEY);
  if(mutation==='missing-marker')f.db.prepare('DELETE FROM system_config WHERE key=?').run(KEY);
  assert.throws(()=>insertUser(f),/c02_byok_write_fenced/);assert.equal(f.counts().users,0);
});

test('open permit admits only the pending case; update checks old and new ownership, delete stays closed',async t=>{
  const f=await setup(t);await f.armFence();setControl(f,{...control(f),state:'pending',pendingCase:BYOK_D1_CASES[0]});
  insertUser(f);
  assert.throws(()=>f.db.prepare("INSERT INTO users(id,email) VALUES(?,'other@example.invalid')").run(f.runId+'-1-u'),/c02_byok_write_fenced/);
  assert.throws(()=>f.db.prepare('UPDATE users SET id=? WHERE id=?').run(f.runId+'-1-u',f.runId+'-0-u'),/c02_byok_write_fenced/);
  assert.throws(()=>f.db.exec('DELETE FROM users'),/c02_byok_write_fenced/);
  setControl(f,{...control(f),cursor:1,pendingCase:BYOK_D1_CASES[1]});
  assert.throws(()=>f.db.prepare('UPDATE users SET id=? WHERE id=?').run(f.runId+'-1-u',f.runId+'-0-u'),/c02_byok_write_fenced/);
  assert.equal(f.counts().users,1);
});

test('closed fence blocks fixture updates and deletes, not only new inserts',async t=>{
  const f=await setup(t);await f.completeFence(3);
  for(const table of ['users','workspaces','management_api_keys','byok_keys','user_audit_logs']){
    assert.ok(f.counts()[table]>0);assert.throws(()=>f.db.exec(`UPDATE ${table} SET id=id`),/c02_byok_write_fenced/);
    assert.throws(()=>f.db.exec(`DELETE FROM ${table}`),/c02_byok_write_fenced/);
  }
  assert.throws(()=>insertUser(f),/c02_byok_write_fenced/);
});

for(const mode of ['blocked-before-execution','rejected-then-late-execution'])test('stopped pending seed cannot resurrect fixture / '+mode,{timeout:10000},async t=>{
  const f=await setup(t),entered=deferred(),release=deferred();await f.armFence();let captured;
  // This hook is before BEGIN: it represents a binding call not yet executed by the DB.
  f.hooks.beforeBatch=async items=>{if(!items[0].sql.startsWith('INSERT INTO users'))return;captured=items;entered.resolve();
    if(mode==='rejected-then-late-execution')throw Error('native acknowledgement rejected before delayed execution');await release.promise;};
  t.after(()=>release.resolve());const running=f.send(BYOK_D1_CASES[0]);await entered.promise;
  if(mode==='rejected-then-late-execution')assert.equal((await running).status,500);
  await f.seal();release.resolve();
  if(mode==='blocked-before-execution')assert.equal((await running).status,503);
  else {f.hooks.beforeBatch=undefined;await assert.rejects(f.raw.batch(captured),/c02_byok_write_fenced/);}
  assert.equal(marker(f),CLOSED);assert.equal(f.counts().users,0);assert.equal(f.counts().byok_keys,0);
  const state=control(f);assert.equal(state.state,'stopped');
  assert.equal(state.pendingCase,mode==='blocked-before-execution'?BYOK_D1_CASES[0]:null);
  const r=await f.task().run();assert.equal(r.result,'ATTENTION_REQUIRED');assert.equal(r.deleteAttempted,false);
});

for(const mode of ['delete-count','post-row-drift','restore-marker-count','ack-lost'])test('fenced cleanup retains containment across '+mode,async t=>{
  const f=await setup(t);await f.completeFence(1);const before=f.allRows();
  f.hooks.beforeBatch=async items=>{if(!destructive(items))return;
    if(mode==='delete-count')items.find(s=>s.sql.startsWith('DELETE FROM byok_keys')).values[0]='[]';
    if(mode==='restore-marker-count')items.find(s=>s.sql.startsWith('UPDATE system_config')&&s.values[0]===CLOSED).values[2]='wrong';
  };
  f.hooks.afterStatement=s=>{if(mode==='post-row-drift'&&s.sql.startsWith('DELETE FROM users'))f.db.exec("UPDATE admin_api_keys SET description='changed'");};
  f.hooks.afterBatch=async items=>{if(mode==='ack-lost'&&destructive(items))throw Error('commit ack lost');};
  const task=f.task(),r=await task.run();assert.equal(r.result,'ATTENTION_REQUIRED');assert.equal(r.deleteAttempted,true);
  assert.equal(r.deleteAcknowledged,false);assert.equal(r.fixtureRemoved,false);assert.equal(marker(f),CLOSED);
  assert.deepEqual(f.allRows(),mode==='ack-lost'?f.before:before);assert.throws(()=>insertUser(f),/c02_byok_write_fenced/);
  await task.run();assert.equal(f.batches.filter(b=>destructive(b.statements)).length,1);
});

test('installation is exclusive and atomic on stale schema, occupied tables and trigger failure',async t=>{
  for(const fault of ['schema','occupied','ddl']){
    const f=byokCleanupFixture();t.after(()=>f.close());const plan=installPlan(JSON.stringify(f.schema()));
    if(fault==='schema')f.db.exec('CREATE TABLE unexpected (id TEXT)');
    if(fault==='occupied')insertUser(f);
    const before=f.allRows();if(fault==='ddl')f.hooks.beforeStatement=s=>{if(s.sql===TRIGGERS[7].sql)throw Error('synthetic DDL failure');};
    await assert.rejects(f.raw.batch(plan.map(q=>f.raw.prepare(q.sql).bind(...q.params))));
    assert.deepEqual(f.allRows(),before);assert.equal(f.schema().filter(r=>r.name.startsWith('c02_byok_fence_v1_')).length,0);
  }
  const f=await setup(t);await assert.rejects(f.raw.batch(installPlan(JSON.stringify(f.schema())).map(q=>f.raw.prepare(q.sql).bind(...q.params))));
  assertInstalled(f.schema(),f.allRows().system_config);assert.equal(marker(f),CLOSED);
});

test('fenced and unfenced acceptance forward identical product statements and preserve original rollback errors',async t=>{
  const fenced=await setup(t),legacy=byokCleanupFixture();t.after(()=>legacy.close());
  const errors=[],batch=fenced.raw.batch.bind(fenced.raw);fenced.raw.batch=async s=>{try{return await batch(s);}catch(e){errors.push(e.message);throw e;}};
  const fencedStart=fenced.batches.length,legacyStart=legacy.batches.length;
  await fenced.completeFence();await legacy.complete();
  const product=(f,start)=>f.batches.slice(start).map(b=>({state:b.state,sql:b.statements.map(s=>s.sql)}));
  assert.deepEqual(product(fenced,fencedStart),product(legacy,legacyStart));assert.ok(product(fenced,fencedStart).length>25);
  assert.ok(errors.some(s=>s.includes('byok_keys_label_chk')));assert.ok(errors.some(s=>s.includes('FOREIGN KEY constraint failed')));
  assert.ok(errors.every(s=>!s.includes('c02_byok_write_fenced')));
  assert.deepEqual(control(fenced).receipts.map(r=>r.result),control(legacy).receipts.map(r=>r.result));
});

test('a different run cannot lend its open permit to a delayed previous-run write',async t=>{
  const f=await setup(t);await f.completeFence(1);assert.equal((await f.task().run()).result,'CLEANED');
  f.arm();const runId='c02-byok-111111111111';setControl(f,{...control(f),runId});
  assert.equal((await runQuery(f,transition(f.runId,true))).meta.changes,0);
  assert.equal((await runQuery(f,transition(runId,true))).meta.changes,1);
  setControl(f,{...control(f),state:'pending',pendingCase:BYOK_D1_CASES[0]});
  assert.throws(()=>insertUser(f),/c02_byok_write_fenced/);
  f.db.prepare("INSERT INTO users(id,email) VALUES(?,'next@example.invalid')").run(runId+'-0-u');
  assert.equal(f.counts().users,1);
});

test('operator transitions require exact prior marker and ready/stopped control states',async t=>{
  const f=await setup(t);assert.equal((await runQuery(f,transition(f.runId,true))).meta.changes,0);
  await f.armFence();assert.equal((await runQuery(f,transition(f.runId,true))).meta.changes,0);
  assert.equal((await runQuery(f,transition(f.runId,false))).meta.changes,0);
  assert.equal(marker(f),fenceValue('open',f.runId));await f.seal();
  assert.equal((await runQuery(f,transition(f.runId,false))).meta.changes,0);
  assert.equal((await runQuery(f,transition(f.runId,true))).meta.changes,0);
  assert.throws(()=>transition('wrong',true),/byok_fence_invalid/);
});
