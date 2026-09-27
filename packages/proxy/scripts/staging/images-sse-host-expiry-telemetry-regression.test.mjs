import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {setupExpiryCleanup} from './images-sse-host-expiry-cleanup-fixture.mjs';
import {reconcileHostExpirySseStagingRun,hostExpirySseCleanupNotBefore} from '../../../../scripts/deploy/staging-sse-host-expiry-telemetry-reconciliation.mjs';

for(const modelPlatform of [true,false])test('two-request mixed intent-only/committed run, modeled platform='+modelPlatform,{timeout:10000},async t=>{
  const f=await setupExpiryCleanup(t,'before-hold',{modelPlatform});await f.repeat('after-hold');
  assert.deepEqual(f.financial().map(rows=>rows.length),[2,1,1,1,1,2]);
  const result=await reconcileHostExpirySseStagingRun(f.options());
  assert.equal(result.unknownFixturesRemoved,1);assert.equal(result.committedFixturesRemoved,1);assert.equal(result.experimentPassed,modelPlatform);
  assert.equal(result.platformCancelled,modelPlatform?2:0);assert.equal(result.failedExperiments,modelPlatform?0:2);
  assert.deepEqual(f.counts(),f.baseline);assert.deepEqual(f.otherRows(),f.unrelated);assert.equal(f.sends,2);
});

for(const mode of ['before-hold','after-hold'])for(const profile of ['modeled-held','timer-survived','timer-no-cancel'])
test(`local cleanup contract ${mode} / ${profile}: preserve evidence, restore baseline`,{timeout:10000},async t=>{
  const f=await setupExpiryCleanup(t,mode,{modelPlatform:profile==='modeled-held',cancel:profile!=='timer-no-cancel'});
  const before=f.read(),r=await reconcileHostExpirySseStagingRun(f.options());
  assert.equal(r.fixtureRemoved,true);assert.equal(r.cancelObservationsRemoved,true);
  assert.equal(r.unknownFixturesRemoved,mode==='before-hold'?1:0);assert.equal(r.committedFixturesRemoved,mode==='after-hold'?1:0);
  assert.equal(r.experimentPassed,profile==='modeled-held');assert.equal(r.failedExperiments,profile==='modeled-held'?0:1);
  const evidence=f.saved.find(e=>e.step==='host-expiry-sse-facts-observed');
  assert.deepEqual(JSON.parse(evidence.snapshotProbes[0].value),before,'No phase normalization in persisted evidence');
  assert.equal(evidence.syntheticRemovalNotRefund,true);
  assert.deepEqual(f.counts(),f.baseline);assert.deepEqual(f.otherRows(),f.unrelated);assert.equal(f.sends,1);
  const deleting=f.batches.filter(b=>b.some(q=>q.sql.startsWith('DELETE FROM request_dispatch_intents')));
  assert.equal(deleting.length,1,'All financial/probe/owner deletions must share one batch');
  assert.equal(deleting[0].filter(q=>q.sql.startsWith('DELETE FROM system_config')&&String(q.params[0]).startsWith('c02_sse_cancel:')).length,1);
  assert.equal((await reconcileHostExpirySseStagingRun(f.options())).alreadyRemoved,true);
});

for(const fault of ['no-platform','wrong-version','cancel-missing','cancel-extra','held-changed','pending-job','wrong-amount','upstream-live','too-early','bad-journal'])
test('cleanup refuses incomplete/unsafe evidence: '+fault,{timeout:10000},async t=>{
  const f=await setupExpiryCleanup(t,'after-hold',{recover:fault!=='pending-job'}),options=f.options();
  if(fault==='pending-job'){
    assert.deepEqual(f.financial().map(rows=>rows.length),[1,1,1,0,0,1]);
    assert.equal(f.financial()[2][0].state,'pending');
  }
  if(fault==='no-platform')options.platform={events:[]};
  if(fault==='wrong-version')options.platform={...options.platform,version:randomUUID()};
  if(fault==='cancel-missing')f.db.sqlite.prepare('DELETE FROM system_config WHERE key=?').run('c02_sse_cancel:'+f.probe.probeId);
  if(fault==='cancel-extra')f.db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run('c02_sse_cancel:'+randomUUID(),'{}','c02-cancel:'+f.probe.runId);
  if(fault==='held-changed')f.db.sqlite.prepare('UPDATE system_config SET value=? WHERE key=?').run(JSON.stringify({...f.read(),phase:'release-requested'}),f.rowKey);
  if(fault==='wrong-amount')f.db.sqlite.prepare('UPDATE api_key_request_logs SET charged_cost=0.2 WHERE user_id=?').run(f.probe.runId+'-user');
  if(fault==='upstream-live'){
    const key='c02_images_sse_probe:'+f.journal.requests[0].upstreamProbeId,v=JSON.parse(f.db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(key).value);
    f.db.sqlite.prepare('UPDATE system_config SET value=? WHERE key=?').run(JSON.stringify({...v,phase:'started'}),key);
  }
  if(fault==='too-early')options.nowMs=hostExpirySseCleanupNotBefore(f.journal)-1;
  if(fault==='bad-journal')options.journal={...f.journal,requests:[{...f.journal.requests[0],id:'unknown'}]};
  const before=f.financial();await assert.rejects(reconcileHostExpirySseStagingRun(options));
  assert.deepEqual(f.financial(),before);assert.deepEqual(f.otherRows(),f.unrelated);
  assert.ok(f.apiCalls.some(c=>c.path.includes('/access/apps/')),'Closure checked before data validation');
});

for(const fault of ['save-fail','snapshot-drift','cancel-drift','log-drift','late-cancel','delete-fail','ack-loss'])
test('full native SQLite transaction fault: '+fault,{timeout:10000},async t=>{
  const f=await setupExpiryCleanup(t,'after-hold'),options=f.options(),before=f.financial();let hit=false;
  if(['save-fail','snapshot-drift','cancel-drift','log-drift','late-cancel'].includes(fault))options.persist=async e=>{
    if(e.step!=='host-expiry-sse-facts-observed')return;hit=true;
    if(fault==='save-fail')throw Error('Evidence save failed');
    if(fault==='snapshot-drift')f.db.sqlite.prepare('UPDATE system_config SET value=? WHERE key=?').run('{}',f.rowKey);
    if(fault==='cancel-drift')f.db.sqlite.prepare('UPDATE system_config SET value=? WHERE key=?').run('{}','c02_sse_cancel:'+f.probe.probeId);
    if(fault==='log-drift')f.db.sqlite.prepare('UPDATE api_key_request_logs SET error_message=? WHERE user_id=?').run('changed-non-pricing-field',f.probe.runId+'-user');
    if(fault==='late-cancel')f.db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run('c02_sse_cancel:'+randomUUID(),'{}','c02-cancel:'+f.probe.runId);
  };
  if(fault==='delete-fail')f.db.hooks.beforeStatement=(sql,values)=>{
    if(sql.startsWith('DELETE FROM system_config')&&String(values[0]).startsWith('c02_sse_cancel:')){hit=true;throw Error('Delete failed after financial deletes');}
  };
  if(fault==='ack-loss')f.db.hooks.afterBatch=sql=>{if(sql.some(q=>q.startsWith('DELETE FROM request_dispatch_intents'))){hit=true;throw Error('Delete ACK lost');}};
  await assert.rejects(reconcileHostExpirySseStagingRun(options));assert.equal(hit,true);
  if(fault==='ack-loss'){
    f.db.hooks.afterBatch=undefined;assert.deepEqual(f.counts(),f.baseline);
    assert.equal((await reconcileHostExpirySseStagingRun(f.options())).alreadyRemoved,true);
  }else{
    assert.deepEqual(f.financial().map(rows=>rows.length),before.map(rows=>rows.length));
    if(fault!=='log-drift')assert.deepEqual(f.financial(),before);
  }
  assert.deepEqual(f.otherRows(),f.unrelated);
});
