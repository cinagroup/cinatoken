import assert from'node:assert/strict';import{readFile,writeFile}from'node:fs/promises';import{join,resolve}from'node:path';import{createRequire}from'node:module';
import{command,file,success,out,repo,info}from'./capture.mjs';
const baseCommit='4a9b4fb984035bb62ec5930cce01f8da605f476f',target='scripts/db/cutover/postgres-shared-key-quote-versions.native.test.mjs';
const head=success(await command('head','git',['rev-parse','HEAD'])).toString().trim();assert.equal(head,baseCommit);
const before=success(await command('original-source','git',['show',baseCommit+':'+target]));
assert.deepEqual(info(before),{bytes:34823,sha256:'16ef4b701728c9de46ea932851354d7cee2aa9d80c6ab543ceae6f4526380c83'});
const current=await file('current-source',join(repo,target));assert.equal(current.receipt.actualExit,0);assert.deepEqual(current.stdout,before);
const blob=success(await command('original-blob','git',['rev-parse',baseCommit+':'+target])).toString().trim();
const diag=await file('frozen-diagnosis','C:/Users/cina/AppData/Local/Temp/cinatoken-quote-version-next-readonly-gn9DdD/FINAL-quote-version-499-readonly-diagnosis.json');
assert.equal(diag.receipt.actualExit,0);assert.deepEqual(info(diag.stdout),{bytes:26643,sha256:'92f7916e867d6e8c807b0c5dc50ca04321fb5d1c9d0248be477e735fd1706975'});
const require=createRequire(join(repo,'package.json')),ts=require('typescript'),ast=ts.createSourceFile(target,before.toString(),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
assert.equal(ast.parseDiagnostics.length,0);
const imports=[],urls=[];function visit(n){
 if(ts.isImportDeclaration(n)&&ts.isStringLiteral(n.moduleSpecifier))imports.push({module:n.moduleSpecifier.text,source:n.getText(ast)});
 if(ts.isNewExpression(n)&&n.expression.getText(ast)==='URL'&&n.arguments&&ts.isStringLiteralLike(n.arguments[0]))urls.push({value:n.arguments[0].text,source:n.getText(ast)});
 ts.forEachChild(n,visit)}visit(ast);
console.log('urls',JSON.stringify(urls));
const protectionPaths=new Set(['package-lock.json','node_modules/postgres/package.json','node_modules/postgres/src/types.js','node_modules/postgres/src/errors.js']);
for(const i of imports)if(i.module.startsWith('.'))protectionPaths.add(resolve(repo,'scripts/db/cutover',i.module).replaceAll('\\','/').replace(repo+'/',''));
for(const u of urls){if(u.value.endsWith('.sql')){const candidate=resolve(repo,'scripts/db/cutover',u.value).replaceAll('\\','/');if(candidate.startsWith(repo+'/'))protectionPaths.add(candidate.slice(repo.length+1))}}
// Protect fixed native PG73 helper and its production runtime grant input.
protectionPaths.add('scripts/db/cutover/pg73-native-fixture.mjs');protectionPaths.add('scripts/db/cutover/grant-postgres-runtime.ts');
const protection=[];let index=0;
for(const path of protectionPaths){const r=await file('protected-'+index++,join(repo,path));assert.equal(r.receipt.actualExit,0,'Necessary input exists: '+path);protection.push({path,...info(r.stdout)})}
const lock=JSON.parse(await readFile(join(repo,'package-lock.json'),'utf8')),installed=JSON.parse(await readFile(join(repo,'node_modules/postgres/package.json'),'utf8'));
assert.equal(lock.packages['node_modules/postgres'].version,'3.4.9');assert.equal(installed.version,'3.4.9');
const instructions=[];for(const[p,i]of['C:/AGENTS.md','C:/cinagroup/AGENTS.md',join(repo,'AGENTS.md'),join(repo,'scripts/AGENTS.md'),join(repo,'scripts/db/AGENTS.md'),join(repo,'scripts/db/cutover/AGENTS.md')].map((p,i)=>[p,i])){
 const r=await file('instructions-'+i,p);instructions.push(r.receipt)}
const data={at:new Date().toISOString(),actualExit:0,baseCommit,head,target,originalBlob:blob,before:info(before),diagnosis:diag.receipt,imports,urls,protection,
 driver:{version:installed.version,lockVersion:lock.packages['node_modules/postgres'].version,integrity:lock.packages['node_modules/postgres'].integrity},typescriptVersion:ts.version,instructions,
 repositoryWrites:0,nativeExecuted:false};
await writeFile(join(out,'inputs.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx'});await writeFile(join(out,'source.before.mjs'),before,{flag:'wx'});
console.log(JSON.stringify({actualExit:0,target,...info(before),protectedFiles:protection.length,driverVersion:installed.version}));
