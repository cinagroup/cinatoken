import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const root='C:/Users/cina/AppData/Local/Temp/cinatoken-g7-native-four-archive-prep-45cfb0f397164d5a8451d8d3c3a5b5fd',sha=b=>createHash('sha256').update(b).digest('hex');
const tools=root+'/tools',enhanced=root+'/enhanced-tools';fs.mkdirSync(enhanced);
for(const f of fs.readdirSync(tools))fs.writeFileSync(enhanced+'/'+f,fs.readFileSync(tools+'/'+f),{flag:'wx'});
let lib=fs.readFileSync(tools+'/evidence-lib.mjs','utf8');
const needle="  if (value.source === 'actual synchronous spawnSync return, not aggregate report') {";
assert.equal(lib.split(needle).length,2);
const extension=`  if (value.schema === 'g7-owner-exact-terminal-spawnSync-status-v1') {
    if (value.closed !== true || !numeric('actualExit') || value.actualExit < 0 ||
        value.signal !== null || value.spawnError !== null || value.productionRequests !== 0 ||
        typeof value.id !== 'string' || !/^[a-z0-9-]+$/u.test(value.id) ||
        typeof value.program !== 'string' || !path.isAbsolute(value.program) ||
        typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd) ||
        !Array.isArray(value.args) || !value.args.every(x => typeof x === 'string') ||
        !timestamp('startedAt') || !timestamp('endedAt') || Date.parse(value.endedAt) < Date.parse(value.startedAt) ||
        !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 ||
        value.source !== 'Exact spawnSync status; not inferred from wrapper success' ||
        !Array.isArray(value.outputs) || value.outputs.length !== 2 ||
        !value.outputs.every((x, i) => x && !Array.isArray(x) &&
          x.file === value.id + (i === 0 ? '.stdout.log' : '.stderr.log') &&
          relativeSafe(x.file) && !Object.hasOwn(x, 'path') &&
          Number.isSafeInteger(x.bytes) && x.bytes >= 0 && /^[0-9a-f]{64}$/u.test(x.sha256))) return null;
    return { dialect: value.schema, actualExit: value.actualExit, signal: null, spawnError: null,
      startedAt: value.startedAt, endedAt: value.endedAt, timeoutMs: value.timeoutMs,
      actualChildExitProven: true, separateOuterToolReceiptClaimed: false };
  }
`;
lib=lib.replace(needle,extension+needle);
const bindNeedle="      assert.ok(receipt && value?.closed === true && typeof value.program === 'string' && value.program !== '' &&\n        Array.isArray(value.args) && value.args.every(x => typeof x === 'string') &&\n        Number.isSafeInteger(value.actualExit) && typeof value.begin === 'string' && typeof value.endedAt === 'string' &&\n        Number.isFinite(Date.parse(value.begin)) && Number.isFinite(Date.parse(value.endedAt)) && Date.parse(value.endedAt) >= Date.parse(value.begin),\n        'Explicit output binding requires its own numeric closed command with ordered timestamps');";
assert.equal(lib.split(bindNeedle).length,2);
const replacement=`      const exactG7Owner = receipt?.dialect === 'g7-owner-exact-terminal-spawnSync-status-v1';
      const begin = exactG7Owner ? value.startedAt : value?.begin;
      assert.ok(receipt && value?.closed === true && typeof value.program === 'string' && value.program !== '' &&
        Array.isArray(value.args) && value.args.every(x => typeof x === 'string') &&
        Number.isSafeInteger(value.actualExit) && typeof begin === 'string' && typeof value.endedAt === 'string' &&
        Number.isFinite(Date.parse(begin)) && Number.isFinite(Date.parse(value.endedAt)) && Date.parse(value.endedAt) >= Date.parse(begin),
        'Explicit output binding requires its own numeric closed command with ordered timestamps');
      if (exactG7Owner) assert.deepEqual(binding.outputs, value.outputs, 'G7 owner binding must exactly match both original stream descriptors');`;
lib=lib.replace(bindNeedle,replacement);
fs.writeFileSync(enhanced+'/evidence-lib.mjs',lib); // New exclusive copy only; original/frozen files remain byte exact.
const config=JSON.parse(fs.readFileSync(root+'/four-frozen-roots-initial-config.json'));
config.sourceCommit='473de5fc520fc7d64db700db88a76c7a6b45c241';
config.explicitCommandOutputBindings=[];
const owner=config.roots.find(r=>r.id==='g7-observe-owner');
for(const f of fs.readdirSync(owner.path).filter(f=>/^(first|final)-.*\.result\.json$/.test(f)).sort()){const b=fs.readFileSync(owner.path+'/'+f),r=JSON.parse(b);assert.equal(r.schema,'g7-owner-exact-terminal-spawnSync-status-v1');config.explicitCommandOutputBindings.push({rootId:owner.id,receiptFile:f,expectedReceiptSha256:sha(b),outputs:r.outputs});}
assert.equal(config.explicitCommandOutputBindings.length,8);
const reference=root+'/historical-observer-original-reference';fs.mkdirSync(reference);const h=JSON.parse(fs.readFileSync(owner.path+'/historical-source-index.json')),copyRecords=[];
for(const r of h.records){const b=fs.readFileSync(r.source);assert.equal(b.length,r.bytes);assert.equal(sha(b),r.sha256);const name=path.basename(r.source);fs.writeFileSync(reference+'/'+name,b,{flag:'wx'});assert.deepEqual(fs.readFileSync(reference+'/'+name),b);copyRecords.push({...r,referenceFile:name,immutableByteCopy:true,newExecution:false})}
fs.writeFileSync(reference+'/immutable-original-source-index.json',JSON.stringify({schema:'cinatoken-selected-historical-original-byte-reference-v1',closed:true,actualCopyOutcome:0,sourceRun:'37403868149',sourceCommit:'07d19c1c941cc373019811be3dbf553c441a0ff3',scope:'Eight already archived original observer receipts/raw and runtime/wire reports; exact byte copies, no fresh execution or broad previous archive validation',sourceHistoricalIndex:{path:owner.path+'/historical-source-index.json',sha256:sha(fs.readFileSync(owner.path+'/historical-source-index.json'))},originalProducerTimingsPreserved:true,newExecution:false,productionRequests:0,records:copyRecords},null,2)+'\n',{flag:'wx'});
config.roots.push({id:'original-observer-reference',path:reference,phase:'closed-ci-evidence'});
config.immutableSchemaCopies=[];
for(const id of ['082','083']){const receipt='original-linux-'+id+'-docker.result.json',originalFile=id+'-docker.result.json',b=fs.readFileSync(owner.path+'/'+receipt);config.immutableSchemaCopies.push({rootId:owner.id,file:receipt,originalRootId:'original-observer-reference',originalFile,sha256:sha(b),partialLogCopy:true,includedLogCopies:['stdout','stderr'].map(kind=>{const file='original-linux-'+id+'-docker.'+kind+'.log',bb=fs.readFileSync(owner.path+'/'+file);return {file,originalFile:id+'-docker.'+kind+'.log',bytes:bb.length,sha256:sha(bb)}}),scope:'Legacy API name partialLogCopy denotes selected historical artifact; both full observer streams are included byte exactly, no fresh execution'})}
config.semantics={...config.semantics,sourceCommit:config.sourceCommit,frozenProducerRoots:4,selectedOriginalReferenceRoots:1,originalCopiedObserverActualExits:[0,1],originalRuntimeActualExit:1,originalWireActualExit:0,ownerFirstGlobReviewActualExit:1,peerFirstReadPathActualExit:1,toolInitialFourRootAuditActualExit:1,allNegativeRawPreserved:true,noExclusions:true,partialPreparationOnly:true,newCIResultsNotCollected:true,applicationTestsRunByPreparer:false};
fs.writeFileSync(root+'/four-frozen-roots-bound-config.json',JSON.stringify(config,null,2)+'\n',{flag:'wx'});
fs.writeFileSync(root+'/new-tool-patch-scope.json',JSON.stringify({originalLib:{path:tools+'/evidence-lib.mjs',sha256:sha(fs.readFileSync(tools+'/evidence-lib.mjs'))},enhancedLib:{path:enhanced+'/evidence-lib.mjs',sha256:sha(Buffer.from(lib))},oldTestsUntouched:true,patches:['Strict completed numeric-only exact G7 owner terminal schema','Explicit pinned outputs binding accepts startedAt only for that validated schema and matches both original descriptors'],rootRunClosedDialectChanged:false,globalGenericClosureChanged:false,exclusionPolicyChanged:false,originalSourcesChanged:false,productionRequests:0},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({config:root+'/four-frozen-roots-bound-config.json',producerRoots:4,referenceRoots:1,bindings:8,streamBindings:16,schemaCopies:2,enhancedLibSha256:sha(Buffer.from(lib))}));