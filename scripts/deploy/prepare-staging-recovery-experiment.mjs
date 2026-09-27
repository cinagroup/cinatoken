/** Offline preparation only. Explicit hypothesis, NOT an accepted runtime memory profile. */
import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonc } from './prepare-proxy-staging.mjs';
import { assertRecoveryControlIsolation } from './validate-staging-usage-recovery.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const RECOVERY_EXPERIMENT_PROFILE=Object.freeze({
  id:'staging-recovery-single-consumer-v2',
  status:'EXPERIMENTAL_NOT_CAPACITY_ACCEPTANCE',
  maxItems:5,concurrency:1,leaseSeconds:30,runBudgetMs:5000,
  // Initial 32 MiB hypothesis was below dense-audit Node heap+external samples.
  // 64 MiB is the next test allocation, not a conversion of Node RSS to Workers memory.
  reservedBytesPerConsumer:64*1024*1024,instancePoolBytes:64*1024*1024,
  payloadLimitBytes:256*1024,schemaSqlLimitBytes:4096,schemaResultRowLimit:25,
  runtimeMemoryMeasured:false,productionDefault:false,
});
export function recoveryExperimentConfig(receiver,control,production,acknowledgement){
  assert.equal(acknowledgement,'unmeasured-staging-experiment','Explicit experimental acknowledgement required');
  assertRecoveryControlIsolation(control,receiver,production);
  const config=structuredClone(receiver),profile=RECOVERY_EXPERIMENT_PROFILE;
  config.vars.RECOVERY_ENABLED='true';
  config.vars.RECOVERY_RESERVED_BYTES=String(profile.reservedBytesPerConsumer);
  config.vars.RECOVERY_INSTANCE_BYTES=String(profile.instancePoolBytes);
  // Cardinality, lease and deadline retain the reviewed closed-source values.
  assert.equal(config.vars.RECOVERY_MAX_ITEMS,String(profile.maxItems));
  assert.equal(config.vars.RECOVERY_CONCURRENCY,String(profile.concurrency));
  assert.equal(config.vars.RECOVERY_LEASE_SECONDS,String(profile.leaseSeconds));
  assert.equal(config.vars.RECOVERY_RUN_BUDGET_MS,String(profile.runBudgetMs));
  return config;
}
/** Same closed DB-only experiment, with a separately reviewed bounded pause adapter. */
export function recoveryFencingExperimentConfig(receiver,control,production,acknowledgement){
  const config=recoveryExperimentConfig(receiver,control,production,acknowledgement);
  config.main='./usage-recovery-fencing-worker.ts';
  return config;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['--prepare-unmeasured-staging-experiment']);
  const config=recoveryExperimentConfig(
    readJsonc(resolve(root,'packages/proxy/scripts/staging/wrangler.usage-recovery.jsonc')),
    readJsonc(resolve(root,'packages/proxy/scripts/staging/wrangler.usage-recovery-control.jsonc')),
    readJsonc(resolve(root,'packages/proxy/wrangler.base.jsonc')),
    'unmeasured-staging-experiment');
  config.main=resolve(root,'packages/proxy/scripts/staging/usage-recovery-worker.ts');
  config.$schema=resolve(root,'node_modules/wrangler/config-schema.json');
  const directory=resolve(root,'.wrangler/staging/recovery-experiment-v2');
  mkdirSync(directory,{recursive:true});
  // First creation only: never overwrite a previously reviewed deployment artifact.
  writeFileSync(resolve(directory,'wrangler.jsonc'),JSON.stringify(config,null,2)+'\n',{flag:'wx'});
  writeFileSync(resolve(directory,'profile.json'),JSON.stringify(RECOVERY_EXPERIMENT_PROFILE,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({status:RECOVERY_EXPERIMENT_PROFILE.status,config:resolve(directory,'wrangler.jsonc'),
    publicIngress:false,deployed:false,remoteIdentityVerified:false,remoteSchemaVerified:false,
    warning:'64 MiB is a test allocation hypothesis, not a measured bound. Recheck cloud/schema/Access before deploy or invoke.'}));
}
