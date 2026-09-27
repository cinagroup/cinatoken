import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setup } from './images-recovery-test-support.mjs';
import { recoveryImageObservations } from './images-recovery-live-fixture.mjs';
import { IMAGE_STORAGE_FAULT_HEADER, imageStorageFaultHeader, imageStorageFaultRow, parseImageStorageFault } from './images-storage-fault-contract.ts';
import { createImagesStagingGateway } from './images-gateway-handler.ts';
import { createUsageRecoveryHost } from '../../src/runtime/usage-recovery-host.ts';
import { withRecoveryFencingProbe, RECOVERY_FENCING_CONTROL_KEY, RECOVERY_FENCING_CONTROL_DESCRIPTION } from './recovery-fencing-probe.ts';

const hostSettings={RECOVERY_ENVIRONMENT:'staging',RECOVERY_ENABLED:'true',RECOVERY_MAX_ITEMS:'5',RECOVERY_CONCURRENCY:'1',
  RECOVERY_LEASE_SECONDS:'30',RECOVERY_RUN_BUDGET_MS:'5000',RECOVERY_RESERVED_BYTES:'67108864',RECOVERY_INSTANCE_BYTES:'67108864'};

async function until(check) {
  const deadline=performance.now()+3000;
  while(!check()){if(performance.now()>deadline)throw Error('Local barrier was not reached');await new Promise(r=>setTimeout(r,5));}
}

test('fencing probe contract accepts only the exact bounded mode',()=>{
  const p={runId:'c02-success-'+randomUUID(),probeId:randomUUID(),mode:'before-fence'};
  assert.deepEqual(parseImageStorageFault(imageStorageFaultHeader(p)),p);
  for(const bad of ['after-fence','before-fence:50000','before-fence-isolate'])assert.equal(parseImageStorageFault(imageStorageFaultHeader(p).replace(p.mode,bad)),null);
});
test('staging observation profiles are server-only finite choices',()=>{
  const transport=()=>{throw Error('No transport should be invoked during composition');};
  for(const storageFaultPolls of [20,40])assert.doesNotThrow(()=>createImagesStagingGateway(transport,{storageFaultPolls}));
  for(const storageFaultPolls of [0,1,39,41,1000,'40',NaN,Infinity])assert.throws(()=>createImagesStagingGateway(transport,{storageFaultPolls}),/observation profile/);
});

for(const enabled of [false,true]) test(`non-fencing staging rejects request/binding profile toggles before admission: recovery=${enabled}`,async t=>{
  const f=await setup(t,{composition:'staging',enabled,envPatch:{storageFaultPolls:40,imageUsageRecovery:{settlementLeaseSeconds:5}}});
  const probe={runId:f.fixture.ids.runId,probeId:randomUUID(),mode:'before-fence'};
  const r=await f.request('generations',{storageFaultPolls:40,imageUsageRecovery:{settlementLeaseSeconds:5}},undefined,
    {[IMAGE_STORAGE_FAULT_HEADER]:imageStorageFaultHeader(probe),'x-storage-fault-polls':'40'});
  assert.equal(r.status,400);await r.body.cancel();assert.equal(f.holds,0);assert.equal(f.sends,0);
  assert.equal(f.row('SELECT COUNT(*) AS n FROM request_dispatch_intents').n,0);
});

for(const operation of ['generations','edits']) for(const scenario of ['valid-owner','expired-owner','new-owner-success','new-owner-fail-retry']) {
  test(`full staging gateway lease fence / ${operation} / ${scenario}`,{timeout:15000},async t=>{
    let injectNewAuditFailure=false;
    const f=await setup(t,{composition:'fencing',cost:0.1,hooks:{beforeStatement(sql){
      if(injectNewAuditFailure && sql.startsWith('INSERT INTO user_audit_logs')){injectNewAuditFailure=false;throw Error('TEST_NEW_OWNER_LATE_AUDIT_FAILURE');}
    }}});
    const p={runId:f.fixture.ids.runId,probeId:randomUUID(),mode:'before-fence'},row=imageStorageFaultRow(p);
    f.db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(row.key,row.value,row.description);
    const phase=()=>JSON.parse(f.row('SELECT value FROM system_config WHERE key=?',row.key).value);
    const releaseOld=()=>{
      const value=f.row('SELECT value FROM system_config WHERE key=?',row.key).value;
      if(JSON.parse(value).phase==='held-before-commit')assert.equal(f.db.sqlite.prepare('UPDATE system_config SET value=? WHERE key=? AND description=? AND value=?')
        .run(JSON.stringify({...JSON.parse(value),phase:'release-requested'}),row.key,row.description,value).changes,1);
    };
    const observe=()=>Object.fromEntries(Object.entries(recoveryImageObservations(f.fixture)).map(([k,s])=>[k,f.db.sqlite.prepare(s.sql).all(...s.params).map(r=>({...r}))]));
    const newerProbe={runId:p.runId,probeId:randomUUID(),mode:'before-release'},newerRow=imageStorageFaultRow(newerProbe);
    const newerPhase=()=>JSON.parse(f.row('SELECT value FROM system_config WHERE key=?',newerRow.key).value).phase;
    const releaseNew=()=>{
      const value=f.row('SELECT value FROM system_config WHERE key=?',newerRow.key)?.value;
      if(value && JSON.parse(value).phase==='held-before-commit')assert.equal(f.db.sqlite.prepare('UPDATE system_config SET value=? WHERE key=? AND description=? AND value=?')
        .run(JSON.stringify({...JSON.parse(value),phase:'release-requested'}),newerRow.key,newerRow.description,value).changes,1);
    };
    if(scenario.startsWith('new-owner')){
      f.db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(newerRow.key,newerRow.value,newerRow.description);
      f.db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)')
        .run(RECOVERY_FENCING_CONTROL_KEY,imageStorageFaultHeader(newerProbe),RECOVERY_FENCING_CONTROL_DESCRIPTION);
    }
    const nativeBatch=f.db.binding.batch.bind(f.db.binding),nativeClaims=[];
    const host=createUsageRecoveryHost(),hostTasks=[],hostContext={waitUntil(p){assert.equal(this,hostContext);hostTasks.push(p);p.catch(()=>undefined);}};
    let recovery,staleError;
    f.db.binding.batch=async statements=>{
      const receipt=statements.find(s=>s.sql?.startsWith('INSERT INTO request_usage_commit_receipts'));
      if(receipt){
        const revision=receipt.values[4];nativeClaims.push(revision);
        try{return await nativeBatch(statements);}catch(error){if(revision===1)staleError=error;throw error;}
      }
      return nativeBatch(statements);
    };
    try {
      const response=await f.request(operation,{},undefined,{[IMAGE_STORAGE_FAULT_HEADER]:imageStorageFaultHeader(p)});
      assert.equal(response.status,200);assert.equal((await response.json()).data[0].b64_json,'AQID');
      await until(()=>phase().phase==='held-before-commit');
      const first={...f.row('SELECT * FROM request_usage_recovery_jobs')};
      assert.equal(first.revision,1);assert.equal(first.attempts,1);assert.equal(first.lease_expires_at-first.updated_at,5);
      assert.equal((await f.recover()).claimed,0,'a live producer lease must exclude a competing consumer');
      assert.equal(nativeClaims.length,0,'old prepared batch is still held');

      if(scenario==='valid-owner'){
        releaseOld();await f.drain();assert.equal(phase().phase,'ack-returned');assert.equal(staleError,undefined);
      }else{
        f.advance(6); // Local DB clock only; a cloud experiment must wait for real D1 time.
        if(scenario.startsWith('new-owner')){
          recovery=host.run(withRecoveryFencingProbe(f.db.binding),hostSettings,hostContext).then(outcome=>{assert.equal(outcome.status,'finished');return outcome.result;});recovery.catch(()=>undefined);
          await until(()=>newerPhase()==='held-before-commit');
          const newer=f.row('SELECT * FROM request_usage_recovery_jobs');
          assert.equal(newer.state,'leased');assert.equal(newer.revision,2);assert.equal(newer.attempts,2);assert.notEqual(newer.lease_token,first.lease_token);
          assert.equal(newer.lease_expires_at-newer.updated_at,30);
          assert.equal(hostTasks.length,1);assert.equal(host.snapshot().active,true);assert.equal(host.snapshot().capacity.reservedBytes,67108864);
          assert.deepEqual(await host.run(f.db.binding,hostSettings,hostContext),{status:'busy'});
        }
        const beforeStale=observe();assert.equal(beforeStale.logs.length,0);assert.equal(beforeStale.receipts.length,0);
        releaseOld();await f.drain();
        assert.match(staleError?.message??'',/Settlement recovery lease invalid/);
        assert.equal(phase().phase,'stale-lease-rejected');
        assert.deepEqual(observe(),beforeStale,'stale batch and its failure handler must not change any financial projection or new lease');
        assert.equal(f.row('SELECT budget_spent_micros FROM users WHERE id=?',f.fixture.ids.user).budget_spent_micros,0);
        assert.equal(f.row('SELECT budget_reserved_micros FROM users WHERE id=?',f.fixture.ids.user).budget_reserved_micros,100000);
        if(scenario.startsWith('new-owner')){
          assert.deepEqual(nativeClaims,[1],'new native batch has not executed; adapter owns the real pause');
          injectNewAuditFailure=scenario==='new-owner-fail-retry';releaseNew();
          const result=await recovery;
          assert.deepEqual(nativeClaims,[1,2]);
          assert.equal(f.db.sqlite.prepare('DELETE FROM system_config WHERE key=? AND description=? AND value=?')
            .run(RECOVERY_FENCING_CONTROL_KEY,RECOVERY_FENCING_CONTROL_DESCRIPTION,imageStorageFaultHeader(newerProbe)).changes,1);
          if(scenario==='new-owner-fail-retry'){
            assert.equal(result.deferred,1);assert.equal(result.committed,0);
            const failed=observe(),job=failed.jobs[0];assert.equal(job.state,'pending');assert.equal(job.revision,3);assert.equal(job.attempts,2);
            assert.equal(job.available_at-job.updated_at,10);assert.equal(job.last_error,'execution_error');
            assert.deepEqual(failed.account,beforeStale.account);for(const key of ['logs','receipts','audit','attempts','stats','statsRaw'])assert.equal(failed[key].length,0,key);
            assert.equal((await f.recover()).claimed,0);f.advance(11);assert.equal((await f.recover()).committed,1);
          }else assert.equal(result.committed,1);
        }else assert.equal((await f.recover()).committed,1);
      }
      const final=observe(),retries=scenario==='valid-owner'?0:scenario==='new-owner-fail-retry'?2:1;
      assert.equal(final.jobs[0].state,'committed');assert.equal(final.jobs[0].revision,retries===0?2:retries===1?3:5);
      assert.equal(final.jobs[0].attempts,retries+1);assert.equal(final.receipts[0].lease_revision,retries===0?1:retries===1?2:4);
      assert.equal(final.logs.length,1);assert.equal(final.receipts.length,1);assert.equal(final.audit.length,1);assert.equal(final.attempts.length,1);
      assert.equal(final.account[0].budget_spent_micros,100000);assert.equal(final.account[0].budget_reserved_micros,0);
      assert.equal(final.logs[0].charged_cost,0.1);assert.equal(final.logs[0].upstream_attempt_count,1);assert.equal(final.stats[0].request_count,1);
      assert.equal(f.sends,1);assert.equal((await f.recover()).claimed,0);assert.deepEqual(observe(),final);
      if(scenario.startsWith('new-owner')){assert.equal(host.snapshot().active,false);assert.equal(host.snapshot().capacity.reservedBytes,0);}
    }finally{
      releaseNew();releaseOld();await recovery?.catch(()=>undefined);await Promise.allSettled(hostTasks);await f.drain();f.db.binding.batch=nativeBatch;
    }
  });
}
