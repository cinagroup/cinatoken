import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const owner='C:/Users/cina/AppData/Local/Temp/cinatoken-retention-v346-time-text-candidate-1a110046edafc3b0b4778a3a';
const repo='C:/cinagroup/cinatoken',source='scripts/db/cutover/postgres-shared-key-buyer-receipt-retention-v346.native.test.mjs';
const info=b=>({bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});
const json=b=>JSON.stringify(b,null,2)+'\n';
async function capture(label,args){
 const at=new Date().toISOString(),chunks=[],errors=[];
 const child=spawn(process.execPath,args,{cwd:repo,windowsHide:true,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>chunks.push(b));child.stderr.on('data',b=>errors.push(b));let spawnError=null;child.once('error',e=>spawnError=String(e));
 const close=await new Promise(resolve=>child.once('close',(actualExit,signal)=>resolve({actualExit,signal})));
 const stdout=Buffer.concat(chunks),stderr=Buffer.concat(errors),stdoutPath=join(root,label+'.stdout.log'),stderrPath=join(root,label+'.stderr.log');
 await writeFile(stdoutPath,stdout,{flag:'wx'});await writeFile(stderrPath,stderr,{flag:'wx'});
 const receipt={at,finishedAt:new Date().toISOString(),executable:process.execPath,args,cwd:repo,...close,spawnError,
  stdout:{path:stdoutPath,...info(stdout)},stderr:{path:stderrPath,...info(stderr)}};
 await writeFile(join(root,label+'.closed.json'),json(receipt),{flag:'wx'});return receipt;
}
function walk(node,visit){if(!node||typeof node!=='object')return;if(Array.isArray(node)){for(const n of node)walk(n,visit);return;}if(node.type)visit(node);for(const [key,value]of Object.entries(node))if(!['loc','start','end'].includes(key))walk(value,visit);}
const normalize=ast=>JSON.stringify(ast,(key,value)=>['start','end','loc'].includes(key)?undefined:typeof value==='bigint'?String(value)+'n':value);
if(process.argv[2]==='audit'){
 const beforeRaw=await readFile(join(root,'source-before.snapshot.txt')),afterRaw=await readFile(join(root,'candidate-review.native.test.mjs'));
 assert.deepEqual(info(beforeRaw),{bytes:20654,sha256:'c9093cb5c5f167f8e7604b9b91c4d937c8b638a8b0cd1f2dbcdeb88a140dc984'});
 assert.deepEqual(info(afterRaw),{bytes:20768,sha256:'12c37aa3f7151ccab6b39b98fe720661a95695351806c0c802454d8b22c560e6'});
 assert.equal(Buffer.compare(await readFile(join(owner,'source-original-6e2.snapshot.txt')),beforeRaw),0);
 assert.equal(Buffer.compare(await readFile(join(owner,'candidate-retention-time-text.native.test.mjs')),afterRaw),0);
 const ownerFinalPath=join(owner,'FINAL-retention-seven-time-input-candidate.json'),ownerFinalRaw=await readFile(ownerFinalPath);
 assert.deepEqual(info(ownerFinalRaw),{bytes:26187,sha256:'b9007222d13aa49b2e77ed4c4ea4a79f6a0a3b458d86955542a4c50cc267aaf9'});
 const ownerFinal=JSON.parse(ownerFinalRaw);
 const gitReceiptPath=join(owner,'baseline-git.closed.json'),gitReceiptRaw=await readFile(gitReceiptPath),gitReceipt=JSON.parse(gitReceiptRaw);
 assert.equal(gitReceipt.actualExit,0);assert.equal(gitReceipt.signal,null);assert.equal(gitReceipt.spawnError,null);
 assert.equal(gitReceipt.stdin.text,'6e2d65b35d4d60b3b14dac2ecbf9fbaa8ca363fa:'+source+'\nd537f83b6389a4e5bbd7f92325f74d77e6bdfc9a:'+source+'\n');
 assert.deepEqual(info(Buffer.from(gitReceipt.stdin.text)),{bytes:gitReceipt.stdin.bytes,sha256:gitReceipt.stdin.sha256});
 const gitRaw=await readFile(gitReceipt.stdout.path),gitErr=await readFile(gitReceipt.stderr.path);
 assert.deepEqual(info(gitRaw),{bytes:gitReceipt.stdout.bytes,sha256:gitReceipt.stdout.sha256});assert.deepEqual(info(gitErr),{bytes:gitReceipt.stderr.bytes,sha256:gitReceipt.stderr.sha256});assert.equal(gitErr.length,0);
 const blob=createHash('sha1').update(Buffer.from('blob '+beforeRaw.length+'\0')).update(beforeRaw).digest('hex');assert.equal(blob,'47b50617fcc785a982efc79c71834267adbe7a20');
 let cursor=0;const gitRecords=[];for(let i=0;i<2;i++){
  const end=gitRaw.indexOf(10,cursor);assert.ok(end>=0);const header=gitRaw.subarray(cursor,end).toString('utf8');assert.equal(header,blob+' blob '+beforeRaw.length);
  cursor=end+1;const bytes=gitRaw.subarray(cursor,cursor+beforeRaw.length);assert.equal(Buffer.compare(bytes,beforeRaw),0);cursor+=beforeRaw.length;assert.equal(gitRaw[cursor++],10);gitRecords.push({blob,type:'blob',...info(bytes)});
 }assert.equal(cursor,gitRaw.length);
 const before=beforeRaw.toString('utf8'),after=afterRaw.toString('utf8');assert.equal(Buffer.compare(Buffer.from(before),beforeRaw),0);assert.equal(Buffer.compare(Buffer.from(after),afterRaw),0);
 const oldMap='args.map((_, i) => `$${i + 1}`)',newMap="args.map((_, i) => name === 'prune_buyer_budget_receipts' && i === 0 ? '$1::text::timestamptz' : `$${i + 1}`)";
 assert.equal(before.split(oldMap).length-1,1);assert.equal(after.split(newMap).length-1,1);
 const beforeLines=before.split('\n'),afterLines=after.split('\n');assert.equal(beforeLines.length,afterLines.length);
 const changedLines=beforeLines.flatMap((line,i)=>line===afterLines[i]?[]:[i+1]);assert.deepEqual(changedLines,[164,231,240,288,291,301,352]);
 const explicit=after.replace(newMap,()=>oldMap);const casts=[...explicit.matchAll(/\$([12])::text::timestamptz/g)];assert.equal(casts.length,6);
 const explicitLines=casts.map(m=>explicit.slice(0,m.index).split('\n').length);assert.deepEqual(explicitLines,[231,240,288,291,301,352]);
 const reversed=explicit.replace(/\$([12])::text::timestamptz/g,(_,p)=>'$'+p+'::timestamptz');assert.equal(Buffer.compare(Buffer.from(reversed),beforeRaw),0);
 const parserPath=join(repo,'node_modules/acorn/dist/acorn.mjs'),parserRaw=await readFile(parserPath),{parse}=await import('file:///C:/cinagroup/cinatoken/node_modules/acorn/dist/acorn.mjs');
 const parseCode=code=>parse(code,{ecmaVersion:'latest',sourceType:'module',locations:true});
 const beforeAst=parseCode(before),afterAst=parseCode(after),reverseAst=parseCode(reversed);assert.equal(normalize(beforeAst),normalize(reverseAst));
 const normalizedCandidate=parseCode(after);let templates=0,dynamic=0;
 walk(normalizedCandidate,node=>{
  if(node.type==='TemplateElement'&&/\$[12]::text::timestamptz/.test(node.value.raw)){
   templates+=[...node.value.raw.matchAll(/\$[12]::text::timestamptz/g)].length;
   for(const key of ['raw','cooked'])node.value[key]=node.value[key].replace(/\$([12])::text::timestamptz/g,(_,p)=>'$'+p+'::timestamptz');
  }
  if(node.type==='ArrowFunctionExpression'&&node.body.type==='ConditionalExpression'&&node.body.consequent.type==='Literal'&&node.body.consequent.value==='$1::text::timestamptz'){
   assert.deepEqual(node.params.map(p=>p.name),['_','i']);const t=node.body.test;assert.equal(t.type,'LogicalExpression');assert.equal(t.operator,'&&');
   assert.equal(t.left.type,'BinaryExpression');assert.equal(t.left.operator,'===');assert.equal(t.left.left.name,'name');assert.equal(t.left.right.value,'prune_buyer_budget_receipts');
   assert.equal(t.right.type,'BinaryExpression');assert.equal(t.right.operator,'===');assert.equal(t.right.left.name,'i');assert.equal(t.right.right.value,0);
   assert.equal(node.body.alternate.type,'TemplateLiteral');assert.equal(normalize(node.body.alternate),normalize(parseCode(oldMap+';').body[0].expression.arguments[0].body));
   node.body=node.body.alternate;dynamic++;
  }
 });assert.equal(templates,6);assert.equal(dynamic,1);assert.equal(normalize(normalizedCandidate),normalize(beforeAst));
 const assertionNodes=ast=>{const list=[];walk(ast,n=>{if(n.type==='CallExpression'&&n.callee.type==='MemberExpression'&&n.callee.object.type==='Identifier'&&n.callee.object.name==='assert')list.push(n);});return list.sort((a,b)=>a.start-b.start);};
 const originals=assertionNodes(beforeAst),candidates=assertionNodes(afterAst),restored=assertionNodes(reverseAst);assert.equal(originals.length,36);assert.equal(candidates.length,36);assert.equal(restored.length,36);
 const assertions=originals.map((n,i)=>{const oldSource=before.slice(n.start,n.end),newSource=after.slice(candidates[i].start,candidates[i].end),backSource=reversed.slice(restored[i].start,restored[i].end);assert.equal(backSource,oldSource);assert.equal(normalize(n),normalize(restored[i]));return{line:n.loc.start.line,method:n.callee.property.name,directRawExact:oldSource===newSource,reverseExact:true,original:info(Buffer.from(oldSource))};});
 const changedAssertions=assertions.filter(a=>!a.directRawExact);assert.deepEqual(changedAssertions.map(a=>a.line),[239,299]);
 const delay='// postgres-js binds timestamptz parameters at millisecond precision.\n      await new Promise(resolve => setTimeout(resolve, 10));';assert.ok(before.includes(delay));assert.ok(after.includes(delay));
 const guards=[];for(const expected of ownerFinal.necessaryInputPins){
  const path=join(repo,expected.path),raw=await readFile(path);assert.deepEqual(info(raw),{bytes:expected.bytes,sha256:expected.sha256});guards.push({path,...info(raw)});
 }assert.equal(guards.length,9);
 const packageJson=JSON.parse(await readFile(join(repo,'node_modules/postgres/package.json'),'utf8')),lock=JSON.parse(await readFile(join(repo,'package-lock.json'),'utf8'));
 assert.equal(packageJson.version,'3.4.9');assert.equal(lock.packages['node_modules/postgres'].version,'3.4.9');
 const types=await readFile(join(repo,'node_modules/postgres/src/types.js'),'utf8');assert.ok(types.includes('x => (x instanceof Date ? x : new Date(x)).toISOString()'));assert.ok(types.includes("x => '' + x"));
 const syntax=await capture('node-check',['--check',join(root,'candidate-review.native.test.mjs')]);assert.equal(syntax.actualExit,0);assert.equal(syntax.signal,null);assert.equal(syntax.spawnError,null);
 for(const g of guards)assert.deepEqual(info(await readFile(g.path)),{bytes:g.bytes,sha256:g.sha256});assert.deepEqual(info(await readFile(parserPath)),info(parserRaw));
 assert.equal(Buffer.compare(await readFile(join(owner,'source-original-6e2.snapshot.txt')),beforeRaw),0);assert.equal(Buffer.compare(await readFile(join(owner,'candidate-retention-time-text.native.test.mjs')),afterRaw),0);
 const report={schema:'retention-seven-time-casts-independent-review-v1',at:new Date().toISOString(),preparedOnly:true,reviewPassed:true,
  scope:source,sourceHead:'6e2d65b35d4d60b3b14dac2ecbf9fbaa8ca363fa',candidate:{path:join(root,'candidate-review.native.test.mjs'),...info(afterRaw)},before:{path:join(root,'source-before.snapshot.txt'),blob,...info(beforeRaw)},
  ownerInputs:{root:owner,final:{path:ownerFinalPath,...info(ownerFinalRaw)},gitReceipt:{path:gitReceiptPath,...info(gitReceiptRaw)},originalGitActualExit:gitReceipt.actualExit,gitStdout:gitReceipt.stdout,stdin:gitReceipt.stdin,decodedRecords:gitRecords},
  onlyChanges:{count:7,lines:changedLines,explicitTimestampParameters:6,explicitLines,dynamicPruneFirstPlaceholder:1,integerObserveAndPruneLimitUnchanged:true,allOtherNamesArgsAndExpressionsUnchanged:true},
  fullBytesAfterSevenChangeReverseExact:true,entireASTAfterReverseExact:true,entireASTAfterStructuralNormalizationExact:true,
  assertions:{count:36,directRawExact:34,changedNestedSQLOnly:changedAssertions.map(a=>({statementLine:a.line,method:a.method})),allSourceAndASTAfterReverseExact:true,originalPins:assertions},
  protected:{old10msDelayAndCommentExact:true,allSQLGuardsRoleClientsLocksPermissionsTimeoutCleanupAndImportsUnchangedAfterSevenAuthorizedReversals:true,necessaryInputs:guards,necessaryInputsSecondReadExact:true,parser:{path:parserPath,...info(parserRaw)}},
  nodeCheck:syntax,driverMechanism:{lockedVersion:'3.4.9',timestampSerializerSourceVerified:true,textSerializerSourceVerified:true,staticOnly:true,serializeControlRun:false,actualFailureServerOIDCaptured:false,actualFailureTimeValuesCaptured:false},
  originalFailureBoundary:{runId:37424911830,nativeJobId:112142276121,firstFailureStep:90,location:source+':235:14',expected:true,actual:false,originalNodeExit:1,originalTAP:{tests:1,pass:0,fail:1},followingSteps91to113Skipped:23,legacyParent110And111to113NotExecuted:true,priorD537PassNotApplied:true},
  rootCauseConfirmed:false,newNativePass:false,actions:{repositoryWrites:0,oldFrozenRootsWrites:0,gitCommands:0,networkRequests:0,CIRequests:0,PGWorkerdOrApplicationRuns:0,fixtureImportedOrExecuted:false},
  truthBoundary:'Static preparation review and node --check only. The proposed text parameter casts preserve timestamp text before PostgreSQL casts it. Actual failure parameter OIDs and timestamp values were not observed; live root cause and native runtime success remain unconfirmed.'};
 await writeFile(join(root,'FINAL-independent-retention-review.json'),json(report),{flag:'wx'});
 console.log(JSON.stringify({reviewPassed:true,onlyCasts:7,explicitCasts:6,dynamicPruneFirst:1,all36AssertionsReverseExact:true,directAssertions:34,changedAssertStatementLines:[239,299],nodeCheckExit:syntax.actualExit,rootCauseConfirmed:false,final:info(await readFile(join(root,'FINAL-independent-retention-review.json')))}));
}else{
 const audit=await capture('independent-audit-v2',[fileURLToPath(import.meta.url),'audit']);
 if(audit.actualExit!==0||audit.signal||audit.spawnError){console.log(JSON.stringify(audit));process.exitCode=Number.isInteger(audit.actualExit)?audit.actualExit:1;}else{
  const entries=[];for(const name of (await readdir(root)).sort()){const path=join(root,name),s=await stat(path);assert.ok(s.isFile());entries.push({name,path,...info(await readFile(path)),mtimeMs:s.mtimeMs});}
  for(const e of entries){assert.equal((await stat(e.path)).mtimeMs,e.mtimeMs);assert.deepEqual(info(await readFile(e.path)),{bytes:e.bytes,sha256:e.sha256});}
  const seal={schema:'retention-independent-review-after-close-stopwrite-v1',at:new Date().toISOString(),root,preparedOnly:true,rootCauseConfirmed:false,actualClosedAudit:audit,
   sourceCollectionAndSecondReadExact:true,files:entries.length,entries,selfExcluded:'STOPWRITE-seal.json',afterClose:true,STOPWRITE:true};
  const path=join(root,'STOPWRITE-seal.json');await writeFile(path,json(seal),{flag:'wx'});
  console.log(JSON.stringify({STOPWRITE:true,root,filesBeforeSeal:entries.length,auditExit:audit.actualExit,nodeCheckExit:JSON.parse(await readFile(join(root,'node-check.closed.json'),'utf8')).actualExit,
   final:{path:join(root,'FINAL-independent-retention-review.json'),...info(await readFile(join(root,'FINAL-independent-retention-review.json')))},seal:{path,...info(await readFile(path))}}));
 }
}
