import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadBaselineV402,renderInstallerV402,assertFinalCatalogV402,functionContractsV402,triggerContractsV402,
  TABLE_COLUMN_CONTRACTS_V402,TABLE_CONSTRAINT_CONTRACTS_V402,INDEX_CONTRACTS_V402,BASELINE_RAW_SHA256_V402,ACTIONS_SQL_V402,PUBLISHER_ROLE_V402,CONSUMER_ROLE_V402,
  captureCatalogV402} from './build-complete-text-platform-event-delivery-v402.mjs';

const owner='cinatoken_gateway_migrator';
const root=new URL('../../../',import.meta.url);
const baseline=await loadBaselineV402();
const generated=renderInstallerV402(baseline);
const compare=(a,b)=>a<b?-1:a>b?1:0;
const order=(a,key)=>a.sort((x,y)=>compare(key(x),key(y)));
const grant=(grantee,privilege)=>({grantee,grantor:owner,privilege,grantable:false});
function finalContract() {
  const c=structuredClone(baseline);
  c.functions=order([...c.functions,...functionContractsV402()],x=>x.signature);
  c.triggers=order([...c.triggers,...triggerContractsV402()],x=>x.table+'\0'+x.name);
  for(const [name,columns]of Object.entries(TABLE_COLUMN_CONTRACTS_V402))c.relations.push({name,owner,kind:'r',persistence:'p',
    rls:false,force_rls:false,rules:[],constraints:structuredClone(TABLE_CONSTRAINT_CONTRACTS_V402[name]),columns:structuredClone(columns),acl:['DELETE','INSERT','MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE'].map(x=>grant(owner,x))});
  c.delivery_indexes=structuredClone(INDEX_CONTRACTS_V402);
  order(c.relations,x=>x.name);
  for(const name of [PUBLISHER_ROLE_V402,CONSUMER_ROLE_V402])c.principals.push({name,login:true,super:false,config:null,inherit:false,
    bypass_rls:false,create_role:false,memberships:[],replication:false,public_create:false,create_database:false,database_create:false,connection_limit:-1});
  order(c.principals,x=>x.name);
  c.schemas.push({name:'cinatoken_platform_delivery',owner,acl:[grant(owner,'CREATE'),grant(owner,'USAGE')]});
  order(c.schemas,x=>x.name);
  const gateway=c.schemas.find(x=>x.name==='cinatoken_gateway');
  gateway.acl=order([...gateway.acl,grant(PUBLISHER_ROLE_V402,'USAGE'),grant(CONSUMER_ROLE_V402,'USAGE')],x=>x.grantee+'\0'+x.privilege);
  return c;
}

test('selected baseline is the independently recorded final v400/401 authority stack',async()=>{
  const raw=await readFile(new URL('scripts/db/cutover/fixtures/complete-text-platform-event-delivery-baseline-v402.json',root));
  assert.equal(createHash('sha256').update(raw).digest('hex'),BASELINE_RAW_SHA256_V402);
  assert.deepEqual([baseline.functions.length,baseline.relations.length,baseline.triggers.length,baseline.principals.length],[142,93,135,26]);
});
test('saved proposal equals deterministic source compilation',async()=>{
  assert.equal(await readFile(new URL('packages/core/migrations-proposals/postgres/complete-text-platform-event-delivery-v402.sql',root),'utf8'),generated);
  assert.match(generated,/reviewed_v402/u);
  assert.doesNotMatch(ACTIONS_SQL_V402,/ALTER\s+(?:TABLE|FUNCTION|ROLE)|CREATE OR REPLACE|DISABLE\s+TRIGGER|session_replication_role\s*(?:=|TO)/iu);
});
test('new authority is only the six ID/nonce APIs, with isolated role-specific EXECUTE',()=>{
  const functions=functionContractsV402();assert.equal(functions.length,11);
  const exposed=functions.filter(x=>x.signature.startsWith('cinatoken_gateway.'));assert.equal(exposed.length,6);
  assert.ok(functions.every(x=>x.security_definer&&x.config[0]==='search_path=pg_catalog, pg_temp'));
  assert.ok(functions.every(x=>x.acl.every(a=>[owner,PUBLISHER_ROLE_V402,CONSUMER_ROLE_V402].includes(a.grantee)&&!a.grantable)));
  assert.deepEqual(exposed.find(x=>x.signature.includes('consume_')).acl.map(x=>x.grantee),[CONSUMER_ROLE_V402,owner]);
  assert.deepEqual(exposed.find(x=>x.signature.includes('requeue_')).acl.map(x=>x.grantee),[owner]);
  assert.ok(exposed.every(x=>x.config.length===3));
  const revocation=ACTIONS_SQL_V402.match(/REVOKE ALL ON FUNCTION cinatoken_gateway\.scan_complete_text_platform_events_v402\([\s\S]*?FROM ([^;]+);/u)?.[1];
  for(const recipient of baseline.defaults.filter(x=>x.schema==='cinatoken_gateway'&&x.type==='f').flatMap(x=>x.acl.map(a=>a.grantee)))
    assert.ok(revocation?.split(',').map(x=>x.trim()).includes(recipient),'schema-default function recipient must be revoked: '+recipient);
});
test('all new mutation/deferred triggers remain confined to the five private relations',()=>{
  const triggers=triggerContractsV402();assert.equal(triggers.length,13);
  assert.ok(triggers.every(x=>x.table.startsWith('cinatoken_platform_delivery.')&&x.enabled==='O'));
  assert.deepEqual(triggers.filter(x=>x.constraint).map(x=>x.name).sort(),['jobs_v402_companion','projections_v402_companion','receipts_v402_companion']);
  assert.ok(triggers.filter(x=>x.constraint).every(x=>x.deferrable&&x.initially_deferred));
});
test('postflight audit preserves all inherited catalogs and checks new authority',()=>{
  assert.deepEqual(Object.values(assertFinalCatalogV402(finalContract(),baseline)).slice(0,4),[153,98,148,28]);
});
for(const [name,mutate]of Object.entries({
  functionBody:c=>{c.functions[0].body_md5='0'.repeat(32);},
  executeGrantor:c=>{c.functions[0].acl[0].grantor=PUBLISHER_ROLE_V402;},
  columnAcl:c=>{c.relations[0].columns[0].acl.push(grant(PUBLISHER_ROLE_V402,'SELECT'));},
  triggerBinding:c=>{c.triggers[0].function='pg_catalog.current_user()';},
  roleMembership:c=>{c.principals[0].memberships.push({role:'unsafe'});},
  databaseRoleConfig:c=>{c.principals[0].config=['search_path=public'];},
  schemaCreate:c=>{c.schemas[0].acl.push(grant(PUBLISHER_ROLE_V402,'CREATE'));},
  defaultAcl:c=>{c.defaults[0].acl.push(grant('PUBLIC','EXECUTE'));},
}))test('generator rejects inherited baseline drift: '+name,()=>{
  const c=structuredClone(baseline);mutate(c);assert.throws(()=>renderInstallerV402(c),/selected baseline catalog differs/u);
});
for(const [name,mutate]of Object.entries({
  inheritedBody:c=>{c.functions.find(x=>x.signature.includes('grant_complete_flat_text_attempt_v362')).body_md5='0'.repeat(32);},
  extraWrapper:c=>{c.functions.push({...c.functions[0],signature:'public.extra_wrapper()'});},
  newExecute:c=>{c.functions.find(x=>x.signature.includes('consume_complete_text_platform_event_v402')).acl.push(grant(PUBLISHER_ROLE_V402,'EXECUTE'));},
  newRawTable:c=>{c.relations.find(x=>x.name==='cinatoken_platform_delivery.receipts_v402').acl.push(grant(CONSUMER_ROLE_V402,'INSERT'));},
  disabledTrigger:c=>{c.triggers.find(x=>x.name==='jobs_v402_guard').enabled='D';},
  newPrincipal:c=>{c.principals.find(x=>x.name===CONSUMER_ROLE_V402).inherit=true;},
  privateSchemaCreate:c=>{c.schemas.find(x=>x.name==='cinatoken_platform_delivery').acl.push(grant(PUBLISHER_ROLE_V402,'CREATE'));},
  relaxedAttemptBound:c=>{c.relations.find(x=>x.name==='cinatoken_platform_delivery.jobs_v402').constraints.find(x=>x.name==='jobs_v402_attempt_count_check').definition='CHECK ((attempt_count >= 0))';},
  missingSourceForeignKey:c=>{const r=c.relations.find(x=>x.name==='cinatoken_platform_delivery.jobs_v402');r.constraints=r.constraints.filter(x=>x.type!=='f');},
  unvalidatedRestoreBound:c=>{c.relations.find(x=>x.name==='cinatoken_platform_delivery.restores_v402').constraints.find(x=>x.name==='restores_v402_restore_count_check').validated=false;},
  removedDueIndex:c=>{c.delivery_indexes.find(x=>x.table_name==='cinatoken_platform_delivery.jobs_v402').indexes=c.delivery_indexes.find(x=>x.table_name==='cinatoken_platform_delivery.jobs_v402').indexes.filter(x=>x.name!=='jobs_v402_due');},
  nonuniqueReceiptIndex:c=>{c.delivery_indexes.find(x=>x.table_name==='cinatoken_platform_delivery.receipts_v402').indexes[0].unique=false;},
}))test('independent final audit rejects authority or source drift: '+name,()=>{
  const c=finalContract();mutate(c);assert.throws(()=>assertFinalCatalogV402(c,baseline),/v402 .*differs/u);
});
test('bounded metadata capture uses one fresh transaction and requires a catalog',async()=>{
  let calls=0;const statements=[];
  assert.deepEqual(await captureCatalogV402({begin:async run=>{calls++;return run({unsafe:async text=>{
    statements.push(text);return statements.length===1?[]:[{catalog:baseline}];}});}}),baseline);
  assert.equal(calls,1);assert.equal(statements.length,2);
  await assert.rejects(()=>captureCatalogV402({begin:async run=>run({unsafe:async()=>[]})}),/catalog capture differs/u);
});

test('embedded PostgreSQL compiles every complete emitted installer gate before activation',async t=>{
  let moduleUrl;
  if(process.env.GATEWAY_PGLITE_MODULE)moduleUrl=pathToFileURL(resolve(process.env.GATEWAY_PGLITE_MODULE)).href;
  else {
    const local=new URL('.wrangler/staging/pg-schema-v250/package/dist/index.js',root);
    try {await readFile(local);moduleUrl=local.href;}
    catch(error){if(error.code!=='ENOENT')throw error;t.skip('Set GATEWAY_PGLITE_MODULE to a local PGlite ESM module for executable gate compilation');return;}
  }
  const {PGlite}=await import(moduleUrl);
  const db=await PGlite.create();
  try {
    await db.exec('CREATE SCHEMA cinatoken_gateway; CREATE TABLE cinatoken_gateway.schema_migrations(version text)');
    const blocks=[...generated.matchAll(/DO \$(preflight402|postflight402)\$[\s\S]*?\$\1\$;/gu)].map(x=>x[0]);
    assert.equal(blocks.length,2);
    for(const block of blocks)await assert.rejects(()=>db.exec(block),error=>
      error.code==='P0001'&&/^v402 (?:preflight|postflight) activation or PG73 differs$/u.test(error.message),
      'the complete DO must compile and reach the explicit inactive-actor gate');
    const malformed=blocks[1].replace("NOT LIKE 'cinatoken_platform_delivery.%'));",
      "NOT LIKE 'cinatoken_platform_delivery.%')));");
    assert.notEqual(malformed,blocks[1]);
    await assert.rejects(()=>db.exec(malformed),error=>error.code==='42601',
      'the compiler must detect the original extra-parenthesis regression');
  }finally{await db.close();}
});
