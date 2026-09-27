import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync,readdirSync,rmSync,rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createSqliteD1 } from '../../src/test-support/sqlite-d1.ts';

const entry=fileURLToPath(new URL('./images-recovery-process.fixture.mjs',import.meta.url));
for(const mode of ['claim-after','snapshot-before','snapshot-after','batch-before','batch-after','delivery-after'])
for(const operation of ['generations','edits'])for(const cost of [0,0.1]) {
  test(`real Images route process exit: ${mode}, ${operation}, cost=${cost}`,{timeout:45000},()=>{
    const root=mkdtempSync(path.join(tmpdir(),'cinatoken-image-restart-')),filename=path.join(root,'recovery.sqlite');let db;
    const run=(...args)=>spawnSync(process.execPath,['--import','tsx',entry,filename,...args],{encoding:'utf8',timeout:12000,windowsHide:true});
    try {
      const killed=run(mode,operation,String(cost));assert.equal(killed.error,undefined);assert.equal(killed.status,73,killed.stderr);
      const events=killed.stdout.trim().split('\n').map(line=>JSON.parse(line));
      assert.deepEqual(events.at(-1),{boundary:mode,sends:mode==='claim-after'?0:1});
      if(mode==='delivery-after')assert.deepEqual(events[0],{deliveredStatus:200,eof:true});
      db=createSqliteD1({}, {filename,applyMigrations:false});
      const hasSnapshot=!['claim-after','snapshot-before'].includes(mode),committed=mode==='batch-after';
      assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM request_usage_settlements').get().n,Number(hasSnapshot));
      assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM api_key_request_logs').get().n,Number(committed));
      assert.equal(db.sqlite.prepare('SELECT state FROM request_dispatch_intents').get().state,'dispatch_claimed');
      // Advance from the durable lease, not a parent-process wall-clock guess.
      const job=db.sqlite.prepare('SELECT state,updated_at,available_at,lease_expires_at FROM request_usage_recovery_jobs').get();
      const leased=job?.state==='leased';
      if(leased){assert.equal(job.lease_expires_at-job.updated_at,10);assert.equal(job.available_at,job.lease_expires_at);}
      const seconds=Number(job?.available_at??job?.updated_at??Math.floor(Date.now()/1000))+1;
      db.sqlite.close();db=null;
      if(leased){
        const early=run('recover',String(job.lease_expires_at-1));assert.equal(early.error,undefined);assert.equal(early.status,0,early.stderr);
        const result=JSON.parse(early.stdout);assert.equal(result.sqlClockSeconds,job.lease_expires_at-1);
        assert.equal(result.scanned,0,JSON.stringify(result));assert.equal(result.committed,0);
      }
      const recovered=run('recover',String(seconds));assert.equal(recovered.error,undefined);assert.equal(recovered.status,0,recovered.stderr);
      const outcome=JSON.parse(recovered.stdout);assert.equal(outcome.sqlClockSeconds,seconds);assert.equal(outcome.testClockSeconds,seconds);
      assert.equal(outcome.committed,Number(hasSnapshot&&!committed),JSON.stringify(outcome));
      // A second fresh process proves no original HTTP owner or in-memory task is needed.
      const repeated=run('recover',String(seconds));assert.equal(repeated.error,undefined);assert.equal(repeated.status,0,repeated.stderr);
      assert.equal(JSON.parse(repeated.stdout).claimed,0);
      db=createSqliteD1({}, {filename,applyMigrations:false});
      for(const table of ['api_key_request_logs','request_usage_commit_receipts','provider_attempt_availability'])assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,Number(hasSnapshot));
      const account=db.sqlite.prepare('SELECT budget_spent_micros,budget_reserved_micros FROM users').get();
      assert.equal(account.budget_spent_micros,hasSnapshot?cost*1000000:0);
      assert.equal(account.budget_reserved_micros,hasSnapshot?0:cost*1000000);
      assert.equal(db.sqlite.prepare('SELECT COALESCE(SUM(request_count),0) AS n FROM public_model_daily_stats').get().n,Number(hasSnapshot));
      if(hasSnapshot)assert.equal(db.sqlite.prepare('SELECT state FROM request_usage_recovery_jobs').get().state,'committed');
      else assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM request_usage_recovery_jobs').get().n,0,'unknown must not invent a settlement');
      assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
    } finally {
      db?.sqlite.close();
      assert.equal(path.dirname(filename),root);assert.equal(path.dirname(root),path.resolve(tmpdir()));
      assert.ok(path.basename(root).startsWith('cinatoken-image-restart-'));
      for(const item of readdirSync(root)){
        assert.ok(['recovery.sqlite','recovery.sqlite-wal','recovery.sqlite-shm','recovery.sqlite-journal'].includes(item));
        rmSync(path.join(root,item));
      }
      rmdirSync(root);
    }
  });
}
