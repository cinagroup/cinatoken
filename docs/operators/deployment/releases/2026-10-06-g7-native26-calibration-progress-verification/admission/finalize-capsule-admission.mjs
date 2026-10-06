import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root='C:/Users/cina/AppData/Local/Temp/cinatoken-final-capsule-admission-meta-UkwrUh';
const configPath='C:/Users/cina/AppData/Local/Temp/cinatoken-final-capsule-collection-config-NWebV7/all-frozen-final-config.json';
const toolRoot='C:/Users/cina/AppData/Local/Temp/cinatoken-all-frozen-data-tools-FoBS1O';
const peerRoot='C:/Users/cina/AppData/Local/Temp/cinatoken-frozen-data-reader-peer-readonly-l04m66n6';
const capsuleRoot='C:/Users/cina/AppData/Local/Temp/cinatoken-ee122-opaque-capsule-89cf1ba373634086a3926a636a292ec7';
const sha=b=>createHash('sha256').update(b).digest('hex');
const pin=p=>{const b=fs.readFileSync(p);return {path:p,bytes:b.length,sha256:sha(b)}};
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const auditPath=path.join(root,'final-42-capsule-pure-audit.json');
const audit=read(auditPath),receipt=read(path.join(root,'final-42-capsule-pure-audit.result.json')),config=read(configPath);
assert.equal(receipt.actualExit,0);assert.equal(receipt.signal,null);assert.equal(receipt.spawnError,null);
assert.equal(config.sourceCommit,'dc7be6f8597333151c450bae3ae15e6585e3b2eb');
assert.equal(config.roots.length,42);assert.equal(audit.sourceRootIds.length,42);
assert.equal(audit.blockers.length,0);assert.equal(audit.exclusions.length,0);
assert.equal(config.semantics.collectionOnly,true);assert.equal(config.semantics.fullG7Verified,false);assert.equal(config.semantics.fullG8Verified,false);
assert.equal(config.semantics.sourceLayers.productionSourceCommitPrefix,'c13');assert.equal(config.semantics.sourceLayers.productionWorkerVersionPrefix,'2a0');assert.equal(config.semantics.sourceLayers.productionTrafficPercent,100);
const oldRoot='C:/Users/cina/AppData/Local/Temp/cinatoken-final-all-frozen-admission-meta-27arGJ';
const oldReceipt=read(path.join(oldRoot,'final-combined-39-pure-audit.result.json'));
const oldAudit=read(path.join(oldRoot,'final-combined-39-pure-audit.json'));
assert.equal(oldReceipt.actualExit,1);assert.equal(oldAudit.blockers.length,39);
assert(config.roots.some(x=>x.id==='original-final39-failed-admission-metadata'));
assert(config.roots.some(x=>x.id==='ee122-native-terminal-opaque-capsule'));
assert(!config.roots.some(x=>path.resolve(x.path??x.sourceRoot??x.directory??'')===path.resolve(root)));
const counts={numericZero:0,numericOne:0,numericTwo:0,nullActualExit:0,numericOther:0};
for(const r of audit.receipts){if(r.actualExit===0)counts.numericZero++;else if(r.actualExit===1)counts.numericOne++;else if(r.actualExit===2)counts.numericTwo++;else if(r.actualExit===null)counts.nullActualExit++;else counts.numericOther++;}
assert.deepEqual(counts,{numericZero:762,numericOne:36,numericTwo:2,nullActualExit:3,numericOther:0});
const authorityPins=[
 pin(configPath),pin(auditPath),pin(path.join(root,'final-42-capsule-pure-audit.result.json')),
 pin(toolRoot+'/FINAL-all-frozen-data-reader-preparation.json'),pin(toolRoot+'/STOPWRITE-all-frozen-data-reader-seal.json'),
 pin(peerRoot+'/FINAL-frozen-data-reader-independent-peer-review.json'),pin(peerRoot+'/STOPWRITE-independent-peer-seal.json'),
 pin(capsuleRoot+'/FINAL-ee122-opaque-capsule.json'),pin(capsuleRoot+'/CAPSULE-SEAL.json'),pin(capsuleRoot+'/ee122-frozen-root-lossless-opaque.zip'),
 pin(oldRoot+'/final-combined-39-pure-audit.result.json'),pin(oldRoot+'/final-combined-39-pure-audit.json')
];
const report={schema:'final-frozen-capsule-admission-preparation-v1',completedAt:new Date().toISOString(),scope:'Pure evidence audit and frozen preparation only; no collect, application test, native/Miniflare run, CI request, Git mutation, database or production request.',
 sourceCommit:config.sourceCommit,releaseSlug:config.releaseSlug,config:authorityPins[0],toolRoot,toolSourceUnchangedAfter99FileSeal:true,
 sourceRootCount:42,entryCount:audit.entries.length,closedReceiptCount:audit.receipts.length,closedReceiptActualExitCounts:counts,numericNonzeroClosedReceipts:38,unknownActualExitReceipts:3,
 aggregateReportCount:audit.aggregateReports.length,reportOnlyDataBindingCount:audit.reportOnlyDataBindings.length,closedExecutorTransportBindingCount:audit.closedExecutorTransportBindings.length,blockerCount:0,exclusionCount:0,
 pureAudit:{actualExit:receipt.actualExit,signal:receipt.signal,spawnError:receipt.spawnError,startedAt:receipt.at,finishedAt:receipt.finishedAt,executable:receipt.executable,args:receipt.args,stdout:receipt.stdout,stderr:receipt.stderr},
 originalAdmissionFailuresPreserved:{firstOriginal31RootActualExit:1,firstOriginal31RootBlockers:154,original39RootActualExit:1,original39RootBlockers:39,original39FailureRoot:oldRoot,rawAuthorityRetained:true,notReclassifiedAsPass:true},
 ee122OpaquePreservation:{root:capsuleRoot,originalRegularFiles:213,originalBytes:12098565,zipMembers:213,wholeSourceRetained:true,sourceAndZipBytesSha256CrcVerifiedByOriginalCapsuleProducer:true,independentWholeArchiveReviewPendingRoot:true,originalChildReceipts:31,originalChildZero:28,originalChildOne:3,innerReceiptsHistoricalNotFreshTopLevelProcessAuthority:true,packagingAndReplayZeroNotBusinessSuccess:true},
 independentReview:{frozenReaderSourcePeerRoot:peerRoot,frozenReaderSourcePeerScope:'Source, frozen package and existing preparation receipts; not a complete final42 root archive replay.',ee122DerivedRelationshipPeerRoot:'C:/Users/cina/AppData/Local/Temp/cinatoken-ee122-39-binding-peer-readonly-2thrhzc5',rootWillReviewActualCollectedArchiveSeparately:true},
 sourceLayers:config.semantics.sourceLayers,businessSemantics:config.semantics,
 nonzeroAndUnknownReceipts:audit.receipts.filter(r=>r.actualExit!==0),aggregateReports:audit.aggregateReports,
 authorityPins,rootIds:config.roots.map(x=>x.id),ownerAuditMetadataRootNotIncludedIn42Inputs:root,activeRootMetadataNotIncluded:'C:/Users/cina/AppData/Local/Temp/cinatoken-final-durable-collection-meta-S7NHM2',
 collectionOnly:true,gatePassDerived:false,fullG7Verified:false,fullG8Verified:false,fullNativeCancelVerified:false,productionReadPerformedHere:false,
 limitations:['Final42 pure audit proves reader admission and file/raw authority binding, not application or runtime passing.','The opaque ZIP retains all unsupported ee122 original bytes; it does not reinterpret their children, derived slices or original failed admissions as fresh successful commands.','Three original EPERM spawn failures retain actualExit=null.','No collect or verify command was executed by this producer.']};
const target=path.join(root,'FINAL-final42-frozen-capsule-admission.json');fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({file:pin(target),config:authorityPins[0],rootCount:42,entryCount:audit.entries.length,closedReceiptCount:audit.receipts.length,counts,blockerCount:0,exclusionCount:0,collectionOnly:true,fullG7Verified:false,fullG8Verified:false}));
