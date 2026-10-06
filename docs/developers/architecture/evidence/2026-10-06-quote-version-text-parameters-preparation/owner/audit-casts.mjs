import assert from'node:assert/strict';import{readFile,writeFile}from'node:fs/promises';import{join}from'node:path';import{createRequire}from'node:module';
import{out,repo,command,success,info}from'./capture.mjs';
const input=JSON.parse(await readFile(join(out,'inputs.json'),'utf8'));
const original=success(await command('audit-original-git','git',['show',input.baseCommit+':'+input.target]));
assert.deepEqual(info(original),input.before);assert.deepEqual(original,await readFile(join(out,'source.before.mjs')));
const after=await readFile(join(repo,input.target));assert.deepEqual(after,await readFile(join(out,'source.prepared-after.mjs')));
let reverse=after.toString();const allowedReverse=[
 ['SELECT $1::text::timestamptz >= $2::text::timestamptz AS after_insert','SELECT $1::timestamptz >= $2::timestamptz AS after_insert',1],
 ["resolve_shared_key_quote_at_time('quote-key-a',$1::text::timestamptz)","resolve_shared_key_quote_at_time('quote-key-a',$1)",2]
];for(const[from,to,count]of allowedReverse){assert.equal(reverse.split(from).length-1,count);reverse=reverse.replaceAll(from,to)}
assert.deepEqual(Buffer.from(reverse),original,'Complete reverse is original bytes with exactly4 cast insertions');
const ts=createRequire(join(repo,'package.json'))('typescript');
function collect(text){const ast=ts.createSourceFile(input.target,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);assert.equal(ast.parseDiagnostics.length,0);
 const groups={assertions:[],templates:[],sql:[],transactions:[],grants:[],imports:[],cleanup:[],nativeOptions:[],conditions:[],waits:[]};
 const shape=n=>{const children=[];ts.forEachChild(n,c=>{children.push(shape(c))});return{kind:n.kind,...(!children.length?{text:n.getText(ast)}:{}),children}};
 const add=(key,n)=>groups[key].push({source:n.getText(ast),ast:shape(n),line:ast.getLineAndCharacterOfPosition(n.getStart(ast)).line+1});
 function visit(n){if(ts.isCallExpression(n)){const name=n.expression.getText(ast);
  if(/^assert\./.test(name))add('assertions',n);if(/\.unsafe$/.test(name))add('sql',n);if(/\.begin$/.test(name))add('transactions',n);
  if(/^(grantPostgresRuntime|grantPg73RuntimeFixture|listPg73Migrations)$/.test(name))add('grants',n);
  if(/\.(cleanup|end|stop)$/.test(name))add('cleanup',n);if(name==='test'&&n.arguments[1])add('nativeOptions',n.arguments[1]);
  if(name==='delay'||/^release/.test(name))add('waits',n);
 }if(ts.isImportDeclaration(n))add('imports',n);if(ts.isTemplateExpression(n)||ts.isNoSubstitutionTemplateLiteral(n))add('templates',n);
 if(ts.isIfStatement(n))add('conditions',n.expression);ts.forEachChild(n,visit)}visit(ast);return{groups,wholeAst:shape(ast)};
}
const before=collect(original.toString()),current=collect(after.toString()),restored=collect(reverse);
assert.equal(before.groups.assertions.length,65);assert.equal(current.groups.assertions.length,65);
assert.deepEqual(restored,before,'All original65 assertion sources and AST plus complete restored module match');
const changed=(key)=>{assert.equal(current.groups[key].length,before.groups[key].length);return before.groups[key].flatMap((b,i)=>JSON.stringify(b)===JSON.stringify(current.groups[key][i])?[]:[{index:i,originalLine:b.line,before:b.source,after:current.groups[key][i].source}])};
const changedAssertions=changed('assertions'),changedSql=changed('sql'),changedTemplates=changed('templates');
assert.equal(changedAssertions.length,1);assert.equal(changedAssertions[0].originalLine,470);assert.equal(changedSql.length,3);assert.equal(changedTemplates.length,3);
for(const key of['transactions','grants','imports','cleanup','nativeOptions','conditions','waits'])assert.deepEqual(current.groups[key],before.groups[key],'Unchanged source and AST '+key);
for(const difference of changedSql)assert.ok(difference.after.includes('::text::timestamptz'));
assert.deepEqual(changedSql.map(x=>x.originalLine),[470,472,496]);
const protectedInputs=[];
for(const p of input.protection){assert.deepEqual(info(await readFile(join(repo,p.path))),{bytes:p.bytes,sha256:p.sha256});protectedInputs.push({...p,currentBytesExact:true})}
await writeFile(join(out,'source.after.mjs'),after,{flag:'wx'});
const result={at:new Date().toISOString(),actualExit:0,baseCommit:input.baseCommit,target:input.target,before:info(original),after:info(after),
 onlyFourCastInsertions:true,wholeReverseBytesExact:true,completeReversedAstExact:true,
 originalAssertionCount:65,directRawAssertionSourceExact:64,all65AssertionSourceAndAstExactAfterOnlyAuthorizedCastReverse:true,
 authorizedNestedAssertionSqlOnlyChange:changedAssertions,changedThreeSqlQueries:changedSql,
 otherSqlQueriesSourceAndAstExact:true,sqlCount:before.groups.sql.length,templateCount:before.groups.templates.length,
 transactionsGrantsLoaderImportsCleanupConditionsWaitsOptionsExact:true,
 fullOriginalAstSha256:info(Buffer.from(JSON.stringify(before.wholeAst))).sha256,
 originalAll65AssertSourceAstSha256:info(Buffer.from(JSON.stringify(before.groups.assertions))).sha256,
 originalOptions:before.groups.nativeOptions.map(x=>x.source),originalWaits:before.groups.waits.map(x=>x.source),protectedInputs,
 driverOfflineBoundary:'The separate one-run3.4.9 serializer control is purely offline and does not confirm actual PG root cause or native success.',
 repositoryWritesByAudit:0,nativeExecuted:false};
await writeFile(join(out,'independent-cast-audit.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({actualExit:0,originalAssertions:65,directRawExact:64,all65AfterAuthorizedReverseExact:true,changedSqlQueries:3,onlyParameterCasts:4,protectedInputs:protectedInputs.length,...info(after)}));
