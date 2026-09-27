import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

for(const [file,expected,mixed] of [['../db/postgres/api-keys.impl.ts',22,false],['./management-api-keys.ts',15,true]])test(file+': PostgreSQL raw table names are explicit',()=>{
  const text=readFileSync(new URL(file,import.meta.url),'utf8');
  const ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
  let count=0,branches=0;
  function inspect(node){
    if(ts.isStringLiteralLike(node)||[ts.SyntaxKind.TemplateHead,ts.SyntaxKind.TemplateMiddle,ts.SyntaxKind.TemplateTail].includes(node.kind)){
      for(const match of node.text.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([\w.]+)/gi)){
        assert.match(match[1],/^cinatoken_gateway\.[a-z_]+$/);count++;
      }
    }
    ts.forEachChild(node,inspect);
  }
  function visit(node){
    if(ts.isIfStatement(node)&&node.expression.getText(ast)==='client.driver === "postgres"'){branches++;inspect(node.thenStatement);return;}
    ts.forEachChild(node,visit);
  }
  if(mixed){visit(ast);assert.equal(branches,1);}else inspect(ast);
  assert.equal(count,expected);
});
