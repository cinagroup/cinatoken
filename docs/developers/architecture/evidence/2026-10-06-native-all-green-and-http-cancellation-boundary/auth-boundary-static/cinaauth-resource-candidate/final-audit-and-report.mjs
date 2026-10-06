import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const root=process.argv[2],repo='C:/cinagroup/cinaauth';
const sha=b=>createHash('sha256').update(b).digest('hex');
const blob=b=>createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
const desc=p=>{const b=readFileSync(p);return {path:p,bytes:b.length,sha256:sha(b)};};
const prep=JSON.parse(readFileSync(join(root,'preparation.json'),'utf8'));
const labels=['git-head','git-helper-baseline','git-test-baseline','git-target-status','prepare','prepare-v2','diff-helper','diff-test','before-vitest','candidate-vitest'];
const receipts=labels.map(label=>{
 const x=JSON.parse(readFileSync(join(root,label+'.closed.json'),'utf8'));
 for(const kind of ['stdout','stderr']){
  const path=x[kind].path.includes(':')?x[kind].path:join(root,x[kind].path);
  const d=desc(path);
  if(d.bytes!==x[kind].bytes||d.sha256!==x[kind].sha256)throw Error('Raw receipt mismatch '+label+' '+kind);
 }
 if(x.signal!==null||(x.error??x.spawnError??null)!==null)throw Error('Abnormal child '+label);
 if(x.sourceProgram){
  const d=desc(x.sourceProgram.path);
  if(d.bytes!==x.sourceProgram.bytes||d.sha256!==x.sourceProgram.sha256)throw Error('Program mismatch '+label);
 }
 return x;
});
const expectedExits={'git-head':0,'git-helper-baseline':0,'git-test-baseline':0,'git-target-status':128,'prepare':1,'prepare-v2':0,'diff-helper':1,'diff-test':1,'before-vitest':1,'candidate-vitest':0};
for(const r of receipts)if(r.actualExit!==expectedExits[r.label])throw Error('Unexpected actual child exit '+r.label);
const postInputs=prep.inputs.map(x=>{const d=desc(x.path);if(d.bytes!==x.bytes||d.sha256!==x.sha256)throw Error('Working source drift '+x.path);return {...x,afterExact:true};});
const beforeReport=JSON.parse(readFileSync(join(root,'before-vitest.json'),'utf8'));
const candidateReport=JSON.parse(readFileSync(join(root,'candidate-vitest.json'),'utf8'));
if(beforeReport.numTotalTests!==7||beforeReport.numPassedTests!==4||beforeReport.numFailedTests!==3||beforeReport.numPendingTests!==0||beforeReport.success!==false)throw Error('Baseline tests differ');
if(candidateReport.numTotalTests!==7||candidateReport.numPassedTests!==7||candidateReport.numFailedTests!==0||candidateReport.numPendingTests!==0||candidateReport.success!==true)throw Error('Candidate tests differ');
const beforeCases=beforeReport.testResults.flatMap(x=>x.assertionResults);
const candidateCases=candidateReport.testResults.flatMap(x=>x.assertionResults);
if(JSON.stringify(beforeCases.map(x=>x.fullName))!==JSON.stringify(candidateCases.map(x=>x.fullName)))throw Error('Different tests ran');
if(!readFileSync(prep.paths.before.test).equals(readFileSync(prep.paths.candidate.test)))throw Error('Tests bytes differ');
const original=readFileSync(join(root,'helper-Git-baseline.ts'),'utf8');
const candidate=readFileSync(prep.paths.candidate.helper,'utf8');
const originalUserTest=readFileSync(join(root,'test-user-working-baseline.ts'),'utf8');
const additions=readFileSync(join(root,'resource-tests-to-append.ts.txt'),'utf8');
const testPrefix='import type { SQLInputValue } from "node:sqlite";\nimport { DatabaseSync } from "node:sqlite";\n';
if(readFileSync(prep.paths.candidate.test,'utf8')!==testPrefix+originalUserTest+additions)throw Error('User test was rewritten');
const admin=readFileSync(join(repo,'workers/auth-api/src/admin-oidc-client.ts'),'utf8');
const addition=admin.slice(admin.indexOf('\n\t// First-party resource bindings are required by the 1.7 provider.'),-4).replaceAll('adminOrigin','applicationOrigin').replaceAll('ADMIN_OIDC_CLIENT_ID','CINATOKEN_OIDC_CLIENT_ID').replaceAll('CinaSeek Admin Console','cinatoken Gateway');
if(candidate!==original.slice(0,-4)+addition+original.slice(-4))throw Error('Candidate has changes outside appended resource block');
const require=createRequire('C:/cinagroup/cinatoken/package.json'),ts=require('typescript');
const tree=s=>ts.createSourceFile('helper.ts',s,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const a=tree(original),b=tree(candidate);
if(a.parseDiagnostics.length||b.parseDiagnostics.length)throw Error('Source syntax diagnostics');
const fn=sf=>sf.statements.filter(ts.isVariableStatement).flatMap(s=>[...s.declarationList.declarations]).find(d=>d.name.getText(sf)==='ensureCinatokenOidcClient').initializer;
const sa=fn(a).body.statements.map(s=>s.getText(a)),sb=fn(b).body.statements.map(s=>s.getText(b));
if(sb.length!==sa.length+2||JSON.stringify(sb.slice(0,-2))!==JSON.stringify(sa))throw Error('Original statement AST/source not exact');
const final={
 schema:'cinaauth-cinatoken-exact-resource-candidate-FINAL-v1',
 finalizedAt:new Date().toISOString(),
 authority:{sourceHead:prep.sourceHead,
 localHeadNotProofOfDeployedVersion:true,observedProductionVersion:prep.production.reportedVersion,
 observedProductionTag:null,hyperdriveId:prep.production.hyperdriveId,
 actualLiveRowsRead:false,rootCauseConfirmed:false,productionRequests:0},
 scope:{repoWrites:0,gitWrites:0,dependenciesInstalled:0,newCI:0,actualPGOrHyperdriveQueries:0,productionDeploys:0,
 expectedSourceInputs:8,rootAGENTSReadFull:true,
 rootAGENTSInstructionsApplied:'pnpm test/npm/yarn/bun/install not used. Existing direct Vitest selected single file and pattern. No Repo commit/typecheck performed during Temp-only preparation.'},
 sourceInputs:postInputs,
 targetBefore:{helper:{...desc(join(root,'helper-Git-baseline.ts')),gitBlob:blob(readFileSync(join(root,'helper-Git-baseline.ts'))),workingExactGit:true},
 testGit:{...desc(join(root,'test-Git-baseline.ts')),gitBlob:blob(readFileSync(join(root,'test-Git-baseline.ts')))},
 testUserWorking:{...desc(join(root,'test-user-working-baseline.ts')),gitBlobOfWorkingBytes:blob(Buffer.from(originalUserTest)),alreadyUserModified:prep.userTestAlreadyModified,userOriginalBytesUnchanged:true}},
 candidate:{helper:desc(prep.paths.candidate.helper),test:desc(prep.paths.candidate.test),
 patch:desc(join(root,'patch-reviewable.diff')),originalNoIndexPatch:desc(join(root,'patch.diff')),
 originalGitDiffRawUnmodified:true,reviewableHeadersOnlyCorrected:true},
 sourceProtection:{reverseFullHelperBytesExact:true,originalFunctionStatements:sa.length,appendedQueryStatements:2,
 originalAllStatementTextsExact:true,reverseASTInputExact:true,importsConstantsGuardsAndOriginalClientSQLExact:true,
 originalTestExpectCalls:prep.originalExpectCalls,originalThreeTestsAndAllAssertionsWholeBytesExact:true,
 originalUserTestFullReverseExact:true,beforeAndCandidateTestsEntireBytesEqual:true,
 helperAndAll8WorkingInputsPostHashExact:true},
 change:'Append existing Admin insertOnly oauthResource(identifier=applicationOrigin) and oauthClientResource(fixed cinatoken-admin, resourceId=identifier) protocol. No wildcard/client family, no unknown resource enablement or policy overwrite.',
 guardBoundary:{resourceAndLinkDisabledPolicy:'Existing oauthResource.disabled/TTL/allowedScopes/label/timestamps and oauthClientResource metadata/createdAt are unchanged by conflicts.',
 originalClientDisabled:'Original oauthClient upsert still assigns disabled=false from original values; Root explicitly authorized preserving entire original upsert. This patch does not introduce or expand that behavior.',
 scopesPKCEAndClientAuth:'openid/profile/email, requirePKCE and client_secret_basic original exact.',
 secretHandling:'Original strong-prefix/payload validation and SHA256 storage unchanged; existing weak/unprefixed tests demonstrate zero query before validation. Only fixture test secret strings in local tests; no real credentials read or logged.'},
 verification:{runtime:'Existing Vitest4.1.10 + Node24.14.1, direct specific test path/pattern; Temp cwd/root/cache only.',
 red:{actualProcessExit:1,totalTests:7,passed:4,failed:3,skipped:0,report:desc(join(root,'before-vitest.json')),cases:beforeCases.map(x=>({fullName:x.fullName,status:x.status}))},
 green:{actualProcessExit:0,totalTests:7,passed:7,failed:0,skipped:0,report:desc(join(root,'candidate-vitest.json')),cases:candidateCases.map(x=>({fullName:x.fullName,status:x.status}))},
 method:'Four new tests call the actual copied source ensureCinatokenOidcClient against real isolated Node SQLite query execution with UNIQUE/FK constraints; original three tests remain exactly. Disabled resource/link preservation, idempotence and fixed-client-only linkage are data-state observations, not literal matching.',
 limitations:['SQLite fixtures exercise SQL/query protocol, not native PostgreSQL/Hyperdrive defaults, concurrent operators or deployed provider state.',
 'Production invalid_target actual root cause still unconfirmed; missing/disabled resource/link live metadata has not been read.',
 'Repository-wide pnpm typecheck and actual provider authorize/token integration not run in this Temp-only task.',
 'Candidate not copied into either repository, committed, pushed, or deployed.'],
 redOutputRetained:true},
 originalClosedReceipts:receipts,
 receiptSummaryBeforeFinalAuditClosure:{closedChildren:10,actualZero:5,actualOne:4,actual128:1,
 onesMeaning:['prepare failed because readonly git status128 rejected NUL exclude file; no candidate written before that failure','diff-helper/diff-test actual1 are normal no-index differences','before-vitest actual1 is intentional baseline red'],noCollectionExitDerivedAsBusinessPass:true},
 otherFailureObservations:{initialGitDubiousOwnershipTool:desc(join(root,'initial-git-tool-failure.json')),
 toolJavaScriptParseBeforeExecution:desc(join(root,'tool-script-parse-error.json')),
 noGlobalGitConfigChanged:true,perInvocationSafeDirectoryOnly:true,
 v2Resume:'Reused prior true closed HEAD/helper/test Git bytes with raw hash binding; did not rerun their commands. Original status128/prepare1 retained.'},
 reviewableNextStep:'Root can independently review the exact two-file candidate/patch and private live metadata before any external-repo write/deployment. No permission request is generated by this Temp-only task.',
 STOPWRITEAfterFinalAuditClosure:true
};
writeFileSync(join(root,'FINAL-cinatoken-resource-candidate.json'),JSON.stringify(final,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({actualExit:0,helper:final.candidate.helper,test:final.candidate.test,patch:final.candidate.patch,red:'7/4/3/0 process1',green:'7/7/0/0 process0',originalExpectCalls:prep.originalExpectCalls,all8SourcesExact:true,rootCauseConfirmed:false,repoWritten:false}));

