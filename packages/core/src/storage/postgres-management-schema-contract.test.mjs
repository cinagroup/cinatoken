import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const tables=new Set(['users','organizations','organization_memberships','workspaces','workspace_memberships','management_api_keys','api_keys','guardrails','guardrail_versions','user_audit_logs']);
for(const[file,expected]of [['management-workspaces.ts',28],['management-workspace-members.ts',23]])test(file+': all PG table sites are statically schema qualified',()=>{
  const source=readFileSync(new URL(file,import.meta.url),'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);let count=0;const ranges=[];
  function inspect(n){
    if(ts.isStringLiteralLike(n)||[ts.SyntaxKind.TemplateHead,ts.SyntaxKind.TemplateMiddle,ts.SyntaxKind.TemplateTail].includes(n.kind))for(const m of n.text.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([\w.]+)/gi)){
      const table=m[1].split('.').at(-1);if(tables.has(table)){assert.equal(m[1],'cinatoken_gateway.'+table);count++;}
    }
    ts.forEachChild(n,inspect);
  }
  function visit(n){
    if((ts.isFunctionDeclaration(n)&&n.name?.text==='postgresActiveManagementKeyPredicate')||(ts.isIfStatement(n)&&ts.isBinaryExpression(n.expression)&&n.expression.left.getText(ast)==='client.driver'&&n.expression.right.text==='postgres')){inspect(n);ranges.push([n.getStart(ast),n.end]);return;}
    ts.forEachChild(n,visit);
  }
  visit(ast);assert.equal(count,expected);
  let other=source;for(const[a,b]of ranges.reverse())other=other.slice(0,a)+other.slice(b);
  assert.ok(!other.includes('cinatoken_gateway.'),'D1/MySQL and shared paths cannot use the PostgreSQL schema');
});
