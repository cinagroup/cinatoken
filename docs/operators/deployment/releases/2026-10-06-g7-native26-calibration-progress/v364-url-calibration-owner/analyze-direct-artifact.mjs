import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const parent='C:/Users/cina/AppData/Local/Temp/cinatoken-g7-native53-20261006-b5c5ae279d804d44b08535e386e82504';
const artifact=path.join(parent,'direct-artifact-current'),runtime=path.join(artifact,'_temp/v364-direct-socket-once-37412108171-1'),snapshot=path.join(artifact,'cinatoken/cinatoken');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const describe=file=>{const bytes=fs.readFileSync(file);return {file,bytes:bytes.length,sha256:sha(bytes)};};
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const ex=json(path.join(runtime,'executor.closed.json')),node=json(path.join(runtime,'closed-result.json')),start=json(path.join(runtime,'executor-start.json')),events=json(path.join(runtime,'events.json'));
assert.equal(ex.schema,'v364-direct-socket-executor-closed-v1');assert.equal(node.schema,'v364-direct-socket-closed-v1');
assert.equal(ex.actualExit,1);assert.equal(ex.actualProcessExit,1);assert.equal(ex.runnerOutcomeCode,1);
assert.equal(ex.run.GITHUB_SHA,'dcc6ab52f21a18c5d1c02d8a4a4a390f039e61fc');assert.equal(ex.run.GITHUB_RUN_ID,'37412108171');
assert.equal(ex.checkoutSHA,ex.run.GITHUB_SHA);assert.equal(node.checkoutSHA,ex.checkoutSHA);assert.equal(start.checkoutSHA,ex.checkoutSHA);
assert.equal(node.actualExit,1);assert.equal(node.baseline.code,1);assert.equal(node.sourceUnchanged,true);assert.equal(node.results.length,5);
assert.equal(ex.timedOut,false);assert.equal(ex.closure.groupGone,true);assert.equal(ex.closure.directChildReaped,true);assert.equal(ex.closure.leftoverGroupKilled,false);assert.equal(ex.closure.signalAttempts.length,0);assert.equal(ex.closure.gracefulWorkerdExitProven,false);
const runtimeFileProof=ex.files.map(row=>{const current=describe(path.join(runtime,row.path));assert.equal(current.bytes,row.bytes);assert.equal(current.sha256,row.sha256);return current;});
for(const stream of ['stdout','stderr']){const row=node.baseline[stream],current=describe(path.join(runtime,row.file));assert.equal(current.bytes,row.bytes);assert.equal(current.sha256,row.sha256);}
const eventFile=describe(path.join(runtime,'events.json'));assert.equal(eventFile.bytes,node.events.bytes);assert.equal(eventFile.sha256,node.events.sha256);assert.equal(events.length,node.events.count);
const manifest=json(path.join(snapshot,'scripts/diagnostics/v364-direct-socket/sealed-package.json'));
assert.equal(describe(path.join(snapshot,'scripts/diagnostics/v364-direct-socket/sealed-package.json')).sha256,ex.packageSHA256);
const sourceProof=[...manifest.files.map(row=>({...row,path:'scripts/diagnostics/v364-direct-socket/'+row.path})),manifest.workflow].map(row=>{
 const archived=describe(path.join(snapshot,row.path)),current=describe(path.join('C:/cinagroup/cinatoken',row.path));assert.equal(archived.bytes,row.bytes);assert.equal(archived.sha256,row.sha256);assert.equal(current.sha256,row.sha256);assert.equal(current.bytes,row.bytes);return {...archived,relative:row.path,current};
});
sourceProof.push({...describe(path.join(snapshot,'scripts/diagnostics/v364-direct-socket/sealed-package.json')),relative:'scripts/diagnostics/v364-direct-socket/sealed-package.json'});
const files=[];function walk(dir){for(const name of fs.readdirSync(dir)){const file=path.join(dir,name),stat=fs.lstatSync(file);assert.equal(stat.isSymbolicLink(),false);if(stat.isDirectory())walk(file);else{assert.ok(stat.isFile());files.push(describe(file));}}}walk(artifact);
const log=describe(path.join(parent,'direct-terminal-log.stdout.log'));assert.equal(log.bytes,33183);assert.equal(log.sha256,'ee7b3d85131b89292c5d40e9b682008efd14146b947549e2092821745570ea3d');
const workerd=events.filter(row=>row.kind==='workerd-log');
const diagnostic=workerd.filter(row=>row.message.includes('V364_DIAG ')).map(row=>({...row,diagnostic:JSON.parse(row.message.slice(row.message.indexOf('V364_DIAG ')+'V364_DIAG '.length))}));
const results=node.results.map(result=>({result,
 workerKinds:diagnostic.filter(row=>row.caseId===result.caseId).reduce((out,row)=>{const key=row.diagnostic.event;out[key]=(out[key]??0)+1;return out;},{}),
 signalAborts:diagnostic.filter(row=>row.caseId===result.caseId&&row.diagnostic.event==='signal-abort'),
 nonDiagnosticWorkerLogs:workerd.filter(row=>row.caseId===result.caseId&&!row.message.includes('V364_DIAG ')),
 directSocketProof:events.filter(row=>row.caseId===result.caseId&&row.kind==='direct-socket-ready'),
 relevantCalibrationEvents:events.filter(row=>row.caseId===result.caseId&&(row.kind==='miniflare-log'||row.kind==='workerd-log'||row.kind==='case-closed')),
}));
console.log(JSON.stringify({schema:'v364-direct-artifact-readonly-analysis-v1',closed:true,actualReadAnalysisOutcome:0,actualRuntimeOutcome:1,runId:37412108171,sourceSHA:ex.checkoutSHA,
 files,artifactFileCount:files.length,additionalClosedCiLog:log,runtimeFileProof,sourceProof,eventFile,eventCount:events.length,closure:ex.closure,nodeBaseline:node.baseline,results,
 runtimeReexecuted:false,originalRawModified:false,productionRequests:0},null,2));
