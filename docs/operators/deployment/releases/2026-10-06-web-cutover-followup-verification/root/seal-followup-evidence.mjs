import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
const workspace='C:/cinagroup/cinatoken';
const temp="C:/Users/cina/AppData/Local/Temp/cinatoken-migration-progress-20261006-541315903c5243bc9a08bbc8a3515df4";
const release='docs/operators/deployment/releases/2026-10-06-web-cutover-followup';
const destination=path.resolve(workspace,release);
assert.ok(destination.startsWith(path.resolve(workspace)+path.sep));
assert.equal(fs.existsSync(destination),false,'New evidence directory must not exist');
const roots=[
 ['root-progress',temp],
 ['network-diagnostic-draft','C:/Users/cina/AppData/Local/Temp/cinatoken-production-network-diag-20261006-biqh68'],
 ['network-diagnostic','C:/Users/cina/AppData/Local/Temp/cinatoken-production-network-diag-20261006-native-Tidwqh'],
 ['functional-v4-draft','C:/Users/cina/AppData/Local/Temp/cinatoken-functional-browser-v4-20261006-FwrtMf'],
 ['functional-v4','C:/Users/cina/AppData/Local/Temp/cinatoken-functional-browser-v4-final-20261006-qfXa5E'],
 ['pg14-repair','C:/Users/cina/AppData/Local/Temp/cinatoken-pg73-reference-repair-ee01603721fe44e391a089409cd94959'],
 ['pg17-repair','C:/Users/cina/AppData/Local/Temp/cinatoken-pg73-usage-jobs-repair-921bf93575a54e5db7b0afca01508b06'],
 ['pg20-plan','C:/Users/cina/AppData/Local/Temp/cinatoken-pg73-runtime-grant-plan-f0bc0cabd77f47cd9ff14a137cf1d6ce'],
 ['workerd-diagnosis','C:/Users/cina/AppData/Local/Temp/cinatoken-workerd-cancel-diagnosis-393aa84d3e474d2184c6c0b189c803a9'],
 ['docker-local','C:/Users/cina/AppData/Local/Temp/cinatoken-docker-ssr-smoke-778d1e8ba7c14aef8bf42403bc03078c'],
 ['docker-linux-ci','C:/Users/cina/AppData/Local/Temp/cinatoken-docker-ssr-linux-ci-0be4c64d661e4b73a0d2573908eb7048']
];
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const readJSON=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const candidates=[];
function visit(label,root,dir){
 for(const d of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  const absolute=path.join(dir,d.name);assert.equal(d.isSymbolicLink(),false,absolute);
  const relative=path.relative(root,absolute);assert.ok(!relative.startsWith('..')&&!path.isAbsolute(relative));
  if(label==='root-progress'&&/^(?:seal-followup|followup-collector|verify-followup)/.test(d.name))continue;
  if(d.isDirectory()){assert.ok(!['node_modules','.git'].includes(d.name));visit(label,root,absolute);}
  else if(d.isFile())candidates.push({label,source:absolute,relative:relative.replaceAll('\\','/')});
  else assert.fail('Unsupported filesystem entry');
 }
}
for(const [label,root] of roots){assert.ok(fs.statSync(root).isDirectory());visit(label,root,root);}
assert.ok(candidates.length>200&&candidates.length<2000);
const rawBytes=candidates.reduce((n,c)=>n+fs.statSync(c.source).size,0);
assert.ok(rawBytes<150_000_000);
const scope=readJSON(temp+'/checklist-final-scope.json');assert.equal(scope.allOriginalLinesAndStatesExact,true);assert.equal(scope.mainTasks,102);assert.equal(scope.matrix,54);
const guard=readJSON(temp+'/after-functional-v4-guard.deployment-guard.json');assert.equal(guard.actualExit,0);
const ci=readJSON(roots.at(-1)[1]+'/final-ci-verification.json');assert.equal(ci.actualExitCode,0);assert.equal(ci.gitSHA,'5471899c8fd43daf9df1f15261d75171a6dbb8b8');assert.equal(ci.web.conclusion,'success');
const proxy=readJSON(temp+'/second-proxy-ci-final.stdout.log');assert.equal(proxy.status,'completed');assert.equal(proxy.conclusion,'failure');
const browser=readJSON(roots[4][1]+'/before-functional-v4-final-once-execution-closed.json');
const browserRaw=fs.readFileSync(roots[4][1]+'/before-functional-v4-final-once.json');assert.equal(sha(browserRaw),'bbeb36d178fb245f178ee2f8b47ed70f2db92b712c7dcb4ddea31d6a1980087a');
const runtime=readJSON(roots.at(-1)[1]+'/web-ssr-actual-runtime.proof.json');assert.equal(runtime.realHttpCases,87);assert.equal(runtime.realCatalogReads,64);assert.equal(runtime.allCleanupVerifiedAbsent,true);
for(const c of candidates){const b=fs.readFileSync(c.source);for(const name of ['CLOUDFLARE_API_TOKEN','GH_TOKEN','GITHUB_TOKEN']){const secret=process.env[name];if(secret&&secret.length>=12)assert.equal(b.includes(Buffer.from(secret)),false,'Credential must not be archived');}}
fs.mkdirSync(destination);
const index=[];
for(const c of candidates){
 const raw=fs.readFileSync(c.source);
 const compressed=!/\.png$/i.test(c.relative)&&(raw.length>200_000||/\.(?:log|raw)$/i.test(c.relative));
 const stored=compressed?zlib.gzipSync(raw,{level:9}):raw;
 const rel=c.label+'/'+c.relative+(compressed?'.gz':'');const out=path.join(destination,rel);
 fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,stored,{flag:'wx'});
 const actual=fs.readFileSync(out);assert.deepEqual(actual,stored);assert.deepEqual(compressed?zlib.gunzipSync(actual):actual,raw);
 index.push({sourcePath:c.source,storedPath:rel,encoding:compressed?'gzip-lossless':'identity',original:{bytes:raw.length,sha256:sha(raw)},stored:{bytes:actual.length,sha256:sha(actual)}});
}
const reference=(label,relative)=>{const e=index.find(e=>e.storedPath===label+'/'+relative||e.storedPath===label+'/'+relative+'.gz');assert.ok(e,label+'/'+relative);return {path:'2026-10-06-web-cutover-followup/'+e.storedPath,...e};};
const report={
 schema:'independent-web-cutover-followup-v1',recordedAt:new Date().toISOString(),timezone:'Asia/Singapore',
 status:'production-cutover-complete-anonymous-functional-and-isolated-docker-ssr-pass-full-migration-active',
 productionMutationsThisBatch:false,productionGitSHA:'c13a64b9c3b2c90adcf736910ea408868d7854f1',testGitSHA:ci.gitSHA,
 cloudflare:{url:'https://cinatoken.com',...guard,flags:{enabled:29,allTrue:true},adminProxyGitSHA:'34c742d161edbf2c16c7578221578d0b805d35c0',finalProof:reference('root-progress','after-functional-v4.live-proof.json'),finalGuard:reference('root-progress','after-functional-v4-guard.deployment-guard.json')},
 functionalBrowser:{passed:true,scope:'anonymous-functional-only',method:'DOMContentLoaded then shared bounded explicit page, React control and required-asset readiness',environment:{browserPlugin:'absent; regular cached Playwright used',playwright:'1.62.1',chromium:'147.0.7727.15',desktop:'1440x1000',mobile:'390x844'},uniquePages:45,http200:44,expected404:1,privatePagesExact401:37,originalInteractionsPassed:3,screenshotsActuallyInspected:7,unknownErrors:0,allGetRequestsFinished:1003,requiredJsCssSuccessful:870,readyCheckpoints:48,publicReactResponses:11,readyCheckpointsWithPendingLogo:37,finalPending:0,closedContexts:4,browserAndChildClosed:true,originalNetworkidleMatrixPassed:false,oldFailuresRetained:true,oldTimeoutCauseProven:false,formalP8_09Passed:false,realIdentityVerified:false,raw:reference('functional-v4','before-functional-v4-final-once.json'),closed:reference('functional-v4','before-functional-v4-final-once-execution-closed.json'),review:reference('functional-v4','final-functional-v4-review.json'),rootAstReview:reference('root-progress','root-v4-method-review.json'),peerAstReview:reference('functional-v4','peer-reviewed-v4.json')},
 networkDiagnostic:{passedRoutes:3,totalRoutes:3,originalNetworkidleBudgetSeconds:45,cdpFaviconCancellations:2,provesOriginalTimeoutCause:false,review:reference('network-diagnostic','three-route-network-review.json')},
 linuxCI:{web:ci.web,compose:ci.compose,artifact:ci.artifact??ci.artifacts,dockerSsrRuntime:runtime,rawReview:reference('docker-linux-ci','final-ci-verification.json'),fullDockerAdminProxyWebTlsVerified:false,proxyNative:{runId:proxy.databaseId,url:proxy.url,headSHA:proxy.headSha,status:proxy.status,conclusion:proxy.conclusion,jobs:proxy.jobs.map(j=>({id:j.databaseId,name:j.name,conclusion:j.conclusion,failedSteps:j.steps.filter(s=>s.conclusion==='failure'),skippedSteps:j.steps.filter(s=>s.conclusion==='skipped').length})),pg14And17Passed:true,pg20Failure:'historical fixture enumerates 81 while requiring exact PG73',v364Failure:'8 tests, 7 passed, cancellation expected observed but actual null',finalState:reference('root-progress','second-proxy-ci-final.stdout.log'),nativeLog:reference('root-progress','second-native-job-log.stdout.log'),dispatchLog:reference('root-progress','second-dispatch-job-log.stdout.log')}},
 implementationCommits:['abe8eb89e8cdbac005bc085d61acf5d2213a2f23','9ad3ccda60dddd11b3faaf610c45631b986e9cfb','5471899c8fd43daf9df1f15261d75171a6dbb8b8'],
 checklist:{path:'../../../developers/architecture/web-frontend-migration.md',...scope,evidence:reference('root-progress','checklist-final-scope.json'),goalCompleted:false,gatesG0ThroughG8Completed:false},
 remaining:['PG20 exact historical schema/role grant fixture','v364 actual transport cancellation','real CinaAuth and role/business writes','real nonempty catalog and complete chat','financial/chain/ledger and native three databases','upstream historical sources/licensing','formal performance budgets','complete Docker Web/Admin/Proxy same-origin TLS and streaming','actual rollout/rollback and legacy UI retirement'],
 immutableEvidence:{encoding:'gzip entries decompress to the exact original bytes; PNG and other identity entries unchanged',fileCount:index.length,originalBytes:rawBytes,storedBytes:index.reduce((n,e)=>n+e.stored.bytes,0),index}
};
const reportPath=destination+'.json';assert.equal(fs.existsSync(reportPath),false);fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({actualExit:0,reportPath,reportBytes:fs.statSync(reportPath).size,reportSHA256:sha(fs.readFileSync(reportPath)),fileCount:index.length,originalBytes:rawBytes,storedBytes:report.immutableEvidence.storedBytes,allRoundTripsExact:true,negativeEvidenceRetained:true}));
