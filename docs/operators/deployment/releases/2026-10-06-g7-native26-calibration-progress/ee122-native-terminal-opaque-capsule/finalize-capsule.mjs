import fs from'node:fs';import path from'node:path';import crypto from'node:crypto';import{fileURLToPath}from'node:url';import assert from'node:assert/strict';
const root=path.dirname(fileURLToPath(import.meta.url)),load=n=>JSON.parse(fs.readFileSync(path.join(root,n),'utf8'));
const desc=n=>{const f=path.join(root,n),b=fs.readFileSync(f);return{path:f.replaceAll('\\','/'),bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')}};
const before=load('source-index.before.json'),after=load('source-index.after.json'),proof=load('zip-member-roundtrip-proof.json'),receipt=load('package.result.json');
assert.equal(receipt.actualExit,0);assert.equal(receipt.signal,null);assert.equal(receipt.spawnError,null);assert.equal(receipt.timedOut,false);
assert.deepEqual(before.files,after.files);assert.deepEqual(before.directories,after.directories);assert.deepEqual(before.sourceRootIdentity,after.sourceRootIdentity);
for(const k of['beforeAfterCompleteSetBytesShaCrcIdentityExact','zipCompleteMemberSetExact','allDecodedFileBytesComparedWithLiveOriginal','allDecodedBytesShaAndCrcExact'])assert.equal(proof[k],true);
assert.equal(proof.memberCount,proof.fileCount+proof.directoryCount);assert.equal(proof.exclusions.length,0);
assert.equal(proof.originalFinalAndSealPins.length,2);assert.deepEqual(before.originalFinalAndSealPins,proof.originalFinalAndSealPins);
assert.deepEqual({path:receipt.stdout.path,bytes:receipt.stdout.bytes,sha256:receipt.stdout.sha256},desc('package.stdout.log'));
assert.deepEqual({path:receipt.stderr.path,bytes:receipt.stderr.bytes,sha256:receipt.stderr.sha256},desc('package.stderr.log'));
const zip=desc('ee122-frozen-root-lossless-opaque.zip');assert.equal(zip.bytes,proof.zip.bytes);assert.equal(zip.sha256,proof.zip.sha256);
const report={schema:'cinatoken-ee122-opaque-capsule.final.v1',frozenAt:new Date().toISOString(),sourceRoot:proof.sourceRoot,
 originalFinalAndSealPins:proof.originalFinalAndSealPins,ZIP:zip,sourceFileCount:proof.fileCount,sourceDirectoryCount:proof.directoryCount,
 zipMemberCount:proof.memberCount,originalTotalBytes:proof.sourceTotalBytes,originalSourceRootIdentity:before.sourceRootIdentity,
 sourceIndexBefore:desc('source-index.before.json'),sourceIndexAfter:desc('source-index.after.json'),zipMemberProof:desc('zip-member-roundtrip-proof.json'),
 completeSourceBeforeAfterSetBytesShaMtimeIdentity:true,completeZipMembersDecodedBytesShaCrc:true,exclusions:[],symlinkFollowing:false,
 originalDataPlacement:'Every ordinary source file and directory is included in the opaque ZIP. Original raw/failures/slices/stdin stay inside ZIP and are not copied as top-level logs.',
 sourceRootNeverWritten:true,archivalOutputRecursivelyAddedAsSource:false,collectionOnly:true,internalReceiptsRewritten:false,originalExecutionsRepeated:false,
 originalFactsFromRoot:{originalTrueChildren:31,exitZeroChildren:28,exitOneChildren:3,nativeStep24OriginalExit:1,nativeSteps55to113Skipped:59,prepared26AllSkipped:true,strict:{tests:8,pass:7,fail:1},other4RunsSuccess:true,sourceCommit:'ee122dd4'},
 originalFactBoundary:'The opaque capsule preserves original bytes and receipts; packaging does not reclassify original executor1 or derive native0/strict pass/fullG7G8 pass.',
 packagingTrueClosedReceipt:desc('package.result.json'),packagingReceipt:receipt,finalizerExpectedClosedReceipt:path.join(root,'finalize.result.json'),
 packagingTools:[desc('package-root.py'),desc('run-command.mjs'),desc('finalize-capsule.mjs')],
 setupToolReaderFailure:{actualExit:1,rawClosedReceiptAvailable:false,reason:'An initial shell-inline Node source had broken quote escaping and failed before capsule root setup. Tool output recorded the failure; no source evidence or wrapping result derives from it.'},
 applicationRuns:0,ciRunsTriggered:0,dbRuns:0,gitOperations:0,repoWrites:0,productionRequests:0,nativeExitZeroDerived:false,fullG7G8Pass:false,
 gatePassDerived:false,ownerStopWritesAfterFinalizerClosedSeal:true};
const final=path.join(root,'FINAL-ee122-opaque-capsule.json');fs.writeFileSync(final,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({FINAL:desc('FINAL-ee122-opaque-capsule.json'),ZIP:zip,files:proof.fileCount,directories:proof.directoryCount,members:proof.memberCount,
 originalTotalBytes:proof.sourceTotalBytes,collectionOnly:true,gatePassDerived:false}));
