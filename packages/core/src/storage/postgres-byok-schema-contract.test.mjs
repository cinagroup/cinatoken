import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const tables=new Set(['users','organizations','workspaces','management_api_keys','byok_keys','user_audit_logs','guardrails']);
for(const[file,expected]of [['./byok-keys.ts',47],['../db/postgres/users.impl.ts',2]])test(file+': PostgreSQL raw tables are qualified without leaking into other dialects',()=>{
  const source=readFileSync(new URL(file,import.meta.url),'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);let count=0;const ranges=[];
  function inspect(n){
    if(ts.isStringLiteralLike(n)||[ts.SyntaxKind.TemplateHead,ts.SyntaxKind.TemplateMiddle,ts.SyntaxKind.TemplateTail].includes(n.kind))for(const m of n.text.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([\w.]+)/gi)){const table=m[1].split('.').at(-1);if(tables.has(table)){assert.equal(m[1],'cinatoken_gateway.'+table);count++;}}
    ts.forEachChild(n,inspect);
  }
  function visit(n){
    if(ts.isFunctionDeclaration(n)&&n.name?.text==='postgresActiveOwnerPredicate'){inspect(n);ranges.push([n.getStart(ast),n.end]);return;}
    if(ts.isIfStatement(n)&&ts.isBinaryExpression(n.expression)&&n.expression.left.getText(ast)==='client.driver'&&n.expression.right.text==='postgres'){inspect(n.thenStatement);ranges.push([n.thenStatement.getStart(ast),n.thenStatement.end]);return;}
    ts.forEachChild(n,visit);
  }
  if(file.endsWith('users.impl.ts'))inspect(ast);else {visit(ast);let other=source;for(const[a,b]of ranges.reverse())other=other.slice(0,a)+other.slice(b);assert.ok(!other.includes('cinatoken_gateway.'));}
  assert.equal(count,expected);
});
