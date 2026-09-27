import assert from 'node:assert/strict';
import test from 'node:test';
import {createAuthEngine,authImplementation,inferenceSecret,managementSecret,personal,organization} from '../test-support/postgres-auth-engine.mjs';
import {gateway as g,chargeParams,reserveParams,intent} from '../test-support/postgres-financial-engine.mjs';
import {insertRequestUsageAndChargeTxPg as charge} from '../db/postgres/critical-writes.impl.ts';
import {createPostgresGuardrailBudgetsRepository} from '../db/postgres/guardrail-budgets.impl.ts';
import {hashLookupKey} from '../lib/key-hash.ts';

// Explicit local PGlite module required. These are SQL engine tests, not native
// Postgres.js wire, Hyperdrive, role/upgrade, concurrent auth/revoke or Workers tests.
test('PostgreSQL key repositories do not trust the caller search_path',async t=>{
  const f=await createAuthEngine(); t.after(()=>f.pg.close());
  const {createPostgresApiKeysRepository}=await authImplementation('db/postgres/api-keys.impl.ts');
  const {createManagementApiKeysRepository}=await authImplementation('storage/management-api-keys.ts');
  const keys=createPostgresApiKeysRepository(f.client), management=createManagementApiKeysRepository(f.client);
  const lookup=(account=personal)=>({...account,keyHash:f.prepared.keyHash});
  const listing=(account=personal,workspaceId='workspace',extra={})=>({...account,workspaceId,offset:0,includeDisabled:false,...extra});
  const auth=()=>keys.getActiveApiKeyWithUserByLookupHash(f.prepared.keyHash);
  const value=async sql=>Object.values((await f.rows(sql))[0])[0];
  const orgKey=()=>f.pg.exec(`UPDATE ${g}.api_keys SET workspace_id='org-workspace' WHERE id='key'`);
  const insertParams=async(account=personal)=>({...account,id:'new-management',keyHash:await hashLookupKey('synthetic-new-management'),keyPreview:'test-preview',name:'New management',expiresAt:null,createdByUserId:'user',nowIso:f.now});
  const cases={
    async 'inference hash auth resolves user and workspace, never management key'(){
      const row=await auth(); assert.equal(row.id,'key');assert.equal(row.workspace_id,'workspace');assert.equal(row.budget_spent,1);
      assert.equal(await keys.getActiveApiKeyWithUserByLookupHash(f.managementHash),null);
      assert.equal(await management.getActiveBySecret(inferenceSecret),null);
      await assert.rejects(keys.getActiveApiKeyWithUserByLookupHash(inferenceSecret),/SHA-256/);
    },
    async 'legacy inference migration updates only gateway and hash-only lookup never falls back'(){
      await f.pg.query(`UPDATE ${g}.api_keys SET key=$1,key_hash=NULL,key_preview=NULL WHERE id='key'`,[inferenceSecret]);
      assert.equal(await auth(),null);
      const row=await keys.getApiKeyWithUserByKey(inferenceSecret);assert.equal(row.id,'key');assert.notEqual(row.key,inferenceSecret);
      assert.deepEqual(await f.rows(`SELECT key,key_hash FROM ${g}.api_keys WHERE id='key'`),[{key:f.prepared.storageKey,key_hash:f.prepared.keyHash}]);
      assert.equal((await auth()).id,'key');
    },
    async 'organization auth requires live memberships and default workspace bypasses only workspace membership'(){
      await orgKey();assert.equal((await auth()).workspace_id,'org-workspace');
      await f.pg.exec(`UPDATE ${g}.workspace_memberships SET status='removed'`);assert.equal(await auth(),null);
      await f.pg.exec(`UPDATE ${g}.workspaces SET is_default=TRUE,default_scope_key='org-default' WHERE id='org-workspace'`);assert.equal((await auth()).id,'key');
      await f.pg.exec(`UPDATE ${g}.organization_memberships SET status='removed'`);assert.equal(await auth(),null);
    },
    async 'management usage select reads charged/BYOK windows and consumed but not reserved amount'(){
      const params=chargeParams('usage',0.125);await charge(f.client,params);
      await f.pg.exec(`UPDATE ${g}.api_key_request_logs SET is_byok=TRUE,standard_cost=0.25,created_at=CURRENT_TIMESTAMP`);
      const guards=createPostgresGuardrailBudgetsRepository(f.client);
      assert.equal((await guards.reserveMany({...reserveParams(['api_key']),intents:[{...intent('api_key'),periodStart:'2000-01-01T00:00:00.000Z',periodEnd:'2999-01-01T00:00:00.000Z'}]})).status,'reserved');
      await f.pg.exec(`UPDATE ${g}.guardrail_budget_windows SET unreserved_micros=10000,settled_micros=20000`);
      const row=await keys.getCurrentById('key');assert.equal(row.name,'Gateway key');assert.equal(row.limit_consumed_micros,30000);
      for(const field of ['usage','usage_daily','usage_weekly','usage_monthly'])assert.equal(row[field],0.125,field);
      for(const field of ['byok_usage','byok_usage_daily','byok_usage_weekly','byok_usage_monthly'])assert.equal(row[field],0.25,field);
    },
    async 'gateway management personal and organization scope, pagination and disabled filters'(){
      assert.deepEqual((await keys.listForManagement(listing())).map(x=>x.id),['key']);
      assert.equal((await keys.getByHashForManagement(lookup())).name,'Gateway key');
      assert.equal((await keys.listForManagement(listing(personal,'workspace',{offset:1}))).length,0);
      assert.equal(await keys.getByHashForManagement(lookup({...personal,personalOwnerUserId:'other'})),null);
      await f.pg.exec(`UPDATE ${g}.api_keys SET status='disabled' WHERE id='key'`);
      assert.equal(await keys.getCurrentById('key'),null);assert.equal((await keys.listForManagement(listing())).length,0);
      assert.equal((await keys.listForManagement(listing(personal,'workspace',{includeDisabled:true}))).length,1);
      await orgKey(); assert.equal((await keys.getByHashForManagement(lookup(organization))).id,'key');
      assert.equal(await keys.getByHashForManagement(lookup()),null);
    },
    async 'gateway management patch preserves account predicate, parameters and limit epoch'(){
      const name="quote'; SELECT 1; --";
      assert.equal(await keys.updateByHashForManagement(lookup({...personal,personalOwnerUserId:'other'}),{name}),false);
      assert.equal(await keys.updateByHashForManagement(lookup(),{}),false);
      assert.equal(await keys.updateByHashForManagement(lookup(),{name,limitMicros:2000000,limitReset:'monthly',includeByokInLimit:false}),true);
      const row=await keys.getCurrentById('key');assert.equal(row.name,name);assert.equal(row.limit_epoch,1);assert.equal(row.limit_micros,2000000);assert.equal(row.limit_reset,'monthly');assert.equal(row.include_byok_in_limit,false);
      await orgKey();assert.equal(await keys.updateByHashForManagement(lookup(organization),{name:'Org key'}),true);
    },
    async 'management personal and org auth touch only gateway last-used timestamp'(){
      const row=await management.getActiveBySecret(managementSecret);assert.equal(row.id,'management');assert.equal(row.name,'Gateway management');
      assert.notEqual(await value(`SELECT last_used_at FROM ${g}.management_api_keys WHERE id='management'`),null);
      assert.equal((await management.getActiveBySecret(managementSecret+'-org')).id,'org-management');
      await f.pg.exec(`UPDATE ${g}.organizations SET status='pending'`);assert.equal((await management.getActiveBySecret(managementSecret+'-org')).id,'org-management');
    },
    async 'management list and get enforce both owner shapes'(){
      for(const [account,id] of [[personal,'management'],[organization,'org-management']]){
        assert.deepEqual((await management.listByAccount(account)).map(x=>[x.id,x.name]),[[id,'Gateway management']]);
        assert.equal((await management.getByIdInAccount(id,account)).name,'Gateway management');
      }
      assert.equal(await management.getByIdInAccount('org-management',personal),null);
      assert.equal(await management.getByIdInAccount('management',organization),null);
      await f.pg.exec(`UPDATE ${g}.management_api_keys SET status='revoked' WHERE id='management'`);
      assert.equal((await management.listByAccount(personal)).length,0);assert.equal((await management.listByAccount(personal,{includeRevoked:true})).length,1);
    },
    async 'workspace scope validation does not accept shadow ownership or archived gateway workspace'(){
      assert.equal(await management.workspaceBelongsToAccount('workspace',personal),true);
      assert.equal(await management.workspaceBelongsToAccount('org-workspace',organization),true);
      assert.equal(await management.workspaceBelongsToAccount('workspace',organization),false);
      assert.equal(await management.workspaceBelongsToAccount('other-workspace',personal),false);
      await f.pg.exec(`UPDATE ${g}.workspaces SET status='archived' WHERE id='workspace'`);
      assert.equal(await management.workspaceBelongsToAccount('workspace',personal),false);
    },
  };
  for(const [name,sql] of [
    ['revoked key',`UPDATE ${g}.api_keys SET status='revoked'`],
    ['expired key',`UPDATE ${g}.api_keys SET expires_at='2000-01-01'`],
    ['disabled user',`UPDATE ${g}.users SET status='disabled' WHERE id='user'`],
    ['archived workspace',`UPDATE ${g}.workspaces SET status='archived' WHERE id='workspace'`],
    ['wrong personal owner',`UPDATE ${g}.api_keys SET workspace_id='other-workspace'`],
    ['suspended organization',`UPDATE ${g}.api_keys SET workspace_id='org-workspace';UPDATE ${g}.organizations SET status='suspended'`],
    ['missing external identity',`UPDATE ${g}.api_keys SET workspace_id='org-workspace';UPDATE ${g}.users SET external_user_id=NULL,external_system=NULL WHERE id='user'`],
  ])cases['inference rejects '+name]=async()=>{await f.pg.exec(sql);assert.equal(await auth(),null);};
  for(const [name,sql,secret] of [
    ['revoked',`UPDATE ${g}.management_api_keys SET status='revoked'`,managementSecret],
    ['expired',`UPDATE ${g}.management_api_keys SET expires_at='2000-01-01'`,managementSecret],
    ['inactive personal owner',`UPDATE ${g}.users SET status='disabled' WHERE id='user'`,managementSecret],
    ['suspended organization',`UPDATE ${g}.organizations SET status='suspended'`,managementSecret+'-org'],
  ])cases['management auth rejects '+name]=async()=>{await f.pg.exec(sql);assert.equal(await management.getActiveBySecret(secret),null);};
  for(const account of [personal,organization]){
    cases[account.accountType+' management create and revoke are audited atomically']=async()=>{
      const params=await insertParams(account);await management.insert(params);
      assert.equal((await management.getByIdInAccount(params.id,account)).name,'New management');
      assert.equal(await management.revokeByIdInAccount(params.id,account,f.now,'user'),true);
      assert.equal(await management.revokeByIdInAccount(params.id,account,f.now,'user'),false);
      assert.deepEqual((await f.rows(`SELECT event_type FROM ${g}.user_audit_logs ORDER BY event_type`)).map(x=>x.event_type),['key_created','key_revoked']);
      assert.ok(f.transactions.every(x=>x.state==='committed'));
    };
    for(const action of ['insert','revoke'])cases[account.accountType+' '+action+' rolls back when audit fails']=async()=>{
      await f.pg.exec(`ALTER TABLE ${g}.user_audit_logs ADD CONSTRAINT auth_reject_audit CHECK (source <> 'portal_management_keys')`);
      try{
        const before=await f.snapshot(g);
        await assert.rejects(action==='insert'?management.insert(await insertParams(account)):management.revokeByIdInAccount(account===personal?'management':'org-management',account,f.now,'user'),/auth_reject_audit/);
        assert.deepEqual(await f.snapshot(g),before);assert.deepEqual(f.transactions,[{state:'rolled_back'}]);
      }finally{await f.pg.exec(`ALTER TABLE ${g}.user_audit_logs DROP CONSTRAINT auth_reject_audit`);}
    };
  }
  for(const method of ['management','hard']){
    const remove=()=>method==='management'?keys.deleteByHashForManagement(lookup()):keys.deleteApiKeyHard('key',inferenceSecret);
    cases[method+' delete is gateway-only and returns false on replay']=async()=>{
      assert.equal(await remove(),true);assert.equal(await value(`SELECT count(*) FROM ${g}.api_keys`),'0');assert.equal(await remove(),false);
    };
    for(const state of ['reserved','dispatched'])for(const kind of ['ordinary','guardrail'])cases[method+' delete protects '+kind+' '+state]=async()=>{
      if(kind==='ordinary')await f.pg.exec(`INSERT INTO ${g}.user_budget_reservations (request_id,user_id,api_key_id,budget_epoch,limit_micros,reserved_micros,state,expires_at,created_at,updated_at)
        VALUES ('request','user','key',0,1000000,100000,'${state}',CURRENT_TIMESTAMP+INTERVAL '1 day',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
      else{
        const guards=createPostgresGuardrailBudgetsRepository(f.client);assert.equal((await guards.reserveMany(reserveParams(['api_key']))).status,'reserved');
        if(state==='dispatched')await f.pg.exec(`UPDATE ${g}.guardrail_budget_reservations SET state='dispatched'`);
      }
      assert.equal(await remove(),false);assert.equal(await value(`SELECT count(*) FROM ${g}.api_keys`),'1');
    };
    cases[method+' delete protects historical charged request']=async()=>{await charge(f.client,chargeParams());assert.equal(await remove(),false);};
  }
  cases['missing gateway relations fail closed instead of reading shadows']=async()=>{
    for(const [table,action] of [['management_api_keys',()=>management.getActiveBySecret(managementSecret)],['api_keys',()=>keys.getCurrentById('key')]]){
      await f.pg.exec(`ALTER TABLE ${g}.${table} RENAME TO auth_hidden`);
      try{await assert.rejects(action(),/does not exist/);}finally{await f.pg.exec(`ALTER TABLE ${g}.auth_hidden RENAME TO ${table}`);}
    }
  };
  for(const path of ['public, pg_temp','pg_catalog','pg_temp, public'])for(const [name,action]of Object.entries(cases))await t.test(path+': '+name,async()=>{
    const shadows=await f.reset(path);
    try{await action();}finally{
      assert.deepEqual(await f.snapshot('public'),shadows.public,'public same-name tables must not change');
      assert.deepEqual(await f.snapshot('pg_temp'),shadows.temp,'temporary same-name tables must not change');
    }
    assert.equal(await value('SHOW search_path'),path);
  });
});
