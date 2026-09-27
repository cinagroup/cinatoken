import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readJsonc } from './prepare-proxy-staging.mjs';
import { recoveryExperimentConfig,recoveryFencingExperimentConfig,RECOVERY_EXPERIMENT_PROFILE as profile } from './prepare-staging-recovery-experiment.mjs';
const read=name=>readJsonc(fileURLToPath(new URL('../../'+name,import.meta.url)));
function inputs(){
  return [read('packages/proxy/scripts/staging/wrangler.usage-recovery.jsonc'),
    read('packages/proxy/scripts/staging/wrangler.usage-recovery-control.jsonc'),
    read('packages/proxy/wrangler.base.jsonc')];
}
test('fencing experiment changes only main and retains all existing isolation checks',()=>{
  const source=inputs(),before=JSON.stringify(source);
  const normal=recoveryExperimentConfig(...source,'unmeasured-staging-experiment');
  assert.deepEqual(recoveryFencingExperimentConfig(...source,'unmeasured-staging-experiment'),{...normal,main:'./usage-recovery-fencing-worker.ts'});
  assert.equal(JSON.stringify(source),before);
  for(const mutate of [a=>{a[0].workers_dev=true;},a=>{a[0].services=[];},a=>{a[0].d1_databases[0].database_id=a[2].d1_databases[0].database_id;}]){
    const args=inputs();mutate(args);assert.throws(()=>recoveryFencingExperimentConfig(...args,'unmeasured-staging-experiment'));
  }
});
test('experiment is explicit, detached, closed and only changes enablement and numeric allocation',()=>{
  const source=inputs(),before=JSON.stringify(source),config=recoveryExperimentConfig(...source,'unmeasured-staging-experiment');
  assert.equal(JSON.stringify(source),before);
  const expected=structuredClone(source[0]);Object.assign(expected.vars,{
    RECOVERY_ENABLED:'true',RECOVERY_RESERVED_BYTES:'67108864',RECOVERY_INSTANCE_BYTES:'67108864'});
  assert.deepEqual(config,expected);assert.equal(config.workers_dev,false);assert.equal(config.preview_urls,false);
  assert.deepEqual(config.routes,[]);assert.deepEqual(config.triggers.crons,[]);
  assert.equal(config.d1_databases.length,1);assert.equal(config.services,undefined);
  assert.equal(profile.runtimeMemoryMeasured,false);assert.equal(profile.productionDefault,false);assert.ok(Object.isFrozen(profile));
  config.d1_databases[0].database_id='mutated';assert.notEqual(source[0].d1_databases[0].database_id,'mutated');
});
for(const acknowledgement of [undefined,null,false,'','production','measured'])
  test('reject missing/wrong experimental acknowledgement '+String(acknowledgement),()=>{
    const args=inputs();
    assert.throws(()=>recoveryExperimentConfig(...args,acknowledgement),{name:'AssertionError',message:/Explicit experimental acknowledgement required/});
  });
for(const [name,mutate] of [
  ['production DB',args=>{args[0].d1_databases[0].database_id=args[2].d1_databases[0].database_id;}],
  ['public receiver',args=>{args[0].workers_dev=true;}],
  ['cron',args=>{args[0].triggers.crons=['* * * * *'];}],
  ['inherited service',args=>{args[0].services=[];}],
  ['enabled source',args=>{args[0].vars.RECOVERY_ENABLED='true';}],
  ['different item cap',args=>{args[0].vars.RECOVERY_MAX_ITEMS='50';}],
  ['different concurrency',args=>{args[0].vars.RECOVERY_CONCURRENCY='4';}],
  ['control enabled',args=>{args[1].vars.RECOVERY_CONTROL_ENABLED='true';}],
  ['control capability redirected',args=>{args[1].services[0].service='cinatoken-proxy';}],
  ['environment override',args=>{args[0].env={production:{}};}],
])test('reject source drift: '+name,()=>{
  const args=inputs();mutate(args);assert.throws(()=>recoveryExperimentConfig(...args,'unmeasured-staging-experiment'));
});
