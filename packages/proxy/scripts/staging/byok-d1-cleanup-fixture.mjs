import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {BYOK_D1_CASES} from './byok-d1-acceptance.ts';
import {BYOK_D1_CONTROL_KEY,BYOK_D1_ORIGIN,handleByokD1OneShot} from './byok-d1-one-shot.ts';

/** Test-only: 68 migrations + the already-installed staging recovery proposals
 * + Wrangler's bookkeeping table. Exact local schema digest, NOT cloud proof.
 * Hooks can model acknowledgement loss or concurrent writes; no external I/O.
 */
export function byokCleanupFixture(){
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
  const directory=new URL('../../../core/migrations-d1/',import.meta.url);
  const files=readdirSync(directory).filter(n=>n.endsWith('.sql')).sort();assert.equal(files.length,68);
  for(const name of files)db.exec(readFileSync(new URL(name,directory),'utf8'));
  db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)');
  for(const [i,name] of files.entries())db.prepare('INSERT INTO d1_migrations(id,name) VALUES(?,?)').run(i+1,name);
  for(const name of ['request-dispatch-intents','request-usage-settlements','request-usage-recovery-jobs'])
    db.exec(readFileSync(new URL(`../../../core/migrations-proposals/d1/${name}.sql`,import.meta.url),'utf8'));
  db.exec("UPDATE admin_api_keys SET status='revoked',revoked_at=datetime('now')");
  const hooks={},batches=[],calls=[],tasks=[],events=[];
  const sync=(s)=>{hooks.beforeStatement?.(s);calls.push({sql:s.sql,values:s.values});const stmt=db.prepare(s.sql),select=stmt.columns().length>0;
    const results=select?stmt.all(...s.values):[],changes=select?0:Number(stmt.run(...s.values).changes);
    hooks.afterStatement?.(s);return {success:true,results,meta:{changes,rows_read:0,rows_written:0}};};
  class Statement{
    constructor(sql,values=[]){this.sql=sql;this.values=values;}
    bind(...values){return new Statement(this.sql,values);}
    async all(){return sync(this);}
    run(){return this.all();}
    async first(){return (await this.all()).results[0]??null;}
  }
  const raw={prepare:sql=>new Statement(sql),async batch(items){
    await hooks.beforeBatch?.(items);const op={statements:items,state:'STARTED'};batches.push(op);db.exec('BEGIN IMMEDIATE');let result;
    try{result=items.map(sync);db.exec('COMMIT');op.state='COMMITTED';}catch(error){db.exec('ROLLBACK');op.state='ROLLED_BACK';throw error;}
    await hooks.afterBatch?.(items,result);return result;
  }};
  const schema=()=>db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type COLLATE BINARY,name COLLATE BINARY LIMIT 513').all();
  const schemaSha256=createHash('sha256').update(JSON.stringify(schema())).digest('hex');
  const tables=schema().filter(r=>r.type==='table'&&!r.name.startsWith('sqlite_')).map(r=>r.name);assert.equal(tables.length,56);
  const counts=()=>Object.fromEntries(tables.map(t=>[t,db.prepare('SELECT count(*) n FROM '+t).get().n]));
  const allRows=()=>Object.fromEntries(tables.map(t=>[t,db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all().map(r=>({...r}))]));
  const runId='c02-byok-a1b2c3d4e5f6',bearer='a1'.repeat(32),ctx={waitUntil(p){tasks.push(p);}};
  const send=async action=>handleByokD1OneShot(new Request(BYOK_D1_ORIGIN+'/__staging/byok-d1/'+action,
    {method:'POST',headers:{Authorization:'Bearer '+bearer}}),raw,ctx);
  const arm=()=>{const now=Math.floor(Date.now()/1000);db.prepare('INSERT INTO system_config(key,value) VALUES(?,?)').run(BYOK_D1_CONTROL_KEY,
    JSON.stringify({version:1,runId,tokenHash:createHash('sha256').update(bearer).digest('hex'),issuedAt:now-1,expiresAt:now+899,state:'ready',cursor:0,pendingCase:null,receipts:[]}));};
  const complete=async(n=10)=>{arm();for(const id of BYOK_D1_CASES.slice(0,n)){const r=await send(id);assert.equal(r.status,200,await r.text());}
    assert.equal((await send('stop')).status,200);await Promise.all(tasks);};
  let closedCalls=0;
  const assertProducerClosed=async()=>{closedCalls++;await hooks.closed?.(closedCalls);};
  const persist=async event=>{events.push(structuredClone(event));await hooks.persist?.(event);};
  return {db,raw,hooks,batches,calls,events,schema,schemaSha256,counts,allRows,runId,arm,send,complete,
    assertProducerClosed,persist,get closedCalls(){return closedCalls;},async close(){await Promise.all(tasks);db.close();}};
}
