import assert from 'node:assert/strict';
import {SSE_STAGING_SCOPE} from './staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE} from './staging-sse-recovery-access.mjs';

const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const uuidPattern=new RegExp(`^${uuid}$`);
export function assertSseAccessJournal(journal){
  assert.ok(journal&&typeof journal==='object');
  assert.match(journal.runId,new RegExp(`^c02-success-${uuid}$`));
  if(journal.tokenName!==undefined)assert.match(journal.tokenName,new RegExp(`^cinatoken-sse-v[0-9]+-${uuid}$`));
  if(journal.tokenId!==undefined){assert.match(journal.tokenId,uuidPattern);assert.ok(journal.tokenName);}
  // Do not inspect inference metadata here: an uncertain request must not block ingress closure.
}
const freeze=value=>{if(value&&typeof value==='object'){for(const v of Object.values(value))freeze(v);Object.freeze(value);}return value;};
const exact=(value,keys)=>assert.deepEqual(Object.keys(value).sort(),keys.slice().sort());

/** Pure pre-write contract. This does NOT replace live billing, binding, Access and schema checks.
 * A plan contains probes, not fabricated server-assigned generation IDs or inference ACKs.
 */
export function validateSseOperatorPlan(input,{previousPublicHttp,firstRoundUsdCap}={}){
  const plan=structuredClone(input);
  exact(plan,['scope','version','runId','keyHash','expiresAt','tokenName','plans','budget']);
  assertSseAccessJournal(plan);assert.equal(typeof plan.tokenName,'string');assert.match(plan.version,uuidPattern);
  assert.deepEqual(plan.scope,{account:SSE_STAGING_SCOPE.account,database:SSE_STAGING_SCOPE.database,
    gateway:SSE_STAGING_SCOPE.worker,controller:SSE_RECOVERY_ACCESS_SCOPE.worker});
  assert.match(plan.keyHash,/^sha256:[a-f0-9]{64}$/);
  assert.equal(typeof plan.expiresAt,'string');assert.equal(new Date(plan.expiresAt).toISOString(),plan.expiresAt);
  assert.ok(Number.isSafeInteger(previousPublicHttp)&&previousPublicHttp>=0);assert.equal(firstRoundUsdCap,2);
  assert.deepEqual(plan.budget,{firstRoundUsdCap,capReset:false,previousPublicHttp,maxPublicHttp:32,maxRpc:2});
  assert.ok(Array.isArray(plan.plans)&&plan.plans.length===2);
  const modes=new Set(),probes=new Set();
  for(const p of plan.plans){
    exact(p,['mode','snapshot','upstream']);assert.ok(['before-hold','after-hold'].includes(p.mode)&&!modes.has(p.mode));modes.add(p.mode);
    for(const [kind,mode] of [['snapshot',p.mode],['upstream','success']]){
      const probe=p[kind];exact(probe,['runId','mode','probeId']);assert.equal(probe.runId,plan.runId);assert.equal(probe.mode,mode);
      assert.match(probe.probeId,uuidPattern);assert.ok(!probes.has(probe.probeId));probes.add(probe.probeId);
    }
  }
  return freeze(plan);
}

/** No callback or external effect is reached for malformed plans. Call before creating a tail,
 * seeding data, creating a service token, or opening either fixed staging ingress.
 */
export async function withValidatedSseOperatorPlan(input,baseline,execute){
  assert.equal(typeof execute,'function');const plan=validateSseOperatorPlan(input,baseline);return execute(plan);
}
