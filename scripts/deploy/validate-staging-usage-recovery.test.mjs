import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readJsonc } from './prepare-proxy-staging.mjs';
import { assertRecoveryStagingIsolation, assertRecoveryControlIsolation, RECOVERY_CONTROL_BINDING } from './validate-staging-usage-recovery.mjs';
const source=readJsonc(fileURLToPath(new URL('../../packages/proxy/scripts/staging/wrangler.usage-recovery.jsonc',import.meta.url)));
const production=readJsonc(fileURLToPath(new URL('../../packages/proxy/wrangler.base.jsonc',import.meta.url)));
const control=readJsonc(fileURLToPath(new URL('../../packages/proxy/scripts/staging/wrangler.usage-recovery-control.jsonc',import.meta.url)));
test('closed control has only exact named recovery capability and no identity simulation',()=>assertRecoveryControlIsolation(control,source,production));
for(const [name,change] of [
  ['worker',c=>c.name=production.name],['account',c=>c.account_id='other'],['main',c=>c.main='usage-recovery-worker.ts'],
  ['public',c=>c.workers_dev=true],['preview',c=>c.preview_urls=true],['route',c=>c.routes=['example.com/*']],
  ['cron',c=>c.triggers.crons=['* * * * *']],['queue',c=>c.queues={}],['database',c=>c.d1_databases=source.d1_databases],
  ['assets router',c=>c.assets={directory:'.'}],['fake runtime identity',c=>c.access={dev:{aud:'a'.repeat(64)}}],
  ['env override',c=>c.env={staging:{}}],['secret',c=>c.secrets={required:['MANAGEMENT_SECRET']}],
  ['enabled',c=>c.vars.RECOVERY_CONTROL_ENABLED='true'],['production env',c=>c.vars.RECOVERY_CONTROL_ENVIRONMENT='production'],
  ['unverified audience',c=>c.vars.RECOVERY_CONTROL_ACCESS_AUD='a'.repeat(64)],['inference credential',c=>c.vars.MODEL_API_KEY='synthetic'],
  ['wrong service',c=>c.services[0].service='production'],['default entrypoint',c=>delete c.services[0].entrypoint],
  ['wrong entrypoint',c=>c.services[0].entrypoint='default'],['remote',c=>c.services[0].remote=true],
  ['extra service',c=>c.services.push({...c.services[0],binding:'EXTRA'})],['arbitrary props',c=>c.services[0].props={tenant:'other'}],
  ['invocation URL logging',c=>c.observability.logs.invocation_logs=true],['missing closed flag',c=>delete c.preview_urls],
])test('reject unsafe recovery control configuration: '+name,()=>{
  const config=structuredClone(control);change(config);assert.throws(()=>assertRecoveryControlIsolation(config,source,production));
});
test('control validation also rejects an enabled receiver',()=>{
  const receiver=structuredClone(source);receiver.vars.RECOVERY_ENABLED='true';assert.throws(()=>assertRecoveryControlIsolation(control,receiver,production));
});
test('dedicated closed Worker has only the pinned staging D1 and no trigger credentials',()=>{
  assertRecoveryStagingIsolation(source,production);
  assert.deepEqual(RECOVERY_CONTROL_BINDING,{binding:'USAGE_RECOVERY',service:'cinatoken-staging-usage-recovery',entrypoint:'UsageRecovery',remote:false});
  assert.equal(Object.isFrozen(RECOVERY_CONTROL_BINDING),true);
});
for(const [name,change] of [
  ['production worker',c=>c.name=production.name],['account drift',c=>c.account_id='another-account'],
  ['public hostname',c=>c.workers_dev=true],['preview hostname',c=>c.preview_urls=true],
  ['custom route',c=>c.routes=['example.com/*']],['cron',c=>c.triggers.crons=['* * * * *']],
  ['queue',c=>c.queues={consumers:[{queue:'unapproved'}]}],['provider credential',c=>c.secrets={required:['OPENAI_API_KEY']}],
  ['outbound service',c=>c.services=[{binding:'PROVIDER',service:'production'}]],['alternate DB',c=>c.d1_databases[0].database_id='f7588b56-e761-49fc-b944-4cd7d121fc21'],
  ['production name with pinned ID',c=>c.d1_databases[0].database_name='production'],['remote local binding',c=>c.d1_databases[0].remote=true],
  ['extra DB',c=>c.d1_databases.push({...c.d1_databases[0],binding:'DB'})],['schema migration auto-wiring',c=>c.d1_databases[0].migrations_dir='../../../../packages/core/migrations-proposals/d1'],
  ['enable flag',c=>c.vars.RECOVERY_ENABLED='true'],['unmeasured profile',c=>c.vars.RECOVERY_RESERVED_BYTES='1024'],
  ['environment override',c=>c.env={production:{}}],['alternative entrypoint',c=>c.main='images-gateway.ts'],
  ['inherited crypto material',c=>c.vars.SHARED_KEY_ENCRYPTION_SECRET='synthetic-not-real'],['all fields removed',c=>delete c.workers_dev],
])test('reject unsafe recovery staging configuration: '+name,()=>{
  const config=structuredClone(source);change(config);assert.throws(()=>assertRecoveryStagingIsolation(config,production));
});
