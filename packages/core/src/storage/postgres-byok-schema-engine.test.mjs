import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import {createByokEngine} from '../test-support/postgres-byok-engine.mjs';
import {gateway as g} from '../test-support/postgres-financial-engine.mjs';
import {personal,organization} from '../test-support/postgres-auth-engine.mjs';

// Local engine/constraints, not portal authentication, real KMS, wire/pooling,
// concurrent revoke/reorder or Workers resource acceptance.
test('BYOK lifecycle, runtime policies and user deletion use the gateway schema',async t=>{
  const f=await createByokEngine();t.after(()=>f.pg.close());
  const load=(path,file)=>import(process.env.GATEWAY_PG_BYOK_BASELINE_DIR?pathToFileURL(resolve(process.env.GATEWAY_PG_BYOK_BASELINE_DIR,file+'.js')).href:new URL(path,import.meta.url).href);
  const byok=(await load('./byok-keys.ts','byok-keys')).createByokKeysRepository(f.client);
  const users=(await load('../db/postgres/users.impl.ts','users.impl')).createPostgresUsersRepository(f.client);
  const p={...personal,keyId:'management',createdByUserId:'user'},o={...organization,keyId:'org-management',createdByUserId:'user'};
  const portal={...personal,principalType:'portal_user',userId:'user',workspaceId:'workspace'};
  const page={offset:0,limit:100},base={workspaceId:'workspace',provider:'fixture',name:'Created',apiKey:f.ciphertext,label:'label',disabled:false,isFallback:false,alwaysUseForProvider:false,alwaysUseForMatchingModels:false,allowedModels:null,allowedUserIds:null,allowedApiKeyHashes:null};
  const runtime={workspaceId:'workspace',provider:'fixture',modelId:'fixture/model',userId:'user',apiKeyHash:'a'.repeat(64)};
  const scalar=async sql=>Object.values((await f.rows(sql))[0])[0];
  const get=(id='byok-a',account=personal)=>byok.getByIdInAccount(id,account);
  const insert=(principal=p,id='created',input={})=>byok.insertForManagement({principal,id,input:{...base,...input},nowIso:f.now});
  const update=(patch={name:'Updated'},principal=p,id='byok-a')=>byok.updateForManagement({principal,id,patch,nowIso:f.now});
  const del=(principal=p,id='byok-a')=>byok.deleteForManagement({principal,id,nowIso:f.now});
  const reorder=(principal=p,keys=[{id:'byok-b',isFallback:false},{id:'byok-a',isFallback:true}],workspaceId='workspace')=>byok.reorderForManagement({principal,input:{workspaceId,provider:'fixture',keys},nowIso:f.now});
  const active=(patch={})=>byok.listActiveForRequest({...runtime,...patch});
  const suppress=(patch={})=>byok.shouldSuppressSharedCapacityForRequest({...runtime,...patch});
  const cases={
    async 'metadata listing and lookup isolate accounts and never return ciphertext'(){
      const own=await byok.listForAccount(personal,page);assert.equal(own.totalCount,2);assert.deepEqual(own.data.map(x=>x.id).sort(),['byok-a','byok-b']);assert.equal((await get()).name,'byok-a');assert.ok(!JSON.stringify(own).includes(f.ciphertext));assert.ok(!('api_key' in own.data[0]));
      assert.equal(await get('byok-other'),null);assert.equal(await get('byok-org'),null);assert.equal((await get('byok-org',organization)).id,'byok-org');
    },
    async 'metadata filters, pagination and archived workspace visibility'(){
      assert.equal((await byok.listForAccount(personal,{...page,provider:'missing'})).totalCount,0);
      assert.equal((await byok.listForAccount(personal,{...page,workspaceId:'other-workspace'})).totalCount,0);
      const one=await byok.listForAccount(personal,{offset:1,limit:1,workspaceId:'workspace',provider:'fixture'});assert.equal(one.totalCount,2);assert.equal(one.data.length,1);
      await f.pg.exec(`UPDATE ${g}.workspaces SET status='archived' WHERE id='workspace'`);assert.equal(await get(),null);assert.deepEqual(await active(),[]);
    },
    async 'management creation persists ciphertext and safe actor audit'(){
      const row=await insert();assert.equal(row.id,'created');assert.equal(row.sort_order,2);assert.equal(row.created_by_management_key_id,'management');assert.equal(await scalar(`SELECT api_key_encrypted FROM ${g}.byok_keys WHERE id='created'`),f.ciphertext);
      const audit=await f.rows(`SELECT actor_type,source,actor_id,change_payload FROM ${g}.user_audit_logs`);assert.equal(audit[0].source,'gateway_management_byok');assert.equal(audit[0].actor_id,'service:management_key:management');assert.ok(!JSON.stringify(audit).includes(f.ciphertext));assert.deepEqual(f.transactions,[{state:'committed'}]);
    },
    async 'organization management and trusted portal creation keep their actor contracts'(){
      assert.equal((await insert(o,'org-created',{workspaceId:'org-workspace'})).created_by_management_key_id,'org-management');assert.equal((await insert(portal,'portal-created')).created_by_management_key_id,null);
      assert.deepEqual(await f.rows(`SELECT actor_type,source,actor_id FROM ${g}.user_audit_logs WHERE source='gateway_portal_byok'`),[{actor_type:'user',source:'gateway_portal_byok',actor_id:'portal:user'}]);
    },
    async 'rotation and allowlist updates preserve ciphertext-only storage and metadata projection'(){
      const row=await update({name:null,apiKey:f.rotated,label:'new-label',disabled:true,allowedModels:['fixture/model'],allowedUserIds:['user'],allowedApiKeyHashes:['a'.repeat(64)]});assert.equal(row.name,null);assert.equal(row.disabled,true);assert.deepEqual(row.allowed_models,['fixture/model']);assert.ok(!JSON.stringify(row).includes(f.rotated));assert.equal(await scalar(`SELECT api_key_encrypted FROM ${g}.byok_keys WHERE id='byok-a'`),f.rotated);
      const audit=await scalar(`SELECT change_payload FROM ${g}.user_audit_logs`);assert.ok(!audit.includes(f.rotated));assert.ok(JSON.parse(audit).changed_fields.includes('key'));
      assert.deepEqual((await active()).map(x=>x.id),['byok-b']);
    },
    async 'trusted portal update and deletion pin the selected workspace'(){
      assert.equal((await update({name:'Portal'},portal)).name,'Portal');const wrong={...portal,workspaceId:'other-workspace'};const before=await f.snapshot(g);assert.equal(await update({name:'Updated'},wrong),null);assert.equal(await del(wrong),false);assert.deepEqual(await f.snapshot(g),before);
      assert.equal(await del(portal),true);assert.equal(await get(),null);
    },
    async 'soft deletion wipes ciphertext and filters and is idempotent'(){
      await update({allowedModels:['fixture/model'],allowedUserIds:['user'],allowedApiKeyHashes:['a'.repeat(64)]});assert.equal(await del(),true);
      const row=(await f.rows(`SELECT api_key_encrypted,label,disabled,allowed_models_json,allowed_user_ids_json,allowed_api_key_hashes_json,deleted_at FROM ${g}.byok_keys WHERE id='byok-a'`))[0];assert.equal(row.api_key_encrypted,'');assert.equal(row.label,'deleted');assert.equal(row.disabled,true);assert.equal(row.allowed_models_json,null);assert.equal(row.allowed_user_ids_json,null);assert.equal(row.allowed_api_key_hashes_json,null);assert.ok(row.deleted_at);
      const before=await f.snapshot(g);assert.equal(await del(),false);assert.deepEqual(await f.snapshot(g),before);assert.deepEqual((await active()).map(x=>x.id),['byok-b']);
    },
    async 'management and portal reorder atomically swap occupied unique slots'(){
      for(const principal of [p,portal])assert.equal(await reorder(principal),'updated');
      assert.deepEqual(await f.rows(`SELECT id,provider,sort_order,is_fallback FROM ${g}.byok_keys WHERE workspace_id='workspace' ORDER BY sort_order`),[{id:'byok-b',provider:'fixture',sort_order:0,is_fallback:false},{id:'byok-a',provider:'fixture',sort_order:1,is_fallback:true}]);assert.equal(await scalar(`SELECT count(*) FROM ${g}.byok_keys WHERE provider LIKE 'cinatoken-reorder-%'`),'0');
      assert.deepEqual((await active()).map(x=>x.id),['byok-b','byok-a']);
    },
    async 'reorder stale set or protected priority returns conflict without changes'(){
      const before=await f.snapshot(g);assert.equal(await reorder(p,[{id:'byok-a',isFallback:false}]),'conflict');assert.deepEqual(await f.snapshot(g),before);
      await update({alwaysUseForProvider:true});const protectedState=await f.snapshot(g);assert.equal(await reorder(),'conflict');assert.deepEqual(await f.snapshot(g),protectedState);
    },
    async 'all 100 slots can be reordered and runtime delivery stays bounded to 32 keys'(){
      await f.pg.query(`INSERT INTO ${g}.byok_keys (id,workspace_id,provider,api_key_encrypted,label,sort_order) SELECT 'bulk-'||n,'workspace','fixture',$1,'label',n FROM generate_series(2,99) n`,[f.ciphertext]);
      await assert.rejects(insert(),/key limit reached/);assert.equal(await scalar(`SELECT count(*) FROM ${g}.byok_keys WHERE workspace_id='workspace'`),'100');
      const keys=(await f.rows(`SELECT id FROM ${g}.byok_keys WHERE workspace_id='workspace' ORDER BY sort_order DESC`)).map(x=>({id:x.id,isFallback:false}));assert.equal(await reorder(p,keys),'updated');assert.equal((await active()).length,32);assert.equal((await active())[0].id,'bulk-99');assert.equal(await scalar(`SELECT count(DISTINCT sort_order) FROM ${g}.byok_keys WHERE workspace_id='workspace'`),'100');
    },
    async 'runtime includes only matching provider workspace and identity allowlists in priority order'(){
      assert.deepEqual((await active()).map(x=>x.id),['byok-a','byok-b']);assert.equal((await active())[0].api_key,f.ciphertext);assert.deepEqual(await active({provider:'missing'}),[]);
      await update({allowedModels:['fixture/model'],allowedUserIds:['user'],allowedApiKeyHashes:['a'.repeat(64)]});assert.equal((await active()).length,2);
      for(const patch of [{modelId:'fixture/other'},{userId:'other'},{apiKeyHash:'b'.repeat(64)}])assert.deepEqual((await active(patch)).map(x=>x.id),['byok-b']);
    },
    async 'invalid stored allowlist entries fail closed at the runtime boundary'(){
      await f.pg.exec(`UPDATE ${g}.byok_keys SET allowed_models_json='[123]' WHERE id='byok-a'`);assert.deepEqual((await get()).allowed_models,[]);assert.deepEqual((await active()).map(x=>x.id),['byok-b']);
    },
    async 'provider-wide suppression ignores model filters but honors identity and enabled state'(){
      await update({alwaysUseForProvider:true,allowedModels:['fixture/other'],allowedUserIds:['user'],allowedApiKeyHashes:['a'.repeat(64)]});assert.equal(await suppress(),true);assert.equal(await suppress({userId:'other'}),false);assert.equal(await suppress({apiKeyHash:'b'.repeat(64)}),false);
      await update({disabled:true});assert.equal(await suppress(),false);
    },
    async 'matching-model suppression only applies to an eligible prioritized credential'(){
      await update({alwaysUseForMatchingModels:true,allowedModels:['fixture/model']});assert.equal(await suppress(),true);assert.equal(await suppress({modelId:'fixture/other'}),false);
      const before=await f.snapshot(g);await assert.rejects(update({isFallback:true}),/only valid for prioritized/);await assert.rejects(update({alwaysUseForProvider:true}),/mutually exclusive/);assert.deepEqual(await f.snapshot(g),before);
    },
    async 'foreign account management key cannot mutate personal credentials'(){
      const before=await f.snapshot(g);assert.equal(await insert(o),null);assert.equal(await update({name:'Updated'},o),null);assert.equal(await del(o),false);assert.equal(await reorder(o),'not_found');assert.deepEqual(await f.snapshot(g),before);
    },
    async 'missing gateway credential table fails closed instead of reading shadows'(){
      await f.pg.exec(`ALTER TABLE ${g}.byok_keys RENAME TO byok_missing_test`);try{await assert.rejects(active(),e=>e.code==='42P01');await assert.rejects(get(),e=>e.code==='42P01');}finally{await f.pg.exec(`ALTER TABLE ${g}.byok_missing_test RENAME TO byok_keys`);}
    },
    async 'plaintext input and invalid request controls reject before SQL'(){
      await assert.rejects(insert(p,'created',{apiKey:'plain-not-a-real-key'}),/encrypted/);await assert.rejects(update({apiKey:'plain-not-a-real-key'}),/encrypted/);await assert.rejects(active({apiKeyHash:'invalid'}),TypeError);await assert.rejects(byok.listForAccount(personal,{offset:-1,limit:1}),TypeError);await assert.rejects(insert(portal,'created',{workspaceId:'other-workspace'}),/selected workspace/);assert.equal(f.queries.length,0);
    },
    async 'user hard delete resolves its target and default-Guardrail protection in the gateway'(){
      await f.pg.exec(`INSERT INTO ${g}.users (id,email) VALUES ('deletable','deletable@example.invalid');UPDATE ${g}.guardrails SET is_workspace_default=TRUE WHERE id='guardrail'`);
      assert.equal(await users.deleteUserHard('user'),false);assert.equal(await users.deleteUserHard('deletable'),true);assert.equal(await scalar(`SELECT count(*) FROM ${g}.users WHERE id='deletable'`),'0');assert.equal(await users.deleteUserHard('deletable'),false);
    },
    async 'ORM identity reads and scalar mutations stay schema qualified'(){
      assert.equal((await users.getByExternalPair('cinaauth','subject')).id,'user');assert.equal((await users.getById('user')).budget_spent,1);
      assert.equal(await users.setUserEmailById('user','updated@example.invalid'),true);assert.equal((await users.listByEmail('updated@example.invalid'))[0].id,'user');
      await users.setUserMetadataById('user','{"local":true}');await users.setUserChargedCostFactorsById('user','{"fixture":1}');await users.setUserExternalIdentityById('other','cinaauth','second');await users.updateUserStatus('other','disabled');
      assert.deepEqual(await users.getUsersCount(),{total:2,active:1});assert.equal((await users.getById('user')).metadata,'{"local":true}');assert.equal((await users.getByExternalPair('cinaauth','second')).id,'other');
    },
    async 'ORM user creation includes default resources and blocks hard deletion'(){
      await users.createUser({id:'new-user',email:'new@example.invalid',budgetMax:20,externalSystem:'cinaauth',externalUserId:'new-subject'});assert.equal((await users.getById('new-user')).budget_max,20);assert.equal(await scalar(`SELECT count(*) FROM ${g}.guardrails WHERE owner_user_id='new-user'`),'2');assert.equal(await scalar(`SELECT count(*) FROM ${g}.guardrail_versions WHERE created_by_user_id='new-user'`),'2');assert.equal(await users.deleteUserHard('new-user'),false);
    },
    async 'ORM user creation rolls back the whole default-resource transaction on version failure'(){
      await f.pg.exec(`ALTER TABLE ${g}.guardrail_versions ADD CONSTRAINT byok_reject_version CHECK (created_by_user_id <> 'new-user')`);
      try{const before=await f.snapshot(g);await assert.rejects(users.createUser({id:'new-user',email:'new@example.invalid'}));assert.deepEqual(await f.snapshot(g),before);assert.equal(f.transactions.at(-1).state,'rolled_back');}finally{await f.pg.exec(`ALTER TABLE ${g}.guardrail_versions DROP CONSTRAINT byok_reject_version`);}
    },
    async 'ORM budget plan branches preserve or reset spending and reservation epoch as requested'(){
      const original=await users.getById('user');await users.updateUserPlan('user',30,'monthly',null,false,undefined,undefined,2);let user=await users.getById('user');assert.equal(user.budget_spent,1);assert.equal(user.budget_base,2);assert.equal(user.budget_epoch,original.budget_epoch);
      await users.updateUserPlan('user',40,'none',null,false,undefined,3);user=await users.getById('user');assert.equal(user.budget_spent,3);assert.equal(user.budget_epoch,original.budget_epoch+1);
      await users.updateUserPlan('user',null,'none',null,true);user=await users.getById('user');assert.equal(user.budget_spent,0);assert.equal(user.budget_epoch,original.budget_epoch+2);assert.equal((await users.list({maxBudget:'null'})).total,1);assert.equal((await users.list({maxBudget:'positive'})).total,1);
    },
  };
  for(const[name,sql,principal]of [
    ['revoked management key',`UPDATE ${g}.management_api_keys SET status='revoked' WHERE id='management'`,p],
    ['expired management key',`UPDATE ${g}.management_api_keys SET expires_at='2000-01-01' WHERE id='management'`,p],
    ['disabled personal owner',`UPDATE ${g}.users SET status='disabled' WHERE id='user'`,p],
    ['disabled portal user',`UPDATE ${g}.users SET status='disabled' WHERE id='user'`,portal],
    ['archived workspace',`UPDATE ${g}.workspaces SET status='archived' WHERE id='workspace'`,p],
  ])cases[name+' denies every mutation without writes']=async()=>{
    await f.pg.exec(sql);const before=await f.snapshot(g);assert.equal(await insert(principal),null);assert.equal(await update({name:'Updated'},principal),null);assert.equal(await del(principal),false);assert.equal(await reorder(principal),'not_found');assert.deepEqual(await f.snapshot(g),before);
  };
  cases['suspended organization rejects its management-key mutations']=async()=>{
    await f.pg.exec(`UPDATE ${g}.organizations SET status='suspended'`);const before=await f.snapshot(g);assert.equal(await insert(o,'created',{workspaceId:'org-workspace'}),null);assert.equal(await update({name:'Updated'},o,'byok-org'),null);assert.equal(await del(o,'byok-org'),false);assert.equal(await reorder(o,[{id:'byok-org',isFallback:false}],'org-workspace'),'not_found');assert.deepEqual(await f.snapshot(g),before);
  };
  for(const principal of [p,portal])for(const[name,operation]of [['insert',()=>insert(principal)],['update',()=>update({name:'Updated'},principal)],['delete',()=>del(principal)],['reorder',()=>reorder(principal)]])cases[(principal===p?'management':'portal')+' '+name+' rolls back when final audit fails']=async()=>{
    await f.pg.exec(`ALTER TABLE ${g}.user_audit_logs ADD CONSTRAINT byok_reject_audit CHECK (source NOT IN ('gateway_management_byok','gateway_portal_byok'))`);
    try{const before=await f.snapshot(g);await assert.rejects(operation(),/byok_reject_audit/);assert.deepEqual(await f.snapshot(g),before);assert.equal(f.transactions.at(-1).state,'rolled_back');}finally{await f.pg.exec(`ALTER TABLE ${g}.user_audit_logs DROP CONSTRAINT byok_reject_audit`);}
  };
  for(const path of [`${g},public`,'public,pg_temp','pg_temp,public'])for(const[name,operation]of Object.entries(cases))await t.test(path+': '+name,async()=>{
    const before=await f.reset(path);try{await operation();}finally{assert.deepEqual(await f.snapshot('public'),before.public,'public shadows unchanged');assert.deepEqual(await f.snapshot('pg_temp'),before.temp,'temporary shadows unchanged');}
  });
});
