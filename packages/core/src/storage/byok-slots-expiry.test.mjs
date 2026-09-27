import assert from 'node:assert/strict';
import test from 'node:test';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createSlotD1Engine} from '../test-support/byok-slots-d1-engine.mjs';
const {createByokKeysRepository}=await import(process.env.GATEWAY_BYOK_SLOTS_BASELINE
  ?pathToFileURL(resolve(process.env.GATEWAY_BYOK_SLOTS_BASELINE)).href:new URL('./byok-keys.ts',import.meta.url).href);
const principal={keyId:'management',createdByUserId:'user',accountType:'personal',personalOwnerUserId:'user',organizationId:null};
const nowIso='2026-09-16T00:00:00.000Z';
const input={workspaceId:'workspace',provider:'fixture',name:'New',apiKey:'enc:v2:synthetic-fixture',label:'label',disabled:false,isFallback:false,alwaysUseForProvider:false,alwaysUseForMatchingModels:false,allowedModels:null,allowedUserIds:null,allowedApiKeyHashes:null};

// Real SQLite mutations with a synthetic SQL clock changing between batch
// statements. Not a Cloudflare clock, transport or multi-session simulation.
for(const operation of ['compact-create','plain-create','update','delete','reorder'])for(const expiry of ['first','after-first','audit'])test('D1 '+operation+': key expires '+expiry,async()=>{
  const f=createSlotD1Engine();let expired=expiry==='first';
  f.db.function('datetime',value=>{assert.equal(value,'now');return expired?'2026-09-16 00:00:02':'2026-09-16 00:00:00';});
  try{
    f.db.exec("UPDATE management_api_keys SET expires_at='2026-09-16 00:00:01'");
    const slots=operation==='compact-create'?[1,50,99]:[0,1];
    for(const n of slots)f.db.prepare("INSERT INTO byok_keys(id,workspace_id,provider,api_key_encrypted,label,sort_order,created_at,updated_at) VALUES(?,'workspace','fixture','enc:v2:synthetic-fixture','label',?,?,?)").run('slot-'+n,n,nowIso,nowIso);
    const snapshot=()=>JSON.stringify({keys:f.db.prepare('SELECT * FROM byok_keys ORDER BY id').all(),audit:f.db.prepare('SELECT * FROM user_audit_logs ORDER BY id').all()});
    const before=snapshot(),results=[];
    const raw={prepare:sql=>f.client.raw.prepare(sql),async batch(statements){
      f.db.exec('BEGIN IMMEDIATE');try{
        for(let i=0;i<statements.length;i++){
          if((expiry==='after-first'&&i===1)||(expiry==='audit'&&statements[i].sql.startsWith('INSERT INTO user_audit_logs')))expired=true;
          results.push(statements[i].run());
        }f.db.exec('COMMIT');return results;
      }catch(e){f.db.exec('ROLLBACK');throw e;}
    }};
    const repo=createByokKeysRepository({...f.client,raw}),params={principal,id:'slot-'+slots[0],nowIso};
    const returned=operation.endsWith('create')?await repo.insertForManagement({...params,id:'new',input})
      :operation==='update'?await repo.updateForManagement({...params,patch:{name:'Updated'}})
      :operation==='delete'?await repo.deleteForManagement(params)
      :await repo.reorderForManagement({principal,nowIso,input:{workspaceId:'workspace',provider:'fixture',keys:slots.slice().reverse().map(n=>({id:'slot-'+n,isFallback:false}))}});
    // A no-op compaction is not an authorization grant. Plain creation must
    // still reject if the key expired before its first actual insert.
    const accepted=expiry!=='first'&&!(operation==='plain-create'&&expiry==='after-first');
    if(!accepted){
      assert.equal(returned,operation==='delete'?false:operation==='reorder'?'not_found':null);
      assert.equal(snapshot(),before);assert.ok(results.every(x=>x.meta.changes===0));
    }else{
      assert.ok(returned);if(operation==='reorder')assert.equal(returned,'updated');
      assert.equal(f.db.prepare('SELECT count(*) n FROM user_audit_logs').get().n,1);
      assert.equal(results.at(-1).meta.changes,1);assert.equal(f.db.prepare("SELECT count(*) n FROM byok_keys WHERE provider LIKE 'cinatoken-%'").get().n,0);
      if(operation==='compact-create')assert.deepEqual(f.db.prepare('SELECT sort_order FROM byok_keys ORDER BY sort_order').all().map(x=>x.sort_order),[0,1,2,3]);
      if(operation.endsWith('create'))assert.equal(returned.id,'new');
    }
  }finally{f.db.close();}
});

test('D1 denied full-capacity create cannot audit an old ID with matching timestamps',async()=>{
  const f=createSlotD1Engine();try{
    for(let n=0;n<100;n++)f.db.prepare("INSERT INTO byok_keys(id,workspace_id,provider,api_key_encrypted,label,sort_order,created_by_management_key_id,created_at,updated_at) VALUES(?,'workspace','fixture','enc:v2:synthetic-fixture','label',?,'management',?,?)").run('slot-'+n,n,nowIso,nowIso);
    const repo=createByokKeysRepository(f.client);
    assert.equal(await repo.insertForManagement({principal,id:'slot-0',input,nowIso}),null);
    assert.equal(f.db.prepare('SELECT count(*) n FROM user_audit_logs').get().n,0);
  }finally{f.db.close();}
});
