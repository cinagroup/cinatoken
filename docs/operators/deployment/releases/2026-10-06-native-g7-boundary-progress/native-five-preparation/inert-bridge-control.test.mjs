import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parse } from 'file:///C:/cinagroup/cinatoken/node_modules/acorn/dist/acorn.mjs';
import ts from 'file:///C:/cinagroup/cinatoken/node_modules/typescript/lib/typescript.js';
const repo='file:///C:/cinagroup/cinatoken/';
const target=await readFile(new URL('scripts/db/cutover/postgres-complete-text-secretless-plan-v365.native.test.mjs',repo),'utf8');
const helperUrl=new URL('scripts/db/cutover/pg73-native-fixture.mjs',repo);
const helper=await readFile(helperUrl,'utf8');
const grant=await readFile(new URL('scripts/db/cutover/grant-postgres-runtime.ts',repo),'utf8');
const auditBody=await readFile(new URL('packages/core/migrations-postgres/0074_config_change_audit.sql',repo),'utf8');
const ast=parse(target,{ecmaVersion:'latest',sourceType:'module'});
let wrapperSource,negativeSource;
function walk(node){if(!node||typeof node!=='object')return;if(node.type==='VariableDeclarator'&&node.id?.name==='grantPostgresRuntime')wrapperSource=target.slice(node.init.start,node.init.end);if(node.type==='CallExpression'&&node.callee?.object?.name==='assert'&&node.callee?.property?.name==='rejects'&&target.slice(node.start,node.end).includes('Request capability v356 is installed'))negativeSource=target.slice(node.start,node.end);for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);}}
walk(ast);assert.ok(wrapperSource&&negativeSource);
const sourceFile=ts.createSourceFile('grant.ts',grant,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const grantNode=sourceFile.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='grantPostgresRuntime');
assert.ok(grantNode);
const grantFunction=ts.transpileModule(grantNode.getText(sourceFile).replace('export ',''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const createProduction=postgres=>new Function('postgres','GATEWAY_MIGRATOR_ROLE','GATEWAY_RUNTIME_ROLE','GATEWAY_SCHEMA','GRANT_LOCK_KEY','console',grantFunction+'\nreturn grantPostgresRuntime;')(postgres,'cinatoken_gateway_migrator','cinatoken_gateway_runtime','cinatoken_gateway',746923553,{log(){}});
const makeBridge=production=>new Function('assert','readFile','readdir','createHash','grantPostgresRuntime',helper.replace(/^import[^\n]*\n/gm,'').replaceAll('export async function','async function').replaceAll('import.meta.url',JSON.stringify(helperUrl.href))+'\nreturn grantPg73RuntimeFixture;')(assert,readFile,readdir,createHash,production);
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const exactNegative=new AsyncFunction('assert','grantPostgresRuntime','migratorUrl','await '+negativeSource+';');
function model({buyerSplit=false,membership=false}={}){
  const state={audit:false,ledger:73,buyerSplit,membership,login:true,broadGrants:0,productionCalls:0,productionClosed:0,events:[]};
  const role=()=>({can_login:state.login,is_superuser:false,can_create_database:false,can_create_role:false,can_replicate:false,can_bypass_rls:false,inherits:true,has_memberships:state.membership});
  const admin={unsafe:async(sql)=>{state.events.push({kind:'admin',sql});if(sql.includes('SELECT rolcanlogin'))return [role()];throw Error('Unexpected admin SQL: '+sql);}};
  const migrator={unsafe:async(sql,params)=>{state.events.push({kind:'migrator',sql});if(sql.includes('SELECT current_user AS current_role'))return [{current_role:'cinatoken_gateway_migrator',schema_owner:'cinatoken_gateway_migrator',migration_count:state.ledger,migration_md5:'ca1ea96a1b4bcd0675642f30dcf48042',audit_table:state.audit,audit_ledger:state.audit}];if(sql===auditBody){assert.equal(state.audit,false);state.audit=true;return [];}if(sql.includes('INSERT INTO cinatoken_gateway.schema_migrations')){assert.deepEqual(params,['0074_config_change_audit.sql']);state.ledger++;return [];}if(sql.includes('SELECT\n      pg_catalog.has_table_privilege'))return [{can_insert:true,can_select:false,can_update:false,can_delete:false}];if(sql==='DROP TABLE cinatoken_gateway.config_change_audit'){state.audit=false;return [];}if(sql.includes('DELETE FROM cinatoken_gateway.schema_migrations')){state.ledger--;return [];}throw Error('Unexpected migrator SQL: '+sql);},begin:async fn=>fn(migrator)};
  const unsafe=migrator.unsafe;
  migrator.unsafe=(...args)=>{const pending=unsafe(...args);pending.simple=()=>pending;return pending;};
  const postgres=url=>{state.productionCalls++;assert.equal(url,'postgres://cinatoken_gateway_migrator:synthetic@127.0.0.1:54321/postgres');const sql=async(strings)=>{const text=strings.join('?');state.events.push({kind:'production-query',sql:text});if(text.includes('SELECT current_user AS user_name'))return [{user_name:'cinatoken_gateway_migrator',schema_owner:'cinatoken_gateway_migrator'}];if(text.includes("version = '0074_config_change_audit.sql'"))return [{applied:state.audit}];if(text.includes('pg_advisory_xact_lock'))return [];if(text.includes('authenticated_request_capabilities_v356'))return [{installed:state.buyerSplit}];if(text.includes('buyer_split_grant_policy_v348'))return [{active:false}];throw Error('Unexpected production query: '+text);};sql.begin=async fn=>fn(sql);sql.unsafe=async text=>{state.events.push({kind:'production-unsafe',sql:text});assert.equal(state.membership,false);assert.equal(state.login,true);state.broadGrants++;return [];};sql.end=async()=>{state.productionClosed++;};return sql;};
  const production=createProduction(postgres),bridge=makeBridge(production),cluster={owned:'inert-owned-fixture',port:54321,admin};
  const wrapper=new Function('grantPg73RuntimeFixture','cluster','migrator','return ('+wrapperSource+');')(bridge,cluster,migrator);
  return {state,cluster,migrator,wrapper,bridge,production,url:'postgres://cinatoken_gateway_migrator:synthetic@127.0.0.1:54321/postgres'};
}
test('actual source wrapper and bridge preserve LOGIN and restore PG73 after initial production success',async()=>{
  const m=model();await m.wrapper({DATABASE_URL:m.url});
  assert.equal(m.state.audit,false);assert.equal(m.state.ledger,73);assert.equal(m.state.login,true);assert.equal(m.state.membership,false);assert.equal(m.state.broadGrants,1);assert.equal(m.state.productionClosed,1);assert.ok(m.state.events.every(event=>!event.sql.includes('ALTER ROLE')));
});
test('original exact Request capability assert reaches actual production marker guard and bridge finally restores PG73',async()=>{
  const m=model({buyerSplit:true});await exactNegative(assert,m.wrapper,m.url);
  assert.equal(m.state.audit,false);assert.equal(m.state.ledger,73);assert.equal(m.state.login,true);assert.equal(m.state.broadGrants,0);assert.equal(m.state.productionCalls,1);assert.equal(m.state.productionClosed,1);assert.ok(m.state.events.some(event=>event.kind==='production-query'&&event.sql.includes('authenticated_request_capabilities_v356')));
});
test('unchanged direct production grant without bridge hits real 0074 preflight before Request capability',async()=>{
  const m=model({buyerSplit:true});await assert.rejects(m.production({DATABASE_URL:m.url}),/0074_config_change_audit.sql is required/);
  assert.equal(m.state.broadGrants,0);assert.equal(m.state.productionClosed,1);assert.ok(!m.state.events.some(event=>event.sql.includes('authenticated_request_capabilities_v356')));
});
test('owned URL admission rejects remote target before any inert SQL call',async()=>{
  const m=model();await assert.rejects(m.wrapper({DATABASE_URL:m.url.replace('127.0.0.1','example.invalid')}),/owned loopback migrator URL/);
  assert.equal(m.state.events.length,0);assert.equal(m.state.productionCalls,0);
});
test('runtime membership admission rejects before 0074 installation and leaves original role intact',async()=>{
  const m=model({membership:true});await assert.rejects(m.wrapper({DATABASE_URL:m.url}),/restricted and have no role memberships/);
  assert.equal(m.state.audit,false);assert.equal(m.state.ledger,73);assert.equal(m.state.membership,true);assert.equal(m.state.login,true);assert.equal(m.state.productionCalls,0);
});
test('original exact Request capability assertion still fails on an unrelated production error while bridge cleans audit',async()=>{
  const m=model({buyerSplit:true});const unrelated=async()=>{throw Error('unrelated failure');};const bridge=makeBridge(unrelated);const wrapper=new Function('grantPg73RuntimeFixture','cluster','migrator','return ('+wrapperSource+');')(bridge,m.cluster,m.migrator);
  await assert.rejects(exactNegative(assert,wrapper,m.url),error=>error.code==='ERR_ASSERTION');
  assert.equal(m.state.audit,false);assert.equal(m.state.ledger,73);assert.equal(m.state.login,true);
});
