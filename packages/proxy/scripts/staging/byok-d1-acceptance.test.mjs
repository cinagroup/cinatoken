import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readByokD1FrozenMigrations} from './byok-d1-frozen-migrations-fixture.mjs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {BYOK_D1_CASES,byokD1Fixture,runByokD1Case,cleanupByokD1Case}=await import(process.env.BYOK_D1_ACCEPTANCE_MODULE
  ?pathToFileURL(resolve(process.env.BYOK_D1_ACCEPTANCE_MODULE)).href:new URL('./byok-d1-acceptance.ts',import.meta.url).href);

// Frozen 0001–0068 D1 chain, real SQLite constraints and atomic transactions.
// This checks the historical acceptance oracle, not newer schemas or workerd.
function fixture(){
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
  for(const {sql} of readByokD1FrozenMigrations())db.exec(sql);
  const operations=[],calls=[];
  function run(sql,values,mode){
    calls.push({sql,values,mode});const stmt=db.prepare(sql),select=stmt.columns().length>0;
    const results=select?stmt.all(...values):[];
    const changes=select?0:Number(stmt.run(...values).changes);
    return {success:true,results,meta:{changes,rows_read:0,rows_written:0}};
  }
  class Statement{
    constructor(sql,values=[]){this.sql=sql;this.values=values;}
    bind(...values){return new Statement(this.sql,values);}
    run(){return run(this.sql,this.values,'run');}
    all(){return run(this.sql,this.values,'all');}
    first(){return run(this.sql,this.values,'first').results[0]??null;}
  }
  const raw={prepare:sql=>new Statement(sql),async batch(statements){
    const operation={statements:statements.map(s=>s.sql),state:'STARTED'};operations.push(operation);
    db.exec('BEGIN IMMEDIATE');try{const results=statements.map(s=>s.run());db.exec('COMMIT');operation.state='COMMITTED';return results;}
    catch(e){db.exec('ROLLBACK');operation.state='ROLLED_BACK';throw e;}
  }};
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
  for(const table of tables)assert.match(table,/^[a-z][a-z0-9_]*$/);
  const counts=()=>Object.fromEntries(tables.map(t=>[t,db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n]));
  const schema=()=>db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
  return {db,raw,operations,calls,counts,schema};
}
const runId='c02-byok-a1b2c3d4e5f6';

for(const caseId of BYOK_D1_CASES)test('acceptance oracle / '+caseId,async()=>{
  const f=fixture(),before=f.counts(),schema=f.schema();
  try{
    const result=await runByokD1Case(f.raw,runId,caseId);
    assert.equal(result.result,'PASS');assert.equal(result.caseId,caseId);
    assert.equal(result.midBatchWallClockExpiryVerified,false);
    assert.ok(!JSON.stringify(result).includes('enc:v2:'));
    assert.deepEqual(f.schema(),schema);
    if(caseId.endsWith('rollback'))assert.equal(f.operations.filter(o=>o.state==='ROLLED_BACK').length,1);
    if(caseId.startsWith('compact-'))assert.deepEqual(result.batches.map(b=>b.map(m=>m.changes)),[[1,1],[99,99,99,1,1]]);
    if(caseId==='full-old-id')assert.deepEqual(result.batches.map(b=>b.map(m=>m.changes)),[[0,0,0,0,0]]);
    if(caseId==='concurrent-last-slot')assert.deepEqual(result.batches.slice(1).map(b=>b.map(m=>m.changes)),[[99,99,99,1,1],[0,0,0,0,0]]);
    assert.ok(f.operations.every(o=>o.statements.length<=103));
    assert.ok(f.calls.every(c=>c.values.length<=100));
    await cleanupByokD1Case(f.raw,runId,caseId);
    assert.deepEqual(f.counts(),before);assert.deepEqual(f.schema(),schema);
  }finally{f.db.close();}
});

test('all cases in one database: no collisions, schema or baseline drift',async()=>{
  const f=fixture(),before=f.counts(),schema=f.schema();
  try{for(const id of BYOK_D1_CASES)await runByokD1Case(f.raw,runId,id);
    for(const id of BYOK_D1_CASES)await cleanupByokD1Case(f.raw,runId,id);
    assert.deepEqual(f.counts(),before);assert.deepEqual(f.schema(),schema);
  }finally{f.db.close();}
});
test('same fixture cannot be replayed or reset by seed',async()=>{
  const f=fixture();try{
    await runByokD1Case(f.raw,runId,'compact-management');
    const snapshot=f.db.prepare('SELECT * FROM byok_keys ORDER BY id').all(),counts=f.counts();
    await assert.rejects(runByokD1Case(f.raw,runId,'compact-management'),/UNIQUE constraint/);
    assert.deepEqual(f.counts(),counts);assert.deepEqual(f.db.prepare('SELECT * FROM byok_keys ORDER BY id').all(),snapshot);
  }finally{f.db.close();}
});
test('invalid scope/case rejected before database access',async()=>{
  const db={prepare(){throw Error('database accessed');},batch(){throw Error('database accessed');}};
  for(const id of ['', 'production','c02-byok-a1b2c3d4e5f6-extra','c02-byok-A1B2C3D4E5F6'])
    await assert.rejects(runByokD1Case(db,id,'changes-contract'),/byok_acceptance_run_id/);
  await assert.rejects(runByokD1Case(db,runId,'arbitrary-query'),/byok_acceptance_case_id/);
});
test('SQL transport failures cannot masquerade as intentional rollback evidence',async()=>{
  const f=fixture();try{
    const broken={prepare:f.raw.prepare,async batch(statements){
      if(statements.length===5&&statements[0].sql.startsWith('WITH compactable'))throw Error('transport timeout');
      return f.raw.batch(statements);
    }};
    await assert.rejects(runByokD1Case(broken,runId,'insert-rollback'),/fault_must_reject/);
  }finally{f.db.close();}
});
test('cleanup rejects mismatched ownership without writes',async()=>{
  const f=fixture();try{
    await runByokD1Case(f.raw,runId,'changes-contract');
    const scope=byokD1Fixture(runId,'changes-contract');
    f.db.prepare('UPDATE users SET email=? WHERE id=?').run('different@example.invalid',scope.user);
    const count=f.operations.length;
    await assert.rejects(cleanupByokD1Case(f.raw,runId,'changes-contract'),/cleanup_ownership/);
    assert.equal(f.operations.length,count);
  }finally{f.db.close();}
});

test('oracle rejects a binding that resets changes between batch statements',async()=>{
  const f=fixture();try{
    const broken={prepare:f.raw.prepare,async batch(statements){
      const results=await f.raw.batch(statements);
      for(let i=0;i<statements.length;i++)if(statements[i].sql==='SELECT changes() AS previous_changes')
        results[i].results=[{previous_changes:0}];
      return results;
    }};
    await assert.rejects(runByokD1Case(broken,runId,'changes-contract'),/changes_one/);
  }finally{f.db.close();}
});
test('oracle rejects missing mutation audit, not just a successful SQL batch',async()=>{
  const f=fixture();try{
    const broken={prepare:f.raw.prepare,async batch(statements){
      if(statements.length===5&&statements[0].sql.startsWith('WITH compactable')){
        const results=await f.raw.batch(statements.slice(0,-1));
        return [...results,{success:true,results:[],meta:{changes:0,rows_read:0,rows_written:0}}];
      }
      return f.raw.batch(statements);
    }};
    await assert.rejects(runByokD1Case(broken,runId,'crud-management'),/plain_create/);
  }finally{f.db.close();}
});
test('oracle rejects compaction that changes unrelated credential metadata',async()=>{
  const f=fixture();try{
    const scope=byokD1Fixture(runId,'compact-management');
    const broken={prepare:f.raw.prepare,async batch(statements){
      const results=await f.raw.batch(statements);
      if(statements.length===5&&statements[0].sql.startsWith('WITH compactable'))
        f.db.prepare('UPDATE byok_keys SET label=? WHERE id=?').run('corrupted',scope.key(0));
      return results;
    }};
    await assert.rejects(runByokD1Case(broken,runId,'compact-management'),/metadata_preserved/);
  }finally{f.db.close();}
});
test('concurrent case waits for rejected and pending operation before returning',async()=>{
  const f=fixture();let release,pending=false,finished=false;
  const held=new Promise(r=>{release=r;});
  try{
    let calls=0;
    const broken={prepare:f.raw.prepare,async batch(statements){
      if(statements.length===5&&statements[0].sql.startsWith('WITH compactable')){
        if(++calls===1)throw Error('transport timeout');
        pending=true;await held;
      }
      return f.raw.batch(statements);
    }};
    const running=runByokD1Case(broken,runId,'concurrent-last-slot').finally(()=>{finished=true;});
    const outcome=assert.rejects(running,/concurrent_rejection/);
    for(let i=0;i<30&&!pending;i++)await new Promise(r=>setImmediate(r));
    assert.equal(pending,true);assert.equal(finished,false);
    release();await outcome;assert.equal(finished,true);
  }finally{release?.();f.db.close();}
});
