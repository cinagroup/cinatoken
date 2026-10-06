import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import{fileURLToPath}from'node:url';
import{stableRead,sha256}from'file:///C:/Users/cina/AppData/Local/Temp/cinatoken-native59-info-evidence-tools-6a81f21b197047159394b64addf8eb59/evidence-lib.mjs';
const out=path.dirname(fileURLToPath(import.meta.url)),temp='C:/Users/cina/AppData/Local/Temp',old=`${temp}/cinatoken-native59-info-evidence-tools-6a81f21b197047159394b64addf8eb59`,first=`${temp}/cinatoken-g7-native26-final-config-4851c19d4cc24ecdae397bcb12a8ad30`;
const copied=['evidence-lib.mjs','direct-socket-dialect.mjs','collect-evidence.mjs','verify-evidence.mjs','collector-controlled-tests.mjs','collector-closure-boundary-tests.mjs','collector-explicit-association-tests.mjs','collector-g7-boundary-descriptor-tests.mjs','collector-g7-producer-output-controls.mjs','direct-socket-dialect-controls.mjs','native59-info-binding.mjs','native59-original-receipt-pins.json','native59-info-binding-controls.mjs','run-tool-closed.mjs'];
const pin=p=>({file:p,...(()=>{const d=stableRead(p);return{bytes:d.bytes.length,sha256:d.sha256}})()});
const priorPins=copied.map(f=>({...pin(path.join(old,f)),name:f}));
for(const f of copied)fs.copyFileSync(path.join(old,f),path.join(out,f),fs.constants.COPYFILE_EXCL);
const config=JSON.parse(fs.readFileSync(path.join(first,'all-frozen-config.json'))),bindings=[],transports=[];
for(const rootId of ['native-pin94-readonly','native-frozen94-109-prepare']){const r=config.roots.find(r=>r.id===rootId);for(const file of fs.readdirSync(r.path).filter(f=>f.endsWith('.closed.json')).sort()){const full=path.join(r.path,file),d=stableRead(full),value=JSON.parse(d.bytes);if(value.operation!=='readFile')continue;bindings.push({kind:'exact-file-read-report-only-v1',rootId,sourceRoot:r.path,reportFile:file,reportBytes:d.bytes.length,reportSha256:d.sha256,report:value,producer:pin(path.join(r.path,'capture.mjs')),outputs:['stdout','stderr'].map(stream=>({stream,file:path.basename(value[stream].path),bytes:value[stream].bytes,sha256:value[stream].sha256}))});}}
assert.equal(bindings.length,52);assert.equal(bindings.filter(x=>x.report.actualExit===null).length,16);
const nr=config.roots.find(r=>r.id==='native26-terminal-peer'),final=JSON.parse(fs.readFileSync(path.join(nr.path,'FINAL-native26-ci-independent-peer.json')));
const rows=final.records??final.nativeRecords??final.originalNativeRecords;
assert.ok(Array.isArray(rows),'Explicit native report records array required');
const groups=rows.filter(r=>r.group);
assert.equal(groups.length,40);
for(const row of groups){bindings.push({kind:'exact-native-workflow-utf16-slice-v1',rootId:nr.id,sourceRoot:nr.path,file:path.basename(row.group.file),bytes:row.group.bytes,sha256:row.group.sha256,startStringOffset:row.group.startStringOffset,endStringOffset:row.group.endStringOffset,workflowCommand:row.workflowCommand,step:row.step,sourceFile:'native-terminal.stdout.log',source:pin(path.join(nr.path,'native-terminal.stdout.log')),receiptFile:'native-terminal.closed.json',receipt:pin(path.join(nr.path,'native-terminal.closed.json')),report:pin(path.join(nr.path,'FINAL-native26-ci-independent-peer.json')),producer:pin(path.join(nr.path,'audit-terminal-v2.mjs'))});}
const cr=config.roots.find(r=>r.id==='current-terminal-evidence'),ir=config.roots.find(r=>r.id==='current-frozen-index-input');
for(const [directory,receiptFile,metadataFile,metadataReceiptFile]of[
 ['canonical-calibration-artifact/_temp/v364-direct-socket-once-37414167261-1','download-canonical-calibration-artifact.result.json','canonical-calibration-artifact-metadata.stdout.log','canonical-calibration-artifact-metadata.result.json'],
 ['direct-artifact-current/_temp/v364-direct-socket-once-37412108171-1','download-direct-terminal-artifact.result.json','direct-terminal-artifact-metadata.stdout.log','direct-terminal-artifact-metadata.result.json']]){
 const executorFile=directory+'/executor.closed.json',executor=JSON.parse(fs.readFileSync(path.join(cr.path,executorFile))),download=JSON.parse(fs.readFileSync(path.join(cr.path,receiptFile))),metadata=JSON.parse(fs.readFileSync(path.join(cr.path,metadataFile)));
 assert.equal(executor.actualExit,1);assert.equal(download.actualExit,0);assert.equal(metadata.artifacts.length,1);
 transports.push({kind:'exact-downloaded-direct-executor-manifest-v1',rootId:cr.id,sourceRoot:cr.path,executorFile,executor:pin(path.join(cr.path,executorFile)),downloadFile:receiptFile,download:pin(path.join(cr.path,receiptFile)),downloadBody:download,metadataFile,metadata:pin(path.join(cr.path,metadataFile)),metadataReceiptFile,metadataReceipt:pin(path.join(cr.path,metadataReceiptFile)),artifactId:metadata.artifacts[0].id,runId:executor.run.GITHUB_RUN_ID,runAttempt:executor.run.GITHUB_RUN_ATTEMPT,sourceSHA:executor.checkoutSHA,indexRootId:ir.id,indexSourceRoot:ir.path,indexFile:'frozen-current-root-index.json',index:pin(path.join(ir.path,'frozen-current-root-index.json'))});
}
fs.writeFileSync(path.join(out,'frozen-data-original-pins.json'),JSON.stringify({schema:'exact-frozen-data-original-pins-v1',bindings,transports},null,2)+'\n',{flag:'wx'});
config.frozenInputDataBindings=bindings;config.transportedDirectExecutorBindings=transports;
config.outputDirectory=path.join(out,'future-output-not-created');
config.semantics.nonProcessReadAndSliceOutputsAreReportOnly=true;config.semantics.originalArchiveAdmission154BlockersPreserved=true;config.semantics.downloadedMtimeNeverClaimedOriginalProducerMtime=true;
fs.writeFileSync(path.join(out,'all-frozen-data-config.json'),JSON.stringify(config,null,2)+'\n',{flag:'wx'});
fs.writeFileSync(path.join(out,'previous-native59-tool-source-pins.json'),JSON.stringify({oldTool:old,pins:priorPins,oldToolUnchanged:true},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({copied:copied.length,fsReadReports:52,fsSuccessReportOnly:36,fsMissingReportOnly:16,slices:40,transportedActualExecutors:2,originalRuntimeExits:[1,1],oldRootUnchanged:true}));
