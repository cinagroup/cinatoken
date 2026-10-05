import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {copyFileSync,mkdtempSync,readdirSync,writeFileSync,renameSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {BYOK_D1_FROZEN_MIGRATION_COUNT,readByokD1FrozenMigrations} from './byok-d1-frozen-migrations-fixture.mjs';

const directory=new URL('../../../core/migrations-d1/',import.meta.url);
function copyFrozen(t){
  const path=mkdtempSync(join(tmpdir(),'cinatoken-byok-frozen-migrations-'));
  for(const {name} of readByokD1FrozenMigrations())copyFileSync(new URL(name,directory),join(path,name));
  // Retain controlled negative inputs outside the repository for inspection.
  t.diagnostic('Retained migration input: '+path);
  return {path,url:pathToFileURL(path+'/')};
}

test('historical loader retains exact68 despite the current69–77 migration suffix',()=>{
  const frozen=readByokD1FrozenMigrations();
  assert.equal(frozen.length,BYOK_D1_FROZEN_MIGRATION_COUNT);
  assert.equal(frozen[0].name,'0001_baseline.sql');assert.equal(frozen.at(-1).name,'0068_batch_jobs.sql');
  const suffix=readdirSync(directory).filter(name=>/\.sql$/.test(name)&&Number(name.slice(0,4))>=69&&Number(name.slice(0,4))<=77).sort();
  assert.equal(suffix.length,9);assert.ok(frozen.every(({name})=>!suffix.includes(name)));
});

test('appended migration is not executed by the historical SQLite fixture',t=>{
  const input=copyFrozen(t);writeFileSync(join(input.path,'0069_future_table.sql'),'CREATE TABLE post_freeze_marker(id TEXT);');
  writeFileSync(join(input.path,'0078_future_invalid.sql'),'not valid SQL and must not be executed');
  const db=new DatabaseSync(':memory:');try{
    db.exec('PRAGMA foreign_keys=ON');for(const {sql} of readByokD1FrozenMigrations(input.url))db.exec(sql);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='post_freeze_marker'").get().n,0);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n,51);
  }finally{db.close();}
});

test('changed old SQL bytes are rejected even when the schema would be equivalent',t=>{
  const input=copyFrozen(t),file=join(input.path,'0068_batch_jobs.sql');
  writeFileSync(file,readFileSync(file,'utf8')+'\n-- harmless schema comment still changes the frozen input\n');
  assert.throws(()=>readByokD1FrozenMigrations(input.url),/byok_frozen_migration_source_pin/);
});

test('missing and duplicate historical migration inputs cannot be hidden by a newer suffix',t=>{
  const missing=copyFrozen(t);renameSync(join(missing.path,'0068_batch_jobs.sql'),join(missing.path,'0069_batch_jobs.sql'));
  assert.throws(()=>readByokD1FrozenMigrations(missing.url),/byok_frozen_migration_count/);
  const duplicate=copyFrozen(t);copyFileSync(join(duplicate.path,'0068_batch_jobs.sql'),join(duplicate.path,'0068_duplicate.sql'));
  assert.throws(()=>readByokD1FrozenMigrations(duplicate.url),/byok_frozen_migration_count/);
});

test('renamed old input is rejected even when its sequence and SQL bytes are unchanged',t=>{
  const input=copyFrozen(t);renameSync(join(input.path,'0068_batch_jobs.sql'),join(input.path,'0068_renamed.sql'));
  assert.throws(()=>readByokD1FrozenMigrations(input.url),/byok_frozen_migration_source_pin/);
});
