import {readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {createRequire} from "node:module";
const root=process.argv[2];
const r="C:/Users/cina/AppData/Local/Temp/cinatoken-followup-auth-gates-80c5f57d2e0a68";
const prior="C:/Users/cina/AppData/Local/Temp/cinaauth-firstparty-data-repair-plan-41c3699de26d498096ecf6cc9e498880";
const sha=b=>createHash("sha256").update(b).digest("hex");
const read=path=>{const bytes=readFileSync(path);return {path,bytes:bytes.length,sha256:sha(bytes),text:bytes.toString("utf8"),raw:bytes};};
const oldWorker=read(join(prior,"root-worker-audited.snapshot.mjs"));
const oldController=read(join(prior,"root-controller-audited.snapshot.mjs"));
const newWorker=read(join(r,"registration-link-repair-v2/registration-link-repair.worker.mjs"));
const newController=read(join(r,"repair-registration-via-owned-worker-v2.mjs"));
const expected={oldWorker:"9be840dd466f58734de2050f9441206641fcd9e69ad327078a2f4adf90a5d421",
 oldController:"f3bc3660f311f99ead7108208dac1aeccd3d3e63e3d639445ad6ec468163372b",
 newWorker:"07103d4c4a646e5a0ad97b220c7c36db882e0be3e9b2266f9c1e2269e5594944"};
for(const [key,pin] of Object.entries(expected))if(({oldWorker,oldController,newWorker})[key].sha256!==pin)throw Error("Pinned source drift "+key);
const addClient="!after.clientExists || ",addResource="!after.resourceExists || ";
if(newWorker.text.split(addClient).length!==2||newWorker.text.split(addResource).length!==2)throw Error("Expected exactly two final guard operands");
if(newWorker.text.replace(addClient,"").replace(addResource,"")!==oldWorker.text)throw Error("Worker reverse bytes differ beyond final guard operands");
const oldBundle="2e8feaf50cad98f1cb775b58ec6d2e7e2b6da527f8560aca015fd7cdaa0d0474";
const newBundle="20ea7d7a16b19c9c65fd84fa28d2de24a4ab9a6be4d1d924e92707d2f9d80577";
const reverseController=newController.text.replaceAll("registration-link-repair-v2/","registration-link-repair/").replaceAll(newBundle,oldBundle);
if(reverseController!==oldController.text)throw Error("Controller changes extend beyond bundle directory and pin");
const require=createRequire("C:/cinagroup/cinatoken/package.json"),acorn=require("acorn");
const ast=acorn.parse(newWorker.text,{ecmaVersion:"latest",sourceType:"module"}),mutations=[];
const visit=n=>{if(!n||typeof n!=="object")return;if(n.type==="Literal"&&typeof n.value==="string"&&/^(INSERT|UPDATE|DELETE)\b/.test(n.value))mutations.push(n.value);for(const [k,v]of Object.entries(n)){if(k==="start"||k==="end")continue;if(Array.isArray(v))v.forEach(visit);else if(v&&typeof v==="object")visit(v);}};
visit(ast);
if(mutations.length!==1||!mutations[0].startsWith('INSERT INTO "oauthClientResource"'))throw Error("Unexpected mutation scope");
acorn.parse(newController.text,{ecmaVersion:"latest",sourceType:"module"});
writeFileSync(join(root,"worker-v2-reviewed.snapshot.mjs"),newWorker.raw,{flag:"wx"});
writeFileSync(join(root,"controller-v2-reviewed.snapshot.mjs"),newController.raw,{flag:"wx"});
const sqlReceipt=JSON.parse(readFileSync(join(prior,"sqlite-tests.closed.json"),"utf8"));
if(sqlReceipt.actualExit!==0||sqlReceipt.stdout.sha256!=="de866baa16c0b25d0684e205545da52e7baa807fd6edbd677058dedd1573e939")throw Error("Prior SQLite receipt differs");
const descriptor=({text,raw,...rest})=>rest;
const oldLines=oldWorker.text.split(/\r?\n/),newLines=newWorker.text.split(/\r?\n/);
const differences=newLines.map((line,index)=>line===oldLines[index]?null:{line:index+1,before:oldLines[index],after:line}).filter(Boolean);
const report={
 schema:"cinaauth-firstparty-link-v2-static-approval-status-FINAL-v1",at:new Date().toISOString(),
 sourceInputs:{oldWorker:descriptor(oldWorker),oldController:descriptor(oldController),workerV2:descriptor(newWorker),controllerV2:descriptor(newController)},
 sourceAudit:{workerFullReverseExact:true,workerOnlyDeltaTwoFinalExistsGuards:true,workerChangedLines:differences,
 controllerFullReverseExact:true,controllerOnlyDeltaBundleDirectoryAndExpectedHash:true,
 rootFinalGuardNowRequiresAllFiveStatuses:true,
 soleMutationLiteral:mutations[0],noClientOrResourceMutation:true,
 gateFixedPathPOSTAndMemoryBeforeDBUnchanged:true,noRequestBodyOrQuerySQLUnchanged:true,
 fixedClientResourceAndLockOrderUnchanged:true,
 finallySqlEndAndOnePOSTOwnedCleanupUnchanged:true,
 SQLiteModuleAlias:"peer insertedLink <=> Root insertedClientLink",PGTimeAlias:"peer CURRENT_TIMESTAMP <=> Root now()",
 dataTransactionStaticSupport:true},
 bundlePin:{bytes:82428,sha256:newBundle,authority:"Root reported prepared bundle and new controller embedded expected pin; bundle bytes not re-read/verified by this audit."},
 priorLocalTests:{root:prior,receiptPath:join(prior,"sqlite-tests.closed.json"),
 actualStartedAt:sqlReceipt.startedAt,actualEndedAt:sqlReceipt.endedAt,actualExit:0,tests:9,pass:9,fail:0,skip:0,
 candidateScope:"Actual peer module transaction exercised using real in-memory SQLite with explicit PG lock/SETLOCAL adaptation; Root Worker HTTP/PG not executed here.",
 rerunPerformed:false,receipt:sqlReceipt,
 priorFINAL:{path:join(prior,"FINAL-firstparty-link-data-repair-plan.json"),bytes:10534,sha256:"941768352a41832c0dbad482c08ce12954cf309e929b443a9152f104216ea224"},
 priorSeal:{path:join(prior,"STOPWRITE.json"),bytes:3037,sha256:"f3d81d4e64e4404be94bd036877b6988af53e043d1c6aec5d9826c247bff64d2"}},
 liveMetadataAuthority:{source:"Root prior direct message, no new request by this agent",
 fiveBooleans:{clientExists:true,clientDisabled:false,resourceExists:true,resourceDisabled:false,linkExists:false},
 rootCauseConfirmed:false,deployedSourceTag:null,localDirtyTreeNotWholeDeployedSourceProof:true},
 approvalStatus:{authority:"Root direct message; rejection tool not called or replayed by this agent",
 status:"prepared_not_executed_blocked_by_specific_production_write_approval",
 intendedAction:"One fixed cinatoken-admin / https://cinatoken.com oauthClientResource association INSERT via temporary owned Worker",
 rejectionReason:"Persistent production OAuth association changes security boundary; no specific authorization for that change.",
 CreateProcessCreatedChild:false,actualProcessExit:null,actualProcessSignal:null,
 repairWorkerCreated:false,productionDBWritePerformed:false,
 repeatedAttemptByThisAgent:false,APIOrNetworkRequestsByThisAgent:0,
 specificUserApprovalPendingAsReportedByRoot:true},
 conclusion:"V2 is the reviewed minimal link-only transaction with the two missing post-existence guards added exactly. Local nine-case result remains valid for its guarded protocol and does not prove PG/live execution. Static candidate supports review; actual production repair is prepared and not executed because automatic approval rejected process creation.",
 scope:{newSQLiteRuns:0,newAppOrPGOrCIOrBrowserRuns:0,sourceOrGitOrRepoWrites:0,oldFrozenRootsModified:false,
 newOwnedRootOnly:true,noCredentialCookiesTokensReadOrPrinted:true},
 STOPWRITEAfterOwnStaticAuditClosure:true
};
writeFileSync(join(root,"FINAL-firstparty-link-v2-approval-review.json"),JSON.stringify(report,null,2)+"\n",{flag:"wx"});
console.log(JSON.stringify({actualExit:0,workerV2:descriptor(newWorker),controllerV2:descriptor(newController),workerReverseExact:true,controllerReverseExact:true,
 priorNineTestsTrue0:true,newTests:0,productionWritePerformed:false,blockedApprovalChildCreated:false}));

