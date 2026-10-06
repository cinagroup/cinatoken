import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'file:///C:/cinagroup/cinatoken/node_modules/typescript/lib/typescript.js';
const target='C:/cinagroup/cinatoken/scripts/db/cutover/postgres-shared-key-usage-repair-runtime-grant.native.test.mjs';
const source=await fs.readFile(target,'utf8'),tree=ts.createSourceFile(target,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const names=['privileges','pg73State','runtimeState','repairAclState','rejectMembershipBeforeRuntimeGrant'];
const declarations=tree.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.includes(node.name?.text));
assert.equal(declarations.length,5);
const construct=Function('assert','readFile','listPg73Migrations','grantPostgresRuntime','schema','migrations',
  declarations.map(node=>node.getText(tree)).join('\n')+'\nreturn rejectMembershipBeforeRuntimeGrant;');
const auditMigration='0074_config_change_audit.sql';
const migrationURL=new URL('file:///C:/cinagroup/cinatoken/packages/core/migrations-postgres/');
const auditBody=await fs.readFile(new URL(auditMigration,migrationURL),'utf8');
const clone=value=>structuredClone(value);
function harness(fault=null){
  const original={role:{oid:'42',name:'cinatoken_gateway_runtime',can_login:false,is_superuser:false,
    can_create_database:false,can_create_role:false,can_replicate:false,can_bypass_rls:false,
    inherits:true,connection_limit:-1,valid_until:null,config:null},
    memberships:[{role_name:'shared_usage_repair_shadow',member_name:'cinatoken_gateway_runtime',
      grantor_name:'fixture_owned_admin',admin_option:false,inherit_option:true,set_option:true}],
    effective:{repair_table:true,enqueue:false,repair:true,ordinary_users_select:true},
    acl:[{kind:'table',name:'shared_key_usage_repair_jobs',owner:'43',acl:'original-job-acl'},
      {kind:'table',name:'users',owner:'43',acl:'original-users-acl'},
      {kind:'function',name:'enqueue_shared_key_usage_repair',owner:'43',acl:'original-enqueue-acl'},
      {kind:'function',name:'repair_one_shared_key_usage',owner:'43',acl:'original-repair-acl'}],
    audit:false,ledger:false};
  const state=clone(original),events=[];
  let directGrantCalls=0,loginFaultThrown=false;
  if(fault==='unexpected-membership')state.memberships.push({...state.memberships[0],role_name:'unexpected_shadow'});
  const sql={unsafe(text,args=[]){
    events.push({text,args});
    if(text.startsWith('SELECT current_user AS current_role')){
      assert.ok(text.includes("E'\\n'"),'SQL must retain the escaped newline ledger separator');
      return Promise.resolve([{current_role:'cinatoken_gateway_migrator',schema_owner:'cinatoken_gateway_migrator',
        migration_count:state.ledger?74:73,migration_md5:'ca1ea96a1b4bcd0675642f30dcf48042',
        audit_table:state.audit,audit_ledger:state.ledger}]);
    }
    if(text.startsWith('SELECT oid::text AS oid'))return Promise.resolve([clone(state.role)]);
    if(text.startsWith('SELECT parent.rolname AS role_name'))return Promise.resolve(clone(state.memberships));
    if(text.startsWith("SELECT 'table' AS kind"))return Promise.resolve(clone(state.acl));
    if(text.startsWith('SELECT\n\t\tpg_catalog.has_table_privilege'))return Promise.resolve([clone(state.effective)]);
    if(text===auditBody)return {simple:async()=>{
      state.audit=true;
      if(fault==='audit-install')throw new Error('synthetic audit install failure');
    }};
    if(text.startsWith('INSERT INTO cinatoken_gateway.schema_migrations')){assert.deepEqual(args,[auditMigration]);state.ledger=true;return Promise.resolve([]);}
    if(text==='ALTER ROLE cinatoken_gateway_runtime LOGIN'){
      state.role.can_login=true;
      if(fault==='login-ack'&&!loginFaultThrown){loginFaultThrown=true;throw new Error('synthetic LOGIN acknowledgement failure');}
      return Promise.resolve([]);
    }
    if(text==='ALTER ROLE cinatoken_gateway_runtime NOLOGIN'){state.role.can_login=false;return Promise.resolve([]);}
    if(text==='DROP TABLE IF EXISTS cinatoken_gateway.config_change_audit'){
      if(fault==='drop-cleanup')throw new Error('synthetic DROP cleanup failure');
      state.audit=false;return Promise.resolve([]);
    }
    if(text==='DELETE FROM cinatoken_gateway.schema_migrations WHERE version=$1'){
      assert.deepEqual(args,[auditMigration]);state.ledger=false;return Promise.resolve([]);
    }
    throw new Error('Unrecognized inert SQL operation: '+text.slice(0,100));
  },async begin(callback){
    const auditBefore=state.audit,ledgerBefore=state.ledger;
    try{return await callback(sql);}catch(error){state.audit=auditBefore;state.ledger=ledgerBefore;throw error;}
  }};
  const grant=async env=>{
    directGrantCalls++;
    assert.deepEqual(env,{DATABASE_URL:'postgres://cinatoken_gateway_migrator:synthetic@127.0.0.1:54321/postgres'});
    assert.equal(state.audit,true);assert.equal(state.ledger,true);assert.equal(state.role.can_login,true);
    if(fault==='acl-mutation')state.acl[0].acl='unexpected-grant-mutation';
    throw Object.assign(new Error(fault==='wrong-message'?'Wrong production rejection':'Runtime must be a restricted direct LOGIN without role memberships'),
      {code:fault==='wrong-sqlstate'?'23514':'P0001'});
  };
  const reject=construct(assert,fs.readFile,async()=>Array(73).fill('historical-file'),grant,'cinatoken_gateway',migrationURL);
  const args={cluster:{owned:'inert-owned-cluster',port:54321,admin:sql},migrator:sql,
    databaseUrl:'postgres://cinatoken_gateway_migrator:synthetic@127.0.0.1:54321/postgres'};
  const unchanged=()=>{assert.deepEqual(state,original);};
  return {run:()=>reject(args),state,original,events,unchanged,get directGrantCalls(){return directGrantCalls;}};
}
test('exact production rejection restores audit, NOLOGIN, ACL and membership snapshots',async()=>{
  const h=harness();await h.run();h.unchanged();assert.equal(h.directGrantCalls,1);
});
for(const fault of ['wrong-message','wrong-sqlstate']){
  test(fault+' fails the exact production predicate and still restores prerequisites',async()=>{
    const h=harness(fault);await assert.rejects(h.run(),error=>error.code==='ERR_ASSERTION');
    h.unchanged();assert.equal(h.directGrantCalls,1);
  });
}
test('business ACL mutation is detected while temporary audit and LOGIN still close',async()=>{
  const h=harness('acl-mutation');await assert.rejects(h.run(),error=>error.code==='ERR_ASSERTION');
  assert.equal(h.state.audit,false);assert.equal(h.state.ledger,false);assert.equal(h.state.role.can_login,false);
  assert.deepEqual(h.state.memberships,h.original.memberships);assert.notDeepEqual(h.state.acl,h.original.acl);
});
test('audit install failure still closes its attempted scope without calling grant',async()=>{
  const h=harness('audit-install');await assert.rejects(h.run(),/synthetic audit install failure/);
  h.unchanged();assert.equal(h.directGrantCalls,0);
});
test('LOGIN acknowledgement failure still attempts NOLOGIN restoration',async()=>{
  const h=harness('login-ack');await assert.rejects(h.run(),/synthetic LOGIN acknowledgement failure/);
  h.unchanged();assert.equal(h.directGrantCalls,0);
});
test('audit cleanup failure remains a failure and nested finally restores NOLOGIN',async()=>{
  const h=harness('drop-cleanup');await assert.rejects(h.run(),/synthetic DROP cleanup failure/);
  assert.equal(h.state.role.can_login,false);assert.equal(h.state.audit,true);assert.equal(h.state.ledger,true);
  assert.deepEqual(h.state.memberships,h.original.memberships);assert.deepEqual(h.state.acl,h.original.acl);
});
test('unexpected membership rejects before prerequisite mutation or grant',async()=>{
  const h=harness('unexpected-membership');await assert.rejects(h.run(),error=>error.code==='ERR_ASSERTION');
  assert.equal(h.directGrantCalls,0);assert.equal(h.state.audit,false);assert.equal(h.state.role.can_login,false);
  assert.equal(h.events.some(event=>event.text.startsWith('ALTER ROLE')||event.text===auditBody),false);
});
// Every SQL/grant operation above is an inert stateful stub. These tests cover
// extracted JavaScript cleanup/error control flow, not PostgreSQL ACL or locks.
