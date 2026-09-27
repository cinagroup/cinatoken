import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import {createProjectionEngine} from '../test-support/postgres-projection-engine.mjs';
import {gateway as g} from '../test-support/postgres-financial-engine.mjs';
import {personal,organization} from '../test-support/postgres-auth-engine.mjs';
import {DEFAULT_MANAGEMENT_WORKSPACE_SETTINGS as settings} from '../management-workspaces.ts';
import {workspaceMembershipKey} from '../workspaces.ts';

// Local PostgreSQL execution and constraint rollback, not wire/pooling, roles,
// concurrent sessions or Workers acceptance. The selector is test-only.
test('management workspace lifecycle and members stay in the gateway schema',async t=>{
  const f=await createProjectionEngine();t.after(()=>f.pg.close());
  const implementation=file=>import(process.env.GATEWAY_PG_MANAGEMENT_BASELINE_DIR
    ?pathToFileURL(resolve(process.env.GATEWAY_PG_MANAGEMENT_BASELINE_DIR,file+'.js')).href
    :new URL('./'+file+'.ts',import.meta.url).href);
  const w=await implementation('management-workspaces'),m=await implementation('management-workspace-members');
  const p={keyId:'management',createdByUserId:'user',account:personal},o={...p,keyId:'org-management',account:organization};
  const page={offset:0,limit:100},roles=new Set(['owner']),options={nowIso:f.now};
  const input={name:'Created workspace',slug:'created',description:'Description',settings};
  const scalar=async sql=>Object.values((await f.rows(sql))[0])[0];
  const create=(principal=p,id='created')=>w.createManagementWorkspace(f.client,principal,{...input,slug:id},{...options,id});
  const get=(id='workspace',account=personal)=>w.getManagementWorkspace(f.client,account,id);
  const update=(patch={name:'Updated'},principal=p,id='workspace')=>w.updateManagementWorkspace(f.client,principal,id,patch,options);
  const del=(id='workspace',principal=p,confirm=true)=>w.deleteManagementWorkspace(f.client,principal,id,confirm,options);
  const listMembers=(id='org-workspace',account=organization,at=page)=>m.listManagementWorkspaceMembers(f.client,account,id,at,roles);
  const add=(ids=['subject-2'],principal=o,id='org-workspace')=>m.addManagementWorkspaceMembers(f.client,principal,id,ids,roles,options);
  const remove=(ids=['subject'],principal=o,id='org-workspace')=>m.removeManagementWorkspaceMembers(f.client,principal,id,ids,options);
  async function reset(path){
    await f.reset(path);
    await f.pg.query(`UPDATE ${g}.workspace_memberships SET membership_key=$1`,[await workspaceMembershipKey('org-workspace','subject')]);
    await f.pg.exec(`UPDATE ${g}.users SET external_system='cinaauth',external_user_id='subject-2' WHERE id='other';
      UPDATE ${g}.workspaces SET created_by_user_id='user' WHERE id IN ('workspace','org-workspace');
      INSERT INTO ${g}.organization_memberships (organization_id,subject,user_id,roles_json,source_updated_at)
        VALUES ('org','subject-2','other','["owner"]',CURRENT_TIMESTAMP);
      INSERT INTO ${g}.workspaces (id,scope_type,organization_id,name,slug,is_default,default_scope_key)
        VALUES ('org-default','organization','org','Default organization workspace','default',TRUE,'org-default')`);
    f.queries.length=0;f.transactions.length=0;
    return {public:await f.snapshot('public'),temp:await f.snapshot('pg_temp')};
  }
  const cases={
    async 'listing and pagination respect personal and organization account boundaries'(){
      const own=await w.listManagementWorkspaces(f.client,personal,page);assert.equal(own.totalCount,1);assert.deepEqual(own.data.map(x=>x.id),['workspace']);assert.equal(own.data[0].slug,'workspace');
      const org=await w.listManagementWorkspaces(f.client,organization,{offset:1,limit:1});assert.equal(org.totalCount,2);assert.equal(org.data.length,1);
      assert.deepEqual(await w.listManagementWorkspaces(f.client,personal,{offset:1,limit:1}),{data:[],totalCount:1});
    },
    async 'lookup resolves creator external id but rejects foreign or archived workspaces'(){
      assert.equal((await get()).created_by,'subject');assert.equal(await get('other-workspace'),null);assert.equal(await get('org-workspace'),null);
      await f.pg.exec(`UPDATE ${g}.workspaces SET status='archived' WHERE id='workspace'`);assert.equal(await get(),null);
    },
    async 'exact id takes precedence over another workspace slug'(){
      await create(p,'created');await f.pg.exec(`UPDATE ${g}.workspaces SET slug='different' WHERE id='created';UPDATE ${g}.workspaces SET slug='created' WHERE id='workspace'`);
      assert.equal((await get('created')).id,'created');
    },
    async 'personal and organization creation persist defaults, versions and audit in one transaction'(){
      for(const [principal,id]of [[p,'new-personal'],[o,'new-org']]){
        const row=await create(principal,id);assert.equal(row.id,id);assert.equal(row.scope_type,principal.account.accountType);assert.equal(row.created_by,'subject');assert.deepEqual(row.settings,settings);
        assert.equal(await scalar(`SELECT count(*) FROM ${g}.guardrails WHERE workspace_id='${id}' AND is_workspace_default`),'1');
        assert.equal(await scalar(`SELECT count(*) FROM ${g}.guardrail_versions v JOIN ${g}.guardrails r ON r.id=v.guardrail_id WHERE r.workspace_id='${id}'`),'1');
      }
      assert.equal(await scalar(`SELECT count(*) FROM ${g}.user_audit_logs WHERE event_type='workspace_created'`),'2');assert.deepEqual(f.transactions,[{state:'committed'},{state:'committed'}]);
    },
    async 'duplicate slug rolls back the complete creation transaction'(){
      await create();const before=await f.snapshot(g);await assert.rejects(w.createManagementWorkspace(f.client,p,input,{...options,id:'another'}),/slug already exists/);assert.deepEqual(await f.snapshot(g),before);assert.equal(f.transactions.at(-1).state,'rolled_back');
    },
    async 'settings merge preserves unspecified fields and permits explicit description clear'(){
      await create();const row=await update({name:'Renamed',description:null,settings:{defaultTextModel:'test/model'}},p,'created');assert.equal(row.name,'Renamed');assert.equal(row.description,null);assert.equal(row.settings.defaultTextModel,'test/model');assert.equal(row.settings.ioLoggingSamplingRate,1);
      const kept=await update({slug:'renamed'},p,'created');assert.equal(kept.name,'Renamed');assert.equal(kept.settings.defaultTextModel,'test/model');assert.equal(await scalar(`SELECT count(*) FROM ${g}.user_audit_logs WHERE event_type='workspace_updated'`),'2');
    },
    async 'cross-account writes cannot touch another owner workspace'(){
      const before=await f.snapshot(g);assert.equal(await update({},p,'other-workspace'),null);assert.equal(await del('other-workspace'),'not_found');assert.deepEqual(await f.snapshot(g),before);
    },
    async 'active inference keys block deletion without audit or mutations'(){
      const before=await f.snapshot(g);assert.equal(await del(),'active_keys');assert.deepEqual(await f.snapshot(g),before);
    },
    async 'custom workspace deletion cascades defaults and records a single audit'(){
      await create();assert.equal(await del('created'),'deleted');assert.equal(await get('created'),null);assert.equal(await scalar(`SELECT count(*) FROM ${g}.guardrails WHERE workspace_id='created'`),'0');assert.equal(await scalar(`SELECT count(*) FROM ${g}.user_audit_logs WHERE event_type='workspace_deleted'`),'1');assert.equal(await del('created'),'not_found');
    },
    async 'default deletion requires confirmation and leaves an archived tombstone'(){
      await f.pg.exec(`UPDATE ${g}.api_keys SET status='revoked';UPDATE ${g}.workspaces SET is_default=TRUE,default_scope_key=id WHERE id='workspace'`);
      assert.equal(await del('workspace',p,false),'confirmation_required');assert.equal(await del(),'deleted');
      assert.deepEqual(await f.rows(`SELECT status,is_default,default_scope_key FROM ${g}.workspaces WHERE id='workspace'`),[{status:'archived',is_default:true,default_scope_key:'workspace'}]);assert.equal(await get(),null);
    },
    async 'account default Guardrail needs an active same-account anchor before deletion'(){
      // Account defaults inherit implicitly; explicit assignments are prohibited.
      // Do not convert the financial helper's explicitly assigned ordinary rule.
      await f.pg.exec(`UPDATE ${g}.api_keys SET status='revoked';INSERT INTO ${g}.guardrails (id,owner_user_id,workspace_id,name,is_account_default,account_scope_key) VALUES ('account-guardrail','user','workspace','Account Default',TRUE,'personal:user')`);
      assert.equal(await del(),'account_default_anchor');assert.equal(await scalar(`SELECT workspace_id FROM ${g}.guardrails WHERE id='account-guardrail'`),'workspace');
      await create();assert.equal(await del(),'deleted');assert.equal(await scalar(`SELECT workspace_id FROM ${g}.guardrails WHERE id='account-guardrail'`),'created');
    },
    async 'personal member listing derives the exact active external owner and paginates'(){
      const found=await listMembers('workspace',personal);assert.equal(found.totalCount,1);assert.equal(found.data[0].user_id,'subject');assert.equal(found.data[0].role,'admin');
      assert.deepEqual(await listMembers('workspace',personal,{offset:1,limit:1}),{data:[],totalCount:1});await f.pg.exec(`UPDATE ${g}.users SET status='disabled' WHERE id='user'`);assert.deepEqual(await listMembers('workspace',personal),{data:[],totalCount:0});
    },
    async 'default organization members derive active org roles and cannot be removed explicitly'(){
      const found=await listMembers('org-default');assert.equal(found.totalCount,2);assert.equal(found.data.find(x=>x.user_id==='subject-2').role,'admin');
      const before=await f.snapshot(g),result=await add(['subject-2'],o,'org-default');assert.equal(result.changedCount,0);assert.equal(result.data[0].role,'admin');assert.deepEqual(await remove(['subject'],o,'org-default'),{ok:false,reason:'default_workspace'});assert.deepEqual(await f.snapshot(g),before);
    },
    async 'custom member listing intersects explicit membership with active organization membership'(){
      const found=await listMembers();assert.equal(found.totalCount,1);assert.equal(found.data[0].id,'membership');assert.equal(found.data[0].user_id,'subject');
      await f.pg.exec(`UPDATE ${g}.organization_memberships SET status='removed' WHERE subject='subject'`);assert.deepEqual(await listMembers(),{data:[],totalCount:0});
    },
    async 'member addition persists hashed identity and roles derive from org, not workspace row'(){
      const result=await add();assert.equal(result.ok,true);assert.equal(result.changedCount,1);assert.equal(result.data[0].role,'admin');
      assert.equal(await scalar(`SELECT count(*) FROM ${g}.user_audit_logs WHERE event_type='workspace_members_added'`),'1');
      assert.deepEqual(await f.rows(`SELECT membership_key,role,status FROM ${g}.workspace_memberships WHERE subject='subject-2'`),[{membership_key:await workspaceMembershipKey('org-workspace','subject-2'),role:'member',status:'active'}]);
    },
    async 'readding a removed member retains its id and creation timestamp'(){
      await f.pg.exec(`UPDATE ${g}.workspace_memberships SET status='removed',role='admin'`);const prior=await f.rows(`SELECT id,created_at FROM ${g}.workspace_memberships`);
      assert.equal((await add(['subject'])).data[0].id,'membership');assert.deepEqual(await f.rows(`SELECT id,created_at FROM ${g}.workspace_memberships`),prior);assert.equal(await scalar(`SELECT role FROM ${g}.workspace_memberships`),'member');
    },
    async 'unknown member in a batch prevents all additions and audit'(){
      const before=await f.snapshot(g);assert.deepEqual(await add(['subject-2','missing']),{ok:false,reason:'unknown_members'});assert.deepEqual(await f.snapshot(g),before);
    },
    async 'members cannot mutate personal or foreign workspaces'(){
      const before=await f.snapshot(g);assert.deepEqual(await add(['subject'],p,'workspace'),{ok:false,reason:'personal_workspace'});assert.deepEqual(await remove(['subject'],p,'workspace'),{ok:false,reason:'personal_workspace'});
      assert.deepEqual(await add(['subject'],o,'other-workspace'),{ok:false,reason:'not_found'});assert.deepEqual(await f.snapshot(g),before);
    },
    async 'member removal persists tombstone with audit and is idempotent'(){
      assert.deepEqual(await remove(),{ok:true,data:[],changedCount:1});assert.equal(await scalar(`SELECT status FROM ${g}.workspace_memberships WHERE id='membership'`),'removed');
      const before=await f.snapshot(g);assert.deepEqual(await remove(),{ok:true,data:[],changedCount:0});assert.deepEqual(await f.snapshot(g),before);
    },
    async 'member removal is blocked by active owned keys but succeeds after revocation'(){
      await f.pg.exec(`UPDATE ${g}.api_keys SET workspace_id='org-workspace' WHERE id='key'`);const before=await f.snapshot(g);assert.deepEqual(await remove(),{ok:false,reason:'active_keys'});assert.deepEqual(await f.snapshot(g),before);
      await f.pg.exec(`UPDATE ${g}.api_keys SET status='revoked'`);assert.equal((await remove()).changedCount,1);
    },
    async 'missing gateway relation fails closed instead of using a shadow table'(){
      await f.pg.exec(`ALTER TABLE ${g}.workspaces RENAME TO workspace_missing_test`);
      try{await assert.rejects(get(),e=>e.code==='42P01');}finally{await f.pg.exec(`ALTER TABLE ${g}.workspace_missing_test RENAME TO workspaces`);}
    },
    async 'invalid pagination and identifiers fail before any query'(){
      await assert.rejects(w.listManagementWorkspaces(f.client,personal,{offset:-1,limit:1}),TypeError);await assert.rejects(get(' '),TypeError);await assert.rejects(listMembers('org-workspace',organization,{offset:0,limit:101}),TypeError);assert.equal(f.queries.length,0);
    },
  };
  for(const [name,sql,principal,id]of [
    ['revoked personal key',`UPDATE ${g}.management_api_keys SET status='revoked' WHERE id='management'`,p,'workspace'],
    ['expired personal key',`UPDATE ${g}.management_api_keys SET expires_at='2000-01-01' WHERE id='management'`,p,'workspace'],
    ['disabled personal owner',`UPDATE ${g}.users SET status='disabled' WHERE id='user'`,p,'workspace'],
    ['revoked org key',`UPDATE ${g}.management_api_keys SET status='revoked' WHERE id='org-management'`,o,'org-workspace'],
    ['expired org key',`UPDATE ${g}.management_api_keys SET expires_at='2000-01-01' WHERE id='org-management'`,o,'org-workspace'],
    ['suspended org',`UPDATE ${g}.organizations SET status='suspended'`,o,'org-workspace'],
  ])cases[name+' denies mutations without side effects']=async()=>{
    await f.pg.exec(`UPDATE ${g}.api_keys SET status='revoked';${sql}`);const before=await f.snapshot(g);
    assert.equal(await create(principal),null);assert.equal(await update({},principal,id),null);assert.equal(await del(id,principal),'not_found');
    if(principal===o){assert.deepEqual(await add(['subject-2']),{ok:false,reason:'not_found'});assert.deepEqual(await remove(),{ok:false,reason:'not_found'});}
    assert.deepEqual(await f.snapshot(g),before);
  };
  for(const [name,operation]of [['create',()=>create()],['update',()=>update()],['delete',()=>del('org-workspace',o)],['add members',()=>add()],['remove members',()=>remove()]])cases[name+' rolls back when final audit fails']=async()=>{
    await f.pg.exec(`ALTER TABLE ${g}.user_audit_logs ADD CONSTRAINT management_reject_audit CHECK (source <> 'gateway_management_workspaces')`);
    try{const before=await f.snapshot(g);await assert.rejects(operation(),/management_reject_audit/);assert.deepEqual(await f.snapshot(g),before);assert.equal(f.transactions.at(-1).state,'rolled_back');}
    finally{await f.pg.exec(`ALTER TABLE ${g}.user_audit_logs DROP CONSTRAINT management_reject_audit`);}
  };
  for(const path of [`${g},public`,'public,pg_temp','pg_temp,public'])for(const [name,operation]of Object.entries(cases))await t.test(path+': '+name,async()=>{
    const before=await reset(path);
    try{await operation();}finally{assert.deepEqual(await f.snapshot('public'),before.public,'public shadow state unchanged');assert.deepEqual(await f.snapshot('pg_temp'),before.temp,'temporary shadow state unchanged');}
  });
});
