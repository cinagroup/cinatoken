import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createD1DatabaseClient} from '../storage/database-client.ts';

// Actual SQLite constraints plus the documented atomic D1 batch contract.
// This is not a Cloudflare service, workerd or concurrency acceptance test.
export function createSlotD1Engine(){
  const db=new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,status TEXT NOT NULL);
    CREATE TABLE organizations(id TEXT PRIMARY KEY,status TEXT NOT NULL);
    CREATE TABLE workspaces(id TEXT PRIMARY KEY,scope_type TEXT,organization_id TEXT,personal_owner_user_id TEXT,status TEXT);
    CREATE TABLE management_api_keys(id TEXT PRIMARY KEY,status TEXT,expires_at TEXT,account_type TEXT,personal_owner_user_id TEXT,organization_id TEXT,created_by_user_id TEXT);
    CREATE TABLE api_keys(id TEXT PRIMARY KEY);
    CREATE TABLE user_audit_logs(id TEXT PRIMARY KEY,user_id TEXT,api_key_id TEXT,event_type TEXT,actor_type TEXT,change_payload TEXT,source TEXT,actor_id TEXT,reason_code TEXT,reason_text TEXT,created_at TEXT);
    INSERT INTO users VALUES('user','active'),('other','active');
    INSERT INTO workspaces VALUES('workspace','personal',NULL,'user','active'),('other-workspace','personal',NULL,'other','active');
    INSERT INTO management_api_keys VALUES('management','active',NULL,'personal','user',NULL,'user');`);
  for(const name of ['0064_private_byok.sql','0065_byok_always_use_for_provider.sql'])db.exec(readFileSync(new URL('../../migrations-d1/'+name,import.meta.url),'utf8'));
  const queries=[],batches=[];
  class Statement{
    constructor(sql,values=[]){this.sql=sql;this.values=values;}
    bind(...values){return new Statement(this.sql,values);}
    run(){queries.push({query:this.sql,params:this.values});return {success:true,results:[],meta:{changes:Number(db.prepare(this.sql).run(...this.values).changes)}};}
    first(){queries.push({query:this.sql,params:this.values});return db.prepare(this.sql).get(...this.values)??null;}
    all(){queries.push({query:this.sql,params:this.values});return {success:true,results:db.prepare(this.sql).all(...this.values),meta:{}};}
  }
  const raw={prepare:sql=>new Statement(sql),async batch(statements){
    const receipt={length:statements.length,state:'started'};batches.push(receipt);db.exec('BEGIN IMMEDIATE');
    try{const result=statements.map(s=>s.run());db.exec('COMMIT');receipt.state='committed';return result;}
    catch(e){db.exec('ROLLBACK');receipt.state='rolled_back';throw e;}
  }};
  return {db,client:createD1DatabaseClient(raw),queries,batches,
    rows:async sql=>db.prepare(sql).all().map(r=>({...r})),
    exec:async sql=>db.exec(sql),
    query:async(sql,values)=>db.prepare(sql).run(...values)};
}
