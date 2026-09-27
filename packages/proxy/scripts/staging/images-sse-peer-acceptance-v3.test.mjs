import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {setupPeerAcceptanceV3} from './images-sse-peer-acceptance-v3-fixture.mjs';
import {assertSseCapacityPeerAcceptanceV3,assertSseCapacityPeerV3Sequence} from '../../../../scripts/deploy/staging-sse-capacity-peer-acceptance-v3.mjs';

for(const occupied of [false,true])for(const foreignFirst of [false,true])test(`V3 original client + actual SQLite recovery join (native locally modeled): occupied=${occupied}, foreignFirst=${foreignFirst}`,{timeout:15000},async t=>{
  const f=await setupPeerAcceptanceV3(t,{occupied,foreignFirst}),before=f.financial();
  const result=assertSseCapacityPeerAcceptanceV3(f.evidence);
  assert.equal(result.result,occupied?'OCCUPIED_AFTER_NATIVE_MARKER':'AFTER_HOLD_PEER_V3_EVIDENCE_PASS');
  assert.equal(result.samePoolIdleObserved,!occupied);assert.equal(result.financialEvidenceValidated,true);
  assert.equal(result.c02GatePassed,false);assert.equal(result.isolateEvictionProven,false);assert.equal(result.cleanupExecuted,false);
  assert.equal('statements' in result,false);assert.deepEqual(f.financial(),before);
  const logical=assertSseCapacityPeerV3Sequence(f.evidence.peerReport,f.evidence.primary);assert.equal(logical.nativeVerified,false);
  assert.deepEqual(assertSseCapacityPeerAcceptanceV3(JSON.parse(JSON.stringify(f.evidence))),result);
});

const changeJson=(row,change)=>{const value=JSON.parse(row.value);change(value);row.value=JSON.stringify(value);};
test('V3 joint acceptance rejects evidence splicing without DB mutations',{timeout:20000},async t=>{
  const f=await setupPeerAcceptanceV3(t,{foreignFirst:true}),before=f.financial();
  const changes=()=>dbChanges(f.db);
  const originalChanges=changes();
  const cases=[
    ['second inference',v=>v.journal.requests.push(structuredClone(v.journal.requests[0]))],
    ['wrong mode',v=>v.journal.requests[0].mode='before-hold'],
    ['foreign request',v=>v.primary.requestId='gen-'+randomUUID()],
    ['foreign original response',v=>v.journal.requests[0].id='gen-'+randomUUID()],
    ['non200 primary',v=>v.journal.requests[0].responseStatus=409],
    ['V2 primary profile',v=>v.primary.profile='c02-sse-peer-v2'],
    ['false pre-dispatch baseline',v=>v.primary.before='1/1024'],
    ['inconsistent primary copies',v=>v.peerReport.primary.requestId='gen-'+randomUUID()],
    ['primary from another clock',v=>v.primary.received.clockId=randomUUID()],
    ['invented header timestamp',v=>v.journal.requests[0].timing.headers.monoMs--],
    ['missing body completion',v=>delete v.journal.requests[0].timing.finished],
    ['changed original audit label',v=>v.journal.requests[0].finishedAt='2020-01-01T00:00:00.000Z'],
    ['unsealed report',v=>v.peerReport.stopped=false],
    ['failed observer',v=>v.peerReport.failed=true],
    ['explicit observer error',v=>v.peerReport.error='socket_closed'],
    ['pending journal',v=>v.peerReport.journalPending=true],
    ['unconfirmed journal',v=>v.peerReport.journalUnconfirmed=true],
    ['precomputed native proof',v=>v.peerReport.nativeVerified=true],
    ['precomputed acceptance',v=>v.peerReport.c02GatePassed=true],
    ['extra secret field',v=>v.peerReport.credentials='must not accept'],
    ['oversized report',v=>v.peerReport.extra='x'.repeat(16385)],
    ['wrong client protocol',v=>v.peerReport.profile='c02-sse-peer-client-v2'],
    ['missing upgrade',v=>v.peerReport.upgrades.pop()],
    ['ninth upgrade',v=>v.peerReport.upgradeAttempts=9],
    ['wrong attempt order',v=>v.peerReport.upgrades[0].attempt=2],
    ['unattempted upgrade',v=>delete v.peerReport.upgrades[0].dispatched],
    ['mismatch body incomplete',v=>v.peerReport.upgrades[0].rejectionComplete=false],
    ['mismatch hash changed',v=>v.peerReport.upgrades[0].rejectionSha256='0'.repeat(64)],
    ['mismatch byte count',v=>v.peerReport.upgrades[0].rejectionBytes--],
    ['authentication substituted for mismatch',v=>v.peerReport.upgrades[0].status=401],
    ['mismatch wrong peer',v=>v.peerReport.upgrades[0].peer=randomUUID()+':1'],
    ['mismatch EOF beyond bound',v=>v.peerReport.upgrades[0].finished.monoMs+=1002],
    ['matched upgrade unconfirmed',v=>delete v.peerReport.upgrades[1].openedAt],
    ['non101 matched upgrade',v=>v.peerReport.upgrades[1].status=200],
    ['matched status unknown',v=>v.peerReport.upgrades[1].result='PENDING'],
    ['open before upgrade response',v=>v.peerReport.upgrades[1].openedAt.monoMs--],
    ['foreign matched clock',v=>v.peerReport.upgrades[1].headersAt.clockId=randomUUID()],
    ['baseline before primary',v=>v.peerReport.records[0].started.monoMs=999],
    ['discovery window expired',v=>v.peerReport.records[0].finished.monoMs=21001],
    ['baseline names unobserved attempt',v=>v.peerReport.records[0].upgradeAttempt=1],
    ['V2 idle watch baseline',v=>{v.peerReport.records[0].sample.requests=0;v.peerReport.records[0].sample.reservedBytes=0;}],
    ['baseline gap',v=>v.peerReport.records[0].sample.sequence=2],
    ['missing phase',v=>v.peerReport.records.pop()],
    ['reordered stage',v=>v.peerReport.records[1].stage='post-native'],
    ['unconfirmed send',v=>delete v.peerReport.records[1].sendConfirmed],
    ['late send callback',v=>v.peerReport.records[1].sendConfirmed.monoMs+=6000],
    ['ACK before send',v=>v.peerReport.records[1].acknowledged.monoMs--],
    ['stale sample before ACK',v=>v.peerReport.records[1].received.monoMs--],
    ['wrong ACK marker',v=>v.peerReport.records[1].barrier.barrier=2],
    ['wrong sample marker',v=>v.peerReport.records[1].sample.barrier=0],
    ['sample sequence reused',v=>v.peerReport.records[2].sample.sequence=v.peerReport.records[1].sample.sequence],
    ['sample belongs to another instance',v=>v.peerReport.records[2].sample.instanceId=randomUUID()],
    ['sample belongs to another epoch',v=>v.peerReport.records[2].sample.watchEpoch=2],
    ['impossible reservation',v=>v.peerReport.records[2].sample.reservedBytes=1024],
    ['failed parser',v=>v.peerReport.parser.failed=true],
    ['parser ACK sample pending',v=>v.peerReport.parser.awaitingSample=true],
    ['parser sequence precedes stage',v=>v.peerReport.parser.sequence=1],
    ['parser frame count inconsistency',v=>v.peerReport.parser.frames++],
    ['parser unbounded bytes',v=>v.peerReport.parser.bytes=94209],
    ['fewer marker attempts',v=>v.peerReport.markerAttempts=2],
    ['sealed before last stage',v=>v.peerReport.endedAt.monoMs=34999],
    ['observer over lifetime',v=>v.peerReport.endedAt.monoMs=181002],
    ['held DB before baseline complete',v=>v.held.received.monoMs=1049],
    ['held DB after client cancel',v=>v.held.received.monoMs=1201],
    ['missing upstream DONE',v=>v.held.observation.upstream.events=v.held.observation.upstream.events.filter(e=>e.phase!=='done-enqueued')],
    ['upstream event order reversed',v=>v.held.observation.upstream.events.reverse()],
    ['foreign upstream probe',v=>v.held.observation.upstream.probeId=randomUUID()],
    ['snapshot bytes changed',v=>v.held.observation.snapshotRow.value+=' '],
    ['snapshot owner changed',v=>v.held.observation.snapshot.requestId='gen-'+randomUUID()],
    ['held job not pending',v=>v.held.observation.jobs[0].state='committed'],
    ['native rows already committed',v=>v.native.observation.jobs[0].state='committed'],
    ['native has a preexisting log',v=>v.native.observation.logs=[{id:v.primary.requestId}]],
    ['native upstream changed',v=>v.native.observation.upstream.events[0].at++],
    ['no native events',v=>v.native.platform.events=[]],
    ['two native events',v=>v.native.platform.events.push(structuredClone(v.native.platform.events[0]))],
    ['no original warning',v=>v.native.platform.events[0].waitUntilWarnings=[]],
    ['wrong deployed version',v=>v.native.platform.version=randomUUID()],
    ['missing original receipt',v=>v.native.platform.receipts=[]],
    ['native receipt clock splice',v=>v.native.platform.receipts[0].sample.clockId=randomUUID()],
    ['future native receipt',v=>v.native.platform.receipts[0].sample.monoMs=999999],
    ['native before tail receipt',v=>v.native.received.monoMs--],
    ['fake native boolean only',v=>v.native={nativeVerified:true}],
    ['abort not observed',v=>changeJson(v.native.cancelRow,x=>x.signalAborted=false)],
    ['abort snapshot replaced',v=>changeJson(v.native.cancelRow,x=>x.snapshotValue+=' ')],
    ['only one RPC',v=>v.recovery.calls.pop()],
    ['uncertain RPC',v=>v.recovery.calls[0].result='PENDING'],
    ['RPC before native marker',v=>v.recovery.calls[0].started.monoMs=32999],
    ['RPC over original bound',v=>v.recovery.calls[0].finished.monoMs+=30002],
    ['failed RPC',v=>v.recovery.calls[0].status=500],
    ['RPC permits replay',v=>v.recovery.calls[0].body.retry_safe=true],
    ['uncertain recovery outcome',v=>v.recovery.calls[0].body.result.uncertain=1],
    ['duplicate RPC receipt',v=>v.recovery.calls[1].body.runId=v.recovery.calls[0].body.runId],
    ['second RPC recharges',v=>v.recovery.calls[1].body.result.committed=1],
    ['unknown recovery field',v=>v.recovery.calls[0].body.result.extra=true],
    ['recovery marker before facts',v=>v.recovery.received.monoMs--],
    ['dedup facts differ',v=>v.recovery.afterDedup[4][0].charged_cost=0],
    ['both cost totals forged',v=>{v.recovery.afterRecovery[4][0].charged_cost=0;v.recovery.afterDedup[4][0].charged_cost=0;}],
    ['totals only instead of full ledger',v=>{v.recovery.afterRecovery=[[{charged_cost:.1}]];v.recovery.afterDedup=structuredClone(v.recovery.afterRecovery);}],
    ['lost recovery snapshot',v=>v.recovery.probeRows=[]],
    ['lost cancellation row',v=>v.recovery.cancelRows=[]],
    ['snapshot after recovery changed',v=>v.recovery.probeRows[0].value+=' '],
  ];
  for(const [label,change] of cases)await t.test(label,()=>{
    const evidence=structuredClone(f.evidence);change(evidence);assert.throws(()=>assertSseCapacityPeerAcceptanceV3(evidence));
    assert.equal(changes(),originalChanges);
  });
  assert.deepEqual(f.financial(),before);
});
function dbChanges(db){return db.sqlite.prepare('SELECT total_changes() AS n').get().n;}

test('logical occupancy cannot be erased by valid native and committed financial evidence',async t=>{
  const f=await setupPeerAcceptanceV3(t);
  for(const [stage,result] of [[1,'INCONCLUSIVE_HELD'],[2,'OCCUPIED_AFTER_NATIVE_MARKER'],[3,'OCCUPIED_AFTER_RECOVERY_MARKER']]){
    const e=structuredClone(f.evidence),sample=e.peerReport.records[stage].sample;
    sample.requests=stage===1?0:1;sample.reservedBytes=sample.requests*1024;
    const decision=assertSseCapacityPeerAcceptanceV3(e);assert.equal(decision.result,result);
    assert.equal(decision.samePoolIdleObserved,false);assert.equal(decision.c02GatePassed,false);assert.equal(decision.financialEvidenceValidated,true);
  }
});
