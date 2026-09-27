import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {createProjectionEngine,projectionImplementation} from '../test-support/postgres-projection-engine.mjs';
import {gateway as g} from '../test-support/postgres-financial-engine.mjs';

// Actual local SQL and transactional constraints; not wire/TLS, connection
// pooling, event delivery concurrency, production roles or Workers acceptance.
test('organization identity and workspace projection use only the gateway schema',async t=>{
  const f=await createProjectionEngine();t.after(()=>f.pg.close());
  const identity=await projectionImplementation('organization-identity.ts'),workspace=await projectionImplementation('workspaces.ts');
  const principal={userId:'user',subject:'subject'};
  const rows=f.rows,scalar=async sql=>Object.values((await rows(sql))[0])[0];
  const ensure=(input=principal)=>workspace.ensureDefaultWorkspacesForSubject(f.client,input);
  const list=(input=principal)=>workspace.listAccessibleWorkspacesForSubject(f.client,input);
  const get=id=>workspace.getAccessibleWorkspaceForSubject(f.client,{...principal,workspaceId:id});
  const event=(id,patch={})=>({id,type:'organization.upserted',occurredAt:'2027-01-01T00:00:00.000Z',organization:{id:'projected',name:'Projected',slug:'projected',metadata:{local:true}},...patch});
  const membership=(id,patch={})=>event(id,{type:'organization.membership.upserted',membership:{subject:'subject',roles:['member'],email:'member@example.invalid'},...patch});
  const apply=(event,extra={})=>identity.applyOrganizationIdentityEvent(f.client,{event,payloadSha256:createHash('sha256').update(JSON.stringify(event)).digest('hex'),processedAt:'2027-01-02T00:00:00.000Z',...extra});
  const cases={
    async 'event receipt is immutable on exact duplicate and reused id with a different payload'(){
      const first=event('event-1');assert.equal(await apply(first),'applied');
      assert.equal(await scalar(`SELECT name FROM ${g}.organizations WHERE id='projected'`),'Projected');
      const before=await f.snapshot(g);assert.equal(await apply(first),'duplicate');assert.deepEqual(await f.snapshot(g),before);
      assert.equal(await apply({...first,organization:{id:'projected',name:'Changed'}}),'conflict');assert.deepEqual(await f.snapshot(g),before);
      assert.equal(await scalar(`SELECT count(*) FROM ${g}.identity_event_inbox`),'1');
    },
    async 'stale organization update cannot overwrite newer projection'(){
      await apply(event('new'));await apply(event('old',{occurredAt:'2026-01-01T00:00:00.000Z',organization:{id:'projected',name:'Stale'}}));
      assert.equal(await scalar(`SELECT name FROM ${g}.organizations WHERE id='projected'`),'Projected');
      assert.equal(await scalar(`SELECT count(*) FROM ${g}.identity_event_inbox`),'2');
    },
    async 'organization tombstone wins equal timestamp and preserves display metadata'(){
      await apply(event('new'));
      await apply(event('delete',{type:'organization.deleted',organization:{id:'projected'}}));
      await apply(event('equal',{organization:{id:'projected',name:'Resurrected'}}));
      assert.deepEqual(await rows(`SELECT name,slug,status,metadata_json FROM ${g}.organizations WHERE id='projected'`),[{name:'Projected',slug:'projected',status:'deleted',metadata_json:'{"local":true}'}]);
      await apply(event('later',{occurredAt:'2027-01-03T00:00:00.000Z',organization:{id:'projected',name:'Newer'}}));
      assert.equal(await scalar(`SELECT status FROM ${g}.organizations WHERE id='projected'`),'active');
    },
    async 'foreign organization source is not overwritten'(){
      await f.pg.exec(`UPDATE ${g}.organizations SET source='foreign-source',name='Keep' WHERE id='org'`);
      await apply(event('source',{organization:{id:'org',name:'Changed'}}));
      assert.equal(await scalar(`SELECT name FROM ${g}.organizations WHERE id='org'`),'Keep');
    },
    async 'membership arriving first creates pending placeholder and links exact external subject'(){
      await apply(membership('member-first'));
      assert.equal(await scalar(`SELECT status FROM ${g}.organizations WHERE id='projected'`),'pending');
      assert.equal(await scalar(`SELECT user_id FROM ${g}.organization_memberships WHERE organization_id='projected'`),'user');
      await apply(event('organization-later'));
      const found=(await identity.listOrganizationMembershipsForSubject(f.client,'subject')).find(x=>x.organizationId==='projected');
      assert.equal(found.organizationName,'Projected');assert.equal(found.userId,'user');assert.deepEqual(found.roles,['member']);
    },
    async 'membership removal wins equal time and retains roles and email'(){
      await apply(membership('member'));
      await apply(membership('removed',{type:'organization.membership.removed',membership:{subject:'subject',roles:['owner']}}));
      await apply(membership('equal',{membership:{subject:'subject',roles:['owner']}}));
      assert.deepEqual(await rows(`SELECT status,roles_json,email FROM ${g}.organization_memberships WHERE organization_id='projected'`),[{status:'removed',roles_json:'["member"]',email:'member@example.invalid'}]);
      assert.ok(!(await identity.listOrganizationMembershipsForSubject(f.client,'subject')).some(x=>x.organizationId==='projected'));
      await apply(membership('newer',{occurredAt:'2027-01-03T00:00:00.000Z'}));
      assert.equal(await scalar(`SELECT status FROM ${g}.organization_memberships WHERE organization_id='projected'`),'active');
    },
    async 'pre-login membership links once but cannot be reassigned to another local user'(){
      await apply(membership('pre-login',{membership:{subject:'late-subject',roles:['member']}}));
      assert.equal(await scalar(`SELECT user_id FROM ${g}.organization_memberships WHERE organization_id='projected'`),null);
      await identity.linkOrganizationMembershipsToUser(f.client,'late-subject','other',f.now);
      await identity.linkOrganizationMembershipsToUser(f.client,'late-subject','user',f.now);
      assert.equal(await scalar(`SELECT user_id FROM ${g}.organization_memberships WHERE organization_id='projected'`),'other');
    },
    async 'membership failure rolls back inbox and placeholder organization'(){
      await f.pg.exec(`ALTER TABLE ${g}.organization_memberships ADD CONSTRAINT projection_reject_member CHECK (subject <> 'reject-subject')`);
      try{
        const before=await f.snapshot(g);
        await assert.rejects(apply(membership('reject',{membership:{subject:'reject-subject',roles:[]}})),/projection_reject_member/);
        assert.deepEqual(await f.snapshot(g),before);assert.deepEqual(f.transactions,[{state:'rolled_back'}]);
      }finally{await f.pg.exec(`ALTER TABLE ${g}.organization_memberships DROP CONSTRAINT projection_reject_member`);}
    },
    async 'reused processor token cannot commit a second event'(){
      await apply(event('first'),{processorToken:'processor'});const before=await f.snapshot(g);
      await assert.rejects(apply(event('second',{organization:{id:'second',name:'Second'}}),{processorToken:'processor'}),/unique constraint/);
      assert.deepEqual(await f.snapshot(g),before);
    },
    async 'invalid receipt hash is rejected before a transaction starts'(){
      assert.throws(()=>apply(event('invalid'),{payloadSha256:'invalid'}),/SHA-256/);assert.equal(f.transactions.length,0);
    },
    async 'membership reads reflect suspension, removal and organization state'(){
      assert.deepEqual((await identity.listOrganizationMembershipsForSubject(f.client,'subject')).map(x=>x.organizationName),['Organization']);
      await f.pg.exec(`UPDATE ${g}.organization_memberships SET status='suspended'`);
      assert.equal((await identity.listOrganizationMembershipsForSubject(f.client,'subject')).length,0);
      await f.pg.exec(`UPDATE ${g}.organization_memberships SET status='active';UPDATE ${g}.organizations SET status='suspended'`);
      assert.equal((await identity.listOrganizationMembershipsForSubject(f.client,'subject')).length,0);
      await f.pg.exec(`UPDATE ${g}.organizations SET status='pending'`);
      assert.equal((await identity.listOrganizationMembershipsForSubject(f.client,'subject')).length,1);
    },
    async 'default workspaces, workspace defaults and account defaults are idempotent'(){
      await ensure();const before=await f.snapshot(g);await ensure();assert.deepEqual(await f.snapshot(g),before);
      assert.deepEqual(await rows(`SELECT id FROM ${g}.workspaces WHERE is_default ORDER BY id`),[{id:'organization:org'},{id:'personal:user'}]);
      assert.equal(await scalar(`SELECT count(*) FROM ${g}.guardrails WHERE is_workspace_default`),'4');
      assert.equal(await scalar(`SELECT count(*) FROM ${g}.guardrails WHERE is_account_default`),'2');
      assert.equal(await scalar(`SELECT count(*) FROM ${g}.guardrail_versions`),'6');
      assert.deepEqual(await rows(`SELECT workspace_id FROM ${g}.guardrails WHERE is_account_default ORDER BY workspace_id`),[{workspace_id:'organization:org'},{workspace_id:'personal:user'}]);
    },
    async 'workspace access uses exact owner and custom/default organization membership rules'(){
      const found=await list();assert.deepEqual(found.map(x=>x.id).sort(),['org-workspace','organization:org','personal:user','workspace']);
      assert.equal(found.find(x=>x.id==='workspace').role,'owner');assert.equal(found.find(x=>x.id==='org-workspace').role,'member');
      await f.pg.exec(`UPDATE ${g}.workspace_memberships SET role='admin';UPDATE ${g}.organization_memberships SET roles_json='["member","billing_admin","member"]'`);
      const row=await get('org-workspace');assert.equal(row.role,'admin');assert.deepEqual(row.organizationRoles,['billing_admin','member']);
      await f.pg.exec(`UPDATE ${g}.workspace_memberships SET status='removed'`);assert.equal(await get('org-workspace'),null);assert.notEqual(await get('organization:org'),null);
      await f.pg.exec(`UPDATE ${g}.organization_memberships SET status='removed'`);assert.equal(await get('organization:org'),null);
    },
    async 'browser workspace preference never authorizes another account'(){
      const context=await workspace.resolveWorkspaceContextForSubject(f.client,{...principal,preferredWorkspaceId:'other-workspace'});
      assert.equal(context.preferredWorkspaceAvailable,false);assert.equal(context.currentWorkspace.id,'personal:user');
      const valid=await workspace.resolveWorkspaceContextForSubject(f.client,{...principal,preferredWorkspaceId:'org-workspace'});
      assert.equal(valid.currentWorkspace.id,'org-workspace');assert.equal(valid.preferredWorkspaceAvailable,true);
      assert.equal(await get('other-workspace'),null);
    },
    async 'active workspace filters honor archived workspace and suspended organization'(){
      await ensure();await f.pg.exec(`UPDATE ${g}.workspaces SET status='archived' WHERE id='workspace';UPDATE ${g}.organizations SET status='suspended'`);
      assert.deepEqual((await list()).map(x=>x.id),['personal:user']);
    },
    async 'late guardrail-version constraint failure rolls back all six provisioning statements'(){
      await f.pg.exec(`ALTER TABLE ${g}.guardrail_versions ADD CONSTRAINT projection_reject_version CHECK (config_json <> '{}')`);
      try{
        const before=await f.snapshot(g);await assert.rejects(ensure(),/projection_reject_version/);assert.deepEqual(await f.snapshot(g),before);assert.deepEqual(f.transactions,[{state:'rolled_back'}]);
      }finally{await f.pg.exec(`ALTER TABLE ${g}.guardrail_versions DROP CONSTRAINT projection_reject_version`);}
    },
    async 'invalid workspace preference is rejected without querying the database'(){
      assert.equal(await get('x'.repeat(601)),null);assert.equal(await get(''),null);assert.equal(f.queries.length,0);
    },
    async 'missing gateway relations fail closed without reading or writing shadows'(){
      for(const [table,action]of [['identity_event_inbox',()=>apply(event('missing'))],['workspaces',()=>list()]]){
        await f.pg.exec(`ALTER TABLE ${g}.${table} RENAME TO projection_hidden`);
        try{await assert.rejects(action(),/does not exist/);}finally{await f.pg.exec(`ALTER TABLE ${g}.projection_hidden RENAME TO ${table}`);}
      }
    },
  };
  for(const [name,input,setup]of [
    ['wrong subject',{userId:'user',subject:'forged'},''],
    ['wrong local user',{userId:'other',subject:'subject'},''],
    ['missing local user',{userId:'missing',subject:'subject'},''],
    ['disabled user',principal,`UPDATE ${g}.users SET status='disabled' WHERE id='user'`],
    ['missing external identity',principal,`UPDATE ${g}.users SET external_system=NULL,external_user_id=NULL WHERE id='user'`],
  ])cases['invalid principal '+name+' cannot provision or read']=async()=>{
    if(setup)await f.pg.exec(setup);const before=await f.snapshot(g);assert.deepEqual(await list(input),[]);assert.deepEqual(await f.snapshot(g),before);
    await assert.rejects(workspace.resolveWorkspaceContextForSubject(f.client,input),/No accessible Workspace/);assert.deepEqual(await f.snapshot(g),before);
  };
  for(const path of ['public, pg_temp','pg_catalog','pg_temp, public'])for(const[name,action]of Object.entries(cases))await t.test(path+': '+name,async()=>{
    const shadows=await f.reset(path);
    try{await action();}finally{assert.deepEqual(await f.snapshot('public'),shadows.public);assert.deepEqual(await f.snapshot('pg_temp'),shadows.temp);}
    assert.equal(await scalar('SHOW search_path'),path);
  });
});
