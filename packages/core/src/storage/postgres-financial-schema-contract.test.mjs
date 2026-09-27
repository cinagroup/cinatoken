import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = relative => readFileSync(new URL(relative,import.meta.url),'utf8');
const tables = new Set(['guardrail_budget_reservations','guardrail_budget_windows','api_key_request_logs','workspace_budgets','workspaces','api_keys']);
for (const file of ['../db/postgres/critical-writes.impl.ts','../db/postgres/guardrail-budgets.impl.ts']) {
  test(file+': raw financial table positions are schema-qualified',()=>{
    const ast=ts.createSourceFile(file,source(file),ts.ScriptTarget.Latest,true);
    let positions=0;
    function visit(node) {
      if(ts.isStringLiteralLike(node)||[ts.SyntaxKind.TemplateHead,ts.SyntaxKind.TemplateMiddle,ts.SyntaxKind.TemplateTail].includes(node.kind)) {
        for(const match of node.text.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([\w.]+)/gi)) {
          const name=match[1].split('.').at(-1);
          if(tables.has(name)){positions++;assert.equal(match[1],'cinatoken_gateway.'+name);}
        }
      }
      ts.forEachChild(node,visit);
    }
    visit(ast);
    assert.equal(positions,file.includes('critical-writes')?2:20);
  });
}
test('all migration-defined gateway functions have an explicit trusted search path',()=>{
  const dir=new URL('../../migrations-postgres/',import.meta.url);
  const names=new Set(readdirSync(dir).filter(file=>file.endsWith('.sql')&&file<='0068_function_schema_resolution.sql').flatMap(file=>[
    ...readFileSync(new URL(file,dir),'utf8').matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_]+)/gi),
  ].map(match=>match[1])));
  const sql=readFileSync(new URL('0068_function_schema_resolution.sql',dir),'utf8').replace(/--[^\n]*/g,'');
  const statements=[...sql.matchAll(/ALTER FUNCTION cinatoken_gateway\.([a-z_]+)\([^)]*\)\s+SET search_path TO pg_catalog, cinatoken_gateway, pg_temp;/g)];
  assert.equal(statements.length,10);assert.deepEqual(new Set(statements.map(match=>match[1])),names);
  assert.equal(sql.replace(/ALTER FUNCTION[\s\S]*?;/g,'').trim(),'');
});
test('actual settlement CASE branches carry an explicit integer type',()=>{
  const text=source('../db/postgres/critical-writes.impl.ts');
  assert.match(text,/THEN \$\{byokStandardMicros\}::bigint\s+ELSE \$\{budgetChargedMicros\}::bigint/);
});
