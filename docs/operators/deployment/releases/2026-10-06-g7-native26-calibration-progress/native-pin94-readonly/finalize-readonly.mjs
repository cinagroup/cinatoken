import assert from'node:assert/strict';import{readFile,writeFile,readdir}from'node:fs/promises';import{join,basename}from'node:path';
import{out,repo,file,info}from'./capture.mjs';
const authority=JSON.parse(await readFile(join(out,'initial-authority.json'),'utf8'));
const proof=JSON.parse(await readFile(join(out,'pin-authority-proof.json'),'utf8'));
const scan=JSON.parse(await readFile(join(out,'tail-pin-scan.json'),'utf8'));
const terminalBytes=await readFile(join(out,'parent-terminal-final.stdout.log'));
assert.deepEqual(info(terminalBytes),{bytes:413706,sha256:'6635f04f77f6f6325a794756883a8bf697f752af239e33deb2b8c3b226a57e66'});
const terminal=JSON.parse(terminalBytes.toString());
assert.equal(terminal.run.headSha,authority.base);assert.equal(terminal.run.databaseId,37412060008);
assert.equal(proof.actualExit,0);assert.equal(proof.sourceProofs.length,2);
assert.equal(scan.records.length,19);assert.equal(scan.records.reduce((n,r)=>n+r.hashes.length,0),2);
const inventoryPath='C:/Users/cina/AppData/Local/Temp/cinatoken-native59-full-inventory-10b2722ab06d4cf6b6305e24571b4a8d/FINAL-native59-full-readonly-inventory.json';
const inv=await file('final-frozen-inventory',inventoryPath);assert.equal(inv.receipt.actualExit,0);
assert.deepEqual(info(inv.stdout),{bytes:635773,sha256:'67bf17ba71aa1b9a1b3eba948cc0f2a7e221e80a9e8a1ed3ee33eef8e5ceb6cb'});
const workingChecks=[];
const workingInputs=[
 {step:94,path:authority.wrapper,label:'base-wrapper'},
 ...scan.records.map(r=>({step:r.step,path:r.file,label:'tail-step-'+r.step})),
 {path:authority.source,label:'base-source'},
 {path:'scripts/db/cutover/postgres-shared-key-stats-claim-reader-v349.native.test.mjs',label:'source-step-99'},
 {path:'scripts/db/cutover/postgres-replay-reservations.native.test.mjs',label:'source-step-109'}
];
assert.equal(workingInputs.length,23);assert.equal(new Set(workingInputs.map(x=>x.path)).size,23);
for(let i=0;i<workingInputs.length;i++){
 const input=workingInputs[i],r=await file('final-working-'+i,join(repo,input.path));
 assert.equal(r.receipt.actualExit,0);assert.deepEqual(r.stdout,await readFile(join(out,input.label+'.stdout.log')));
 workingChecks.push({...input,...info(r.stdout),currentBaseGitBytesExact:true});
}
const workflow=await readFile(join(out,'base-workflow.stdout.log'),'utf8');
for(const r of scan.records)assert.ok(workflow.includes(r.file));
const receipts=[];
for(const name of(await readdir(out)).filter(n=>n.endsWith('.closed.json')).sort()){
 const raw=await readFile(join(out,name)),r=JSON.parse(raw.toString());
 assert.equal(r.signal,null);assert.equal(r.spawnError??null,null);
 if(r.operation==='readFile'&&r.error){assert.equal(r.actualExit,null);assert.equal(r.error.code,'ENOENT');assert.match(name,/^instructions-[0-5]\.closed\.json$/)}
 else assert.equal(r.actualExit,0,'Unexpected actual exit in '+name);
 assert.deepEqual(info(await readFile(r.stdout.path)),{bytes:r.stdout.bytes,sha256:r.stdout.sha256});
 assert.deepEqual(info(await readFile(r.stderr.path)),{bytes:r.stderr.bytes,sha256:r.stderr.sha256});
 receipts.push({receiptPath:join(out,name),receiptInfo:info(raw),...r});
}
assert.equal(receipts.filter(r=>r.actualExit===null).length,6);
const evidence=[];
for(const name of['capture.mjs','run.mjs','initial-read.mjs','history-and-tail.mjs','tail-pin-scan.mjs','tail-source-history.mjs','pin-authority-proof.mjs','finalize-readonly.mjs','initial-authority.json','history-tail-inputs.json','tail-pin-scan.json','tail-source-history.json','pin-authority-proof.json'])evidence.push({path:join(out,name),...info(await readFile(join(out,name)))});
const minimalFrozenFix=proof.sourceProofs.map(p=>({step:p.step,existingWrapper:p.wrapper,
  addFrozenTextPath:'scripts/db/cutover/fixtures/history/'+basename(p.target)+'.source.txt',
  exactFrozenGitInput:p.pinCommit+':'+p.target,expectedFrozenBytes:p.old,
  currentExecutionSource:p.target,currentExecutionSourceBytes:p.current,
  changes:'Read the original pinned historical bytes from the new non-executable text snapshot and identify that snapshot in lineage/provenance; retain the original SHA constant and every original assertion/call/SQL/role/option/cleanup.',
  noCurrentLegacyReversion:'The existing PG73-adapted executable fixture stays current; reverting its helper wiring would restore the known all-formal/73 setup problem.',
  nativeTestDiscovery:'Use .source.txt so this historical text is not selected as an executable test.'}));
const report={
 schema:'cinatoken.native-pin94-tail-readonly.final.v1',finishedAt:new Date().toISOString(),actualExit:0,
 baseCommit:authority.base,initialHead:authority.current,repositoryWrites:0,
 conclusions:{
  step94:'Actual Linux failure at successor:187:14: old frozen pin603646 differs from current adapted legacy sourcedfe004. The old pin is correct for its historical Git bytes.',
  step99:'Current and pin-introduction historical claim-reader bytes both exactly28167B/095f8ec; preserve this pin and reference.',
  step109:'Static mismatch at successor:143: old frozen pind950 differs from current adapted replay source9cb9a57. This step was not executed after step94; no actual Linux failure/pass claim.',
  remainingTail:'All19 original workflow fixtures95-113 were read from immutable dcc6 Git, parsed, and compared with current working bytes. Their two literal historical-native source pins are99 and109; no other same inline fixed-native-source pin was found.',
  noNewChangeCausedLegacyMismatch:'Both mismatched legacy inputs changed in66ef5a698c0bb16aa1f2c490c79b6a06bdb5b33b, before473 anddcc6. This native26 task did not modify them.'
 },
 lineageAuthority:proof,
 oldFrozenVersusCurrent:{
  old:'The pin-introduction commits and exact Git blobs define the old frozen whole-file identities; they remain603646 andd950.',
  current:'The dcc6 tracked bytes define the PG73-adapted executable fixtures; they aredfe004 and9cb9a57. Equal business assertions/SQL do not mean equal frozen whole-file bytes.',
  diff:'For each legacy source, reversing only the fs import, helper import, PG73 loader and two grant-call adapters reproduces the entire old source byte-for-byte. Selected assert/SQL/template/cleanup/if/native-option source arrays are exact.'
 },
 recommendedMinimalFrozenContractFix:{
  status:'Proposal only; no repository edits',files:4,items:minimalFrozenFix,
  authority:'Retrieve snapshot bytes directly from the stable local Git objects recorded above, without text newline conversion; retain the original pin values and equality assertions.',
  validationForImplementation:'Audit new snapshot bytes against original Git blobs; preserve every original wrapper assertion/grant/negative SQL/role/timeout/skip/cleanup; syntax/diff checks then original Linux workflow.',
  reason:'Separates immutable historical text from the now-adapted executable fixture while preserving the original freeze assertion.'
 },
 alternativeCurrentContractRebaseline:{
  files:2,wrappers:proof.sourceProofs.map(p=>({path:p.wrapper,originalPin:p.pin,currentPin:p.current.sha256})),
  meaning:'Updating only the two constants is a smaller diff but changes the historical whole-file identity contract. It must be explicitly recorded as a rebaseline to reviewed PG73 fixture adapters; it cannot be called preservation of the old frozen whole-file source.',
  originalEqualityAssertSourceCouldRemain:true,oldWholeFileFrozenIdentityWouldRemain:false,
  status:'Not performed; do not change hashes merely because the current CI mismatches.'
 },
 tailInventory:scan,workingInputs:workingChecks,
 frozenInputs:{originalInventory:{path:inventoryPath,...info(inv.stdout)},
  parentTerminalFinal:{path:'C:/Users/cina/AppData/Local/Temp/cinatoken-native26-ci-terminal-independent-peer-cc2708922c0e4f64a9cca948194a20d9/FINAL-native26-ci-independent-peer.json',...info(terminalBytes)}},
 originalNativeEvidence:{runId:37412060008,jobId:112102451588,headSha:authority.base,
  raw:proof.actualNativeRaw,originalActualClosedReceipt:proof.originalNativeDownloadReceipt,
  observedFailingStep94:proof.actualStep94Group},
 commands:receipts,commandCounts:{closedBeforeFinalWriter:receipts.length,actualZero:receipts.filter(r=>r.actualExit===0).length,
  actualNull:6,expectedAbsentInstructionReads:6,actualNonzero:0,signals:0,spawnErrors:0},
 toolBootstrapFailure:{actualExit:1,reason:'The first bootstrap --input-type=module invocation used a Windows C:/ path as an ESM specifier; Node rejected protocol c: before loading capture.mjs.',
  rawClosedReceiptAvailable:false,rawStreams:null,evidence:'exec_command tool returned ERR_UNSUPPORTED_ESM_URL_SCHEME and actual exit1; the later relative-import run.mjs succeeded. No read proof was derived from the failed bootstrap.'},
 evidenceFiles:evidence,finalWriterClosedReceipt:join(out,'finalize-readonly.closed.json'),
 finalWriterReceiptBoundary:'The final wrapper records its actual close, stdout/stderr byte counts and hashes after this report is saved.',
 scope:{onlyRepoOperations:'Read Git objects/history/status and files; no Git mutation.',nativeExecuted:false,
  databaseExecuted:false,appRerun:false,networkCalls:0,markdownWrites:0,ciActions:0,productionWrites:0,
  pinScanBoundary:'The19 authoritative fixture source ASTs and their direct historical-native URL/hash references; no assertion of arbitrary npm/import transitive closure.',
  exactProtectedAssertions:'No source was edited. Proofs57/79 old legacy assertions and all protected selected source arrays remain exact across the already-existing adapter diffs.',
  frozenRootsNeverWritten:true,ownerStopWrites:true}
};
const path=join(out,'FINAL-native-pin94-tail-readonly.json'),bytes=Buffer.from(JSON.stringify(report,null,2)+'\n');
await writeFile(path,bytes,{flag:'wx'});
console.log(JSON.stringify({path,...info(bytes),actualExit:0,baseCommit:authority.base,filesRead:23,
  tailFixtures:19,actualFailureStep:94,staticMismatchStep:109,step99Matches:true,
  closedBeforeFinalWriter:receipts.length,expectedAbsentReads:6,repositoryWrites:0,ownerStopWrites:true}));
