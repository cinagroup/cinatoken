import assert from'node:assert/strict';import{createRequire}from'node:module';
import{readFile,writeFile}from'node:fs/promises';import{join,basename}from'node:path';import{pathToFileURL}from'node:url';
import{command,file,success,out,repo,info}from'./capture.mjs';
const inputs=JSON.parse(await readFile(join(out,'base-inputs.json'),'utf8'));
const owner=JSON.parse(await readFile(join(out,'prior-owner-final.stdout.log'),'utf8'));
const priorPins=JSON.parse(await readFile(join(out,'prior-pin-final.stdout.log'),'utf8'));
const allowed=new Set(inputs.allowedPaths),allowedWrappers=new Set(inputs.targets.map(t=>t.wrapper));
const protectionMap=new Map();
const add=(path,expected,group)=>{if(allowed.has(path))return;const existing=protectionMap.get(path);
 if(existing){assert.deepEqual(existing.expected,expected,'Consistent overlapping protection: '+path);existing.groups.push(group)}else protectionMap.set(path,{path,expected,groups:[group]})};
assert.equal(owner.protection.length,302);
const preservedOwnerProtection=owner.protection.filter(p=>!allowedWrappers.has(p.file));assert.equal(preservedOwnerProtection.length,300);
for(const p of preservedOwnerProtection)add(p.file,{bytes:p.bytes,sha256:p.sha256},'prior-owner302-minus-allowed2');
assert.equal(owner.finalFiles.length,26);for(const p of owner.finalFiles)add(p.file,p.after,'prior-native26');
assert.equal(priorPins.workingInputs.length,23);const otherPinInputs=priorPins.workingInputs.filter(p=>!allowedWrappers.has(p.path));assert.equal(otherPinInputs.length,21);
for(const p of otherPinInputs)add(p.path,{bytes:p.bytes,sha256:p.sha256},'prior-pin23-minus-allowed2');
const attributes=await readFile(join(out,'gitattributes-git.stdout.log'));add('.gitattributes',info(attributes),'raw-snapshot-text-attribute-contract');
const protection=[...protectionMap.values()];
const jobs=[];for(const t of inputs.targets){
 jobs.push(['audit-wrapper-'+t.step,['show',inputs.baseCommit+':'+t.wrapper]]);
 jobs.push(['audit-current-legacy-'+t.step,['show',inputs.baseCommit+':'+t.legacy]]);
 jobs.push(['audit-historical-'+t.step,['show',t.originalCommit+':'+t.legacy]]);
}
const readResults=await Promise.allSettled(jobs.map(async([label,args])=>({label,bytes:success(await command(label,'git',args))})));
for(const r of readResults)if(r.status==='rejected')throw r.reason;
const blobInput=Buffer.from(protection.map(p=>inputs.baseCommit+':'+p.path+'\n').join(''));
const corpus=success(await command('audit-protected-git','git',['cat-file','--batch'],blobInput));
let cursor=0;for(const p of protection){const end=corpus.indexOf(10,cursor);assert.notEqual(end,-1);
 const header=corpus.subarray(cursor,end).toString(),match=/^([0-9a-f]{40}) blob (\d+)$/.exec(header);assert.ok(match,'Resolved Git blob: '+p.path);
 cursor=end+1;const bytes=corpus.subarray(cursor,cursor+Number(match[2]));cursor+=bytes.length;assert.equal(corpus[cursor++],10);
 assert.deepEqual(info(bytes),p.expected,'Protected immutable Git bytes '+p.path);
 assert.deepEqual(info(await readFile(join(repo,p.path))),p.expected,'Protected working bytes '+p.path);
 p.baseBlob=match[1];p.currentBaseGitBytesExact=true;
}assert.equal(cursor,corpus.length);
const ts=createRequire(join(repo,'package.json'))('typescript');
function selected(text,path,includeGrants=true){const ast=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);assert.equal(ast.parseDiagnostics.length,0);
 const groups={assertions:[],grantCalls:[],templates:[],sqlAndTransactions:[],cleanup:[],conditions:[],nativeOptions:[],reporters:[]};
 const shape=n=>{const children=[];ts.forEachChild(n,c=>children.push(shape(c)));return{kind:n.kind,...(!children.length?{text:n.getText(ast)}:{}),children}};
 const add=(key,n)=>groups[key].push({source:n.getText(ast),ast:shape(n)});
 function visit(n){if(ts.isCallExpression(n)){
  const name=n.expression.getText(ast);if(/^assert\./.test(name))add('assertions',n);
  if(includeGrants&&/^(grantPostgresRuntime|grantPg73RuntimeFixture)$/.test(name))add('grantCalls',n);
  if(/\.(unsafe|begin)$/.test(name))add('sqlAndTransactions',n);
  if(/\.(cleanup|end|stop)$/.test(name))add('cleanup',n);
  if(name==='test'&&n.arguments[1])add('nativeOptions',n.arguments[1]);
  if(/^(writeFile|console\.log|console\.error|process\.stdout\.write)$/.test(name))add('reporters',n);
 }if(ts.isTemplateExpression(n)||ts.isNoSubstitutionTemplateLiteral(n))add('templates',n);
 if(ts.isIfStatement(n))add('conditions',n.expression);ts.forEachChild(n,visit)}visit(ast);return groups;
}
const results=[];
for(const t of inputs.targets){
 const before=await readFile(join(out,'audit-wrapper-'+t.step+'.stdout.log')),after=await readFile(join(repo,t.wrapper));
 const historical=await readFile(join(out,'audit-historical-'+t.step+'.stdout.log')),snapshot=await readFile(join(repo,t.frozenPath));
 assert.deepEqual(info(historical),{bytes:t.oldBytes,sha256:t.pin});assert.deepEqual(snapshot,historical);
 let reverse=after.toString('utf8');
 const backwards=t.step===94?[
  ["historicalFixture: '"+t.frozenPath+"'","historicalFixture: '"+t.legacy+"'"],
  ["'./fixtures/historical-native/"+basename(t.frozenPath)+"', import.meta.url","'./"+basename(t.legacy)+"', import.meta.url"]
 ]:[
  ["'./fixtures/historical-native/"+basename(t.frozenPath)+"', import.meta.url","'./"+basename(t.legacy)+"', import.meta.url"],
  ["lineage: { historicalNativeTest: '"+t.frozenPath+"',\n        historicalNativeTestSha256,","lineage: { historicalNativeTestSha256,"]
 ];
 for(const [current,original]of backwards){assert.equal(reverse.split(current).length,2);reverse=reverse.replace(current,original)}
 assert.deepEqual(Buffer.from(reverse),before,'Independent full-wrapper reverse bytes '+t.step);
 const oldGroups=selected(before.toString(),t.wrapper),newGroups=selected(after.toString(),t.wrapper);
 assert.deepEqual(newGroups,oldGroups,'Original assertion/grant/SQL/option/cleanup/report source and normalized AST '+t.step);
 const beforeComment=before.toString().split('\n').slice(0,t.step===94?2:1).join('\n');assert.ok(after.toString().startsWith(beforeComment));
 const pinName=t.step===94?'historicalFixtureSha256':'historicalNativeTestSha256';
 assert.ok(after.toString().includes("const "+pinName+" = '"+t.pin+"';"));
 const relative='./fixtures/historical-native/'+basename(t.frozenPath),resolved=new URL(relative,pathToFileURL(join(repo,t.wrapper)));
 assert.deepEqual(await readFile(resolved),historical,'Static actual new URL resolves original frozen bytes '+t.step);
 assert.ok(after.toString().includes("historical"+(t.step===94?'Fixture':'NativeTest')+": '"+t.frozenPath+"'"));
 assert.ok(t.frozenPath.endsWith('.native.test.mjs.txt'));assert.equal(t.frozenPath.endsWith('.test.mjs'),false);
 const currentLegacy=await readFile(join(out,'audit-current-legacy-'+t.step+'.stdout.log'));
 assert.deepEqual(info(currentLegacy),{bytes:t.currentBytes,sha256:t.currentSha256});assert.deepEqual(await readFile(join(repo,t.legacy)),currentLegacy);
 let legacyReverse=currentLegacy.toString();const variable=t.step===94?'names':'files';
 const adapters=[
  ["import { readFile, writeFile } from 'node:fs/promises';","import { readFile, readdir, writeFile } from 'node:fs/promises';",1],
  ["import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';","import { grantPostgresRuntime } from './grant-postgres-runtime.ts';",1],
  [`const ${variable} = await listPg73Migrations();`,`const ${variable} = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort();`,1],
  ['await grantPg73RuntimeFixture({ cluster, migrator, migratorUrl });','await grantPostgresRuntime({ DATABASE_URL: migratorUrl });',2]
 ];for(const[from,to,count]of adapters){assert.equal(legacyReverse.split(from).length-1,count);legacyReverse=legacyReverse.replaceAll(from,to)}
 assert.deepEqual(Buffer.from(legacyReverse),historical,'Current legacy adapter exact reverse historical '+t.step);
 // Grant adapters are the previously existing, explicitly reviewed differences.
 const currentLegacyGroups=selected(currentLegacy.toString(),t.legacy,false),historicalGroups=selected(historical.toString(),t.legacy,false);
 assert.deepEqual(currentLegacyGroups,historicalGroups);
 await writeFile(join(out,'wrapper-'+t.step+'.final-after'),after,{flag:'wx'});
 await writeFile(join(out,'snapshot-'+t.step+'.final'),snapshot,{flag:'wx'});
 results.push({step:t.step,wrapper:t.wrapper,wrapperBefore:info(before),wrapperAfter:info(after),snapshotPath:t.frozenPath,snapshot:info(snapshot),
  historicalCommit:t.originalCommit,historicalBlob:inputs.gitBlobs[inputs.targets.indexOf(t)*3+2],
  fullWrapperReverseBytesExact:true,allOriginalProtectedCallSourcesAndAstExact:true,
  originalPinsAndFrozenCommentsExact:true,staticNewUrlDigestMatchesOriginalPin:true,lineagePathMatchesNewUrl:true,
  originalCounts:Object.fromEntries(Object.entries(oldGroups).map(([k,v])=>[k,v.length])),protectedAstAndSourceSha256:info(Buffer.from(JSON.stringify(oldGroups))).sha256,
  currentLegacyUnchanged:info(currentLegacy),currentLegacyAdapterReverseBytesExact:true,
  legacyOriginalCounts:Object.fromEntries(Object.entries(historicalGroups).map(([k,v])=>[k,v.length]))});
}
const nestedInstructions=[];for(const[p,label]of[[join(repo,'scripts/db/cutover/fixtures/AGENTS.md'),'fixture-instructions'],[join(repo,'scripts/db/cutover/fixtures/historical-native/AGENTS.md'),'historical-instructions']]){
 const r=await file(label,p);assert.equal(r.receipt.actualExit,null);assert.equal(r.receipt.error.code,'ENOENT');nestedInstructions.push(r.receipt)}
const totals={files:4,wrappers:2,snapshots:2,originalAssertions:results.reduce((n,r)=>n+r.originalCounts.assertions,0),
 originalGrants:results.reduce((n,r)=>n+r.originalCounts.grantCalls,0),originalSqlTemplates:results.reduce((n,r)=>n+r.originalCounts.templates,0),
 originalSqlAndTransactions:results.reduce((n,r)=>n+r.originalCounts.sqlAndTransactions,0),
 owner302ProtectedExceptAllowed2:300,priorNative26Unchanged:26,priorPin23ProtectedExceptAllowed2:21,uniqueProtectedInputs:protection.length};
await writeFile(join(out,'four-independent-audit.json'),JSON.stringify({at:new Date().toISOString(),actualExit:0,baseCommit:inputs.baseCommit,allowedPaths:inputs.allowedPaths,
 totals,results,protection,nestedInstructions,nativeExecuted:false,databaseExecuted:false,productionWrites:0,gitMutations:0},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({actualExit:0,...totals,nativeExecuted:false,currentLegacyUnchanged:true}));
