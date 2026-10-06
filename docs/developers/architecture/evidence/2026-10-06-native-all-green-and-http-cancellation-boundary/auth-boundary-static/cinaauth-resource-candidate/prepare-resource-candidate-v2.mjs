import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const out=process.argv[2], repo='C:/cinagroup/cinaauth';
const git='C:/Program Files/Git/cmd/git.exe';
const sha=b=>createHash('sha256').update(b).digest('hex');
const desc=p=>{const b=readFileSync(p);return {path:p,bytes:b.length,sha256:sha(b)};};
const records=[];
function child(label,executable,args,options={}){
 const startedAt=new Date().toISOString();
 const r=spawnSync(executable,args,{cwd:repo,encoding:null,windowsHide:true,timeout:30000,maxBuffer:1024*1024,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'},...options});
 const stdout=r.stdout??Buffer.alloc(0),stderr=r.stderr??Buffer.alloc(0);
 writeFileSync(join(out,label+'.stdout.log'),stdout,{flag:'wx'});
 writeFileSync(join(out,label+'.stderr.log'),stderr,{flag:'wx'});
 const record={label,command:[executable,...args],cwd:repo,startedAt,endedAt:new Date().toISOString(),actualExit:r.status,signal:r.signal??null,error:r.error?{code:r.error.code,message:r.error.message}:null,stdout:desc(join(out,label+'.stdout.log')),stderr:desc(join(out,label+'.stderr.log'))};
 writeFileSync(join(out,label+'.closed.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx'});
 records.push(record);return {r,stdout,stderr};
}
function recover(label){
 const r=JSON.parse(readFileSync(join(out,label+'.closed.json'),'utf8'));
 const stdout=readFileSync(join(out,label+'.stdout.log'));
 const stderr=readFileSync(join(out,label+'.stderr.log'));
 if(sha(stdout)!==r.stdout.sha256||sha(stderr)!==r.stderr.sha256)throw Error('Frozen Git raw mismatch');
 records.push(r);
 return {r:{status:r.actualExit,signal:r.signal,error:r.error},stdout,stderr};
}
const ga=['-c','safe.directory='+repo,'-c','core.excludesFile=NUL','-C',repo];
const head=recover('git-head');
if(head.r.status!==0||head.stdout.toString().trim()!=='bfa56df798ede6a40e9d5cea0ef1a1e9a3568f3f')throw Error('HEAD differs from requested baseline');
const files=[
'workers/auth-api/src/cinatoken-oidc-client.ts',
'workers/auth-api/test/cinatoken-oidc-client.test.ts',
'workers/auth-api/src/admin-oidc-client.ts',
'workers/auth-api/test/admin-oidc-resource.integration.test.ts',
'packages/oauth-provider/src/resources.ts',
'packages/oauth-provider/src/schema.ts',
'workers/auth-api/vitest.config.ts',
'workers/auth-api/package.json'
];
const inputs=files.map(p=>({relativePath:p,...desc(join(repo,p))}));
const originalHelper=readFileSync(join(repo,files[0]),'utf8');
const originalTest=readFileSync(join(repo,files[1]),'utf8');
const admin=readFileSync(join(repo,files[2]),'utf8');
const gitHelper=recover('git-helper-baseline');
const gitTest=recover('git-test-baseline');
if(gitHelper.r.status!==0||gitTest.r.status!==0)throw Error('Git baseline read failed');
if(!readFileSync(join(repo,files[0])).equals(gitHelper.stdout))throw Error('Helper working bytes differ from Git');
const status=recover('git-target-status');
// Prior actual status128 is preserved; no status claim is derived. Helper/test working bytes are compared directly to original closed Git blobs.
writeFileSync(join(out,'root-AGENTS.snapshot.md'),readFileSync(join(repo,'AGENTS.md')),{flag:'wx'});
writeFileSync(join(out,'helper-Git-baseline.ts'),gitHelper.stdout,{flag:'wx'});
writeFileSync(join(out,'test-Git-baseline.ts'),gitTest.stdout,{flag:'wx'});
writeFileSync(join(out,'test-user-working-baseline.ts'),originalTest,{flag:'wx'});
const anchor='\n\t// First-party resource bindings are required by the 1.7 provider.';
const start=admin.indexOf(anchor);
if(start<0||!admin.endsWith('\n};\n'))throw Error('Admin resource block anchor shape changed');
const adminBlock=admin.slice(start,-4);
const addition=adminBlock.replaceAll('adminOrigin','applicationOrigin').replaceAll('ADMIN_OIDC_CLIENT_ID','CINATOKEN_OIDC_CLIENT_ID').replaceAll('CinaSeek Admin Console','cinatoken Gateway');
if(!originalHelper.endsWith('\n};\n'))throw Error('Helper final closing shape changed');
const candidate=originalHelper.slice(0,-4)+addition+originalHelper.slice(-4);
if(candidate.replace(addition,'')!==originalHelper)throw Error('Helper reverse bytes changed');
const sqliteImport='import type { SQLInputValue } from "node:sqlite";\nimport { DatabaseSync } from "node:sqlite";\n';
const appendedTests=readFileSync(join(out,'resource-tests-to-append.ts.txt'),'utf8');
const candidateTest=sqliteImport+originalTest+appendedTests;
if(candidateTest.slice(sqliteImport.length,-appendedTests.length)!==originalTest)throw Error('Original user test bytes changed');
const paths={};
for(const [stage,helper] of [['before',originalHelper],['candidate',candidate]]){
 const stageRoot=join(out,stage);
 const src=join(stageRoot,'workers/auth-api/src'),test=join(stageRoot,'workers/auth-api/test');
 mkdirSync(src,{recursive:true});mkdirSync(test,{recursive:true});
 writeFileSync(join(src,'cinatoken-oidc-client.ts'),helper,{flag:'wx'});
 writeFileSync(join(src,'admin-oidc-client.ts'),admin,{flag:'wx'});
 writeFileSync(join(test,'cinatoken-oidc-client.test.ts'),candidateTest,{flag:'wx'});
 paths[stage]={root:stageRoot,helper:join(src,'cinatoken-oidc-client.ts'),test:join(test,'cinatoken-oidc-client.test.ts')};
}
const require=createRequire('C:/cinagroup/cinatoken/package.json');
const ts=require('typescript');
const tree=s=>ts.createSourceFile('helper.ts',s,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const beforeAST=tree(originalHelper),afterAST=tree(candidate);
if(beforeAST.parseDiagnostics.length||afterAST.parseDiagnostics.length)throw Error('TS syntax diagnostics');
const fn=sf=>sf.statements.find(s=>ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>d.name.getText(sf)==='ensureCinatokenOidcClient')).declarationList.declarations.find(d=>d.name.getText(sf)==='ensureCinatokenOidcClient').initializer;
const originalStatements=fn(beforeAST).body.statements.map(s=>s.getText(beforeAST));
const afterStatements=fn(afterAST).body.statements.map(s=>s.getText(afterAST));
if(afterStatements.length!==originalStatements.length+2||JSON.stringify(afterStatements.slice(0,-2))!==JSON.stringify(originalStatements))throw Error('Original function statements altered');
const originalExpectCount=(originalTest.match(/\bexpect\s*\(/g)||[]).length;
const config={
 resolve:{alias:{'@cinaauth/auth-web-contract':'C:/cinagroup/cinaauth/packages/auth-web-contract/src/index.ts','vitest':'C:/cinagroup/cinaauth/node_modules/vitest/dist/index.js'}},
 test:{environment:'node',include:['workers/auth-api/test/cinatoken-oidc-client.test.ts'],testTimeout:10000,watch:false,fileParallelism:false},
};
writeFileSync(join(out,'vitest.config.mjs'),'export default '+JSON.stringify(config,null,2)+';\n',{flag:'wx'});
function patch(label,beforePath,afterPath,relativePath){
 const result=child(label,git,['diff','--no-index','--no-prefix',beforePath,afterPath],{cwd:out});
 if(result.r.status!==1||result.r.signal||result.r.error)throw Error('Expected git no-index diff actual1');
 let text=result.stdout.toString('utf8');
 const a=beforePath.replaceAll('\\','/'),b=afterPath.replaceAll('\\','/');
 text=text.replaceAll(a,'a/'+relativePath).replaceAll(b,'b/'+relativePath);
 return text;
}
const helperPatch=patch('diff-helper',paths.before.helper,paths.candidate.helper,files[0]);
const testPatch=patch('diff-test',join(out,'test-user-working-baseline.ts'),paths.candidate.test,files[1]);
writeFileSync(join(out,'patch.diff'),helperPatch+testPatch,{flag:'wx'});
const preparation={
 schema:'cinaauth-cinatoken-resource-Temp-preparation-v1',
 sourceHead:head.stdout.toString().trim(),inputs,rootAGENTS:desc(join(out,'root-AGENTS.snapshot.md')),
 gitHelper:{...desc(join(out,'helper-Git-baseline.ts')),workingExact:true},
 gitTest:desc(join(out,'test-Git-baseline.ts')),userTest:desc(join(out,'test-user-working-baseline.ts')),
 userTestAlreadyModified:!Buffer.from(originalTest).equals(gitTest.stdout),
 candidateHelper:desc(paths.candidate.helper),candidateTest:desc(paths.candidate.test),patch:desc(join(out,'patch.diff')),
 originalFunctionStatements:originalStatements.length,appendedQueries:2,
 originalFunctionStatementsByteExact:true,helperReverseFullBytesExact:true,
 originalUserTestReverseFullBytesExact:true,originalExpectCalls:originalExpectCount,
 adminProtocolMapping:{resourceSQL:'Admin block text exact with adminOrigin/applicationOrigin, ADMIN/CINATOKEN client constant, display-name substitutions only',resourceId:'Resource identifier applicationOrigin, not oauthResource.id',clientId:'fixed cinatoken-admin'},
 guardChanges:'None in original client upsert/scopes/PKCE/client_secret_basic/secret validation/hash; insertOnly resource and link preserve existing policy. Existing oauthClient.disabled=false upsert is original behavior and remains.',
 production:{hyperdriveId:'374f6da17aff4c968cadd8d6aa454c22',reportedVersion:'1afab5f9-f614-4d83-bb99-22489561e88b',tag:null,
 localHeadIsNotDeployedSourceProof:true,liveResourceAndLinkRowsObserved:false,rootCauseConfirmed:false},
 paths,records,testsNotRunYet:true,repoWritten:false,productionRequests:0
};
writeFileSync(join(out,'preparation.json'),JSON.stringify(preparation,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({actualExit:0,candidateHelper:preparation.candidateHelper,candidateTest:preparation.candidateTest,patch:preparation.patch,originalExpectCount,originalFunctionStatements:originalStatements.length,appendedQueries:2,userTestAlreadyModified:preparation.userTestAlreadyModified,paths}));

