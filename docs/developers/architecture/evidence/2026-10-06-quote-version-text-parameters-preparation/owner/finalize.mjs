import assert from'node:assert/strict';import{readFile,writeFile,readdir}from'node:fs/promises';import{join}from'node:path';
import{out,repo,info}from'./capture.mjs';
const load=async n=>JSON.parse(await readFile(join(out,n),'utf8'));
const input=await load('inputs.json'),audit=await load('independent-cast-audit.json'),checks=await load('static-checks.json'),offline=await load('offline-serialize-proof.json');
assert.equal(audit.actualExit,0);assert.equal(checks.actualExit,0);assert.equal(offline.actualExit,0);assert.equal(offline.driverVersion,'3.4.9');
assert.equal(audit.originalAssertionCount,65);assert.equal(audit.directRawAssertionSourceExact,64);
assert.equal(audit.all65AssertionSourceAndAstExactAfterOnlyAuthorizedCastReverse,true);assert.equal(audit.wholeReverseBytesExact,true);
assert.equal(audit.completeReversedAstExact,true);assert.equal(audit.changedThreeSqlQueries.length,3);assert.equal(audit.transactionsGrantsLoaderImportsCleanupConditionsWaitsOptionsExact,true);
assert.deepEqual(info(await readFile(join(repo,input.target))),audit.after);
for(const p of input.protection)assert.deepEqual(info(await readFile(join(repo,p.path))),{bytes:p.bytes,sha256:p.sha256});
assert.deepEqual(info(await readFile(input.diagnosis.path)),{bytes:26643,sha256:'92f7916e867d6e8c807b0c5dc50ca04321fb5d1c9d0248be477e735fd1706975'});
const receipts=[];
for(const name of(await readdir(out)).filter(n=>n.endsWith('.closed.json')).sort()){
 const raw=await readFile(join(out,name)),r=JSON.parse(raw.toString());assert.equal(r.signal,null);assert.equal(r.spawnError??null,null);
 if(r.operation==='readFile'&&r.error){assert.equal(r.actualExit,null);assert.equal(r.error.code,'ENOENT');assert.match(name,/^instructions-[0-5]\.closed\.json$/)}else assert.equal(r.actualExit,0);
 assert.deepEqual(info(await readFile(r.stdout.path)),{bytes:r.stdout.bytes,sha256:r.stdout.sha256});assert.deepEqual(info(await readFile(r.stderr.path)),{bytes:r.stderr.bytes,sha256:r.stderr.sha256});
 receipts.push({receiptPath:join(out,name),receiptInfo:info(raw),...r});
}
assert.equal(receipts.filter(r=>r.actualExit===null).length,6);
const manifestBytes=Buffer.from(JSON.stringify({schema:'cinatoken-quote-three-casts-command-manifest-v1',commands:receipts,
 actualZero:receipts.filter(r=>r.actualExit===0).length,actualNonzero:0,actualNull:6,expectedAbsentInstructions:6,signals:0,spawnErrors:0},null,2)+'\n');
await writeFile(join(out,'command-manifest.json'),manifestBytes,{flag:'wx'});
const descriptor=async n=>({path:join(out,n),...info(await readFile(join(out,n)))});
const report={schema:'cinatoken-quote-version-three-query-four-cast-preparation.final.v1',frozenAt:new Date().toISOString(),baseCommit:input.baseCommit,
 repositoryWritePaths:[input.target],originalGitBlob:input.originalBlob,before:audit.before,after:audit.after,
 changes:{queries:3,parameterCasts:4,originalParameterLines:[470,470,473,497],comparisonQuery:'$1/$2::timestamptz -> $1/$2::text::timestamptz',
  timeResolvers:'Each of the two existing quote-key-a resolver $1 parameters receives ::text::timestamptz.',otherRepositoryFilesWritten:0},
 sourceSnapshots:{before:await descriptor('source.before.mjs'),after:await descriptor('source.after.mjs')},
 independentAudit:await descriptor('independent-cast-audit.json'),original65AssertSourceAndAstAfterOnlyAuthorizedCastReverseExact:true,
 directRawAssertionsExact:64,authorizedNestedAssertionChange:'One assert.equal contains the comparison SQL; only its two parameter cast literals change. All65 assertion calls/expectations and the entire original source/AST are exact after reversing only the four authorized casts.',
 originalB2ExpectationPreserved:true,otherSqlAndOrderExact:true,originalWaitsAndOptions:{waits:audit.originalWaits,options:audit.originalOptions},
 productionProposalPinsLoaderGrantsImportsRolesCleanupUnchanged:true,necessaryProtectedInputs:input.protection,
 originalFrozenDiagnosis:{path:input.diagnosis.path,bytes:26643,sha256:'92f7916e867d6e8c807b0c5dc50ca04321fb5d1c9d0248be477e735fd1706975'},
 staticChecks:await descriptor('static-checks.json'),syntaxActualExit:0,diffCheckActualExit:0,
 oneOfflineDriverControl:{proof:await descriptor('offline-serialize-proof.json'),closedReceipt:await descriptor('offline-serialize.closed.json'),actualExit:0,
  driverVersion:'3.4.9',realInstalledSerializeFunctions:true,postgresClientCreated:false,
  observation:'1184 timestamp serializer normalizes both synthetic6-digit and3-digit inputs to .123Z;25 text serializer preserves the controlled strings.',
  boundary:'Pure real-driver mechanism control only; does not establish actual server parameter OIDs, PG root cause or native pass.'},
 commandManifest:{path:join(out,'command-manifest.json'),...info(manifestBytes)},
 receiptBoundary:{alreadyClosed:receipts.length,actualZero:receipts.filter(r=>r.actualExit===0).length,actualNonzero:0,actualNull:6,expectedAbsentInstructionReads:6,
  finalWriterExpectedClosedReceipt:join(out,'finalize.closed.json')},
 ownerFileList:'The after-close seal lists every owned ordinary artifact, including raw stdout/stderr, true closed receipts, tool sources and FINAL; seal itself is externally pinned.',
 truthBoundary:{preparedOnly:true,nativeExecuted:false,postgresExecuted:false,ciRerun:false,applicationRerun:false,rootCauseConfirmed:false,
  gatePassDerived:false,gitMutations:0,markdownWrites:0,deploymentActions:0,oldFrozenRootsWritten:false,
  derivedCiSliceLogsCreated:false,historyArchivesOrAllOldMetadataCopied:false,necessaryReadScope:'Only the target, pinned diagnosis and8 necessary direct driver/helper/proposal inputs.',ownerStopWritesAfterClosedSeal:true}};
const path=join(out,'FINAL-quote-version-three-casts-preparation.json'),bytes=Buffer.from(JSON.stringify(report,null,2)+'\n');
await writeFile(path,bytes,{flag:'wx'});console.log(JSON.stringify({path,...info(bytes),target:input.target,after:audit.after,originalAssertions:65,
 directRawExact:64,completeAuthorizedReverseExact:true,protectedInputs:8,syntaxActualExit:0,diffCheckActualExit:0,offlineControlActualExit:0,nativeExecuted:false}));
