import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const repo = 'C:/cinagroup/cinatoken';
const [peerRoot, peerFinalName, peerFinalSha] = process.argv.slice(2);
assert(peerRoot && peerFinalName && /^[a-f0-9]{64}$/.test(peerFinalSha));
const digest = b => createHash('sha256').update(b).digest('hex');
const describe = p => { const b=fs.readFileSync(p); return {bytes:b.length,sha256:digest(b)}; };
const ownerRoot='C:/Users/cina/AppData/Local/Temp/cinatoken-quote-version-three-casts-879c829257b645e4ada53e37362201bd';
const diagnosisRoot='C:/Users/cina/AppData/Local/Temp/cinatoken-quote-version-next-readonly-gn9DdD';
const ownerFinalName='FINAL-quote-version-three-casts-preparation.json';
assert.equal(describe(path.join(ownerRoot,ownerFinalName)).sha256,'40ef17ddcd4a5e51f64151d6830e89a31335addad35ec87242027209805bf2aa');
assert.equal(describe(path.join(ownerRoot,'PREPARATION-SEAL.json')).sha256,'81c4b0b8d00c147bdd5c27b374529764d2359a0c3fd441bfac951c35c3a23e50');
assert.equal(describe(path.join(diagnosisRoot,'FINAL-quote-version-499-readonly-diagnosis.json')).sha256,'92f7916e867d6e8c807b0c5dc50ca04321fb5d1c9d0248be477e735fd1706975');
assert.equal(describe(path.join(diagnosisRoot,'STOPWRITE-root-file-index.json')).sha256,'c08d63e94cbda73978ce601dc4576489386173187ff05b916b052007f437b87c');
assert.equal(describe(path.join(peerRoot,peerFinalName)).sha256,peerFinalSha);
const target='scripts/db/cutover/postgres-shared-key-quote-versions.native.test.mjs';
assert.deepEqual(describe(path.join(repo,target)),{bytes:34873,sha256:'c72cc41a679c64a1fb7edd733fe450e3cea8a9bdc9408b8cb152fb0a9135187f'});
const mdPath=path.join(repo,'docs/developers/architecture/web-frontend-migration.md');
const before=fs.readFileSync(path.join(root,'checklist-before.md'),'utf8');
assert.equal(digest(Buffer.from(before)), '68a9123e943507a4e7d136a9e744937e50dabebceaae822ff12bfdd9e7b7d4a4');
assert.equal(fs.readFileSync(mdPath,'utf8'),before);
const scopeExpressions=[/^- \[[ x]\] (?:P[0-8]-|SRC-).*$/gm,/^\| (?:PUB|AUTH|ACC|ADM)-[0-9]{2} \|.*$/gm,/^验收门槛 G[0-8]：.*$/gm,/^\| P[0-8] .*$/gm,/^\| E0[0-8] \|.*$/gm,/^.*\[[ x]\].*$/gm];
const scope = s => scopeExpressions.map(re => s.match(re)??[]);
const relative='docs/developers/architecture/evidence/2026-10-06-quote-version-text-parameters-preparation';
const out=path.join(repo,relative);
assert(!fs.existsSync(out));
const walk=d => fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>{const p=path.join(d,e.name);assert(!e.isSymbolicLink());return e.isDirectory()?walk(p):e.isFile()?[p]:(assert.fail('Non-regular '+p),[]);}).sort();
const plan=[];
for(const [label,dir] of [['diagnosis',diagnosisRoot],['owner',ownerRoot],['peer',peerRoot]]){
  for(const p of walk(dir))plan.push({label,source:p,storedRelative:label+'/'+path.relative(dir,p).replaceAll('\\','/'),...describe(p)});
}
for(const name of ['run-closed.mjs','guard-live-cutover.mjs','prepare-iteration.mjs','initial-head.result.json','initial-head.stdout.log','initial-head.stderr.log','initial-remote.result.json','initial-remote.stdout.log','initial-remote.stderr.log','initial-ci-list.result.json','initial-ci-list.stdout.log','initial-ci-list.stderr.log','production-web-readonly.result.json','production-web-readonly.stdout.log','production-web-readonly.stderr.log','production-web-readonly.deployment-guard.json']){
  const p=path.join(root,name);plan.push({label:'root',source:p,storedRelative:'root/'+name,...describe(p)});
}
for(const e of plan){const p=path.join(out,e.storedRelative);fs.mkdirSync(path.dirname(p),{recursive:true});fs.copyFileSync(e.source,p);assert.deepEqual(describe(p),{bytes:e.bytes,sha256:e.sha256});assert.deepEqual(describe(e.source),{bytes:e.bytes,sha256:e.sha256});}
const newCurrent='当前推进：独立Web生产c13/2a0仍100%，05:50只读Route/version核验0。4a9证据提交的Release/Verify成功；本批仅修原native24三个query的四个时间参数，先按text传入再由PostgreSQL转timestamptz，原65assert/b2/锁时序与生产SQL保持。准备及独立静态复核完成，真实新SHA Linux尚待；ee122原24失败/26全跳过和dcc6历史39成功/20目标分别保留。dc7显式reader.cancel通过，四HTTP断开NULL/1与原strict8/7/1保持。完整G7/G8、原102/54/211及真实身份/权限写、资金链/SSE/实际回滚继续待验。';
const next='| NEXT-18 | P1、P8-01 | 继续原native剩余门槛与真实取消 | 原native24三query/四参数显式text→timestamptz准备完成（5.83），65assert/原b2/锁/时序保持，原Linux新SHA及94/109待验。ee122失败/26跳过、dcc6 39成功/20目标保持原SHA历史；dc7显式Worker取消通过，四HTTP断开NULL、strict8/7/1保持。真实身份/ACL/资金/取消/G7/G8继续。 |';
const section='### 5.83 报价时间参数的微秒保留与原 Linux 待验（2026-10-06）\n\n本批从4a9b4fb984035bb62ec5930cce01f8da605f476f开始，仅修改postgres-shared-key-quote-versions.native.test.mjs:470/473/497三个query、四个参数cast。源34823 B/16ef4b701728c9de46ea932851354d7cee2aa9d80c6ab543ceae6f4526380c83变为34873 B/c72cc41a679c64a1fb7edd733fe450e3cea8a9bdc9408b8cb152fb0a9135187f：$1/$2::timestamptz及两个resolver $1现先显式::text，再由PG ::timestamptz解析。原PG clock_timestamp()/effective_at微秒文本保持，不改变原quote-a-b2期望、100 ms等待、锁、查询顺序或生产proposal/loader/grant/import。64条assert原文直接相同；嵌套比较SQL的那1条只变两cast，反向还原四cast后全部65条assert及完整源码/AST精确相同。语法、目标diffcheck和独立静态审查通过。锁定postgres3.4.9的一次真实serializer离线控制显示1184转换为毫秒ISO字符串、25保留原文本；控制没有创建PG client，不证明原失败实际参数OID或根因。\n\n[本批证据索引](evidence/2026-10-06-quote-version-text-parameters-preparation/README.md)保留原只读诊断、单文件准备、独立审查及所有raw/读取失败；owner的成功文件读取和ENOENT/null不是成功child。原ee122 step24实际1与26全skip保持，旧dcc6的39成功/20目标只证明旧来源；94/109历史Git字节快照亦须原Linux实际执行，不以静态检查代替。新SHA Linux尚待，fullG7/fullG8/rootCauseConfirmed/gatePassDerived仍false；本批未改生产代码或重复部署。05:50:33.112–05:50:39.128Z Cloudflare只读child0再次确认主站及web-assets Routes为cinatoken-web、API为cinatoken-proxy、version2a0a2777-d3b1-47f0-a0a7-88e701b4d2d9/deploymentfd24618f-121e-4640-9edf-f15d243a6d75/sourcec13a64b9c3b2c90adcf736910ea408868d7854f1/100%，Workers.dev/Preview双false。4a9 Release37419719940与Verify37419719945终态success，不能推广为native/取消门槛成功。完整102主任务/54矩阵/G0–G8/E00–E08/211实际checkbox状态与真实身份/授权写/ACL/资金链/SSE/WebSocket/回滚及旧UI退役门槛保持。\n\n';
let after=before.replace(/^当前推进：.*$/m,newCurrent).replace(/^\| NEXT-18 \|.*$/m,next);
assert.equal(after.includes('### 5.83'),false);assert.equal(after.split('## 6. 更新记录').length,2);
after=after.replace('## 6. 更新记录',section+'## 6. 更新记录');
after+='\n2026-10-06：5.83完成原native24时间参数的三query/四cast最小准备与独立静态审查，保留原65assert/b2及全部历史失败；生产独立Web仍100%，新SHA原Linux和94/109待验。原102/54/G/E/211状态不变。\n';
assert.deepEqual(scope(after),scope(before));
assert.equal((after.match(/\[[ x]\]/g)??[]).length,214);
fs.writeFileSync(mdPath,after);
const report={schema:'cinatoken-quote-text-parameters-preparation.collection.v1',at:new Date().toISOString(),baseCommit:'4a9b4fb984035bb62ec5930cce01f8da605f476f',collectionOnly:true,gatePassDerived:false,rootCauseConfirmed:false,fullG7:false,fullG8:false,target:{path:target,...describe(path.join(repo,target))},originalScopeExact:true,scopeCounts:scope(after).map(x=>x.length),literalCheckboxCount:214,checklist:{before:describe(path.join(root,'checklist-before.md')),after:describe(mdPath)},entries:plan};
fs.writeFileSync(path.join(out,'collection.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
fs.writeFileSync(path.join(out,'README.md'),'# 报价时间参数准备证据\n\n[集合与来源](collection.json)、[原只读诊断](diagnosis/FINAL-quote-version-499-readonly-diagnosis.json)、[准备报告](owner/'+ownerFinalName+')、[独立复核](peer/'+peerFinalName+')、[生产只读复核](root/production-web-readonly.deployment-guard.json)。\n\n只保留本次直接证据，不复制旧完整归档。所有源/存储字节逐项校验，raw、前置读取失败、文件读取0/null按原记录保留。文件读取不是child退出；收集通过不代表原生测试或业务门槛通过。旧ee122失败与原strict8/7/1仍保持。\n',{flag:'wx'});
fs.writeFileSync(path.join(root,'preparation-collection-summary.json'),JSON.stringify({out,fileCount:plan.length+2,storedBytes:plan.reduce((n,e)=>n+e.bytes,0),report:describe(path.join(out,'collection.json')),checklist:describe(mdPath),originalScopeExact:true},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({out,fileCount:plan.length+2,storedBytes:plan.reduce((n,e)=>n+e.bytes,0),report:describe(path.join(out,'collection.json')),checklist:describe(mdPath),originalScopeExact:true}));
