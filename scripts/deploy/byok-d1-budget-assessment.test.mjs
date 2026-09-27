import assert from 'node:assert/strict';
import test from 'node:test';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import * as fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createByokD1Operator} from './byok-d1-operator.mjs';
import {byokD1DeploymentFingerprint} from './byok-d1-deployment.mjs';
import {inspectByokD1OperatorJournal} from './byok-d1-operator-journal.mjs';
import {SSE_STAGING_SCOPE as g} from './staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as c} from './staging-sse-recovery-access-v2.mjs';

const {priceByokD1UsageUpperBound: price, assessByokD1Budget: assess, BYOK_BUDGET_RATE_CARD: card} =
  await import(process.env.BYOK_D1_BUDGET_MODULE ? pathToFileURL(resolve(process.env.BYOK_D1_BUDGET_MODULE)).href : new URL('./byok-d1-budget-assessment.mjs', import.meta.url));
const sha = 'a'.repeat(64);
const zero = () => ({workersRequests:'0', workersCpuMs:'0', d1RowsRead:'0', d1RowsWritten:'0', d1StorageMicroGbMonths:'0'});
const direct = () => ({logsMicros:'0', modelsMicros:'0', kmsMicros:'0', otherCloudMicros:'0', newSubscriptionsMicros:'0'});
const phase = () => ({usage:zero(), directCosts:direct(), evidenceSha256:sha});
function input() {
  return {
    identity:{runId:'c02-byok-000000000286', candidateSha256:sha, priorManifestSha256:'b'.repeat(64), scopeSha256:'c'.repeat(64)},
    firstRoundUsdCap:2, capReset:false, currency:'USD',
    history:{carriedReserveMicros:'1200000', incurredUpperBoundMicros:'0', evidenceSha256:sha},
    outstanding:{entries:[], evidenceSha256:sha},
    phases:{execution:phase(), containment:phase(), retention:phase()},
  };
}
test('published rates, no free allowances, per-line upward rounding', () => {
  assert.deepEqual(price({workersRequests:'1000000',workersCpuMs:'1000000',d1RowsRead:'1000000',d1RowsWritten:'1000000',d1StorageMicroGbMonths:'1000000'}).costsMicros,
    {workersRequests:'300000',workersCpuMs:'20000',d1RowsRead:'1000',d1RowsWritten:'1000000',d1StorageMicroGbMonths:'750000'});
  assert.equal(price({workersRequests:'1',workersCpuMs:'1',d1RowsRead:'1',d1RowsWritten:'1',d1StorageMicroGbMonths:'1'}).totalMicros,'5');
  assert.equal(price(zero()).totalMicros,'0');
  assert.equal(card.includedAllowancesDeducted,false);
  assert.throws(() => { card.id = 'changed'; });
});
test('large integers are exact beyond Number precision', () => {
  assert.equal(price({...zero(), d1RowsWritten:'9007199254740993'}).totalMicros,'9007199254740993');
});
for (const invalid of [-1,0,0.1,NaN,Infinity,'-1','+1','01','1.0','1e6',' 1','1 ','','9'.repeat(25),null,undefined]) {
  test('reject non-canonical quantity '+String(invalid), () => assert.throws(() => price({...zero(),d1RowsRead:invalid})));
}
test('visible zero cannot release historical reserve or authorize execution', () => {
  const r=assess(input());
  assert.equal(r.totalRequiredMicros,'1200000');
  assert.equal(r.arithmeticUnallocatedMicros,'800000');
  assert.equal(r.result,'CALCULATED_REQUIRES_PROOF_AND_RESERVATION');
  for(const k of ['cumulativeBudgetReserved','fullPreflightPassed','reservationCreated','mayDeploy','costBoundsVerified','actualBalanceVerified']) assert.equal(r[k],false);
  assert.equal(r.proofObligations.length,5);
});
test('exact cap accepted arithmetically; one micro over rejected', () => {
  const p=input();p.phases.execution.directCosts.modelsMicros='800000';
  assert.equal(assess(p).arithmeticUnallocatedMicros,'0');
  p.phases.containment.directCosts.otherCloudMicros='1';
  assert.equal(assess(p).result,'OVER_BUDGET');assert.equal(assess(p).arithmeticUnallocatedMicros,null);
});
test('incurred costs above carried reserve increase hold', () => {
  const p=input();p.history.incurredUpperBoundMicros='1500000';
  p.phases.execution.directCosts.modelsMicros='600000';
  assert.equal(assess(p).totalRequiredMicros,'2100000');assert.equal(assess(p).arithmeticFits,false);
});
test('other reservations and all three phases count without netting', () => {
  const p=input();p.outstanding.entries=[{runId:'c02-byok-000000000287',reservedMicros:'200000',evidenceSha256:sha}];
  p.phases.execution.directCosts.modelsMicros='300000';
  p.phases.containment.directCosts.otherCloudMicros='200000';
  p.phases.retention.directCosts.otherCloudMicros='100001';
  assert.equal(assess(p).totalRequiredMicros,'2000001');assert.equal(assess(p).result,'OVER_BUDGET');
});
for(const name of ['execution','containment','retention']) {
  for(const group of ['usage','directCosts']) {
    for(const k of Object.keys(group==='usage'?zero():direct())) {
      test('unknown is not zero: '+name+'.'+group+'.'+k, () => {
        const p=input();p.phases[name][group][k]=null;const r=assess(p);
        assert.equal(r.result,'INCOMPLETE_BUDGET_INPUTS');assert.equal(r.totalRequiredMicros,null);
        assert.equal(r.arithmeticFits,null);assert.ok(r.missing.includes(name+'.'+group+'.'+k));
      });
    }
  }
}
test('unknown incurred history remains unknown even with 1.20 reserve', () => {
  const p=input();p.history.incurredUpperBoundMicros=null;
  assert.equal(assess(p).heldHistoryMicros,null);assert.equal(assess(p).arithmeticFits,null);
});
for(const target of ['history','outstanding','execution','containment','retention']) {
  test('missing proof reference is explicit: '+target, () => {
    const p=input();(p[target]??p.phases[target]).evidenceSha256=null;
    const r=assess(p);assert.equal(r.result,'INCOMPLETE_BUDGET_INPUTS');assert.ok(r.missing.includes(target+'.evidence'));
    assert.equal(r.costBoundsVerified,false);
  });
}
test('missing outstanding entry proof cannot be hidden by catalogue reference', () => {
  const p=input();p.outstanding.entries=[{runId:'c02-byok-000000000287',reservedMicros:'1',evidenceSha256:null}];
  assert.equal(assess(p).result,'INCOMPLETE_BUDGET_INPUTS');
});
for(const modify of [
  p=>p.firstRoundUsdCap=3, p=>p.capReset=true, p=>p.currency='CNY',
  p=>p.history.carriedReserveMicros='0', p=>p.history.carriedReserveMicros='1199999',
  p=>p.history.incurredUpperBoundMicros='-100', p=>p.phases.execution.directCosts.modelsMicros=-1,
  p=>delete p.phases.retention, p=>delete p.phases.execution.directCosts.logsMicros,
  p=>p.phases.execution.usage.workersRequests=undefined,
  p=>p.phases.execution.directCosts.refundMicros='1000000', p=>p.preflightPassed=true,
  p=>p.identity.scopeSha256='bad', p=>p.identity.runId='another-round',
  p=>p.history.evidenceSha256='forged', p=>p.phases.execution.evidenceSha256='',
  p=>p.outstanding.entries=[{runId:p.identity.runId,reservedMicros:'0',evidenceSha256:sha}],
  p=>p.outstanding.entries=Array(2).fill({runId:'c02-byok-000000000287',reservedMicros:'0',evidenceSha256:sha}),
  p=>p.outstanding.entries=Array(101).fill({runId:'c02-byok-000000000287',reservedMicros:'0',evidenceSha256:sha}),
]) {
  test('reject invalid budget contract '+modify.toString(), () => {const p=input();modify(p);assert.throws(()=>assess(p));});
}
test('result hashes bind quantities, complete identity and evidence; snapshots do not alias', () => {
  const p=input(),first=assess(p),second=assess(p);assert.deepEqual(first,second);
  p.identity.scopeSha256='d'.repeat(64);assert.notEqual(assess(p).evidenceSha256,first.evidenceSha256);
  assert.equal(first.identity.scopeSha256,'c'.repeat(64));
  second.identity.runId='changed';assert.equal(first.identity.runId,'c02-byok-000000000286');
  p.phases.execution.directCosts.logsMicros='1';assert.notEqual(assess(p).inputSha256,first.inputSha256);
});
test('post-response row limits and indefinite retention cannot be supplied as proof', () => {
  const p=input();p.phases.execution.usage.d1RowsRead=null;p.phases.retention.usage.d1StorageMicroGbMonths=null;
  p.history.incurredUpperBoundMicros=null;p.history.evidenceSha256=null;p.outstanding.evidenceSha256=null;
  const r=assess(p);assert.equal(r.result,'INCOMPLETE_BUDGET_INPUTS');assert.equal(r.totalRequiredMicros,null);
  assert.equal(r.cumulativeBudgetReserved,false);
});
for (const mode of ['fits', 'over-budget', 'incomplete']) {
  test('real operator rejects '+mode+' assessment before external requests', async () => {
    const digest = v => createHash('sha256').update(v).digest('hex');
    const jsonHash = v => digest(JSON.stringify(v));
    const installToken = 'c1'.repeat(32), settings = {bindings:[]};
    const roles = {receiver:'cinatoken-staging-usage-recovery',controller:c.worker,gateway:g.worker};
    const id = n => '00000000-0000-4000-8000-'+String(n).padStart(12,'0');
    const candidate = {
      runId:'c02-byok-000000000286',priorManifestSha256:'b'.repeat(64),
      // Expired public synthetic grant, never a live credential or permit.
      grant:{version:1,runId:'c02-byok-000000000286',tokenHash:digest(installToken),schemaSha256:'d'.repeat(64),
        fencedSchemaSha256:'e'.repeat(64),issuedAt:1,expiresAt:900},
      bundles:Object.fromEntries(Object.keys(roles).map(role=>{const code='export default {};';return [role,{code,sha256:digest(code)}];})),
      priorWorkers:Object.fromEntries(Object.keys(roles).map((role,i)=>[role,{settingsSha256:jsonHash(settings),versionId:id(i+1)}])),
    };
    const expected = {
      workers:[...Object.values(roles),'cinatoken-staging-images-upstream'].map((name,i)=>({name,settingsSha256:jsonHash(settings),versions:[{version_id:id(i+1),percentage:100}]})),
      production:['cinatoken-proxy','cinatoken-admin','cinatoken-chain-worker'].map(name=>({name,settingsSha256:'a'.repeat(64)})),
      access:[g,c].map(t=>({id:t.app,sha256:'a'.repeat(64)})),previousTokenIds:[],
    };
    const p=input();p.identity={runId:candidate.runId,candidateSha256:byokD1DeploymentFingerprint(candidate),
      priorManifestSha256:candidate.priorManifestSha256,scopeSha256:jsonHash(expected)};
    if(mode==='over-budget')p.phases.execution.directCosts.modelsMicros='800001';
    if(mode==='incomplete')p.history.incurredUpperBoundMicros=null;
    const proof=assess(p),workspace=fs.mkdtempSync(resolve(process.env.BYOK_OPERATOR_TEST_ROOT??'.wrangler/staging','budget-assessment-test-'));
    let external=0,readiness=0;
    const operator=createByokD1Operator({workspace,candidate,expected,apiToken:'synthetic-budget-test-credential',installToken,
      preflight:async()=>proof,assertReady:()=>{readiness++;return true;},fetchImpl:async()=>{external++;throw Error('must_not_call');},signal:undefined});
    const result=await operator.run();
    assert.equal(result.result,'ATTENTION_REQUIRED');assert.equal(result.failedPhase,'preflight');
    assert.equal(external,0);assert.equal(readiness,0);
    const journal=inspectByokD1OperatorJournal(resolve(workspace,'.wrangler/staging/byok-d1-execution-reservation/journal.jsonl'));
    assert.deepEqual(journal.attempts,{preflight:'FAILED_OR_UNCERTAIN'});
  });
}
