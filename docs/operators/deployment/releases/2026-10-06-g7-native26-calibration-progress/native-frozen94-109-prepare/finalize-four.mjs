import assert from'node:assert/strict';import{readFile,writeFile,readdir}from'node:fs/promises';import{join}from'node:path';
import{out,repo,info}from'./capture.mjs';
const load=async n=>JSON.parse(await readFile(join(out,n),'utf8'));
const base=await load('base-inputs.json'),plans=await load('four-planned-edits.json'),applied=await load('four-applied.json');
const audit=await load('four-independent-audit-v3.json'),checks=await load('four-static-command-checks.json');
const priorPins=await load('prior-pin-final.stdout.log'),priorOwner=await load('prior-owner-final.stdout.log');
assert.equal(base.baseCommit,'dc7be6f8597333151c450bae3ae15e6585e3b2eb');
for(const x of[base,plans,applied,audit,checks])assert.equal(x.actualExit,0);
assert.equal(plans.allPreparedBeforeRepositoryWrites,true);
assert.equal(applied.repositoryWrites.length,4);
assert.deepEqual(applied.repositoryWrites.map(r=>r.path).sort(),base.allowedPaths.toSorted());
assert.deepEqual(audit.totals,{files:4,wrappers:2,snapshots:2,originalAssertions:148,originalGrants:4,
 originalSqlTemplates:149,originalSqlAndTransactions:173,owner302ProtectedExceptAllowed2:300,
 priorNative26Unchanged:26,priorPin23ProtectedExceptAllowed2:21,uniqueProtectedInputs:330});
const finalFiles=[];
for(const r of audit.results){
 for(const k of['fullWrapperReverseBytesExact','allOriginalProtectedCallSourcesAndAstExact','originalPinsAndFrozenCommentsExact',
 'staticNewUrlDigestMatchesOriginalPin','lineagePathMatchesNewUrl','currentLegacyAdapterReverseBytesExact'])assert.equal(r[k],true);
 for(const[path,expected,kind]of[[r.wrapper,r.wrapperAfter,'existing-successor'],[r.snapshotPath,r.snapshot,'new-historical-text-snapshot']]){
  const bytes=await readFile(join(repo,path));assert.deepEqual(info(bytes),expected);
  assert.deepEqual(info(bytes),{bytes:applied.repositoryWrites.find(w=>w.path===path).bytes,sha256:applied.repositoryWrites.find(w=>w.path===path).sha256});
  finalFiles.push({path,kind,...expected});
 }
}
for(const p of audit.protection){assert.equal(p.currentBaseGitBytesExact,true);assert.deepEqual(info(await readFile(join(repo,p.path))),p.expected,'Final protection drift: '+p.path)}
assert.equal(checks.results.length,5);for(const r of checks.results){assert.equal(r.receipt.actualExit,0);assert.equal(r.receipt.signal,null)}
assert.equal(checks.results.filter(r=>/^syntax-/.test(r.label)).length,2);
for(const f of base.frozenInputs){assert.deepEqual(info(await readFile(f.path)),{bytes:f.stdout.bytes,sha256:f.stdout.sha256})}
assert.equal(priorOwner.protection.length,302);assert.equal(priorPins.workingInputs.length,23);
const oldCi=priorPins.originalNativeEvidence;
const raw=await readFile(oldCi.raw.stdout.path);assert.deepEqual(info(raw),{bytes:556674,sha256:'c78e11593edf9b694d5a490647fd37f4863aa44f22be14d367e592975dbb8d28'});
assert.equal(oldCi.originalActualClosedReceipt.actualExit,0);assert.equal(oldCi.originalActualClosedReceipt.signal,null);assert.equal(oldCi.originalActualClosedReceipt.spawnError,null);
const receipts=[];
for(const name of(await readdir(out)).filter(n=>n.endsWith('.closed.json')).sort()){
 const bytes=await readFile(join(out,name)),r=JSON.parse(bytes.toString());
 assert.equal(r.signal,null);assert.equal(r.spawnError??null,null);
 if(r.operation==='readFile'&&r.error){assert.equal(r.actualExit,null);assert.equal(r.error.code,'ENOENT');assert.match(name,/^(instructions-[0-5]|fixture-instructions(?:-v3)?|historical-instructions(?:-v3)?)\.closed\.json$/)}
 else assert.equal(r.actualExit,['prepare-audit-v2.closed.json','audit-four-v2.closed.json'].includes(name)?1:0);
 assert.deepEqual(info(await readFile(r.stdout.path)),{bytes:r.stdout.bytes,sha256:r.stdout.sha256});
 assert.deepEqual(info(await readFile(r.stderr.path)),{bytes:r.stderr.bytes,sha256:r.stderr.sha256});
 receipts.push({receiptPath:join(out,name),receiptInfo:info(bytes),...r});
}
const failures=receipts.filter(r=>r.actualExit===1);assert.equal(failures.length,2);
assert.match(await readFile(failures.find(r=>r.receiptPath.endsWith('prepare-audit-v2.closed.json')).stderr.path,'utf8'),/Expected unique-version adaptation/);
assert.match(await readFile(failures.find(r=>r.receiptPath.endsWith('audit-four-v2.closed.json')).stderr.path,'utf8'),/MODULE_NOT_FOUND/);
const evidenceNames=['capture.mjs','run.mjs','collect-base.mjs','prepare-four.mjs','audit-four.mjs','verify-four.mjs',
 'prepare-audit-v2.mjs','prepare-audit-v3.mjs','audit-four-v3.mjs','finalize-four.mjs',
 'base-inputs.json','four-planned-edits.json','four-applied.json','four-independent-audit.json','four-independent-audit-v3.json','four-static-command-checks.json'];
const evidenceFiles=[];for(const n of evidenceNames)evidenceFiles.push({path:join(out,n),...info(await readFile(join(out,n)))});
const report={schema:'cinatoken.native-frozen94-109-four-file-preparation.final.v1',frozenAt:new Date().toISOString(),actualExit:0,platform:process.platform,
 baseCommit:base.baseCommit,repositoryWritePaths:base.allowedPaths,finalFiles,plannedOperations:plans.plans,
 authority:{historical:base.targets.map((t,i)=>({step:t.step,originalCommit:t.originalCommit,sourcePath:t.legacy,
  originalBlob:base.gitBlobs[i*3+2],oldFrozenBytes:t.oldBytes,oldFrozenSha256:t.pin,
  currentBaseLegacyBlob:base.gitBlobs[i*3+1],currentBaseLegacyBytes:t.currentBytes,currentBaseLegacySha256:t.currentSha256})),
  actualStep94Failure:{runId:37412060008,jobId:112102451588,headSha:'dcc6ab52f21a18c5d1c02d8a4a4a390f039e61fc',line:187,column:14,raw:oldCi.raw,originalActualClosedDownload:oldCi.originalActualClosedReceipt,group:oldCi.observedFailingStep94},
  step109:'The old/current identity mismatch was observed statically; step109 was skipped after actual step94 failure. No actual109 pass/failure claim.',
  priorFrozenPinReport:base.frozenInputs.find(r=>r.path.includes('FINAL-native-pin94')),
  initialHead:base.head},
 changes:{snapshots:'Write the raw stdout bytes from the original pin-introduction Git blobs into non-executable .native.test.mjs.txt files. No encoding or newline conversion.',
  step94:'Replace the existing historical read URL and lineage historicalFixture path with the historical text snapshot path.',
  step109:'Replace historicalNativeTest URL and add the corresponding path to its existing lineage object, which previously had only the SHA and contract fields.',
  originalPins:'603646803c82d3209987260ad682a34169b4e53ca7b03b672d818e3a28d7cc13 andd95055419a04465c7c172ff0b8426bd0b928bd538e4dad80f9442229abd5e269 unchanged.',
  originalFrozenComments:'Both top-of-file historical/frozen comments remain byte exact.',
  currentLegacy:'Both PG73-adapted executable legacy fixtures remain byte exact; only historical proof reads are redirected.'},
 independentAudit:{path:join(out,'four-independent-audit-v3.json'),...info(await readFile(join(out,'four-independent-audit-v3.json'))),
  totals:audit.totals,results:audit.results,fullNormalizedAstChildTraversal:true,
  protectionBoundary:'300 inputs from prior owner302 excluding the two allowed wrappers, all prior26 targets,21 inputs from prior pin23 excluding those wrappers and.gitattributes;330 unique files after overlaps.'},
 validation:{staticContract:'New historical URLs were actually resolved/read as files and their SHA256 digests equal the original pinned Git bytes. No test callback or database executed.',
  rawSnapshotAttribute:'git check-attr text returned unset for both new snapshot paths; .gitattributes remains unchanged.',
  syntax:'Two node --check calls actual0.',boundedDiff:'git diff --check for the four allowlisted paths actual0; new untracked snapshots are separately checked byte-for-byte against original Git blobs.',
  protectionAtFreeze:'All330 protected working files rechecked against their independently audited immutable Git hashes at freeze time.',
  originalAssertionAndSqlSources:'148 assertions,4 grant calls,149 templates and173 SQL/transaction call sources and full normalized ASTs exact; timeout/skip/cleanup/conditional/reporter source/AST exact.',
  wholeWrapperReverse:'Independent permitted-path reverse yields each complete dc7 baseline wrapper byte-for-byte.',
  currentLegacyHistoricalReverse:'The previously existing helper/import/loader/two-grant adapter reversal yields each complete old original Git source byte-for-byte.'},
 preservedToolFailures:{failures,repositoryWritesDuringFailures:0,
  explanation:'The v2 audit generator expected a backtick snapshot filename suffix while the original script used quoted names and exited1 before writing v2. Its attempted missing v2 audit then exited1. Both raw errors and original scripts remain. A separate v3 generator and complete AST audit closed0.',
  firstAuditBoundary:'Initial audit already proved all original protected source strings and whole-file reverse bytes. Its AST shape callback returned an array length and could stop sibling traversal; v3 explicitly traverses all child nodes and repeats the independent source audit.'},
 evidenceFiles,commandReceipts:receipts,
 receiptCounts:{alreadyClosed:receipts.length,actualZero:receipts.filter(r=>r.actualExit===0).length,actualOne:2,
  actualNull:receipts.filter(r=>r.actualExit===null).length,expectedAbsentInstructionReads:10,signals:0,spawnErrors:0},
 finalWriterClosedReceipt:join(out,'finalize-four.closed.json'),
 finalWriterReceiptBoundary:'The wrapper closes this finalizer and records its actual exit, stdout/stderr byte counts and hashes after writing this JSON.',
 truthBoundary:{preparedOnly:true,nativeExecuted:false,databaseExecuted:false,appRerun:false,
  linuxPassClaim:false,productionWrites:0,helperWrites:0,sqlWrites:0,markdownWrites:0,gitMutations:0,ciActions:0,networkCalls:0,
  onlyRepositoryWrites:'Exactly the two allowlisted successor wrappers and two new historical text snapshots.',
  previousTempRootsNeverWritten:true,rootNextAction:'Independent peer review, commit/push and original Linux workflow validation are Root-owned.',ownerStopWrites:true}
};
assert.equal(report.receiptCounts.actualNull,10);
const path=join(out,'FINAL-native-frozen94-109-preparation.json'),bytes=Buffer.from(JSON.stringify(report,null,2)+'\n');
await writeFile(path,bytes,{flag:'wx'});
console.log(JSON.stringify({path,...info(bytes),actualExit:0,repositoryFiles:4,originalAssertions:148,originalGrants:4,
 protectedUnchangedInputs:330,syntaxPassed:2,closedBeforeFinalWriter:receipts.length,
 actualZeros:report.receiptCounts.actualZero,actualOnes:2,expectedNullInstructionReads:10,nativeExecuted:false,ownerStopWrites:true}));
