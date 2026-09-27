import assert from 'node:assert/strict';
import test from 'node:test';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {createByokKeysRepository}=await import(process.env.GATEWAY_BYOK_SLOTS_BASELINE
  ?pathToFileURL(resolve(process.env.GATEWAY_BYOK_SLOTS_BASELINE)).href:new URL('./byok-keys.ts',import.meta.url).href);

// SQL/driver contract only. A real MySQL 8 engine and concurrent sessions are
// still required; the mock does not parse JSON_TABLE or prove engine rollback.
const account={accountType:'personal',personalOwnerUserId:'user',organizationId:null};
const management={...account,keyId:'management',createdByUserId:'user'};
const portal={...account,principalType:'portal_user',userId:'user',workspaceId:'workspace'};
const input={workspaceId:'workspace',provider:'fixture',name:'New',apiKey:'enc:v2:synthetic-fixture',label:'label',disabled:false,isFallback:true,alwaysUseForProvider:false,alwaysUseForMatchingModels:false,allowedModels:null,allowedUserIds:null,allowedApiKeyHashes:null};
function fixture(slots,failAt=0,authorized=true){
  const calls=[],lifecycle=[];let writes=0;
  const connection={
    async beginTransaction(){lifecycle.push('begin');},async commit(){lifecycle.push('commit');},async rollback(){lifecycle.push('rollback');},release(){lifecycle.push('release');},
    async query(sql,values){
      assert.equal((sql.match(/\?/g)??[]).length,values.length);calls.push({sql,values});
      if(sql.startsWith('SELECT workspace.id'))return [authorized?[{id:'workspace'}]:[],[]];
      assert.match(sql,/SELECT id, sort_order FROM byok_keys\s+WHERE workspace_id = \? AND provider = \? AND deleted_at IS NULL\s+ORDER BY sort_order, id LIMIT 101 FOR UPDATE/);
      assert.deepEqual(values,['workspace','fixture']);return [slots.map(n=>({id:'slot-'+(99-n),sort_order:n})),[]];
    },
    async execute(sql,values){assert.equal((sql.match(/\?/g)??[]).length,values.length);calls.push({sql,values});if(++writes===failAt)throw new Error('synthetic failure '+failAt);return [{affectedRows:sql.startsWith('UPDATE')?slots.length:1},[]];},
  };
  const raw={async getConnection(){return connection;},async query(sql,values){
    assert.match(sql,/SELECT byok.id/);assert.deepEqual(values,['new','user']);
    return [[{id:'new',workspace_id:'workspace',provider:'fixture',name:'New',label:'label',disabled:0,is_fallback:1,always_use_for_provider:0,always_use_for_matching_models:0,sort_order:slots.length,allowed_models_json:null,allowed_user_ids_json:null,allowed_api_key_hashes_json:null,created_by_management_key_id:'management',created_at:'2026-09-16 00:00:00',updated_at:'2026-09-16 00:00:00'}],[]];
  }};
  return {calls,lifecycle,insert:principal=>createByokKeysRepository({driver:'mysql',raw}).insertForManagement({principal,id:'new',nowIso:'2026-09-16T00:00:00.000Z',input})};
}
for(const [actor,principal]of [['management',management],['portal',portal]]){
  for(const slots of [[],[0,12,48],[99],Array.from({length:99},(_,i)=>i+1),[0,40,99]])test(actor+': MySQL append SQL for '+slots.length+' live rows / tail '+slots.at(-1),async()=>{
    const f=fixture(slots);await f.insert(principal);assert.deepEqual(f.lifecycle,['begin','commit','release']);
    assert.match(f.calls[0].sql,/FOR UPDATE/);assert.match(f.calls[0].sql,actor==='portal'?/JOIN users portal_user/:/JOIN management_api_keys management_key/);
    assert.deepEqual(f.calls[0].values,actor==='portal'?['user','workspace','user']:['management','management','personal','user',null,'workspace','user']);
    const updates=f.calls.filter(c=>c.sql.startsWith('UPDATE')),compact=slots.at(-1)===99;
    assert.equal(updates.length,compact?3:0);assert.equal(f.calls.length,compact?7:4);
    if(compact){
      const mapping=JSON.parse(updates[0].values[0]);assert.deepEqual(mapping.map(x=>[x.id,x.sort_order]),slots.map((n,i)=>['slot-'+(99-n),i]));assert.equal(new Set(mapping.map(x=>x.temporary_provider)).size,slots.length);
      for(const m of mapping){assert.deepEqual(Object.keys(m).sort(),['id','sort_order','temporary_provider']);assert.match(m.temporary_provider,/^cinatoken-compact-[a-f0-9]{32}-\d{1,2}$/);}
      for(const c of updates){assert.match(c.sql,/JOIN JSON_TABLE\(/);assert.match(c.sql,/byok.deleted_at IS NULL/);assert.doesNotMatch(c.sql,/updated_at|api_key|is_fallback|allowed_|always_use/);assert.equal(c.values[0],updates[0].values[0]);}
      assert.deepEqual(updates.map(x=>x.values.slice(1)),[['workspace','fixture'],['workspace'],['fixture','workspace']]);
    }
    const write=f.calls.find(c=>c.sql.startsWith('INSERT INTO byok_keys'));assert.equal(write.values[10],compact?slots.length:(slots.at(-1)??-1)+1);assert.equal(write.values[4],input.apiKey);assert.doesNotMatch(write.sql,/MAX\(/);
    const audit=f.calls.at(-1);assert.match(audit.sql,/INSERT INTO user_audit_logs/);assert.ok(!JSON.stringify(audit.values).includes(input.apiKey));
  });
  for(const step of [1,2,3,4,5])test(actor+': MySQL write '+step+' failure rolls back and releases without commit',async()=>{
    const f=fixture([1,50,99],step);await assert.rejects(f.insert(principal),new RegExp('synthetic failure '+step));assert.deepEqual(f.lifecycle,['begin','rollback','release']);assert.equal(f.calls.length,2+step);
  });
  test(actor+': MySQL full capacity is rejected before compaction',async()=>{
    const f=fixture(Array.from({length:100},(_,i)=>i));await assert.rejects(f.insert(principal),/key limit reached/);assert.deepEqual(f.lifecycle,['begin','rollback','release']);assert.equal(f.calls.length,2);
  });
  test(actor+': MySQL unauthorized actor cannot lock slots or write',async()=>{
    const f=fixture([99],0,false);assert.equal(await f.insert(principal),null);assert.deepEqual(f.lifecycle,['begin','rollback','release']);assert.equal(f.calls.length,1);
  });
}

for(const p of [management,{...management,accountType:'organization',personalOwnerUserId:null,organizationId:'org'}])for(const operation of ['insert','update','delete','reorder'])test('MySQL '+p.accountType+' '+operation+' binds JOIN and predicate management IDs independently',async()=>{
  const calls=[],lifecycle=[];
  const metadata={id:'existing',workspace_id:'workspace',provider:'fixture',name:'Old',label:'label',disabled:0,is_fallback:0,always_use_for_provider:0,always_use_for_matching_models:0,sort_order:0,allowed_models_json:null,allowed_user_ids_json:null,allowed_api_key_hashes_json:null,created_by_management_key_id:'management',created_at:'2026-09-16 00:00:00',updated_at:'2026-09-16 00:00:00'};
  const connection={async beginTransaction(){lifecycle.push('begin');},async commit(){lifecycle.push('commit');},async rollback(){lifecycle.push('rollback');},release(){lifecycle.push('release');},
    async query(sql,values){assert.equal((sql.match(/\?/g)??[]).length,values.length);calls.push({sql,values});return [sql.startsWith('SELECT workspace.id')?[{id:'workspace'}]:[metadata],[]];},
    async execute(sql,values){assert.equal((sql.match(/\?/g)??[]).length,values.length);calls.push({sql,values});return [{affectedRows:1},[]];},
  };
  const byok=createByokKeysRepository({driver:'mysql',raw:{async getConnection(){return connection;},async query(){return [[metadata],[]];}}});
  const params={principal:p,id:'existing',nowIso:'2026-09-16T00:00:00.000Z'};
  if(operation==='insert')await byok.insertForManagement({...params,input});
  if(operation==='update')await byok.updateForManagement({...params,patch:{name:'New'}});
  if(operation==='delete')assert.equal(await byok.deleteForManagement(params),true);
  if(operation==='reorder')assert.equal(await byok.reorderForManagement({...params,input:{workspaceId:'workspace',provider:'fixture',keys:[{id:'existing',isFallback:false}]}}),'updated');
  const owner=p.personalOwnerUserId??p.organizationId,key=[p.keyId,p.accountType,p.personalOwnerUserId,p.organizationId];
  assert.deepEqual(calls[0].values,['insert','reorder'].includes(operation)?[p.keyId,...key,'workspace',owner]:[p.keyId,'existing',...key,owner]);
  assert.match(calls[0].sql,/JOIN management_api_keys management_key ON management_key.id = \?/);
  assert.match(calls[0].sql,/WHERE[\s\S]*management_key.id = \?/);assert.deepEqual(lifecycle,['begin','commit','release']);
});
