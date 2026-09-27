import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import * as workspace from './workspaces.ts';

const tableNames=new Set(['users','organizations','organization_memberships','workspaces','workspace_memberships','identity_event_inbox','guardrails','guardrail_versions']);
for(const[file,expected]of [['organization-identity.ts',9],['workspaces.ts',18]])test(file+': PG-specific projection SQL is qualified',()=>{
  const source=readFileSync(new URL(file,import.meta.url),'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
  let count=0;
  function inspect(n){
    if(ts.isStringLiteralLike(n)||[ts.SyntaxKind.TemplateHead,ts.SyntaxKind.TemplateMiddle,ts.SyntaxKind.TemplateTail].includes(n.kind))for(const m of n.text.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([\w.]+)/gi)){
      const table=m[1].split('.').at(-1);if(tableNames.has(table)){assert.equal(m[1],'cinatoken_gateway.'+table);count++;}
    }
    ts.forEachChild(n,inspect);
  }
  function visit(n){
    if((ts.isFunctionDeclaration(n)&&n.name?.text==='applyPostgres')||(ts.isIfStatement(n)&&ts.isBinaryExpression(n.expression)&&n.expression.left.getText(ast)==='client.driver'&&n.expression.right.text==='postgres')){inspect(n);return;}
    ts.forEachChild(n,visit);
  }
  visit(ast);assert.equal(count,expected);
});

async function capture(module,driver){
  const calls=[],save=(query,params=[])=>{calls.push({query,params});return [];};
  let raw;
  if(driver==='postgres'){
    const sql=(strings,...params)=>save(strings.reduce((s,p,i)=>s+(i?'$'+i:'')+p,''),params);
    raw=Object.assign(sql,{unsafe:save,begin:callback=>callback(sql)});
  }else if(driver==='mysql'){
    const connection={beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release(){},execute:async(q,p)=>[save(q,p),{}]};
    raw={getConnection:async()=>connection,execute:connection.execute};
  }else{
    raw={prepare:query=>({bind:(...params)=>{save(query,params);return {all:async()=>({results:[]})};}}),batch:async()=>[]};
  }
  await module.listAccessibleWorkspacesForSubject({driver,raw,drizzle:{}},{userId:'user',subject:'subject'});
  return calls;
}
for(const driver of ['d1','mysql','postgres'])test(driver+': shared access SQL uses the intended tables and parameter shape',async()=>{
  const calls=await capture(workspace,driver);assert.equal(calls.length,7);
  const access=calls.at(-1);
  const tables=[...access.query.matchAll(/\b(?:FROM|JOIN)\s+([\w.]+)/gi)].map(m=>m[1]);
  assert.equal(tables.length,7);
  for(const table of tables)assert.equal(table,driver==='postgres'?'cinatoken_gateway.'+table.split('.').at(-1):table.split('.').at(-1));
  assert.deepEqual(access.params,driver==='postgres'?['subject','user',null]:driver==='mysql'?['subject','subject','user','subject','user','subject','subject',null,null]:['subject','subject',1,'user','subject','user','subject',1,'subject',null,null]);
  if(driver!=='postgres'&&process.env.GATEWAY_PG_PROJECTION_COMPARE_DIR){
    const before=await import(pathToFileURL(resolve(process.env.GATEWAY_PG_PROJECTION_COMPARE_DIR,'workspaces.js')).href);
    assert.deepEqual(calls,await capture(before,driver),'all seven D1/MySQL SQL statements and bindings remain byte-equivalent');
  }
});
