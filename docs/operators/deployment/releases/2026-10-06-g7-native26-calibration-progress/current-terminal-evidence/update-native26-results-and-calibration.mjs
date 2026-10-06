import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const md='C:/cinagroup/cinatoken/docs/developers/architecture/web-frontend-migration.md';
const sha=b=>createHash('sha256').update(b).digest('hex');
const readPin=(file,pin)=>{const b=fs.readFileSync(file);assert.equal(sha(b),pin);return JSON.parse(b);};
const native=readPin('C:/Users/cina/AppData/Local/Temp/cinatoken-native26-ci-terminal-independent-peer-cc2708922c0e4f64a9cca948194a20d9/FINAL-native26-ci-independent-peer.json','6635f04f77f6f6325a794756883a8bf697f752af239e33deb2b8c3b226a57e66');
const fix=readPin('C:/Users/cina/AppData/Local/Temp/cinatoken-v364-direct-actual-review-DjepMs/FINAL-v364-direct-address-repair.json','7e2af168f4caa7c7568c9c8ffc5003281e36f39b53620bc2b422ec050ac2229f');
assert.equal(native.verdict.businessFullProxyPass,false);assert.equal(native.verdict.nextActualNativeFailure.step,94);
assert.equal(fix.actualReadAndPreparationOutcome,0);assert.equal(fix.actualFailedRuntime.actualProcessExit,1);assert.equal(fix.cohorts.futureRepairExecutionSHA,null);
const before=fs.readFileSync(md,'utf8'),base=fs.readFileSync(path.join(dir,'checklist-before.md'),'utf8');
assert.equal(sha(Buffer.from(before)),'6a734dcd78d0453a45962606c818d077d7c2da0f7f30b256a503d2ba0dceb993');
let after=before.replace(/^当前推进：.*$/m,'当前推进：dcc6ab52原Linux已越过5.78的next60：本批26项中20项原TAP1pass/0fail/0skip，6项未执行；原55–93共39成功，next94 successor187:14因既有历史fixture旧hash pin失败，95–113共19跳过，原strict仍8/7/1，整体Proxy未通过。Web两job、Compose、Release和版本校验success。G7同473 stage0实际TLS/PG目录/seed/两个观察/64SSR+270资源与全清理0，完整G7/G8仍false。5.80保留dcc6 direct实际1及四臂cancelNULL；校准误用私有URL导致404→500，正在提交两文件canonical地址修复并做独立Linux验证。生产c13/2a0继续100%，CF04:08只读核验0；原102/54/211及身份、认证写、资金链/SSE/回滚门槛保持。');
after=after.replace(/^\| NEXT-18 \|.*$/m,'| NEXT-18 | P1、P8-01 | 继续原native剩余门槛与真实取消 | dcc6本批26中20原TAP通过、6未执行；原55–93共39成功，next94既有historicalFixture旧pin严格失败，95–113未执行；原strict8/7/1保持。只读追溯旧pin来源，再决定最小修复。direct四臂取消仍NULL，显式reader校准的canonical URL两文件修复完成本地准备，实际新Linux待续；G7 TLS/PG目录stage0成功，完整身份/ACL/资金/取消/G7/G8待验。 |');
assert.equal((after.match(/^## 6\. 更新记录$/gm)??[]).length,1);assert.ok(!after.includes('### 5.80 '));
const addition=`
### 5.80 原 26 项 Linux 终态及校准地址修复（2026-10-06）

34个文件已提交推送为dcc6ab52f21a18c5d1c02d8a4a4a390f039e61fc，工作区随后clean；26项独立peer actual0，FINAL266848B/f6e8a822…1d93e4，原2233assert/35grant/302保护不改。原[Proxy run37412060008](https://github.com/cinagroup/cinatoken/actions/runs/37412060008)终态failure，native112102451588原55–93共39success，各原TAP tests1/pass1/fail0/cancelled0/skip0/todo0；本批26中20成功（60、61、66、69、71–78、80–86、88），95–99及106六项因原94失败未执行。next94脚本postgres-shared-key-guardrail-post-reservation-denial-v348-runtime-buyer-client-successor.native.test.mjs:187:14严格历史fixture哈希失败，实际dfe004034784018eb9c70502e19a2192c45e1e8982a96c98b03626f72f7cce1d、固定expected603646803c82d3209987260ad682a34169b4e53ca7b03b672d818e3a28d7cc13；原TAP1/0/1/0skip与Node1保留，后续95–113共19skipped。被读legacy fixture在473及dcc6的Git blob同359689d1534cbbee9ea7f7211909d02fe5b33b1f、50146B/dfe004…，本批未更改该历史源；旧pin出处正在只读追溯，不为通过盲改期望。dispatch112102451353原step27保持8tests/7pass/1fail，config与Admin成功；原native原日志556674B/c78e1159…bb8d28。独立终态FINAL413706B/6635f04f…57e66完整核39成功/1失败/19跳过和20/6目标，97采集关闭93个0/4个1及另一个shell读取1均保留；audit/diagnosis/seal0仅证据和读取关闭，不代表业务通过。

同dcc6的Web37412059892两个job、Compose37412059911、Release37412059806与版本校验37412059854全部success，原日志保留；只更新既有draft PR，不合并、tag或发布。CF只读核验2026-10-06T04:08:00–06Z实际0：cinatoken.com/*与/web-assets/*均cinatoken-web，api.cinatoken.com/*保持cinatoken-proxy，version2a0a2777-d3b1-47f0-a0a7-88e701b4d2d9/deploymentfd24618f-121e-4640-9edf-f15d243a6d75/sourcec13a64b9c3b2c90adcf736910ea408868d7854f1/100%，workers.dev及preview关闭。本轮测试/诊断没有生产部署；主站切流事实与后续完整业务验收分别保留。

同dcc6的[direct-socket run37412108171](https://github.com/cinagroup/cinatoken/actions/runs/37412108171)于04:07:12.168–37.555Z实际Node1、executor actualProcessExit1/runnerOutcomeCode1/actualExit1，无timeout/interruption/fatal；原严格8=7pass/1fail。四bare/binding destroy/RST各绕core ENTRY_WORKER且原100×10ms窗口cancel=null，额外4s尾及dispose前cancel/release均null、accepted=one，四结果1不升级。校准worker外500的原workerd日志内层404!=200：诊断误送localhost/fixture/complete-text，被原私有holder的canonical origin/path拒绝，尚未进入reader.cancel；nativeWorkerExecuted=false精确保留。1627事件JSON/NDJSON逐项相等；artifact11389298418含16普通文件（另独立terminal log1，共17核对输入），remote ZIP digest606533d4…30f647仅GitHub报告，不冒认本机ZIP验证。4个esbuild僵尸原waitStatus0被分别reap，外层没有TERM/KILL、groupGone=true、最后完整census空；mf.dispose可能内部SIGKILL，gracefulWorkerdExitProven=false、causeProven=false，不能以外层无强杀冒认Workerd graceful。

仅修scripts/diagnostics/v364-direct-socket/native-reader-calibration.mjs请求为原gateway的https://holder.service.invalid/complete-text-attempt，原Request继承method/headers/body/signal、所有原assert/reader pending/cancel与ctx不变，四比较臂和生产源不改；sealed-package只对应helper bytes/hash及preparedAtHead702→dcc6，source-inputs原702来源仍保持。新helper2546B/e838769c…b8ee8f、manifest1045B/0a02c1af…3a7e7。10纯原guard AST/Node Request构造控制、syntax/prepare-only/formatter/diff-check实际0，未复跑应用/MF/Workerd；作者FINAL51934B/7e2af168…2229f封存，两个准备读取/格式失败1及旧实际业务1全部保留。提交前独立复核和新SHA单次Linux校准待续，原native94旧pin验证独立推进；不提前完成G7/G8或删除原来源和失败。

`;
after=after.replace('## 6. 更新记录',addition+'## 6. 更新记录');
after+='\n2026-10-06：5.80保留dcc6原native20/26成功、next94旧pin失败与原strict7/1，Web/Compose/Release通过；direct真实四NULL和校准404→500失败不洗绿，仅修canonical私有地址并继续实际Linux。CF仍独立Web100%，原完整范围及全部剩余门槛保留。\n';
for(const re of [/^- \[[ x]\] (?:P[0-8]-|SRC-).*$/gm,/^\| (?:PUB|AUTH|ACC|ADM)-[0-9]{2} \|.*$/gm,/^验收门槛 G[0-8]：.*$/gm,/^\| P[0-8] .*$/gm,/^\| E0[0-8] \|.*$/gm,/^.*\[[ x]\].*$/gm])assert.deepEqual(after.match(re)??[],base.match(re)??[]);
fs.writeFileSync(path.join(dir,'checklist-before-native26-results.md'),before,{flag:'wx'});
fs.writeFileSync(md,after);const proof={at:new Date().toISOString(),actualExit:0,bytes:Buffer.byteLength(after),sha256:sha(Buffer.from(after)),originalScopeAndStateLinesExact:true,fullG7Verified:false,fullG8Verified:false,actualNativeTargetsPassed:20,actualNativeTargetsNotExecuted:6,actualNativeNextFailure:94,calibrationRuntimePending:true};
fs.writeFileSync(path.join(dir,'native26-results-and-calibration-checklist-proof.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(proof));

