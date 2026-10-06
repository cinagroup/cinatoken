import {readFileSync,writeFileSync,readdirSync,statSync} from "node:fs";
import {join,relative} from "node:path";
import {createHash} from "node:crypto";
import {createRequire} from "node:module";
const root=process.argv[2],sha=b=>createHash("sha256").update(b).digest("hex");
const desc=path=>{const b=readFileSync(path);return {path,bytes:b.length,sha256:sha(b)};};
const peerCandidate=desc(join(root,"repair-cinatoken-client-link.mjs"));
if(peerCandidate.bytes!==2410||peerCandidate.sha256!=="0f0651066fdd0da2fdb301f1fbbab7ac37dcdf86d57f482863e5189ea2161102")throw Error("Peer candidate drift");
const receipt=JSON.parse(readFileSync(join(root,"sqlite-tests.closed.json"),"utf8"));
for(const kind of ["stdout","stderr"]){const d=desc(join(root,receipt[kind].path));if(d.bytes!==receipt[kind].bytes||d.sha256!==receipt[kind].sha256)throw Error("SQLite raw drift");}
if(receipt.actualExit!==0||receipt.signal!==null||receipt.error!==null)throw Error("SQLite child not closed0");
const stdout=readFileSync(join(root,"sqlite-tests.stdout.log"),"utf8");
if(!/tests 9/.test(stdout)||!/pass 9/.test(stdout)||!/fail 0/.test(stdout)||!/skipped 0/.test(stdout))throw Error("Nine-case summary differs");
const workerPath="C:/Users/cina/AppData/Local/Temp/cinatoken-followup-auth-gates-80c5f57d2e0a68/registration-link-repair/registration-link-repair.worker.mjs";
const controllerPath="C:/Users/cina/AppData/Local/Temp/cinatoken-followup-auth-gates-80c5f57d2e0a68/repair-registration-via-owned-worker.mjs";
const workerBytes=readFileSync(workerPath),controllerBytes=readFileSync(controllerPath);
const worker=workerBytes.toString("utf8"),controller=controllerBytes.toString("utf8");
const workerPin=desc(workerPath),controllerPin=desc(controllerPath);
const expectedWorkerSHA="9be840dd466f58734de2050f9441206641fcd9e69ad327078a2f4adf90a5d421";
const expectedControllerSHA="f3bc3660f311f99ead7108208dac1aeccd3d3e63e3d639445ad6ec468163372b";
const require=createRequire("C:/cinagroup/cinatoken/package.json"),acorn=require("acorn");
const ast=acorn.parse(worker,{ecmaVersion:"latest",sourceType:"module"});
const sqlLiteralValues=[];
const walk=n=>{if(!n||typeof n!=="object")return;if(n.type==="Literal"&&typeof n.value==="string"&&/^(SELECT|INSERT|UPDATE|DELETE|SET LOCAL)\b/.test(n.value))sqlLiteralValues.push(n.value);for(const [key,value] of Object.entries(n)){if(key==="start"||key==="end")continue;if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==="object")walk(value);}};
walk(ast);
const mutations=sqlLiteralValues.filter(x=>/^(INSERT|UPDATE|DELETE)\b/.test(x));
if(mutations.length!==1||!mutations[0].startsWith('INSERT INTO "oauthClientResource"'))throw Error("Root Worker mutation scope differs");
if(!worker.includes("const CLIENT_ID = 'cinatoken-admin';")||!worker.includes("const RESOURCE_ID = 'https://cinatoken.com';"))throw Error("Root identifiers differ");
if(!worker.includes("ON CONFLICT DO NOTHING RETURNING TRUE")||!worker.includes("FOR UPDATE"))throw Error("Root conflict/lock guard missing");
writeFileSync(join(root,"root-worker-audited.snapshot.mjs"),workerBytes,{flag:"wx"});
writeFileSync(join(root,"root-controller-audited.snapshot.mjs"),controllerBytes,{flag:"wx"});
const final={
 schema:"cinaauth-fixed-firstparty-association-data-repair-FINAL-v1",
 finalizedAt:new Date().toISOString(),
 currentPlan:"Only repair the confirmed missing existing first-party client-resource link; no resource initialization or policy update.",
 inputAuthority:{
 liveMetadata:{authority:"Root direct message; this agent made no live/API/database request",observedHTTPStatus:200,clientExists:true,clientDisabled:false,resourceExists:true,resourceDisabled:false,linkExists:false,
 requestAt:"2026-10-06T08:54:08.279Z",readonlyExecutorStartedAt:"2026-10-06T08:53:52.632Z",readonlyExecutorEndedAt:"2026-10-06T08:54:11.771Z",executorActualExit:0,
 rootReportedCleanup:"Owned metadata Worker DELETE200 + verify404",rawAuthority:"Held by Root; raw receipts not copied/read in this task"},
 productionSource:"CinaAuth deployed tagNULL; localHEAD/dirty working tree not whole deployed-source provenance, no whole-source redeploy plan.",
 liveRepairAlreadyExecutedByThisAgent:false,
 deployedAuthorizationRootCauseConfirmed:false},
 candidate:peerCandidate,
 genericEarlierDraft:{...desc(join(root,"repair-cinatoken-registration.mjs")),status:"Superseded for current production branch; never executed. Generic resource initialization draft must not be used for Root current live shape."},
 proposedProtocol:[
 "Use one reviewed postgres.js sql.begin connection, fixed client cinatoken-admin and fixed resource https://cinatoken.com; no caller body/query SQL or identifiers.",
 "Bound transaction-local lock/statement timeouts; SELECT client FOR UPDATE, then resource FOR UPDATE; read only five boolean statuses.",
 "Require clientExists && !clientDisabled && resourceExists && !resourceDisabled. Missing or disabled rolls back without any insert.",
 "Only INSERT oauthClientResource(id=cinatoken-admin:https://cinatoken.com, clientId=cinatoken-admin, resourceId=https://cinatoken.com, createdAt=transaction time), ON CONFLICT DO NOTHING.",
 "Re-read all five booleans in the same transaction; require enabled existing client/resource and exact linkExists. A conflicting reserved ID belonging to another pair refuses and rolls back.",
 "Return {before,after,insertedLink} from peer module; Root Worker equivalent uses {before,after,insertedClientLink}. Both before/after exactly five bools: clientExists/clientDisabled/resourceExists/resourceDisabled/linkExists."
 ],
 postconditionExpectedOnly:{before:{clientExists:true,clientDisabled:false,resourceExists:true,resourceDisabled:false,linkExists:false},after:{clientExists:true,clientDisabled:false,resourceExists:true,resourceDisabled:false,linkExists:true},insertedClientLink:true,authority:"Expected acceptance pattern; not a new production result."},
 invariants:{oauthClientWrites:0,oauthResourceWrites:0,existingMetadataOrTimestampUpdates:0,
 targetLinkIdentifierOnly:true,otherClientAssociationWrites:0,disabledPolicyOverride:false,
 resourceIdIsBusinessIdentifierNotRowId:true,secretOrMetadataReturn:false},
 SQLiteVerification:{actualClosedReceipt:receipt,totalTests:9,passed:9,failed:0,skipped:0,
 actualCandidateFunctionExecuted:true,actualInMemorySQLiteStatementsExecuted:true,
 method:"Same exported candidate invoked with real BEGIN IMMEDIATE/COMMIT/ROLLBACK, SQL UNIQUE/FK constraints. Adapter strips PG FOR UPDATE and ignores SET LOCAL explicitly; result integer bool columns mapped to driver boolean contract.",
 testedCases:[
 "Root observed missing link shape inserts exactly one fixed link, returns only five-bool states plus inserted flag; complete client/resource row snapshots unchanged.",
 "Replay changes no rows/link timestamp/metadata and inserted flag is false.",
 "Missing resource refuses and creates no resource.",
 "Missing client refuses and creates no client.",
 "Disabled client refuses with full snapshot unchanged.",
 "Disabled resource refuses even with an existing exact link, full snapshot unchanged.",
 "Other client links and unrelated disabled resources/policies remain exact.",
 "Reserved link ID occupied by another pair refuses after ON CONFLICT without overwriting and rolls back.",
 "Nullable disabled fields use COALESCE default without changing stored null policy."
 ],
 limits:"Not PG/Hyperdrive row-lock, isolation, SQL type, grant, concurrent-writer, live-provider or real-login proof."},
 rootWorkerStaticReview:{
 worker:workerPin,controller:controllerPin,
 previouslyReportedWorkerExact:workerPin.sha256===expectedWorkerSHA,
 previouslyReportedControllerExact:controllerPin.sha256===expectedControllerSHA,
 snapshotAuthority:"Only these two explicitly frozen paths; no parent/root enumeration. Whole bytes copied for audit reproducibility; no module import/fetch/controller executed.",
 rootReportedBundle:{bytes:82380,sha256:"2e8feaf50cad98f1cb775b58ec6d2e7e2b6da527f8560aca015fd7cdaa0d0474",independentBundleReadOrExecution:false},
 sourceOnlyConclusions:[
 "Fixed path POST and 64hex timingSafeEqual memory gate precede Hyperdrive client; query parameters/body never read.",
 "Bound postgres max1, prepare false/fetch_types false/debug false/onnotice ignored; Root localtimeouts lock2s/statement5s/idle-txn7s.",
 "sql.begin holds client then resource FOR UPDATE; before shape is exactly five booleans and both row count1/disabled=false required.",
 "Exactly one mutation SQL literal: fixed oauthClientResource INSERT ON CONFLICT DO NOTHING now(); no client/resource/metadata UPDATE, no DELETE.",
 "Root now() and peer CURRENT_TIMESTAMP are transaction-time equivalents in PG; Root pre-acquired locks remain held while after boolean metadata is read, peer re-issues locked reads.",
 "Root Worker returns insertedClientLink (peer alias insertedLink), same strict booleans.",
 "finally closes sql with2s; controller prepares owned absence404, memory gate/no stored secret, one business POST, owned DELETE + verify404, and records failures without retrying the transaction."
 ],
 preciseGuardDifference:{
 workerAfterRequiresClientResourceExists:/if \([^;\n]*!after\.clientExists/.test(worker)&&/if \([^;\n]*!after\.resourceExists/.test(worker),
 originalReportedSourceLine:81,
 originalReportedGuard:"!after.linkExists || after.clientDisabled || after.resourceDisabled",
 peerAfterGuardRequiresBothExists:true,
 recommendation:"Add !after.clientExists || !after.resourceExists in the transaction final guard for full post-state validation. Controller checks these after commit; any post-commit transport/cleanup error must not trigger blind retry.",
 status:"Source difference notified to Root; Root sole owner chooses/amends before actual execution. This review does not rewrite Root file or prove live commit."}
 },
 operationalLimits:{repoOrGitWrites:0,oldFrozenRootWrites:0,networkOrAPIRequests:0,livePGConnections:0,remoteRepairExecutions:0,sourceWholeRedeploys:0,
 otherCIOrBrowserRunsTouched:false,noProductionRootCauseClaim:true},
 originalLocalReceipts:{capturedSQLiteChildActualExit:0,sourceAndRawHashesBound:true,noLocalFailureObserved:true,finalAuditClosureWillBeInOwnReceipt:true},
 STOPWRITEAfterFinalAuditClosure:true
};
writeFileSync(join(root,"FINAL-firstparty-link-data-repair-plan.json"),JSON.stringify(final,null,2)+"\n",{flag:"wx"});
console.log(JSON.stringify({actualExit:0,SQLiteCases:9,pass:9,fail:0,skip:0,peerCandidate,
 rootWorker:workerPin,rootController:controllerPin,
 rootExactPins:{worker:workerPin.sha256===expectedWorkerSHA,controller:controllerPin.sha256===expectedControllerSHA},
 onlyRootMutation:mutations[0],productionRequestCount:0,noProductionRepairPassDerived:true}));

