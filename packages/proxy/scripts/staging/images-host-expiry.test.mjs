import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createSqliteD1 } from '../../src/test-support/sqlite-d1.ts';
import { withImageStorageFault, IMAGE_WAIT_UNTIL_EXPIRY_MS } from './images-storage-fault.ts';
import { imageStorageFaultRow, imageStorageFaultHeader, IMAGE_STORAGE_FAULT_HEADER } from './images-storage-fault-contract.ts';
import { createImagesHostExpiryGateway } from './images-host-expiry-handler.ts';
import { createImagesStagingGateway } from './images-gateway-handler.ts';
import { imagesHostExpiryStagingConfig } from '../../../../scripts/deploy/prepare-staging-host-expiry.mjs';
import { imagesStagingConfig } from '../../../../scripts/deploy/prepare-proxy-staging-images.mjs';
import { readJsonc } from '../../../../scripts/deploy/prepare-proxy-staging.mjs';
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};

for(const mode of ['before-release','after-release'])for(const condition of ['armed','unarmed','other-tenant','changed-owner','release-during-hold','owner-changed-during-hold'])test(mode+' fixed host expiry / '+condition,async t=>{
  const db=createSqliteD1({}, {applyMigrations:false});
  db.sqlite.exec('CREATE TABLE system_config(key TEXT PRIMARY KEY,value TEXT,description TEXT,updated_at TEXT); CREATE TABLE api_key_request_logs(id TEXT PRIMARY KEY,user_id TEXT,api_key_id TEXT,workspace_id TEXT,status TEXT)');
  const probe={runId:'c02-success-'+randomUUID(),probeId:randomUUID(),mode},row=imageStorageFaultRow(probe);
  let aborts=0,pending;
  const read=()=>JSON.parse(db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(row.key)?.value??'null');
  const count=()=>db.sqlite.prepare('SELECT COUNT(*) AS n FROM api_key_request_logs').get().n;
  t.mock.timers.enable({apis:['setTimeout']});
  try {
    if(condition!=='unarmed')db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(row.key,row.value,condition==='changed-owner'?'other':row.description);
    const wrapped=withImageStorageFault(db.binding,probe,{waitUntilExpiry:true,abortContext:{abort(){aborts++;throw Error('Native abort forbidden for expiry test');}}});
    const tenant=condition==='other-tenant'?'other-tenant':probe.runId;
    const statement=()=>wrapped.prepare('INSERT INTO api_key_request_logs (id, user_id, api_key_id, workspace_id,status) VALUES(?,?,?,?,?)').bind('gen-'+randomUUID(),tenant+'-user',tenant+'-key',tenant+'-workspace','success');
    pending=wrapped.batch([statement()]);pending.catch(()=>{});
    if(condition==='unarmed'||condition==='changed-owner'){
      await assert.rejects(pending,/NOT_ARMED_OR_OWNERSHIP_CHANGED/);assert.equal(count(),0);
    }else if(condition==='other-tenant'){
      await pending;assert.equal(count(),1);assert.equal(read().phase,'armed');
    }else{
      await flush();
      assert.equal(read().phase,'awaiting-host-expiry-'+(mode==='before-release'?'before':'after')+'-commit');
      assert.equal(count(),mode==='before-release'?0:1);let settled=false;pending.finally(()=>{settled=true;}).catch(()=>{});
      assert.equal(IMAGE_WAIT_UNTIL_EXPIRY_MS,45000);
      t.mock.timers.tick(44999);await flush();assert.equal(settled,false,'fixed pause cannot finish before its timer');
      if(condition==='release-during-hold')db.sqlite.prepare('UPDATE system_config SET value=? WHERE key=?').run(JSON.stringify({...read(),phase:'release-requested'}),row.key);
      if(condition==='owner-changed-during-hold')db.sqlite.prepare('UPDATE system_config SET description=? WHERE key=?').run('other',row.key);
      t.mock.timers.tick(1);
      await assert.rejects(pending,condition==='armed'?/HOST_EXPIRY_NOT_OBSERVED/:/NOT_ARMED_OR_OWNERSHIP_CHANGED/);
      if(condition==='armed')assert.equal(read().phase,'host-expiry-not-observed');
      assert.equal(count(),mode==='before-release'?0:1,'fallback must not commit a previously held batch');
      // Request-owned facade is one-shot; a new facade cannot reclaim the durable marker.
      await wrapped.batch([statement()]);assert.equal(count(),mode==='before-release'?1:2);
      const replay=withImageStorageFault(db.binding,probe,{waitUntilExpiry:true});
      await assert.rejects(replay.batch([replay.prepare('INSERT INTO api_key_request_logs (id, user_id, api_key_id, workspace_id,status) VALUES(?,?,?,?,?)').bind('gen-'+randomUUID(),tenant+'-user',tenant+'-key',tenant+'-workspace','success')]),/NOT_ARMED_OR_OWNERSHIP_CHANGED/);
    }
    assert.equal(aborts,0);
  }finally{t.mock.timers.tick(45000);await pending?.catch(()=>{});db.sqlite.close();}
});

test('host expiry profile is fixed server-side and rejects incompatible modes/configuration',async()=>{
  const transport=async()=>{throw Error('No upstream call expected');};
  for(const options of [{storageFaultProfile:'arbitrary'},{storageFaultProfile:'wait-until-expiry'},{storageFaultProfile:'wait-until-expiry',imageUsageRecovery:{settlementLeaseSeconds:30}}])assert.throws(()=>createImagesStagingGateway(transport,options),/host expiry profile/);
  const db=createSqliteD1({}, {applyMigrations:false});
  try {
    for(const mode of ['before-abort','after-abort','before-fence','before-fail','after-fail'])assert.throws(()=>withImageStorageFault(db.binding,{runId:'c02-success-'+randomUUID(),probeId:randomUUID(),mode},{waitUntilExpiry:true}),/expiry profile/);
    assert.throws(()=>withImageStorageFault(db.binding,{runId:'c02-success-'+randomUUID(),probeId:randomUUID(),mode:'before-release'},{waitUntilExpiry:45000}),/expiry profile/);
    const handler=createImagesHostExpiryGateway(transport),env={DB:db.binding,DATABASE_DRIVER:'d1'};
    for(const [mode,path,method] of [['before-abort','/v1/images/generations','POST'],['before-release','/health','POST'],['after-release','/v1/images/edits','GET']]){
      const response=await handler.fetch(new Request('https://example.invalid'+path,{method,headers:{[IMAGE_STORAGE_FAULT_HEADER]:imageStorageFaultHeader({runId:'c02-success-'+randomUUID(),probeId:randomUUID(),mode})}}),env,{});
      assert.equal(response.status,400);assert.equal(await response.text(),'Invalid staging host expiry probe');
    }
  }finally{db.sqlite.close();}
});

test('host expiry config only changes explicit main; closed staging isolation remains mandatory',()=>{
  const staging=readJsonc('packages/proxy/wrangler.staging.base.jsonc'),production=readJsonc('packages/proxy/wrangler.base.jsonc');
  const original=imagesStagingConfig(staging,production),candidate=imagesHostExpiryStagingConfig(staging,production);
  assert.equal(candidate.main,'scripts/staging/images-host-expiry-gateway.ts');assert.deepEqual({...candidate,main:original.main},original);
  assert.equal(candidate.workers_dev,false);assert.equal(candidate.preview_urls,false);assert.deepEqual(candidate.routes,[]);
  assert.throws(()=>imagesHostExpiryStagingConfig({...staging,name:production.name},production));
});
