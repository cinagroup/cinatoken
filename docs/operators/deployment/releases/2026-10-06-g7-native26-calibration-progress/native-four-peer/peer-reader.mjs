import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,statSync} from 'node:fs';
import {join,basename,normalize} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {parse} from 'file:///C:/cinagroup/cinatoken/node_modules/acorn/dist/acorn.mjs';
const repo='C:/cinagroup/cinatoken';
const out=process.argv[2];
const base='702c4d71379acb697024ef846725871582bff94f';
const owner='C:/Users/cina/AppData/Local/Temp/cinatoken-native-four-repair-38a94fb93d9842929dc7ae9cf6b378da';
const finalPath=join(owner,'FINAL-native-four-pg73-preparation.json');
const info=b=>({bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});
const write=(name,value)=>writeFileSync(join(out,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const readJson=p=>JSON.parse(readFileSync(normalize(p),'utf8'));
const checkInfo=(b,i)=>assert.deepEqual(info(b),{bytes:i.bytes,sha256:i.sha256});
const ownCommands=[];
function git(name,args,input){
 const at=new Date().toISOString();
 const argv=['-c','core.longpaths=true',...args];
 const result=spawnSync('git',argv,{cwd:repo,input,encoding:null,maxBuffer:30*1024*1024,windowsHide:true});
 const finishedAt=new Date().toISOString();
 const stdout=result.stdout??Buffer.alloc(0),stderr=result.stderr??Buffer.alloc(0);
 writeFileSync(join(out,name+'.stdout.log'),stdout,{flag:'wx'});
 writeFileSync(join(out,name+'.stderr.log'),stderr,{flag:'wx'});
 const receipt={schema:'cinatoken.native-four-independent-peer.command.v1',at,finishedAt,executable:'git',args:argv,cwd:repo,actualExit:result.status,signal:result.signal??null,spawnError:result.error?String(result.error):null,input:input===undefined?null:info(Buffer.from(input)),stdout:join(out,name+'.stdout.log'),stderr:join(out,name+'.stderr.log'),stdoutInfo:info(stdout),stderrInfo:info(stderr)};
 write(name+'.closed.json',receipt);ownCommands.push(receipt);
 assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.equal(result.status,0,stderr.toString());
 return stdout;
}
function decodeGit(buffer,count) {
 let pos=0;const blobs=[];
 while(pos<buffer.length){
  const end=buffer.indexOf(10,pos);assert.ok(end>pos);
  const [blob,type,sizeText]=buffer.subarray(pos,end).toString('utf8').split(' ');
  assert.equal(type,'blob');assert.match(blob,/^[0-9a-f]{40}$/);assert.match(sizeText,/^\d+$/);
  const size=Number(sizeText);assert.ok(Number.isSafeInteger(size));const data=buffer.subarray(end+1,end+1+size);
  assert.equal(data.length,size);assert.equal(buffer[end+1+size],10);
  assert.equal(createHash('sha1').update(Buffer.concat([Buffer.from('blob '+size+'\0'),data])).digest('hex'),blob);
  blobs.push({blob,data});pos=end+size+2;
 }
 assert.equal(pos,buffer.length);assert.equal(blobs.length,count);return blobs;
}
const cleanAst=node=>JSON.parse(JSON.stringify(node,(key,value)=>['start','end','loc'].includes(key)?undefined:typeof value==='bigint'?{bigint:value.toString()}:value instanceof RegExp?{pattern:value.source,flags:value.flags}:value));
function calls(source){
 const result={assertions:[],grants:[],testOptions:[],wrappers:[],unsafeSql:[]};
 function walk(n){if(!n||typeof n!=='object')return;
  if(n.type==='CallExpression'){
   const x={source:source.slice(n.start,n.end),ast:cleanAst(n)};
   if(n.callee?.object?.name==='assert')result.assertions.push(x);
   if(n.callee?.name==='grantPostgresRuntime')result.grants.push(x);
   if(n.callee?.name==='test')result.testOptions.push({source:source.slice(n.arguments[1].start,n.arguments[1].end),ast:cleanAst(n.arguments[1])});
   if(n.callee?.type==='MemberExpression'&&['unsafe','simple'].includes(n.callee.property?.name))result.unsafeSql.push(x);
  }
  if(n.type==='VariableDeclarator'&&n.id?.name==='grantPostgresRuntime')result.wrappers.push(source.slice(n.init.start,n.init.end));
  for(const v of Object.values(n)){if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')walk(v);}
 }walk(parse(source,{ecmaVersion:'latest',sourceType:'module'}));return result;
}
function once(text,old,newValue){
 assert.equal(text.split(old).length,2,'Unique allowed edit anchor missing');return text.replace(old,newValue);
}
const finalBytes=readFileSync(finalPath);
checkInfo(finalBytes,{bytes:79877,sha256:'ae66339a066dc2522dc6e7617c5118a7bb7f33ee134d74db9755dcc90194c77d'});
const producer=JSON.parse(finalBytes.toString('utf8'));
assert.equal(producer.baseCommit,base);
assert.equal(git('current-head',['rev-parse','HEAD']).toString().trim(),base);
const files=[
'scripts/db/cutover/postgres-complete-text-legacy-reaper-fence-v366.native.test.mjs',
'scripts/db/cutover/postgres-complete-text-all-hold-renewal-v367.native.test.mjs',
'scripts/db/cutover/postgres-complete-text-buyer-counter-cutover-v367.native.test.mjs',
'scripts/db/cutover/postgres-complete-text-legacy-buyer-held-v368.native.test.mjs'];
assert.deepEqual(producer.sourceOwnership,files);
const priorPath='C:/Users/cina/AppData/Local/Temp/cinatoken-native53-six-inventory-b5e488785b0d4b00a7f69724a8a418e4/FINAL-native53-six-readonly-inventory.json';
const priorBytes=readFileSync(priorPath);
checkInfo(priorBytes,{bytes:84295,sha256:'0156f3d856fe5e24b317b90aa73cefa80d6c65a7b35e8e25d7947121ee6fbeea'});
const prior=JSON.parse(priorBytes.toString('utf8'));
const protectionPaths=prior.immutableInputs.map(i=>i.file).filter(p=>!files.includes(p));
assert.equal(protectionPaths.length,184);assert.equal(new Set(protectionPaths).size,184);
assert.deepEqual(producer.protection.map(i=>i.file),protectionPaths);
const allPaths=[...files,...protectionPaths];
const originals=decodeGit(git('base-inputs',['cat-file','--batch'],allPaths.map(p=>base+':'+p+'\n').join('')),188);
const fileResults=[];
const expectedCounts=[62,159,75,114];
for(let i=0;i<files.length;i++){
 const file=files[i],original=originals[i],before=original.data,after=readFileSync(join(repo,file));
 const b=before.toString('utf8'),a=after.toString('utf8');const owned=producer.files[i];
 assert.equal(owned.file,file);assert.equal(owned.baseGitBlob,original.blob);checkInfo(before,owned.before);checkInfo(after,owned.after);
 assert.ok(readFileSync(join(owner,basename(file)+'.before')).equals(before));
 assert.ok(readFileSync(join(owner,basename(file)+'.after')).equals(after));
 let expected=b;
 const fsLine=b.match(/^import \{ readFile, readdir, writeFile \} from 'node:fs\/promises';\r?\n/m)?.[0];
 const grantLine=b.match(/^import \{ grantPostgresRuntime \} from '\.\/grant-postgres-runtime.ts';\r?\n/m)?.[0];
 const listLine=b.match(/^      const migrationNames=\(await readdir\(migrationDir\)\)\.filter\(x=>x\.endsWith\('\.sql'\)\)\.sort\(\);\r?\n/m)?.[0];
 assert.ok(fsLine&&grantLine&&listLine);
 expected=once(expected,fsLine,"import { readFile, writeFile } from 'node:fs/promises';\n");
 expected=once(expected,grantLine,"import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';\n");
 expected=once(expected,listLine,'      const migrationNames=await listPg73Migrations();\n');
 const originalGrantCall='      await grantPostgresRuntime({DATABASE_URL:migratorUrl});';
 const adapter='      // Keep original grant calls and rejection checks on the owned PG73 ledger.\n      const grantPostgresRuntime = ({ DATABASE_URL }) =>\n        grantPg73RuntimeFixture({ cluster, migrator, migratorUrl: DATABASE_URL });\n';
 expected=once(expected,originalGrantCall,adapter+originalGrantCall);
 assert.ok(Buffer.from(expected).equals(after),'Only exact four allowed substitutions: '+file);
 let reverse=a;
 reverse=once(reverse,adapter,'');
 reverse=once(reverse,"import { readFile, writeFile } from 'node:fs/promises';\n",fsLine);
 reverse=once(reverse,"import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';\n",grantLine);
 reverse=once(reverse,'      const migrationNames=await listPg73Migrations();\n',listLine);
 assert.ok(Buffer.from(reverse).equals(before),'Whole baseline reverse exact: '+file);
 const old=calls(b),now=calls(a);
 assert.deepEqual(now.assertions,old.assertions);assert.equal(old.assertions.length,expectedCounts[i]);
 assert.deepEqual(now.grants,old.grants);assert.equal(old.grants.length,1);
 assert.deepEqual(now.testOptions,old.testOptions);assert.deepEqual(now.testOptions.map(i=>i.source),['{timeout:300_000,skip:!process.env.GATEWAY_NATIVE_PG_BIN}']);
 assert.deepEqual(now.unsafeSql,old.unsafeSql);
 assert.deepEqual(now.wrappers,['({ DATABASE_URL }) =>\n        grantPg73RuntimeFixture({ cluster, migrator, migratorUrl: DATABASE_URL })']);
 const assertionHash=info(Buffer.from(JSON.stringify(old.assertions))).sha256;
 const grantHash=info(Buffer.from(JSON.stringify(old.grants))).sha256;
 assert.equal(assertionHash,owned.originalAssertionProofSha256);assert.equal(grantHash,owned.originalGrantProofSha256);
 assert.ok(a.indexOf('const grantPostgresRuntime =')>a.indexOf('const migratorUrl='));
 assert.ok(a.indexOf('const grantPostgresRuntime =')<a.indexOf('await grantPostgresRuntime'));
 assert.ok(a.indexOf('await grantPostgresRuntime')<a.indexOf('for(const [name,setting] of preliminary)'));
 assert.equal((a.match(/await listPg73Migrations\(\)/g)||[]).length,1);
 fileResults.push({file,baseGitBlob:original.blob,before:info(before),after:info(after),allowedEdits:4,forwardExact:true,reverseWholeFileExact:true,originalAssertions:old.assertions.length,originalGrantCalls:old.grants.length,unsafeSqlCalls:old.unsafeSql.length,originalAssertionProofSha256:assertionHash,originalGrantProofSha256:grantHash,originalAssertionAndGrantAstAndSourceExact:true,allSqlRoleLockWaitNegativeCleanupSourcePreserved:true,originalTestTimeoutAndSkipExact:true,adapterBeforeProposalActivations:true});
}
const protectedResults=[];
for(let i=0;i<protectionPaths.length;i++){
 const file=protectionPaths[i],original=originals[i+4],working=readFileSync(join(repo,file)),claim=producer.protection[i];
 assert.ok(working.equals(original.data),file);assert.equal(claim.blob,original.blob);checkInfo(working,claim);
 protectedResults.push({file,baseGitBlob:original.blob,...info(working),currentBaseBytesExact:true});
}
const excluded=[
'scripts/db/cutover/postgres-buyer-held-opt-in-gap-v370.native.test.mjs',
'scripts/db/cutover/postgres-legacy-buyer-window-accountant-v371.native.test.mjs'];
assert.ok(excluded.every(p=>protectedResults.some(i=>i.file===p)));
const migrationDir=join(repo,'packages/core/migrations-postgres');
const currentMigrationNames=readdirSync(migrationDir).filter(p=>/^\d{4}_[a-z0-9_]+\.sql$/.test(p)).sort();
const pg73=currentMigrationNames.filter(p=>p<='0073_recovery_api_key_workspace_lock.sql');
assert.equal(pg73.length,73);assert.equal(pg73.at(-1),'0073_recovery_api_key_workspace_lock.sql');
const corpus=pg73.map(name=>name+'\n'+readFileSync(join(migrationDir,name),'utf8')).join('\n');
const corpusSha=info(Buffer.from(corpus)).sha256;
const ledgerMd5=createHash('md5').update(pg73.join('\n')).digest('hex');
assert.equal(corpusSha,'23afef61a8a670e0af8c90e3a138f522e6b283b454e380a592bf85bca83108dc');
assert.equal(ledgerMd5,'ca1ea96a1b4bcd0675642f30dcf48042');
assert.equal(producer.corpus.sha256,corpusSha);assert.equal(producer.corpus.ledgerMd5,ledgerMd5);
const helperPath='scripts/db/cutover/pg73-native-fixture.mjs';
const helperProof=protectedResults.find(i=>i.file===helperPath);assert.ok(helperProof);
const helper=readFileSync(join(repo,helperPath),'utf8');
assert.ok(helper.includes("const lastPg73 = '0073_recovery_api_key_workspace_lock.sql';"));
assert.ok(helper.includes('target.hostname === \'127.0.0.1\''));
assert.ok(helper.includes('Number(target.port) === cluster.port'));
assert.ok(helper.includes('cluster?.owned'));
assert.ok(helper.includes('await grantPostgresRuntime({ DATABASE_URL: migratorUrl });'));
assert.ok(helper.includes("DROP TABLE cinatoken_gateway.config_change_audit"));
assert.ok(helper.includes("ALTER ROLE cinatoken_gateway_runtime NOLOGIN"));
assert.ok(helper.includes('assert.deepEqual(await runtimeState(), originalRuntime'));
const sourceAuditBytes=readFileSync(normalize(producer.sourceAudit.path));checkInfo(sourceAuditBytes,producer.sourceAudit);
const sourceAudit=JSON.parse(sourceAuditBytes.toString('utf8'));
assert.deepEqual(sourceAudit.totals,producer.totals);assert.deepEqual(sourceAudit.files,producer.files);assert.deepEqual(sourceAudit.protection,producer.protection);
const ownerRegularFiles=readdirSync(owner).filter(n=>statSync(join(owner,n)).isFile()).sort();
const receiptNames=ownerRegularFiles.filter(n=>n.endsWith('.closed.json'));
assert.deepEqual(receiptNames,[...producer.closedReceipts.map(i=>i.file),producer.finalWriterClosedReceipt].sort());
const receiptResults=[];
for(const name of receiptNames){
 const bytes=readFileSync(join(owner,name)),receipt=JSON.parse(bytes.toString('utf8')),embedded=producer.closedReceipts.find(i=>i.file===name);
 if(embedded){checkInfo(bytes,embedded);for(const key of ['at','finishedAt','executable','args','cwd','actualExit','signal','stdout','stderr','stdoutInfo','stderrInfo'])assert.deepEqual(receipt[key],embedded[key]);}
 assert.ok(Number.isFinite(Date.parse(receipt.at))&&Number.isFinite(Date.parse(receipt.finishedAt)));
 assert.ok(Date.parse(receipt.finishedAt)>=Date.parse(receipt.at));
 assert.equal(receipt.actualExit,0);assert.equal(receipt.signal,null);assert.ok(!receipt.spawnError);
 const stdout=readFileSync(normalize(receipt.stdout)),stderr=readFileSync(normalize(receipt.stderr));
 checkInfo(stdout,receipt.stdoutInfo);checkInfo(stderr,receipt.stderrInfo);
 receiptResults.push({file:name,...info(bytes),at:receipt.at,finishedAt:receipt.finishedAt,executable:receipt.executable,args:receipt.args,actualExit:receipt.actualExit,signal:receipt.signal,stdout:receipt.stdout,stderr:receipt.stderr,stdoutInfo:info(stdout),stderrInfo:info(stderr),rawLogsAndEmbeddedFieldsExact:true,stderrText:stderr.length?stderr.toString('utf8'):null});
}
assert.equal(git('final-current-head',['rev-parse','HEAD']).toString().trim(),base);
for(let i=0;i<allPaths.length;i++){
 const b=readFileSync(join(repo,allPaths[i]));
 assert.ok(b.equals(i<4?readFileSync(join(owner,basename(allPaths[i])+'.after')):originals[i].data),'End snapshot stable: '+allPaths[i]);
}
const report={schema:'cinatoken.native-four-independent-peer.final.v1',at:new Date().toISOString(),actualExit:0,readyForRootReviewAndCommit:true,findings:[],baseCommit:base,producer:{path:finalPath,...info(finalBytes),declaredReady:true,closedReceiptCount:receiptNames.length,allRawCommandLogsByteShaVerified:true,regularFileSnapshot:ownerRegularFiles.map(file=>({file,...info(readFileSync(join(owner,file)))}))},priorInventory:{path:priorPath,...info(priorBytes)},files:fileResults,totals:{changedNativeFiles:4,allowedEditSubstitutions:16,originalAssertions:fileResults.reduce((n,i)=>n+i.originalAssertions,0),originalGrantCalls:fileResults.reduce((n,i)=>n+i.originalGrantCalls,0),protectedInputCount:184,totalInputsIncludingFourTargets:188},protectedInputs:protectedResults,excluded57And58ByteExact:true,historicalPg73:{count:73,last:pg73.at(-1),corpusSha256:corpusSha,ledgerMd5,currentFormalMigrationCount:currentMigrationNames.length,independentlyReadAndHashedFromDisk:true,helperByteExact:helperProof},producerClosedReceipts:receiptResults,peerReadOnlyCommands:ownCommands,scope:{repositoryWrites:0,gitMutations:0,testExecutions:0,cliOrApiRequests:0,ciTriggers:0,databaseExecutions:0,productionRequests:0,G7ModificationReviewed:false,nativeReviewSeparatedFromG7:true},limitations:['This independent review checks exact source edits, corpus, protected inputs and actual closed preparation receipts. The four native fixtures have not been executed on Linux PostgreSQL 18.6 for this batch.','Only original step53 had an observed 81-versus-73 failure; steps54–56 were repaired from the same static source defect, not represented as observed runtime failures.','Root must execute the unchanged original Linux native CI after commit; no passing runtime or full gate claim follows from this read-only review.'],originalGitWarningsPreserved:receiptResults.filter(r=>r.stderrInfo.bytes>0).map(r=>({file:r.file,actualExit:r.actualExit,stderrInfo:r.stderrInfo,stderrText:r.stderrText}))};
assert.equal(report.totals.originalAssertions,410);assert.equal(report.totals.originalGrantCalls,4);
write('FINAL-native-four-independent-peer.json',report);
const finalPeerBytes=readFileSync(join(out,'FINAL-native-four-independent-peer.json'));
process.stdout.write(JSON.stringify({actualExit:0,readyForRootReviewAndCommit:true,path:join(out,'FINAL-native-four-independent-peer.json'),...info(finalPeerBytes),totals:report.totals,closedReceipts:receiptNames.length,realNativeFixtureExecuted:false})+'\n');
