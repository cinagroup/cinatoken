import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {exactStagingRowGuard} from './staging-sql-row-guard.mjs';
for(const width of [1,2,14,76,100])test('Balanced exact guard retains all '+width+' fields and their bind order',()=>{
  const db=new DatabaseSync(':memory:');try{
    const row=Object.fromEntries(Array.from({length:width},(_,i)=>['c'+i,i%3===0?null:i]));
    db.exec('CREATE TABLE fixture('+Object.keys(row).map(n=>n+' INTEGER').join(',')+')');
    db.prepare('INSERT INTO fixture VALUES('+Object.keys(row).map(()=>'?').join(',')+')').run(...Object.values(row));
    const s=exactStagingRowGuard('fixture',row);assert.deepEqual(s.params,Object.values(row));assert.equal((s.sql.match(/ IS \?/g)||[]).length,width);
    assert.equal(db.prepare(s.sql).get(...s.params).cleanup_guard,1);
    db.exec('UPDATE fixture SET c'+(width-1)+'=-1');assert.throws(()=>db.prepare(s.sql).get(...s.params));
  }finally{db.close();}
});
for(const [label,table,row] of [['table injection','fixture; DROP TABLE fixture',{c:1}],['column injection','fixture',{'c OR 1=1':1}],['empty row','fixture',{}]])test('Balanced guard refuses '+label,()=>assert.throws(()=>exactStagingRowGuard(table,row)));
test('Changed wide row rejects and rolls back a guarded destructive transaction',()=>{
  const db=new DatabaseSync(':memory:');try{
    const row=Object.fromEntries(Array.from({length:76},(_,i)=>['c'+i,i]));db.exec('CREATE TABLE fixture('+Object.keys(row).join(',')+')');
    db.prepare('INSERT INTO fixture VALUES('+Object.keys(row).map(()=>'?').join(',')+')').run(...Object.values(row));const s=exactStagingRowGuard('fixture',row);
    db.exec('UPDATE fixture SET c75=100; BEGIN');assert.throws(()=>{db.prepare(s.sql).get(...s.params);db.exec('DELETE FROM fixture');});db.exec('ROLLBACK');assert.equal(db.prepare('SELECT COUNT(*) n FROM fixture').get().n,1);
  }finally{db.close();}
});
