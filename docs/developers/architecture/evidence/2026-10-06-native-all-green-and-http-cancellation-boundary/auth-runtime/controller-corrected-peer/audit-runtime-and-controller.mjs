import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const sourceRoot='C:/Users/cina/AppData/Local/Temp/cinatoken-followup-auth-gates-80c5f57d2e0a68';
const frozenRoot='C:/Users/cina/AppData/Local/Temp/cinatoken-registration-preview-readonly-prepared-mqVPEM';
const require=createRequire('C:/cinagroup/cinatoken/package.json');
const parser=require('@babel/parser');
const sha=b=>createHash('sha256').update(b).digest('hex');
const inputs=[];
function read(file,expected){const b=fs.readFileSync(file);const item={file,bytes:b.length,sha256:sha(b)};if(expected)assert.equal(item.sha256,expected);inputs.push(item);return {item,b,text:b.toString('utf8')};}
function get(relative,expected){return read(path.join(sourceRoot,relative),expected);}
const old=read(path.join(frozenRoot,'registration-metadata.worker.mjs'),'38880c12a7c7107fc7906358f48d546294aa7fa21b939197810582ffc72b6b6b');
const worker=get('registration-runtime-v2/registration-metadata.worker.mjs','44d83eefffd275c0b4122294e8cc57af6590df2078c7f9f79a5cd1a8460e5885');
const bundle=get('registration-runtime-v2/registration-metadata.bundle.mjs','a2d547c6de353ada6eb908a4068df2f597d75a7f85ca96c76d00724f008d2e67');
const controller=get('read-registration-via-owned-worker.mjs','9c957baffb6f6b128a64900416359c420a7109b510b882f4628eafdae6106a43');
const repairController=get('repair-registration-via-owned-worker.mjs','f3bc3660f311f99ead7108208dac1aeccd3d3e63e3d639445ad6ec468163372b');
const repairBundle=get('registration-link-repair/registration-link-repair.bundle.mjs','2e8feaf50cad98f1cb775b58ec6d2e7e2b6da527f8560aca015fd7cdaa0d0474');
const reportInput=get('registration-live-readonly.json','989bb034ac0ed4faf8336b1d341f3a4b4ab56c2df1dac364bb505a2bd361d0f7');
const receiptInput=get('registration-live-readonly.result.json','a762615988a2ea9bb5abeb57e1a475ba5b3768649328a7d261cea0e045b8ad6f');
const stdout=get('registration-live-readonly.stdout.log','ea27981a2ae2299d48441f4ff16e5934fe105e231bbc7ba84d1056c4f3fbaa51');
const stderr=get('registration-live-readonly.stderr.log','e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
const planInput=get('registration-owned-plan.json','827959838c80471c19f430d4e486c13f74d70286aa3e180f52cde0dcafcf8265');
const preflightInput=get('registration-owned-preflight.json','113e6cf033acfa86895af73aba98b754d2a3976a76445cb8cb169cb592a52a45');
const parse=text=>parser.parse(text,{sourceType:'module'});
const originalAst=parse(old.text), workerAst=parse(worker.text);parse(controller.text);parse(repairController.text);
function collect(node,predicate,out=[]){if(!node||typeof node!=='object')return out;if(predicate(node))out.push(node);for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(n=>collect(n,predicate,out));else if(value&&typeof value==='object')collect(value,predicate,out);}return out;}
function single(ast,predicate){const a=collect(ast,predicate);assert.equal(a.length,1);return a[0];}
const declaration=single(workerAst,n=>n.type==='VariableDeclarator'&&n.id.name==='SELECT_METADATA');
assert.equal(declaration.init.type,'CallExpression');assert.equal(declaration.init.callee.property.name,'join');
const separator=declaration.init.arguments[0].value;
assert.deepEqual([...separator].map(c=>c.codePointAt(0)),[10]);
assert.equal(declaration.init.callee.object.elements.length,6);
const generatedSql=declaration.init.callee.object.elements.map(n=>{assert.equal(n.type,'StringLiteral');return n.value;}).join(separator);
assert.match(generatedSql,/^SELECT\s+EXISTS/u);assert.equal((generatedSql.match(/AS "/g)||[]).length,5);
assert.equal(worker.b.length,4044);assert.equal(old.b.length,4052);
const joinLine=worker.text.split('\n')[declaration.init.arguments[0].loc.start.line-1];
assert.deepEqual([...Buffer.from(joinLine)],[93,46,106,111,105,110,40,39,92,110,39,41,59]);
const excluded=new Set(['start','end','loc','extra','comments','leadingComments','trailingComments','innerComments','tokens','errors']);
function clean(value){if(Array.isArray(value))return value.map(clean);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!excluded.has(k)).map(([k,v])=>[k,clean(v)]));return value;}
const originalFactory=single(originalAst,n=>n.type==='CallExpression'&&n.callee.type==='Identifier'&&n.callee.name==='postgres');
const workerFactory=single(workerAst,n=>n.type==='CallExpression'&&n.callee.type==='Identifier'&&n.callee.name==='postgres');
const originalOptions=originalFactory.arguments[1];const workerOptions=workerFactory.arguments[1];
const connectionProperties=originalOptions.properties.filter(n=>n.key.name==='connection');assert.equal(connectionProperties.length,1);
originalOptions.properties=originalOptions.properties.filter(n=>n.key.name!=='connection');
assert.deepEqual(clean(originalOptions),clean(workerOptions));
const originalRows=single(originalAst,n=>n.type==='VariableDeclarator'&&n.id.name==='rows');
const workerRows=single(workerAst,n=>n.type==='VariableDeclarator'&&n.id.name==='rows');
const originalBegin=originalRows.init.argument,workerBegin=workerRows.init.argument;
assert.equal(workerBegin.callee.object.name,'sql');assert.equal(workerBegin.callee.property.name,'begin');assert.equal(workerBegin.arguments[0].value,'read only');
const callback=workerBegin.arguments[1];assert.equal(callback.async,true);assert.equal(callback.params.length,1);assert.equal(callback.params[0].name,'transaction');
const expectedTimeouts=['SET LOCAL statement_timeout = 5000','SET LOCAL lock_timeout = 2000','SET LOCAL idle_in_transaction_session_timeout = 7000'];
assert.equal(callback.body.body.length,4);
for(let i=0;i<3;i++){const s=callback.body.body[i];assert.equal(s.type,'ExpressionStatement');assert.equal(s.expression.type,'AwaitExpression');const call=s.expression.argument;assert.equal(call.callee.object.name,'transaction');assert.equal(call.callee.property.name,'unsafe');assert.equal(call.arguments.length,1);assert.equal(call.arguments[0].value,expectedTimeouts[i]);}
assert.equal(callback.body.body[3].type,'ReturnStatement');assert.deepEqual(clean(callback.body.body[3].argument),clean(originalBegin.arguments[1].body));
originalBegin.arguments[1]=null;workerBegin.arguments[1]=null;assert.deepEqual(clean(originalAst),clean(workerAst));
const report=JSON.parse(reportInput.text),receipt=JSON.parse(receiptInput.text),plan=JSON.parse(planInput.text),preflight=JSON.parse(preflightInput.text);
assert.deepEqual(JSON.parse(stdout.text),report);assert.equal(stderr.b.length,0);
const norm=p=>p.replace(/\\/g,'/').replace(/\/+/g,'/');
assert.equal(receipt.actualExit,0);assert.equal(receipt.signal,null);assert.match(receipt.executable,/node\.exe$/u);assert.equal(receipt.args.length,1);assert.equal(norm(receipt.args[0]),norm(controller.item.file));
for(const [stream,actual]of [['stdout',stdout],['stderr',stderr]]){assert.equal(norm(receipt[stream].path),norm(actual.item.file));assert.equal(receipt[stream].bytes,actual.item.bytes);assert.equal(receipt[stream].sha256,actual.item.sha256);}
assert.ok(Date.parse(receipt.at)<=Date.parse(report.at));assert.ok(Date.parse(report.finishedAt)<=Date.parse(receipt.finishedAt));
assert.match(report.worker,/^cinatoken-regmeta-[a-f0-9]{24}$/u);assert.equal(report.worker,plan.worker);assert.equal(report.worker,preflight.worker);assert.equal(preflight.preflightStatus,404);
assert.equal(report.metadataRequests,1);assert.equal(report.metadata.status,200);assert.equal(report.scriptSha256,bundle.item.sha256);
assert.deepEqual(report.metadata.values,{clientExists:true,clientDisabled:false,resourceExists:true,resourceDisabled:false,linkExists:false});
assert.equal(report.failure,undefined);assert.deepEqual(report.cleanup,{deleteStatus:200,deleteSuccess:true,verifyStatus:404,absent:true});
for(const key of ['productionWorkersChanged','routesChanged','hyperdriveSettingsChanged','databaseDmlOrDdl','gatePersisted'])assert.equal(report[key],false);
const failedHealth=report.steps.filter(s=>s.label==='health_no_database'&&s.transport==='failed');assert.equal(failedHealth.length,4);
assert.ok(report.steps.some(s=>s.label==='health_no_database'&&s.attempt===5&&s.status===404&&s.expected===true));
assert.equal(report.steps[0].label,'unique_name_preflight');assert.equal(report.steps[0].status,404);
assert.match(repairController.text,/const NAME='cinatoken-reglink-'\+randomBytes\(12\)/u);assert.match(repairController.text,/const gate=randomBytes\(32\)/u);
assert.equal((repairController.text.match(/origin\+'\/registration-link-repair'/gu)||[]).length,1);assert.match(repairController.text,/method:'POST',headers:\{'x-registration-probe-token':gate\},redirect:'error',signal:AbortSignal\.timeout\(30000\)/u);
const notes={
 schema:'cinatoken-registration-runtime-and-controller-corrected-peer-v1',createdAt:new Date().toISOString(),sourceRoot,inputs,
 reviewOnly:true,networkRequestsPerformedByPeer:0,remoteOperationsPerformedByPeer:0,postgresLoaded:false,workerModuleExecuted:false,repositoryChanged:false,
 independentReadOnlyAudit:'Pure filesystem reads, byte hashing and Babel AST parse; this new audit process exit does not replace the original producer runtime closure',
 sourceDelta:{originalWorker:old.item,derivedWorker:worker.item,derivedBundle:bundle.item,onlySemanticChanges:'Remove startup connection GUC object; replace transaction callback by three SET LOCAL timeout statements then same single fixed parameterized SELECT',allOtherProgramAstExact:true,allRemainingConnectionOptionsExact:true,readOnlyBeginRetained:true,fixedSelectExact:true,transactionTimeouts:expectedTimeouts,timeoutScope:'SET LOCAL cleared by transaction completion; driver client end does not prove physical upstream pool shutdown',readonlyDatabaseRoleNotProven:true,firstControlTimeoutDoesNotCoverConnectionOrBegin:true},
 separatorCorrection:{originalFalseAlert:'Peer incorrectly reported literal backslash-n separators and asked Root to pause',falseAlertPreserved:true,withdrawn:true,causeOfFalseAlert:'JSON tool display escaped the one source backslash; display escaping was incorrectly treated as actual source bytes',actualJoinSourceLine:declaration.init.arguments[0].loc.start.line,actualJoinSourceBytes:[...Buffer.from(joinLine)],parsedSeparatorCodePoints:[10],separatorIsRealNewline:true,priorIndependentAstTool:{chunkId:'41cce7',actualExit:0,scope:'Pure Babel AST parse/hash; no probe or SQL execution'},noV3Needed:true,noRepeatedProbeRequested:true},
 originalRuntime:{receipt:receiptInput.item,report:reportInput.item,stdout:stdout.item,stderr:stderr.item,executable:receipt.executable,args:receipt.args,cwd:receipt.cwd,actualExit:receipt.actualExit,signal:receipt.signal,at:receipt.at,finishedAt:receipt.finishedAt,worker:report.worker,metadata:report.metadata,metadataRequests:report.metadataRequests,cleanup:report.cleanup,healthTransportFailuresPreserved:failedHealth,healthFifthExpected404:true,steps:report.steps,scope:'Root original remote temporary Worker producer receipt and public sanitized report checked against its raw streams; not a fresh peer remote execution'},
 originalReadController:{file:controller.item,boundary:'Temporary ordinary REST-uploaded public workers.dev endpoint with private random application gate, not legacy remote preview or network-private transport',noExistingWorkersOrRoutesBound:true,onlyFixedHyperdriveAndGateBinding:true,unknownPutCleanupAttempted:true,deleteAndVerificationIndependentlyTried:true,metadataSoleFixedGet:true,gateNoPersistenceOrOutput:true,healthWrongPathBeforeDatabase:true,eachRequestAbortSignalAlsoCoversBody:true,outerLifecycle:'Root reported no total hard deadline; same owned child session polled until true process close; unknown cleanup uses public owned-plan name',hyperdriveCachingDisabled:'Reported earlier Root configuration GET caching.disabled=true; no new CF query performed by peer and no independent cache proof added here'},
 preparedRepairController:{file:repairController.item,bundle:repairBundle.item,reviewedLines:{namespaceAndGate:'8-16',preflightAndUnknownPut:'30-41',fixedBindingsNoLogs:'36',solePost:'58-60',exactResponseAndSafeErrors:'63-73',independentDeleteVerify:'74-88'},controllerBlockerFound:false,preparedOnly:true,executedByPeer:false,liveWriteResultReviewed:false,plannedDatabaseDml:'Fixed client-resource association INSERT only; this is not the original read-only probe',responseSuccessShape:'Exactly3 root keys; before/after exactly5 booleans; enabled existing client/resource and final exact link true; insertedClientLink boolean',noBodyOrQueryOrAutomaticPostReplay:true,solePostFailureBoundary:'Timeout, transport failure or malformed response may follow committed SQL; never infer rollback or automatically replay',cleanupProofRequired:'Original true child close plus exact owned Worker DELETE and settings404; forced outer termination must not be treated as cleanup',sqlReviewBoundary:'Worker locks/guards/INSERT/SQLite cases are separately reviewed by native_four_peer; this review only controls multipart binding, fixed bundle pin, request and cleanup/no-output behavior'},
 finding:{observedDatabaseState:'Enabled fixed client and enabled exact origin resource exist; their exact client-resource association is absent at08:54:08.279Z',inference:'This supplies the missing-link branch metadata that matches previously reviewed provider invalid_target checks; do not treat this static+metadata correspondence as a repaired or authenticated end-to-end login',repairAppliedByThisRead:false,realIdentityAuthenticationVerified:false,fullG7:false,G8:false},
 priorNegativeObservations:[{kind:'originalRootPurePreparationFailure',actualExit:1,description:'First prepare used unexported postgres/package.json resolution; no remote operation; old root source/raw/receipt retained by producer',authority:'Earlier Root message/source review; not derived from later successful preparation'},{kind:'peerReportGeneratorSetupFailure',toolChunkId:'bd4e0c',toolObservedActualExit:1,error:'SyntaxError: unexpected identifier rollback in nested outer template literal regex',phase:'Parsing failed before generator execution; no Temp files created and no child/probe/SQL run',terminalAuthority:'Original exec tool observation only; no fabricated child or raw-stream receipt'},{kind:'peerFalseSeparatorAlert',observation:'Incorrect alert was sent to Root and in commentary; explicitly withdrawn with byte/AST proof above, not deleted or rewritten'}]
};
fs.writeFileSync(path.join(root,'FINAL-registration-runtime-controller-corrected-peer.json'),JSON.stringify(notes,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({sourceInputs:inputs.length,originalRuntimeActualExit:receipt.actualExit,soleMetadataRequests:report.metadataRequests,metadata:report.metadata.values,cleanupAbsent:report.cleanup.absent,separatorCodePoints:[10],allOtherProgramAstExact:true,repairControllerBlockerFound:false,peerScope:'read/hash/AST only'}));
