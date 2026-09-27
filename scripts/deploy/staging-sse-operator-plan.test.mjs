import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {SSE_STAGING_SCOPE as g} from './staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as c} from './staging-sse-recovery-access.mjs';
import {validateSseOperatorPlan,withValidatedSseOperatorPlan} from './staging-sse-operator-plan.mjs';
const baseline={previousPublicHttp:356,firstRoundUsdCap:2};
function fixture(){const runId='c02-success-'+randomUUID();return {
  scope:{account:g.account,database:g.database,gateway:g.worker,controller:c.worker},version:randomUUID(),runId,
  keyHash:'sha256:'+'a'.repeat(64),expiresAt:'2026-09-08T01:00:00.000Z',tokenName:'cinatoken-sse-v202-'+randomUUID(),
  plans:['before-hold','after-hold'].map(mode=>({mode,snapshot:{runId,mode,probeId:randomUUID()},upstream:{runId,mode:'success',probeId:randomUUID()}})),
  budget:{...baseline,capReset:false,maxPublicHttp:32,maxRpc:2},
};}
test('Complete plan is validated and deeply frozen before callback',async()=>{
  const input=fixture();let calls=0;await withValidatedSseOperatorPlan(input,baseline,async plan=>{
    calls++;input.plans[0].snapshot.probeId='changed';input.tokenName='changed';
    assert.notEqual(plan.plans[0].snapshot.probeId,'changed');assert.notEqual(plan.tokenName,'changed');
    assert.throws(()=>plan.plans[0].snapshot.probeId='changed',TypeError);assert.throws(()=>plan.scope.database='production',TypeError);
  });assert.equal(calls,1);
});
for(const [name,mutate] of [
  ['wrong account',p=>p.scope.account='other'],['production database',p=>p.scope.database='f7588b56-e761-49fc-b944-4cd7d121fc21'],
  ['production gateway',p=>p.scope.gateway='cinatoken-proxy'],['other controller',p=>p.scope.controller='other'],
  ['invalid deployment',p=>p.version='unknown'],['invalid run',p=>p.runId='other'],
  ['invalid hash',p=>p.keyHash='sha256:bad'],['invalid expiry',p=>p.expiresAt='tomorrow'],
  ['invalid token',p=>p.tokenName='cinatoken-sse-v201-clock-'+randomUUID()],['missing token',p=>delete p.tokenName],
  ['missing case',p=>p.plans.pop()],['duplicate mode',p=>p.plans[1].mode=p.plans[0].mode],
  ['wrong snapshot run',p=>p.plans[0].snapshot.runId='c02-success-'+randomUUID()],
  ['wrong upstream run',p=>p.plans[0].upstream.runId='c02-success-'+randomUUID()],
  ['wrong upstream mode',p=>p.plans[0].upstream.mode='paid'],['wrong snapshot mode',p=>p.plans[0].snapshot.mode='after-hold'],
  ['duplicate probes',p=>p.plans[1].upstream.probeId=p.plans[0].snapshot.probeId],['bad probe UUID',p=>p.plans[0].snapshot.probeId='bad'],
  ['fabricated generation ID',p=>p.plans[0].id='gen-'+randomUUID()],
  ['reset cap',p=>p.budget.capReset=true],['increased cap',p=>p.budget.firstRoundUsdCap=3],
  ['reset cumulative HTTP',p=>p.budget.previousPublicHttp=0],['excess RPC',p=>p.budget.maxRpc=3],
  ['excess HTTP',p=>p.budget.maxPublicHttp=1000],['unexpected field',p=>p.secret='never-persist'],
])test('Malformed plan '+name+' reaches zero operation callbacks',async()=>{
  const p=fixture();mutate(p);let calls=0;await assert.rejects(withValidatedSseOperatorPlan(p,baseline,async()=>calls++));assert.equal(calls,0);
});
for(const b of [{},{previousPublicHttp:-1,firstRoundUsdCap:2},{previousPublicHttp:356,firstRoundUsdCap:3}])test('Invalid budget baseline fails closed '+JSON.stringify(b),()=>{
  assert.throws(()=>validateSseOperatorPlan(fixture(),b));
});
