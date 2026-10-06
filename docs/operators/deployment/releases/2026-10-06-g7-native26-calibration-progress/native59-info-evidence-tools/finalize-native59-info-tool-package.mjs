import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {enumerate,stableRead} from './evidence-lib.mjs';
const root=path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u,'$1'));
const pin=file=>{const x=stableRead(file);return{path:file,bytes:x.bytes.length,sha256:x.sha256}},read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const old=read('previous-direct-only-tool-pins.json');for(const item of old.pins){const current=pin(item.source);assert.equal(current.bytes,item.bytes);assert.equal(current.sha256,item.sha256);
 if(item.file!=='evidence-lib.mjs'){const copy=pin(path.join(root,item.file));assert.equal(copy.bytes,item.bytes);assert.equal(copy.sha256,item.sha256)}}
const previousSealPath=path.join(old.directory,'FINAL-direct-only-reader-seal.json'),previousSeal=JSON.parse(fs.readFileSync(previousSealPath,'utf8'));
assert.equal(pin(previousSealPath).sha256,'fd0041f111aa7aee63737d68f27f31e9424fb1809f99576ef6e8e6fcf4d849c4');
for(const item of previousSeal.files){const actual=pin(path.join(old.directory,item.file));assert.equal(actual.bytes,item.bytes);assert.equal(actual.sha256,item.sha256)}
const pins=read('native59-original-receipt-pins.json');for(const item of pins.receipts){const actual=pin(path.join(pins.root,item.file));assert.equal(actual.bytes,item.bytes);assert.equal(actual.sha256,item.sha256);
 for(const stream of ['stdout','stderr']){const actualRaw=pin(path.join(pins.root,item.file.replace(/\.closed\.json$/u,'.'+stream+'.log')));assert.equal(actualRaw.bytes,item[stream+'Info'].bytes);assert.equal(actualRaw.sha256,item[stream+'Info'].sha256)}}
const receipts=enumerate(root).filter(file=>file.endsWith('.result.json')).map(file=>{const value=read(file);assert.equal(value.actualExit,0);assert.equal(value.signal,null);assert.equal(value.spawnError,null);
 for(const stream of ['stdout','stderr']){const x=pin(value[stream].path);assert.equal(x.bytes,value[stream].bytes);assert.equal(x.sha256,value[stream].sha256)}
 return{file,...pin(path.join(root,file)),actualExit:value.actualExit,at:value.at,finishedAt:value.finishedAt,stdout:value.stdout,stderr:value.stderr};});assert.equal(receipts.length,9);
const controls=[];for(const [id,count]of [['native59-info-controls-first',20],['unchanged-direct64-controls',64],['unchanged-g7-37-controls',37],['unchanged-generic12-controls',12],['unchanged-closure10-controls',10],['unchanged-association28-controls',28]]){
 const receipt=receipts.find(row=>row.file===id+'.result.json'),proof=JSON.parse(fs.readFileSync(receipt.stdout.path,'utf8'));assert.equal(proof.pass,count);assert.equal(proof.fail,0);assert.equal(proof.skipped,0);controls.push({id,pass:count,originalTerminal:pin(path.join(root,receipt.file))});}
const plan=read('supported-subset-audit.json'),config=read('native59-supported-subset-config.json');assert.equal(config.roots.length,16);assert.equal(plan.entries.length,843);assert.equal(plan.receipts.length,156);assert.equal(plan.blockers.length,0);assert.equal(plan.exclusions.length,0);
for(const entry of plan.entries){const actual=pin(entry.sourcePath);assert.equal(actual.bytes,entry.originalBytes);assert.equal(actual.sha256,entry.originalSha256)}
const report={schema:'cinatoken-native59-info-evidence-reader-final-preparation-v1',closed:true,actualPreparationReviewOutcome:0,
 exactNative59Root:pins.root,exactOriginalReceiptPins:pins.receipts,newBindingDialect:'native59-exact-info-only-output-binding-v1',
 sourcePreparationBase:'473de5fc520fc7d64db700db88a76c7a6b45c241',reportedPushedCommit:'dcc6ab52f21a18c5d1c02d8a4a4a390f039e61fc',newRuntimeSHAAndResultsVerifiedByThisProducer:false,
 exactOriginalTwoCommandsAndFourRawUnmodified:true,originalNumericExitArgsTimingInfoDescriptorsPreserved:true,noOriginalReceiptOrSourceNormalization:true,
 bindingRequiresOriginalRootReceiptPinBodyRawSetBytesShaOrderTime:true,noFinalTotalUsedAsCommandAuthority:true,
 supportedSubset:{actualExit:0,frozenRoots:16,files:843,originalCommandReceipts:156,aggregateEntries:plan.aggregateReports.length,blockers:0,exclusions:0,all843CurrentSourceBytesShaExact:true},
 controls,totalNewAndCopiedControls:171,originalActualToolReceipts:receipts,
 changes:'Only new native59 exact Info module and copied-lib import/explicit-binding branch; all original reader code/suites/direct schema untouched',
 previousFull81FileToolPackageSeal:pin(previousSealPath),previousFull81FilePackageUnchanged:true,previousCopied11SourcePins:old.pins,
 originalPrevious17RootAuditActualExit1Preserved:true,oldDurableMetaOriginalTreeNotDiscarded:true,
 oldDurableMetaFutureRequirement:'Root lossless opaque ZIP with every original-file byte/hash/path plus extraction verification; original history preserved, no fresh runtime/gate/receipt0 from copied prior output',
 preparedSubsetMustNotBeCollectedAsCompleteRelease:true,growingRootWalked:false,collectorMetadataRootIncluded:false,
 realRuntimeReceiptsManufactured:false,applicationNativeG7MiniflareSqlTestsRun:false,productionRequests:0,repositoryWrites:0,gitCommands:0,ciQueriesOrInvocations:0,
 fullNativeCancelVerified:false,fullG7Verified:false,fullG8Verified:false,causeProven:false,gracefulWorkerdExitProven:false,
 sourcePins:['evidence-lib.mjs','native59-info-binding.mjs','native59-original-receipt-pins.json','native59-info-binding-controls.mjs','direct-socket-dialect.mjs'].map(file=>({file,...pin(path.join(root,file))})),
 supportedConfig:pin(path.join(root,'native59-supported-subset-config.json')),unsupportedOldmetaConfigOnly:pin(path.join(root,'native59-expanded-config-with-oldmeta-blockers.json')),
 supportedAudit:pin(path.join(root,'supported-subset-audit.json')),originalPreparationToolObservation:{chunk_id:'e667d1',actualToolExit:0,wall_time_seconds:0.2309176,scope:'Read/copy exact previous tool and original receipt pins, no source commands or app/runtime'}};
const final=path.join(root,'FINAL-native59-info-reader-preparation.json');fs.writeFileSync(final,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
const names=enumerate(root),files=names.map(file=>({file,...pin(path.join(root,file))}));
const seal=path.join(root,'FINAL-native59-info-reader-seal.json');fs.writeFileSync(seal,JSON.stringify({schema:'cinatoken-native59-exact-info-tool-seal-v1',files,
 filesBeforeSelf:files.length,filesIncludingSelf:files.length+1,selfExcluded:'FINAL-native59-info-reader-seal.json',writesStop:true,
 originalWhole81FileToolUnchanged:true,originalNative59FilesUnchanged:true,fullRuntimeOrGatePassClaimed:false,productionRequests:0},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({preparationOutcome:0,partialSupportedSubsetOnly:true,final:pin(final),seal:pin(seal),filesIncludingSelf:files.length+1,writesStop:true}));
