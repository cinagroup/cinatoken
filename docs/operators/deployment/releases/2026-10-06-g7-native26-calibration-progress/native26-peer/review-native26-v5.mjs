import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,lstatSync} from 'node:fs';
import {join,normalize,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {parse} from 'file:///C:/cinagroup/cinatoken/node_modules/acorn/dist/acorn.mjs';
const out=process.argv[2],repo='C:/cinagroup/cinatoken',owner='C:/Users/cina/AppData/Local/Temp/cinatoken-native26-pg73-repair-908e0528cf5e44508d04e761c4540713',base='473de5fc520fc7d64db700db88a76c7a6b45c241';
const producerPath=join(owner,'FINAL-native26-pg73-preparation.json'),inventoryPath='C:/Users/cina/AppData/Local/Temp/cinatoken-native59-full-inventory-10b2722ab06d4cf6b6305e24571b4a8d/FINAL-native59-full-readonly-inventory.json';
const bytes=p=>readFileSync(normalize(p)),json=p=>JSON.parse(bytes(p).toString('utf8')),info=b=>({bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});
const check=(b,c)=>assert.deepEqual(info(b),{bytes:c.bytes,sha256:c.sha256});
const write=(n,v)=>writeFileSync(join(out,n),JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const producerBytes=bytes(producerPath),inventoryBytes=bytes(inventoryPath);
check(producerBytes,{bytes:210963,sha256:'48f61432f183455a1c1557cda0ee8063d9f5419358933ed035504cd85913efda'});
check(inventoryBytes,{bytes:635773,sha256:'67bf17ba71aa1b9a1b3eba948cc0f2a7e221e80a9e8a1ed3ee33eef8e5ceb6cb'});
const producer=JSON.parse(producerBytes.toString('utf8')),inventory=JSON.parse(inventoryBytes.toString('utf8'));
assert.equal(producer.schema,'cinatoken.pg73.native26-owner-preparation.final.v1');assert.equal(producer.baseCommit,base);assert.equal(producer.actualExit,0);
const allowedSteps=[60,61,66,69,71,72,73,74,75,76,77,78,80,81,82,83,84,85,86,88,95,96,97,98,99,106];
assert.deepEqual(inventory.candidateSteps,allowedSteps);assert.deepEqual(producer.allowedSteps,allowedSteps);
const selected=inventory.records.filter(r=>allowedSteps.includes(r.step));assert.equal(selected.length,26);assert.deepEqual(selected.map(r=>r.step),allowedSteps);
const files=selected.map(r=>r.fixture);assert.deepEqual(producer.repositoryWritePaths,files);assert.deepEqual(producer.finalFiles.map(f=>f.file),files);
const untouched=inventory.protection.inputs.map(i=>i.path).filter(p=>!files.includes(p));assert.equal(untouched.length,298);
const priorFour=['legacy-reaper-fence-v366','all-hold-renewal-v367','buyer-counter-cutover-v367','legacy-buyer-held-v368'].map(n=>'scripts/db/cutover/postgres-complete-text-'+n+'.native.test.mjs');
assert.ok(priorFour.every(p=>!untouched.includes(p)));const protectionPaths=[...untouched,...priorFour].sort();assert.equal(protectionPaths.length,302);assert.equal(new Set(protectionPaths).size,302);assert.deepEqual(producer.protection.map(f=>f.file),protectionPaths);
const ownCommands=[];
function git(name,args,input){const at=new Date().toISOString(),argv=['-c','core.longpaths=true',...args],r=spawnSync('git',argv,{cwd:repo,input,encoding:null,maxBuffer:30*1024*1024,windowsHide:true}),finishedAt=new Date().toISOString(),stdout=r.stdout??Buffer.alloc(0),stderr=r.stderr??Buffer.alloc(0);
 writeFileSync(join(out,name+'.stdout.log'),stdout,{flag:'wx'});writeFileSync(join(out,name+'.stderr.log'),stderr,{flag:'wx'});
 const receipt={schema:'cinatoken.native26-independent-peer.command.v1',at,finishedAt,executable:'git',args:argv,cwd:repo,actualExit:r.status,signal:r.signal??null,spawnError:r.error?String(r.error):null,stdinInfo:input===undefined?null:info(Buffer.from(input)),stdout:join(out,name+'.stdout.log'),stderr:join(out,name+'.stderr.log'),stdoutInfo:info(stdout),stderrInfo:info(stderr)};
 write(name+'.closed.json',receipt);ownCommands.push(receipt);assert.equal(r.status,0,stderr.toString());assert.equal(r.signal,null);assert.equal(r.error,undefined);return stdout;}
assert.equal(git('initial-head-v5',['rev-parse','HEAD']).toString().trim(),base);
const allPaths=[...files,...protectionPaths],batch=git('base-328-inputs-v5',['cat-file','--batch'],allPaths.map(p=>base+':'+p+'\n').join(''));
let offset=0;const gitInputs=[];
for(const file of allPaths){const end=batch.indexOf(10,offset),[blob,type,sizeText]=batch.subarray(offset,end).toString('utf8').split(' '),size=Number(sizeText);
 assert.equal(type,'blob');assert.match(blob,/^[0-9a-f]{40}$/);assert.ok(Number.isSafeInteger(size)&&size>=0);
 const b=batch.subarray(end+1,end+1+size);assert.equal(b.length,size);assert.equal(batch[end+1+size],10);
 assert.equal(createHash('sha1').update(Buffer.concat([Buffer.from('blob '+size+'\0'),b])).digest('hex'),blob);
 gitInputs.push({file,blob,bytes:b});offset=end+size+2;}
assert.equal(offset,batch.length);
const cleanAst=n=>JSON.parse(JSON.stringify(n,(k,v)=>['start','end','loc'].includes(k)?undefined:typeof v==='bigint'?{bigint:v.toString()}:v instanceof RegExp?{pattern:v.source,flags:v.flags}:v));
function analyze(source){const r={assertions:[],grants:[],templates:[],transactions:[],cleanup:[],reporters:[],conditions:[],options:[],wrappers:[],helperCalls:[],loaderCalls:[],readdirCalls:[],grantStarts:[]};
 function walk(n){if(!n||typeof n!=='object')return;const record={source:source.slice(n.start,n.end),ast:cleanAst(n)};
  if(n.type==='TemplateLiteral')r.templates.push(record);
  if(n.type==='IfStatement')r.conditions.push({source:source.slice(n.test.start,n.test.end),ast:cleanAst(n.test)});
  if(n.type==='VariableDeclarator'&&n.id?.name==='grantPostgresRuntime')r.wrappers.push(record);
  if(n.type==='CallExpression'){
   if(n.callee?.object?.name==='assert')r.assertions.push(record);
   if(n.callee?.name==='grantPostgresRuntime'){r.grants.push(record);r.grantStarts.push(n.start);}
   if(n.callee?.name==='grantPg73RuntimeFixture')r.helperCalls.push(record);
   if(n.callee?.name==='listPg73Migrations')r.loaderCalls.push(record);
   if(n.callee?.name==='readdir')r.readdirCalls.push(record);
   if(['unsafe','begin'].includes(n.callee?.property?.name))r.transactions.push(record);
   if(['cleanup','end','stop'].includes(n.callee?.property?.name))r.cleanup.push(record);
   if(n.callee?.name==='writeFile'||(n.callee?.object?.name==='console'&&n.callee?.property?.name==='log')||(n.callee?.object?.object?.name==='process'&&n.callee?.property?.name==='write'))r.reporters.push(record);
   if(n.callee?.name==='test')r.options.push({source:source.slice(n.arguments[1].start,n.arguments[1].end),ast:cleanAst(n.arguments[1])});
  }
  for(const v of Object.values(n)){if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')walk(v);}
 }walk(parse(source,{ecmaVersion:'latest',sourceType:'module'}));return r;}
const comparisonKeys=['assertions','grants','templates','transactions','cleanup','reporters','conditions','options'];
function proof(r){return info(Buffer.from(JSON.stringify(Object.fromEntries(comparisonKeys.map(k=>[k,r[k]]))))).sha256;}
function once(source,needle,replacement){assert.equal(source.split(needle).length,2,'Unique allowed source edit anchor');return source.replace(needle,replacement);}
const fileResults=[],sourceByFile=new Map();
for(let i=0;i<selected.length;i++){
 const entry=selected[i],file=entry.fixture,original=gitInputs[i],before=original.bytes,after=bytes(join(repo,file)),claim=producer.finalFiles[i],b=before.toString('utf8'),a=after.toString('utf8');
 check(before,{bytes:entry.bytes,sha256:entry.sha256});check(before,claim.before);check(after,claim.after);assert.equal(claim.baseGitBlob,original.blob);
 assert.ok(bytes(join(owner,basename(file)+'.before-v2')).equals(before));assert.ok(bytes(join(owner,basename(file)+'.prepared-after-v2')).equals(after));assert.ok(bytes(join(owner,basename(file)+'.final-after')).equals(after));
 const old=analyze(b),current=analyze(a);for(const key of comparisonKeys)assert.deepEqual(current[key],old[key],file+':'+key);
 assert.equal(old.assertions.length,entry.originalAssertionCount);assert.equal(old.grants.length,entry.grantCalls.filter(c=>c.name==='grantPostgresRuntime').length);
 assert.equal(claim.originalAstProofSha256,proof(old));assert.equal(claim.originalAssertions,old.assertions.length);assert.equal(claim.originalGrantCalls,old.grants.length);
 const formalLines=[...b.matchAll(/^([ \t]*const\s+(?:migrationNames|names|files|finalMigrationNames)\s*=\s*)\(await readdir\((?:migrationDir|migrations)\)\)[^\n]*;\r?\n/gm)].map(m=>({source:m[0],prefix:m[1],index:m.index,replacement:m[1]+'await listPg73Migrations();\n'}));
 const finalStep=[82,83,84,85].includes(entry.step);
 assert.equal(formalLines.length,finalStep?2:1);assert.ok(b.includes('packages/core/migrations-postgres/'));
 const beforeLines=b.match(/[^\n]*(?:\n|$)/g);assert.equal(beforeLines[entry.initialFormalLoader.line-1],formalLines[0].source);
 if(finalStep)assert.equal(beforeLines[entry.finalCorpusCheck.loaderLine-1],formalLines[1].source);
 const oldGrantImport=b.match(/^import \{ grantPostgresRuntime \} from '\.\/grant-postgres-runtime.ts';\r?\n/m)?.[0];assert.ok(oldGrantImport);
 const newGrantImport="import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';\n";
 let expected=once(b,oldGrantImport,newGrantImport);for(const line of formalLines)expected=once(expected,line.source,line.replacement);
 const firstGrantStart=old.grantStarts[0];assert.ok(Number.isSafeInteger(firstGrantStart));
 const lineStart=b.lastIndexOf('\n',firstGrantStart)+1,lineEnd=b.indexOf('\n',firstGrantStart)+1,callLine=b.slice(lineStart,lineEnd);
 assert.ok(/^[ \t]*await grantPostgresRuntime\(/.test(callLine));assert.equal(callLine,beforeLines[entry.grantCalls.filter(c=>c.name==='grantPostgresRuntime')[0].line-1]);
 const indent=callLine.match(/^[ \t]*/)[0],adapter=indent+'// Keep original grant calls and rejection checks on the owned PG73 ledger.\n'+indent+'const grantPostgresRuntime = ({ DATABASE_URL }) =>\n'+indent+'  grantPg73RuntimeFixture({ cluster, migrator, migratorUrl: DATABASE_URL });\n';
 const anchor=expected.indexOf(callLine);assert.ok(anchor>=0);expected=expected.slice(0,anchor)+adapter+expected.slice(anchor);
 const nonFormal=old.readdirCalls.filter(c=>!['readdir(migrationDir)','readdir(migrations)'].includes(c.source));
 assert.deepEqual(current.readdirCalls,nonFormal,file+': recursive readdir source retained');
 const oldFs=b.match(/^import \{[^\n]*\breaddir\b[^\n]*\} from 'node:fs\/promises';\r?\n/m)?.[0];assert.ok(oldFs);
 let newFs=oldFs;
 if(nonFormal.length===0){newFs=oldFs.replace(/readdir,\s*/,'').replace(/,\s*readdir(?=\s*\})/,'').replace(/\r?\n$/,'\n');assert.ok(!newFs.includes('readdir'));expected=once(expected,oldFs,newFs);}else assert.ok(a.includes(oldFs));
 assert.ok(Buffer.from(expected).equals(after),'Whole-file exact approved edit set '+file);
 let reverse=once(a,adapter,'');reverse=once(reverse,newGrantImport,oldGrantImport);for(const line of formalLines)reverse=once(reverse,line.replacement,line.source);if(nonFormal.length===0)reverse=once(reverse,newFs,oldFs);
 assert.ok(Buffer.from(reverse).equals(before),'Whole-file baseline reverse '+file);
 assert.equal(current.wrappers.length,1);assert.equal(current.helperCalls.length,1);assert.equal(current.loaderCalls.length,formalLines.length);
 assert.equal(current.wrappers[0].source,'grantPostgresRuntime = ({ DATABASE_URL }) =>\n'+indent+'  grantPg73RuntimeFixture({ cluster, migrator, migratorUrl: DATABASE_URL })');
 assert.equal(current.helperCalls[0].source,'grantPg73RuntimeFixture({ cluster, migrator, migratorUrl: DATABASE_URL })');
 if(finalStep){assert.ok(a.includes(entry.finalCorpusCheck.contractSource));const condition=current.conditions.find(c=>c.source.includes('finalMigrationNames.length'));assert.ok(condition&&condition.source.includes('!==73')&&condition.source.includes('report.sourceSha256.formalMigrations'));}
 if([95,96].includes(entry.step)){assert.equal(old.grants.length,entry.step===95?3:4);assert.ok(old.grants[0].source===old.grants[1].source);assert.equal(current.grants.length,entry.step===95?3:4);assert.ok(entry.negativeGrantAssertions.length>0);}
 if([99,106].includes(entry.step)){assert.equal(old.grants.length,1);assert.ok(old.grants[0].source.includes('postgres://cinatoken_gateway_migrator:'));assert.ok(entry.initialOrPostGrant[0].semanticRole.includes('post-proposal'));assert.equal(current.grants[0].source,old.grants[0].source);}
 const originals={assertions:old.assertions.length,grants:old.grants.length,sqlTemplates:old.templates.length,sqlAndTransactions:old.transactions.length,cleanup:old.cleanup.length,reporters:old.reporters.length,conditionalTests:old.conditions.length};
 assert.equal(claim.originalSqlTemplates,originals.sqlTemplates);assert.equal(claim.originalSqlAndTransactionCalls,originals.sqlAndTransactions);
 fileResults.push({step:entry.step,file,baseGitBlob:original.blob,before:info(before),after:info(after),wholeForwardAllowedEditsExact:true,wholeReverseBaselineBytesExact:true,originalAstAndSourceProofSha256:proof(old),allOriginalAssertionsGrantsSqlLocksRolesWaitsTimeoutSkipCleanupSourceExact:true,originals,originalTestOptions:old.options.map(o=>o.source),formalLoaderReplacements:formalLines.map(l=>({before:l.source,after:l.replacement})),singleOwnedLocalGrantBinding:true,recursiveReaddirPreserved:nonFormal.map(c=>c.source),originalGrantCallSources:old.grants.map(c=>c.source),finalCorpusContract:finalStep?entry.finalCorpusCheck.contractSource:null,originalFinalFailureConditionExact:finalStep?true:null,idempotentAndPostSplitRejectionExact:[95,96].includes(entry.step),lateSuccessfulRerunContractExact:[99,106].includes(entry.step)});
 sourceByFile.set(file,{before,after});
}
const protectedInputs=[];
for(let i=0;i<protectionPaths.length;i++){const file=protectionPaths[i],original=gitInputs[i+files.length],working=bytes(join(repo,file)),claim=producer.protection[i];
 assert.ok(working.equals(original.bytes),file);assert.equal(claim.blob,original.blob);check(working,claim);
 protectedInputs.push({file,baseGitBlob:original.blob,...info(working),baseBytesExact:true,group:priorFour.includes(file)?'prior-four-fixture-extra-protection':inventory.protection.inputs.find(p=>p.path===file).group});
 sourceByFile.set(file,{before:original.bytes,after:working});}
const groups=Object.fromEntries([...new Set(protectedInputs.map(p=>p.group))].map(group=>[group,protectedInputs.filter(p=>p.group===group).length]));
assert.deepEqual(groups,producer.protectionGroups);assert.equal(groups['formal-sql'],81);assert.equal(groups['proposal-sql'],85);assert.equal(groups['excluded-fixture'],29);assert.equal(groups['prior-four-fixture-extra-protection'],4);
const helperPath='scripts/db/cutover/pg73-native-fixture.mjs',productionGrantPath='scripts/db/cutover/grant-postgres-runtime.ts';
assert.ok(protectedInputs.some(p=>p.file===helperPath));assert.ok(protectedInputs.some(p=>p.file===productionGrantPath));
const helper=sourceByFile.get(helperPath).before.toString('utf8'),productionGrant=sourceByFile.get(productionGrantPath).before.toString('utf8');
assert.ok(helper.includes('cluster?.owned'));assert.ok(helper.includes("target.hostname === '127.0.0.1'"));assert.ok(helper.includes('Number(target.port) === cluster.port'));
assert.ok(helper.includes("const lastPg73 = '0073_recovery_api_key_workspace_lock.sql'"));assert.ok(helper.includes('await grantPostgresRuntime({ DATABASE_URL: migratorUrl })'));
assert.ok(helper.includes('DROP TABLE cinatoken_gateway.config_change_audit'));assert.ok(helper.includes("ALTER ROLE cinatoken_gateway_runtime NOLOGIN"));assert.ok(helper.includes('assert.deepEqual(await runtimeState(), originalRuntime'));
assert.ok(productionGrant.includes('0074_config_change_audit.sql'));assert.ok(productionGrant.includes('config_change_audit'));
const formal=protectedInputs.filter(p=>p.group==='formal-sql'),pg73=formal.filter(p=>basename(p.file)<='0073_recovery_api_key_workspace_lock.sql').sort((a,b)=>a.file.localeCompare(b.file,'en'));
assert.equal(pg73.length,73);assert.equal(basename(pg73.at(-1).file),'0073_recovery_api_key_workspace_lock.sql');
const corpus=pg73.map(p=>basename(p.file)+'\n'+sourceByFile.get(p.file).before.toString('utf8')).join('\n'),corpusSha256=info(Buffer.from(corpus)).sha256,ledgerMd5=createHash('md5').update(pg73.map(p=>basename(p.file)).join('\n')).digest('hex');
assert.equal(corpusSha256,'23afef61a8a670e0af8c90e3a138f522e6b283b454e380a592bf85bca83108dc');assert.equal(ledgerMd5,'ca1ea96a1b4bcd0675642f30dcf48042');
assert.equal(producer.unchangedHelperCorpus.sha256,corpusSha256);assert.equal(producer.unchangedHelperCorpus.ledgerMd5,ledgerMd5);
const workflow=sourceByFile.get('.github/workflows/proxy-dispatch-safety.yml').before.toString('utf8'),workflowLines=workflow.split('\n');
const workflowMappings=[];
for(const entry of selected){
 const start=entry.workflowLine-1;assert.match(workflowLines[start],/^[ ]{6}- run: \|$/);
 let end=start+1;while(end<workflowLines.length&&!/^[ ]{6}- /.test(workflowLines[end]))end++;
 const block=workflowLines.slice(start,end).join('\n');assert.ok(block.includes('node --import tsx --test '+entry.fixture));
 assert.ok(block.includes('GATEWAY_NATIVE_PG_BIN=/usr/lib/postgresql/18/bin'));assert.equal(entry.step,entry.yamlStep+2);
 workflowMappings.push({step:entry.step,yamlStep:entry.yamlStep,runBlockStartLine:entry.workflowLine,commandLine:start+workflowLines.slice(start,end).findIndex(line=>line.includes(entry.fixture))+1,fixture:entry.fixture,blockSha256:info(Buffer.from(block)).sha256});
}
const ownerNames=readdirSync(owner).sort(),ownerSnapshot=ownerNames.map(name=>{const p=join(owner,name),s=lstatSync(p);assert.ok(s.isFile()&&!s.isSymbolicLink(),p);return {file:name,...info(bytes(p))};});
for(const item of producer.evidenceFiles)check(bytes(item.path),item);
const sourceAudit=json(join(owner,'26-source-audit.json'));assert.deepEqual(sourceAudit.files,producer.finalFiles);assert.deepEqual(sourceAudit.protection,producer.protection);assert.deepEqual(sourceAudit.totals,producer.preservedCounts);
const receiptNames=ownerNames.filter(n=>n.endsWith('.closed.json'));assert.equal(receiptNames.length,42);
assert.deepEqual([...producer.commandReceipts.map(c=>basename(normalize(c.path))),basename(normalize(producer.finalWriterClosedReceipt))].sort(),receiptNames);
const receipts=[];
for(const name of receiptNames){const path=join(owner,name),b=bytes(path),r=JSON.parse(b.toString('utf8')),embedded=producer.commandReceipts.find(c=>normalize(c.path)===normalize(path));
 if(embedded){check(b,embedded);for(const key of ['at','finishedAt','executable','args','actualExit','signal','stdout','stderr','stdoutInfo','stderrInfo'])assert.deepEqual(r[key],embedded[key]);assert.equal(r.spawnError??null,embedded.spawnError);assert.equal(r.exception??null,embedded.exception);}
 assert.ok(Number.isFinite(Date.parse(r.at))&&Number.isFinite(Date.parse(r.finishedAt))&&Date.parse(r.finishedAt)>=Date.parse(r.at));assert.ok([0,1].includes(r.actualExit));assert.equal(r.signal,null);assert.ok(!r.spawnError&&!r.exception);
 for(const stream of ['stdout','stderr']){assert.equal(typeof r[stream],'string');assert.equal(normalize(r[stream]),normalize(join(owner,name.replace('.closed.json','.'+stream+'.log'))));check(bytes(r[stream]),r[stream+'Info']);}
 receipts.push({file:name,...info(b),actualExit:r.actualExit,at:r.at,finishedAt:r.finishedAt,args:r.args,stdout:r.stdout,stderr:r.stderr,stdoutInfo:r.stdoutInfo,stderrInfo:r.stderrInfo,rawBytesAndSha256Exact:true});
}
assert.equal(receipts.filter(r=>r.actualExit===0).length,40);assert.equal(receipts.filter(r=>r.actualExit===1).length,2);
assert.deepEqual(receipts.filter(r=>r.actualExit===1).map(r=>r.file).sort(),['finalize26.closed.json','repair26.closed.json']);
assert.match(bytes(join(owner,'repair26.stderr.log')).toString(),/3 !== 2/);assert.match(bytes(join(owner,'finalize26.stderr.log')).toString(),/ENOENT/);assert.match(bytes(join(owner,'finalize26.stderr.log')).toString(),/step-60\.final-after/);
for(const claim of [producer.historicalPlanningFailure.receipt,producer.historicalFinalizerFailure.receipt])check(bytes(claim.path),claim);
assert.equal(producer.historicalPlanningFailure.repositoryWritesAtFailure,0);assert.equal(producer.historicalFinalizerFailure.repositoryWritesAtFailure,0);
const firstPlanner=bytes(join(owner,'repair26.mjs')).toString('utf8');const failedAnchorPosition=firstPlanner.indexOf("'local-owned-grant-binding'");assert.ok(failedAnchorPosition>=0&&failedAnchorPosition<firstPlanner.indexOf('for(const plan of plans'));assert.ok(firstPlanner.indexOf('for(const plan of plans)')<firstPlanner.indexOf('await writeFile(join(repo,plan.file)'));
const syntax=receipts.filter(r=>r.file.startsWith('syntax-step-'));assert.equal(syntax.length,26);assert.deepEqual(syntax.map(r=>Number(r.file.match(/^syntax-step-(\d+)/)[1])).sort((a,b)=>a-b),allowedSteps);for(const r of syntax){assert.equal(r.actualExit,0);assert.equal(r.args[0],'--check');assert.equal(r.stdoutInfo.bytes,0);assert.equal(r.stderrInfo.bytes,0);}
for(const snapshot of ownerSnapshot){const match=snapshot.file.match(/^(.*\.native\.test\.mjs)\.(before(?:-v2)?|prepared-after(?:-v2)?|final-after)$/);if(match){const file=files.find(f=>basename(f)===match[1]);assert.ok(file);assert.ok(bytes(join(owner,snapshot.file)).equals(sourceByFile.get(file)[match[2].startsWith('before')?'before':'after']));}}
assert.equal(producer.truthBoundary.realPgExecuted,false);assert.equal(producer.truthBoundary.nativeFixtureExecuted,false);assert.equal(producer.truthBoundary.actualLinuxPassClaim,false);
assert.equal(git('final-head-v5',['rev-parse','HEAD']).toString().trim(),base);
for(const file of allPaths)assert.ok(bytes(join(repo,file)).equals(sourceByFile.get(file).after),'Final scoped source snapshot stable '+file);
for(const snapshot of ownerSnapshot)check(bytes(join(owner,snapshot.file)),snapshot);
const peerInitialInspector=json(join(out,'inspect-native26.closed.json'));assert.equal(peerInitialInspector.actualExit,1);const peerInitialFormal=json(join(out,'review-native26.closed.json'));assert.equal(peerInitialFormal.actualExit,1);const peerSecondFormal=json(join(out,'review-native26-v2.closed.json'));assert.equal(peerSecondFormal.actualExit,1);
const totals={files:26,originalAssertions:fileResults.reduce((n,f)=>n+f.originals.assertions,0),originalGrantCalls:fileResults.reduce((n,f)=>n+f.originals.grants,0),originalSqlTemplates:fileResults.reduce((n,f)=>n+f.originals.sqlTemplates,0),originalSqlAndTransactionCalls:fileResults.reduce((n,f)=>n+f.originals.sqlAndTransactions,0),unchangedInventoryProtection:298,extraPriorFourProtection:4,totalUnchangedProtection:302,totalInventoryPlusExtraFour:328};
assert.deepEqual(totals,producer.preservedCounts);assert.equal(totals.originalAssertions,2233);assert.equal(totals.originalGrantCalls,35);
const peerFailureReasons={
 'review-native26-v4.closed.json':'Reviewer v4 compared optional omitted non-error fields to producer embedded normalized null; v5 requires exact mandatory fields and verifies absent-or-null optional non-errors against the declared null.',
 'inspect-native26.closed.json':'Initial inspector assumed the legacy producer files field instead of this schema finalFiles.',
 'review-native26.closed.json':'Initial reviewer assumed step95 and96 each had four original grants. Exact originals are three for95 and four for96.',
 'review-native26-v2.closed.json':'Reviewer v2 contained an extra closing parenthesis and failed parsing before any Git reads or source audit.',
 'review-native26-v3.closed.json':'Reviewer v3 treated workflowLine as a fixture command line. It points to the multiline YAML run header; v4 verifies the bounded original run block and exact Linux command.'
};
const peerFailures=readdirSync(out).filter(n=>n.endsWith('.closed.json')).map(file=>({file,receipt:json(join(out,file))})).filter(x=>x.receipt.actualExit===1).map(({file,receipt})=>{
 assert.ok(peerFailureReasons[file]);check(bytes(receipt.stdout),receipt.stdoutInfo);check(bytes(receipt.stderr),receipt.stderrInfo);
 return {file,path:join(out,file),actualExit:1,reason:peerFailureReasons[file],stdoutInfo:receipt.stdoutInfo,stderrInfo:receipt.stderrInfo};
});
assert.equal(peerFailures.length,5);

const report={schema:'cinatoken.native26-independent-peer.final.v1',at:new Date().toISOString(),actualExit:0,readyForRootReviewAndCommit:true,findings:[],baseCommit:base,reviewedNativePathsOnly:true,producer:{path:producerPath,...info(producerBytes),all42ClosedReceiptsVerified:true,actualZero:40,actualOne:2,allRawCommandLogsByteSha256Verified:true,sourceSnapshotsAndRegularFileSetStable:true,allRegularFiles:ownerSnapshot},inventory:{path:inventoryPath,...info(inventoryBytes),candidateSteps:allowedSteps,immutableBaseReadVerified:true},files:fileResults,workflowMappings,totals,protectionGroups:groups,protectedInputs,historicalPg73:{count:pg73.length,last:basename(pg73.at(-1).file),corpusSha256,ledgerMd5,independentlyHashedFromExactGitAndProtectedSources:true},specialContracts:{finalCorpusAndOriginalIfShaFailureSteps:[82,83,84,85],recursiveReaddirSteps:[81,83,84,85],idempotentTwoInitialGrantAndAllMarkerRejectionSteps:[95,96],lateSuccessfulGrantSteps:[99,106],originalProduction0074AdmissionUnchanged:true,helperSourceUnchanged:true,formal81AndProposal85SqlUnchanged:true,excluded29AndPriorFourUnchanged:true},producerClosedReceipts:receipts,preservedProducerFailures:{planner:{receipt:'repair26.closed.json',actualExit:1,reason:'Original duplicate grant-line planning anchor: 3 split parts versus expected 2; all planning completed before repository apply loop.',stderrInfo:info(bytes(join(owner,'repair26.stderr.log')))},finalizer:{receipt:'finalize26.closed.json',actualExit:1,reason:'Original read-only finalizer referenced step-60.final-after instead of actual basename snapshot; original ENOENT and raw script retained.',stderrInfo:info(bytes(join(owner,'finalize26.stderr.log')))}},peerReaderFailures:peerFailures,peerReadOnlyCommands:ownCommands,scope:{repositoryWrites:0,markdownWrites:0,gitMutations:0,testExecutions:0,syntaxReruns:0,cliNetworkCalls:0,ciTriggers:0,databaseExecutions:0,productionRequests:0,newDirectDiagnosticsAndOtherRootChangesExcludedFromNativeScope:true},truthBoundary:{nativeFixturesExecuted:false,actualLinuxPassClaim:false,fullPipelinePassDerived:false,fullG7Verified:false,fullG8Verified:false},limitations:['The 26 native fixtures have not been executed on Linux PostgreSQL 18.6 in this preparation. Existing syntax 0 and exact source preservation do not establish native runtime pass.','Only original step60 v374:125:14 had an observed 81-versus-73 failure in supplied source473 run37409463636. The other25 are source/inventory based adaptations.','The unchanged existing PG73 fixture bridge still calls the production0074 reconciler. Its complete runtime behavior, all original negative/idempotent/finally/late-rerun paths and the full native workflow require real Linux CI after commit.','This review intentionally covers only26 owned native paths and302 immutable inputs. Other Root-approved direct diagnostic additions and checklist edits are outside native review scope.']};
write('FINAL-native26-independent-peer.json',report);
const reportBytes=bytes(join(out,'FINAL-native26-independent-peer.json'));
console.log(JSON.stringify({actualExit:0,readyForRootReviewAndCommit:true,path:join(out,'FINAL-native26-independent-peer.json'),...info(reportBytes),totals,producerClosedReceipts:42,producerActualZero:40,producerActualOne:2,actualLinuxPassClaim:false}));
