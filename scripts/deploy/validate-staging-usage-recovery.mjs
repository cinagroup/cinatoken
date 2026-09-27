/** Validate the closed local staging source; does not provision, enable or deploy. */
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonc, STAGING_ACCOUNT, STAGING_DATABASE } from './prepare-proxy-staging.mjs';

export const RECOVERY_WORKER = 'cinatoken-staging-usage-recovery';
export const RECOVERY_DATABASE_ID = '6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1';
// Only a separately protected control Worker may receive this capability.
// Do not add it to the public gateway, admin frontend or arbitrary tenant Workers.
export const RECOVERY_CONTROL_BINDING = Object.freeze({ binding:'USAGE_RECOVERY',service:RECOVERY_WORKER,entrypoint:'UsageRecovery',remote:false });
export const RECOVERY_CONTROL_WORKER = 'cinatoken-staging-recovery-control';
export function assertRecoveryControlIsolation(config, receiver, production) {
  assertRecoveryStagingIsolation(receiver, production);
  assert.deepEqual(Object.keys(config).sort(), ['$schema','name','account_id','main','compatibility_date','compatibility_flags',
    'send_metrics','workers_dev','preview_urls','routes','triggers','observability','vars','services'].sort());
  assert.equal(config.$schema, '../../../../node_modules/wrangler/config-schema.json');
  assert.equal(config.name, RECOVERY_CONTROL_WORKER); assert.notEqual(config.name, production.name); assert.notEqual(config.name, receiver.name);
  assert.equal(config.account_id, STAGING_ACCOUNT); assert.equal(config.main, 'usage-recovery-control-worker.ts');
  assert.equal(config.compatibility_date, '2026-09-07'); assert.deepEqual(config.compatibility_flags, ['nodejs_compat']);
  assert.equal(config.send_metrics, false); assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, false);
  assert.deepEqual(config.routes, []); assert.deepEqual(config.triggers, { crons: [] });
  assert.deepEqual(config.observability, { enabled:true,head_sampling_rate:1,logs:{invocation_logs:false} });
  assert.deepEqual(config.vars, { RECOVERY_CONTROL_ENVIRONMENT:'staging',RECOVERY_CONTROL_ENABLED:'false',RECOVERY_CONTROL_ACCESS_AUD:'' });
  assert.deepEqual(config.services, [RECOVERY_CONTROL_BINDING]);
  // No D1, assets router, access.dev simulation, secrets, env overrides or tenant-selected RPC.
  // This checks the closed SOURCE, not real Access policy, account IAM or service-binding deployment.
}
export function assertRecoveryStagingIsolation(config, production) {
  const allowed = ['$schema','name','account_id','main','compatibility_date','compatibility_flags','send_metrics',
    'workers_dev','preview_urls','routes','triggers','observability','vars','d1_databases'];
  assert.deepEqual(Object.keys(config).sort(),allowed.sort(),'Unapproved/missing recovery configuration field');
  assert.equal(config.$schema,'../../../../node_modules/wrangler/config-schema.json');
  assert.equal(config.name,RECOVERY_WORKER);assert.notEqual(config.name,production.name);
  assert.equal(config.account_id,STAGING_ACCOUNT);
  assert.equal(config.main,'usage-recovery-worker.ts');
  assert.equal(config.compatibility_date,'2026-09-07');assert.deepEqual(config.compatibility_flags,['nodejs_compat']);
  assert.equal(config.send_metrics,false);assert.equal(config.workers_dev,false);assert.equal(config.preview_urls,false);
  assert.deepEqual(config.routes,[]);assert.deepEqual(config.triggers,{crons:[]});
  assert.deepEqual(config.observability,{enabled:true,head_sampling_rate:1});
  assert.deepEqual(config.vars,{
    RECOVERY_ENVIRONMENT:'staging',RECOVERY_ENABLED:'false',RECOVERY_MAX_ITEMS:'5',RECOVERY_CONCURRENCY:'1',
    RECOVERY_LEASE_SECONDS:'30',RECOVERY_RUN_BUDGET_MS:'5000',RECOVERY_RESERVED_BYTES:'0',RECOVERY_INSTANCE_BYTES:'0',
  },'Closed source has no enabled or implicit memory profile');
  assert.deepEqual(config.d1_databases,[{binding:'RECOVERY_DB',database_name:STAGING_DATABASE,database_id:RECOVERY_DATABASE_ID,remote:false}]);
  for(const database of production.d1_databases??[]) {
    assert.notEqual(database.database_id,RECOVERY_DATABASE_ID);assert.notEqual(database.database_name,STAGING_DATABASE);
  }
  // This is a local config proof, not a fresh remote identity/IAM or schema check.
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length,2,'No enable, migration or deployment arguments accepted');
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
  assertRecoveryStagingIsolation(readJsonc(resolve(root,'packages/proxy/scripts/staging/wrangler.usage-recovery.jsonc')),
    readJsonc(resolve(root,'packages/proxy/wrangler.base.jsonc')));
  assertRecoveryControlIsolation(readJsonc(resolve(root,'packages/proxy/scripts/staging/wrangler.usage-recovery-control.jsonc')),
    readJsonc(resolve(root,'packages/proxy/scripts/staging/wrangler.usage-recovery.jsonc')), readJsonc(resolve(root,'packages/proxy/wrangler.base.jsonc')));
  console.log(JSON.stringify({status:'LOCAL_CLOSED_CONFIG_VALID',worker:RECOVERY_WORKER,enabled:false,publicIngress:false,
    databaseIdentity:'historical pinned ID; requires remote revalidation',deployed:false}));
}
