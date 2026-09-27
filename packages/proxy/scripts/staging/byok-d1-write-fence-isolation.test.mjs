import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
const {BYOK_D1_FENCE_KEY:KEY,BYOK_D1_FENCE_CLOSED:CLOSED,BYOK_D1_FENCE_TRIGGERS:TRIGGERS,
  byokD1FenceValue:value,byokD1FenceTransition:transition}=await import(process.env.BYOK_D1_FENCE_MODULE
  ?pathToFileURL(resolve(process.env.BYOK_D1_FENCE_MODULE)).href:new URL('./byok-d1-write-fence.ts',import.meta.url).href);
import {BYOK_D1_CONTROL_KEY as CONTROL} from './byok-d1-one-shot.ts';

// Two real SQLite connections and WAL isolation, not a mock D1 batch. Synthetic
// minimal schema only: no migrations, admin credentials or production data.
for(const outcome of ['commit','rollback'])test('cleaning permit is never visible to another connection / '+outcome,t=>{
  t.mock.method(globalThis,'fetch',()=>{throw Error('External network forbidden');});
  const dir=mkdtempSync(join(process.env.BYOK_FENCE_TEST_ROOT??tmpdir(),'byok-fence-isolation-'));
  const path=join(dir,'synthetic.sqlite'),a=new DatabaseSync(path),b=new DatabaseSync(path);
  t.after(()=>{a.close();b.close();});
  a.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE system_config(key TEXT PRIMARY KEY,value TEXT,description TEXT);
    CREATE TABLE users(id TEXT PRIMARY KEY);
    CREATE TABLE workspaces(id TEXT PRIMARY KEY,personal_owner_user_id TEXT);
    CREATE TABLE management_api_keys(id TEXT PRIMARY KEY,personal_owner_user_id TEXT);
    CREATE TABLE byok_keys(id TEXT PRIMARY KEY,workspace_id TEXT);
    CREATE TABLE user_audit_logs(id TEXT PRIMARY KEY,user_id TEXT);`);
  b.exec('PRAGMA busy_timeout=1');
  for(const trigger of TRIGGERS)a.exec(trigger.sql);
  const runId='c02-byok-a1b2c3d4e5f6',user=runId+'-0-u',now=Math.floor(Date.now()/1000);
  const state={version:1,runId,state:'pending',cursor:0,pendingCase:'changes-contract',issuedAt:now-1,expiresAt:now+899};
  a.prepare('INSERT INTO system_config(key,value) VALUES(?,?)').run(KEY,value('open',runId));
  a.prepare('INSERT INTO system_config(key,value) VALUES(?,?)').run(CONTROL,JSON.stringify(state));
  a.prepare('INSERT INTO users(id) VALUES(?)').run(user);
  a.prepare('UPDATE system_config SET value=? WHERE key=?').run(JSON.stringify({...state,state:'stopped'}),CONTROL);
  const seal=transition(runId,false);assert.equal(a.prepare(seal.sql).run(...seal.params).changes,1);
  const late=b.prepare('INSERT INTO users(id) VALUES(?)');
  const observe=()=>({marker:b.prepare('SELECT value FROM system_config WHERE key=?').get(KEY).value,
    users:b.prepare('SELECT count(*) n FROM users').get().n});
  const before={marker:CLOSED,users:1};assert.deepEqual(observe(),before);
  a.exec('BEGIN IMMEDIATE');
  a.prepare('UPDATE system_config SET value=? WHERE key=?').run(value('cleaning',runId),KEY);
  assert.deepEqual(observe(),before);
  assert.throws(()=>late.run(user),/database is locked/);
  a.prepare('DELETE FROM users WHERE id=?').run(user);
  assert.deepEqual(observe(),before);
  a.prepare('UPDATE system_config SET value=? WHERE key=?').run(CLOSED,KEY);
  assert.deepEqual(observe(),before);
  a.exec(outcome==='commit'?'COMMIT':'ROLLBACK');
  assert.deepEqual(observe(),{marker:CLOSED,users:outcome==='commit'?0:1});
  // Even a statement prepared before the cleanup transaction uses the sealed
  // marker when it finally executes, rather than borrowing an earlier permit.
  assert.throws(()=>late.run(user),/c02_byok_write_fenced/);
  t.diagnostic(JSON.stringify({sqliteOnly:true,connections:2,outcome,artifact:path}));
});
