import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url)),repo='C:/cinagroup/cinatoken',md=repo+'/docs/developers/architecture/web-frontend-migration.md';
const sha=b=>createHash('sha256').update(b).digest('hex');
const pin=(file,digest)=>{const b=fs.readFileSync(file);assert.equal(sha(b),digest);return JSON.parse(b);};
const owner=pin('C:/Users/cina/AppData/Local/Temp/cinatoken-native-frozen94-109-prepare-1a3b08f2b97c427989de588e9e4cd450/FINAL-native-frozen94-109-preparation.json','2e69e48b61f362d53bdbb044d366f12a141d267cc6a5efb154864bc8d3de8bf6');
pin('C:/Users/cina/AppData/Local/Temp/cinatoken-native-frozen94-109-independent-peer-a824c8ed062348199c5027f7df556278/FINAL-native-frozen94-109-independent-peer.json','66c64ef9b12d1909656fc4a512aef140c70413f17385ad3df81f9a9546498396');
pin('C:/Users/cina/AppData/Local/Temp/cinatoken-canonical-calibration-terminal-independent-peer-7c64bf0f365242ed9e43c275ac46721a/FINAL-canonical-calibration-terminal-independent-peer.json','39af8a9ec875036dc89cdd9d12789265ae973ff84956b81abd4c33bc51204553');
assert.equal(owner.baseCommit,'dc7be6f8597333151c450bae3ae15e6585e3b2eb');
for(const f of owner.finalFiles){const b=fs.readFileSync(path.join(repo,f.path));assert.equal(b.length,f.bytes);assert.equal(sha(b),f.sha256);}
const before=fs.readFileSync(md,'utf8'),baseline=fs.readFileSync('C:/Users/cina/AppData/Local/Temp/cinatoken-g7-native53-20261006-b5c5ae279d804d44b08535e386e82504/checklist-before.md','utf8');
assert.equal(sha(Buffer.from(before)),'8b4568b815f635a75a078fce131d1c22e211efea159b1d01629a0da0f0b9b20c');
let after=before.replace(/^当前推进：.*$/m,'当前推进：生产独立Web c13/2a0继续100%，04:38只读Route/version核验0。dc7单次Linux校准已实际进入Worker reader.cancel并通过，但四个HTTP socket断开比较仍cancel/release=null、原strict8/7/1，整体诊断实际1。dcc6原native55–93共39成功、本批20/26成功；94既有历史来源pin失败、95–113跳过。两successor改读原Git字节的历史TXT快照，原603646/d950 pin、148assert/4grant/149SQL模板/173事务与330保护输入保持，四文件静态独立复核0；新SHA原Linux待验（5.81）。473 G7 stage0成功，完整G7/G8仍false；原102/54/211及真实身份、认证写、资金链/SSE/回滚门槛保持。');
after=after.replace(/^\| NEXT-18 \|.*$/m,'| NEXT-18 | P1、P8-01 | 继续原native剩余门槛与真实取消 | dcc6原55–93共39成功、本批20/26通过；94历史来源pin严格失败，95–113未执行。原Git快照四文件修复已独立静态复核，新SHA原Linux待验。dc7真实Worker显式reader.cancel通过；四HTTP断开仍NULL且原strict8/7/1，整体诊断1。G7 TLS/PG目录stage0成功，完整身份/ACL/资金/取消/G7/G8待验（5.81）。 |');
assert.equal((after.match(/^## 6\. 更新记录$/gm)??[]).length,1);assert.ok(!after.includes('### 5.81 '));
const addition=[
'### 5.81 显式取消校准终态与历史来源快照修复（2026-10-06）',
'',
'canonical地址修复已提交推送dc7be6f8597333151c450bae3ae15e6585e3b2eb。该SHA单次[Linux诊断37414167261](https://github.com/cinagroup/cinatoken/actions/runs/37414167261)、job112108990309于04:33:21.977–47.987Z实际Node1、executor actualProcessExit1；原strict8tests/7pass/1fail与四bare/binding destroy/RST原100×10ms取消窗口、4s尾观测均不改。真实Worker显式reader校准nativeWorkerExecuted=true、result0、closed=true：首帧holder-ready，pendingBefore=false、pendingAfter.done=true、cancel=observed、release=null、accepted=one，cancelPut、readerCancel和原waitUntil各invoke/fulfilled1，waitUntil rejected0。该校准没有新增生命周期任务；不证明HTTP断开取消或原异步pull全部结束。四HTTP比较仍cancel/release=null、各result1，整体STRICT_FAILURE_PRESERVED。1643事件JSON/NDJSON相等；4个esbuild僵尸分别按pid/start/waitStatus0回收，完整最终census为空，外层未强制TERM/KILL；mf.dispose可能内部SIGKILL，不证明Workerd graceful，也未证明取消根因。原dcc6校准404→500/1与所有旧失败保留。',
'',
'独立终态FINAL123617B/39af8a9e…204553与seal84906B/96d83976…89eb1封存；31个封存前真实关闭30×0/1×1，第一次读取器误匹配ctx.waitUntil注释而失败1保留，v2使用实际AST调用后读取0，仅证明读取。16个artifact和18个显式Root输入精确核验，原终态日志37179B/eb6d736f…172b4b；artifact11390876053的GitHub报告ZIP93166B/0209575a…217af只记远端报告，不称本地ZIP验证。该SHARelease37414088588、版本校验37414088586成功；仅更新既有draft PR4，未合并、tag或发版。',
'',
'dcc6原native94历史hash失败出处已只读追溯：原94c12c1e37e7346330486cf9a3a3246af00d95c5的blob64b2c914251d74191f73bb25f723dd6010fbc366为50164B/603646803c82d3209987260ad682a34169b4e53ca7b03b672d818e3a28d7cc13；原109历史63e305a1bdf14c55fede74fb7ff9cbd9f732fc19的blobdc042910c59037ddd850e361a38d8da745efae73为37114B/d95055419a04465c7c172ff0b8426bd0b928bd538e4dad80f9442229abd5e269。此前PG73适配改变了两个可执行legacy的字节，successor仍要求原历史pin；94是真实CI失败1，109因94跳过，只观察到静态同因，未声称109实际失败。',
'',
'本批仅新增scripts/db/cutover/fixtures/historical-native/内两个非执行.native.test.mjs.txt原Git字节快照，并把两个successor的历史read URL及lineage来源指向快照；原pin、历史冻结注释、当前PG73可执行legacy均保持。完整反向还原两个dc7 wrapper字节与AST一致，148assert/4grant/149SQL模板/173SQL事务以及330保护输入精确保留，两个syntax与限定diff-check0。作者FINAL98970B/2e69e48b…e8bf6、独立FINAL221028B/66c64ef9…98396及seal20371B/feca51dd…d5948均封存，独立静态复核0，支持提交；未运行新native/PG应用。作者55记录为39真实子进程（37×0、2×1）加16文件读取（6成功、10ENOENT）；10个null没有child，不能称进程退出0或spawn失败。两准备工具失败1及独立首读取器失败1原件保留。提交后的原Linux94/109与尚未执行的六目标结果另记；不提前改勾选。',
'',
'04:38:18.500–24.360Z只读Cloudflare核验实际0：cinatoken.com/*与cinatoken.com/web-assets/*仍cinatoken-web，api.cinatoken.com/*仍cinatoken-proxy；version2a0a2777-d3b1-47f0-a0a7-88e701b4d2d9、deploymentfd24618f-121e-4640-9edf-f15d243a6d75、sourcec13a64b9c3b2c90adcf736910ea408868d7854f1、100%，Workers.dev/Preview关闭。本批只改测试历史来源和进度，未重新部署生产。完整证据归档继续：旧Root981文件冻结，首次整包读取实际1的154来源绑定阻断保留；文件读取、派生日志切片和远端下载副本按各自来源校验，不能增加业务进程成功。完整G7/G8、真实身份/权限写、资金链/SSE和实际回滚仍待验。',
'',
].join('\n');
after=after.replace('## 6. 更新记录',addition+'\n## 6. 更新记录');
after+='\n2026-10-06：5.81补dc7真实Worker显式取消0、四HTTP断开NULL/1及整体严格失败；历史94/109原Git字节TXT快照四文件独立静态复核通过，原pin和门槛保留，新SHA Linux待验；独立Web生产继续100%。\n';
for(const re of [/^- \[[ x]\] (?:P[0-8]-|SRC-).*$/gm,/^\| (?:PUB|AUTH|ACC|ADM)-[0-9]{2} \|.*$/gm,/^验收门槛 G[0-8]：.*$/gm,/^\| P[0-8] .*$/gm,/^\| E0[0-8] \|.*$/gm,/^.*\[[ x]\].*$/gm])assert.deepEqual(after.match(re)??[],baseline.match(re)??[]);
fs.writeFileSync(path.join(dir,'checklist-before-historical-four.md'),before,{flag:'wx'});
fs.writeFileSync(md,after);
const proof={at:new Date().toISOString(),verificationOutcome:0,bytes:Buffer.byteLength(after),sha256:sha(Buffer.from(after)),originalScopeAndStatesExact:true,mainTaskCount:102,matrixRows:54,actualTaskCheckboxes:211,newNativeRuntimeExecuted:false,calibrationExplicitWorkerPassed:true,httpDisconnectPass:false,fullG7Verified:false,fullG8Verified:false,files:owner.finalFiles};
fs.writeFileSync(path.join(dir,'historical-four-checklist-proof.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(proof));

