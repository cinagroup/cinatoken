import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'file:///C:/cinagroup/cinatoken/node_modules/acorn/dist/acorn.mjs';
import { listPg73Migrations } from 'file:///C:/cinagroup/cinatoken/scripts/db/cutover/pg73-native-fixture.mjs';
const root=dirname(fileURLToPath(import.meta.url)),repo='C:/cinagroup/cinatoken',baseCommit='4e2ed5196a26cc43c2a3cb7ea852f1fc6284ff27';
const paths=['secretless-plan-v365','send-start-v365','private-route-reader-v366','read-grant-bridge-v367','result-facts-v366'].map(name=>'scripts/db/cutover/postgres-complete-text-'+name+'.native.test.mjs');
const info=b=>({bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});
const normalize=node=>JSON.parse(JSON.stringify(node,(key,value)=>['start','end','loc'].includes(key)?undefined:typeof value==='bigint'?{bigint:value.toString()}:value instanceof RegExp?{source:value.source,flags:value.flags}:value));
function walk(node,visit) { if (!node||typeof node!=='object') return; if (typeof node.type==='string') visit(node); for(const v of Object.values(node)){ if(Array.isArray(v))v.forEach(c=>walk(c,visit));else if(v&&typeof v==='object')walk(v,visit); } }
function extract(source) { const assertions=[],grants=[],options=[],wrapper=[]; walk(parse(source,{ecmaVersion:'latest',sourceType:'module'}),node=>{ if(node.type==='CallExpression'){const item={source:source.slice(node.start,node.end),ast:normalize(node)};if(node.callee?.object?.name==='assert')assertions.push(item);if(node.callee?.name==='grantPostgresRuntime')grants.push(item);if(node.callee?.name==='test')options.push({source:source.slice(node.arguments[1].start,node.arguments[1].end),ast:normalize(node.arguments[1])});} if(node.type==='VariableDeclarator'&&node.id?.name==='grantPostgresRuntime')wrapper.push(source.slice(node.init.start,node.init.end));});return{assertions,grants,options,wrapper}; }
const files=[];
for(const file of paths) {
  const git=spawnSync('git',['show',baseCommit+':'+file],{cwd:repo,windowsHide:true});assert.equal(git.status,0);
  const before=git.stdout,after=await readFile(join(repo,file));assert.ok(before.equals(await readFile(join(root,basename(file)+'.before'))));
  const b=before.toString('utf8'),a=after.toString('utf8'); const old=extract(b),current=extract(a);
  assert.deepEqual(current.assertions,old.assertions);assert.deepEqual(current.grants,old.grants);assert.deepEqual(current.options,old.options);
  assert.deepEqual(current.wrapper,['({ DATABASE_URL }) =>\n        grantPg73RuntimeFixture({ cluster, migrator, migratorUrl: DATABASE_URL })']);
  let reconstructed=a;
  const replacements=[
    ["      // Keep original grant calls and rejection checks on the owned PG73 ledger.\n      const grantPostgresRuntime = ({ DATABASE_URL }) =>\n        grantPg73RuntimeFixture({ cluster, migrator, migratorUrl: DATABASE_URL });\n",''],
    ["import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';","import { grantPostgresRuntime } from './grant-postgres-runtime.ts';"],
    ['readFile, writeFile','readFile, readdir, writeFile'],
  ];
  const originalLoader=b.match(/const (?:names|migrationNames)=\(await readdir\((?:migrations|migrationDir)\)\)\.filter\(x=>x\.endsWith\('\.sql'\)\)\.sort\(\);/u)?.[0];assert.ok(originalLoader);
  const variable=originalLoader.match(/^const (\w+)=/u)[1];replacements.push([`const ${variable}=await listPg73Migrations();`,originalLoader]);
  for(const [needle,replacement] of replacements){assert.equal(reconstructed.split(needle).length,2);reconstructed=reconstructed.replace(needle,replacement);}
  assert.ok(Buffer.from(reconstructed).equals(before));
  files.push({file,before:info(before),after:info(after),originalAssertions:old.assertions.length,originalGrantCalls:old.grants.length,allOriginalAssertionsAstAndSourceExact:true,allOriginalGrantCallsAstAndSourceExact:true,originalTimeoutAndSkipExact:true,wholeFileReverseBytesExact:true});
}
const unchangedPaths=[
 'scripts/db/cutover/pg73-native-fixture.mjs','scripts/db/cutover/grant-postgres-runtime.ts','scripts/db/cutover/provision-postgres-roles.ts','scripts/db/cutover/activate-postgres-buyer-split-v348.ts','scripts/db/cutover/grant-postgres-buyer-split-v348.ts','scripts/db/cutover/activate-postgres-buyer-guardrail-split-v349.ts','scripts/db/cutover/grant-postgres-buyer-guardrail-split-v349.ts',
 'scripts/db/cutover/postgres-complete-text-result-client-digest-v367.native.test.mjs',
 'packages/core/src/test-support/postgres-native-cluster.mjs','packages/core/src/route-data-policy.ts',
 'packages/proxy/src/services/postgres-complete-text-attempt-grant-v362.ts','packages/proxy/src/services/postgres-complete-text-send-start-v365.ts','packages/proxy/src/services/postgres-private-complete-text-reader-v366.ts','packages/proxy/src/services/postgres-complete-text-result-facts-v367.ts',
 '.github/workflows/proxy-dispatch-safety.yml',
 ...(await readdir(join(repo,'packages/core/migrations-postgres'))).filter(n=>n.endsWith('.sql')).map(n=>'packages/core/migrations-postgres/'+n),
 ...(await readdir(join(repo,'packages/core/migrations-proposals/postgres'))).filter(n=>n.endsWith('.sql')).map(n=>'packages/core/migrations-proposals/postgres/'+n),
];
const batch=spawnSync('git',['cat-file','--batch'],{cwd:repo,input:unchangedPaths.map(file=>baseCommit+':'+file+'\n').join(''),maxBuffer:64*1024*1024,windowsHide:true});assert.equal(batch.status,0);assert.equal(batch.stderr.length,0);
let offset=0;const unchanged=[];
for(const file of unchangedPaths){const end=batch.stdout.indexOf(10,offset);const [blob,type,size]=batch.stdout.subarray(offset,end).toString('utf8').split(' ');assert.equal(type,'blob');const bytes=batch.stdout.subarray(end+1,end+1+Number(size));offset=end+1+Number(size)+1;const current=await readFile(join(repo,file));assert.ok(current.equals(bytes),file);unchanged.push({file,blob,...info(current),baseGitBytesExact:true});}
assert.equal(offset,batch.stdout.length);
const corpus=await listPg73Migrations();assert.equal(corpus.length,73);
const ciLogPath='C:/Users/cina/AppData/Local/Temp/cinatoken-native-g7-boundary-next-20261006-Zm6Z3E/native12-native-terminal-log.stdout.log';
const ciLog=await readFile(ciLogPath);const text=ciLog.toString('utf8');assert.ok(text.includes('81 !== 73'));assert.ok(text.includes('postgres-complete-text-secretless-plan-v365.native.test.mjs:78:14'));
const ciReceipt=JSON.parse(await readFile('C:/Users/cina/AppData/Local/Temp/cinatoken-native-g7-boundary-next-20261006-Zm6Z3E/native12-native-terminal-log.result.json','utf8'));assert.equal(ciReceipt.actualExit,0);
const result={at:new Date().toISOString(),baseCommit,actualExit:0,files,totals:{files:files.length,originalAssertions:files.reduce((n,f)=>n+f.originalAssertions,0),originalGrantCalls:files.reduce((n,f)=>n+f.originalGrantCalls,0),unchangedSources:unchanged.length},corpus:{count:corpus.length,last:corpus.at(-1),sha256:'23afef61a8a670e0af8c90e3a138f522e6b283b454e380a592bf85bca83108dc',ledgerMd5:'ca1ea96a1b4bcd0675642f30dcf48042',actualHelperValidation:true},originalCi:{runId:'37401132384',jobId:'112068342381',step:47,logPath:ciLogPath,...info(ciLog),failure:'81 !== 73 at v365 fixture:78:14',downloadReceipt:ciReceipt},unchangedSources:unchanged,nativeFixtureExecuted:false,realPgResultNotClaimed:true,productionWrites:0};
await writeFile(join(root,'five-source-audit.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({actualExit:0,...result.totals,corpusCount:corpus.length,nativeFixtureExecuted:false})+'\n');
