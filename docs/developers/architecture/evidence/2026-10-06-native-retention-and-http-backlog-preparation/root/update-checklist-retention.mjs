import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const target='C:/cinagroup/cinatoken/docs/developers/architecture/web-frontend-migration.md';
const before=fs.readFileSync(target),text=before.toString('utf8'),nl=text.includes('\r\n')?'\r\n':'\n';
const sha=b=>createHash('sha256').update(b).digest('hex');
assert.equal(sha(before),'cddfaa752a4386863b87d4868e29dbec220571f03ba1d1528eec0caefea326b8');
const scope=t=>({tasks:t.match(/^- \[[ x]\] (?:P[0-8]-|SRC-).*$/gm),matrix:t.match(/^\| (?:PUB|AUTH|ACC|ADM)-[0-9]{2} \|.*$/gm),gates:t.match(/^验收门槛 G[0-8]：.*$/gm),phases:t.match(/^\| P[0-8] .*$/gm),acceptance:t.match(/^\| E0[0-8] \|.*$/gm),checkboxLines:t.match(/^.*\[[ x]\].*$/gm)});
const applied=JSON.parse(fs.readFileSync(path.join(here,'applied-source-pins.json')));assert.equal(applied.applied,true);assert.equal(applied.nativeExecuted,false);
const syntax=JSON.parse(fs.readFileSync(path.join(here,'retention-syntax.result.json')));assert.equal(syntax.actualExit,0);
const prep=JSON.parse(fs.readFileSync(path.join(here,'prepare-diagnostic-bundles.result.json')));assert.equal(prep.actualExit,0);
const current='当前推进：独立Web生产c13/2a0仍100%，06:52只读Route/version核验0。最新6e2原Linux报价24通过，但native90收据保留断言235:14为true/false失败；financial106为82success/1fail/23skip，55–113为35success/1fail/23skip。26目标20success/6skip、剩6及94/109/110–113跳过，三处migrator:sql修复尚未运行到；d537的全部目标通过仅属于历史SHA。Web/Compose/Release/Verify同6e2成功，dispatch strict仍8/7/1。收据七处时间输入保留微秒及有限8MiB积压/RST独立诊断已实现并静态复核、准备bundle通过，待下一SHA原CI及单次Linux诊断；根因未证、旧取消失败保留。完整G7/G8、原102/54/211及真实身份/权限写、资金链/SSE/回滚/旧UI退役继续。';
let next=text.replace(/^当前推进：.*$/m,current);
assert.notEqual(next,text);
next=next.replace(/^\| NEXT-18 \|.*$/m,'| NEXT-18 | P1、P8-01 | 继续原native剩余门槛与真实取消 | 6e2原Linux最早失败90/235收据时间比较true/false，106步82success/1fail/23skip，94/109/110–113未执行（5.85）；d537的26目标/剩6通过仅为历史。收据七处微秒保留及有限8MiB积压/RST独立诊断已实现并独立复核，下一SHA原CI/单次Linux待验。原strict8/7/1仍失败；两历史RST signal-abort真而cancelNULL。真实身份/ACL/资金/取消/G7/G8继续。 |');
assert.equal(next.includes('### 5.85 '),false);
const section=[
'### 5.85 原 Linux 收据时间门槛与有限发送积压诊断准备（2026-10-06）',
'',
'06:52:15–21 UTC 的 Cloudflare 只读核验实际0：主Route与资源Route均为独立 `cinatoken-web`，生产 `c13a64b9`、version `2a0a2777-d3b1-47f0-a0a7-88e701b4d2d9`、deployment `fd24618f-121e-4640-9edf-f15d243a6d75`、100%；API仍为Proxy。本批无生产部署。',
'',
'`6e2d65b35d4d60b3b14dac2ecbf9fbaa8ca363fa` 原Proxy run `37424911830` 实际failure；native job `112142276121` 最早失败第90步 `postgres-shared-key-buyer-receipt-retention-v346.native.test.mjs:235:14`，expected true、actual false，原TAP1/0/1及进程1。106财务步骤为82success/1failure/23skipped，55–113为35/1/23；26目标为20success/6skip，剩6全skip，94/109及110–113全skip。报价24和bootstrap7各原TAP1/1/0。上批d537的102success/1failure/3skip与26目标/剩6通过只属于其原SHA；本批尚未运行到110的三处客户端绑定修复。',
'',
'同6e2的Web `37424911790`、Compose `37424911789`、Release `37424911770`、Verify `37424911695` 全部success；dispatch job `112142275908` 第27步仍TAP8/7/1。原watch1的TLS传输超时1、watch2的实际Proxy失败1与各自完整raw保留；24真实关闭为22×0/2×1。完整native raw 537587B/SHA `339c0ac8f83d71356a22f9f6d90988dc88db358d3206aea2025c78eca8fb7334`、dispatch raw 5161564B/SHA `03104a72d0feba1bbf242015c16c4aeeca6cd4edab9132f290700e5cadf3149b` 严格串行下载，各下载0仅证明收集。',
'',
'收据fixture仅改六处显式时间参数为 `::text::timestamptz`，以及prune第一参数的文本入口；其他参数、36原assert、原10ms等待、SQL护栏、角色、锁、超时和清理保留。锁定postgres3.4.9的静态序列化机制支持保留数据库返回的微秒文本；本次原日志没有实际时间值/server OID，live根因仍未证。完整可逆byte/AST、独立复核与语法检查通过，下一SHA原Linux待验。',
'',
'新增诊断仅在原五结果之后增加 `queuedWriteComparison`，`baselineEligible=false`：同bare/RST在ready后触发有限8MiB（128×64KiB），暂停客户端读取，以owned Workerd PID/start time/process group/session、直接端口tuple、socket inode/FD及连续TCP发送积压记录压力，并记录采样结束/RST API调用时间。请求signal、合成清理hook、真实source cancel分别记录；signal不调用reader.cancel、不写cancel KV，只有真实source cancel注册原promise一次。原strict、四HTTP臂、显式reader校准、100×10ms轮询/四秒tail、日期/flags/版本和Python关闭authority保留；任何原失败或新增unknown保持整体失败。换行封包风险和采样年龄记录均已在新候选修复，旧候选和首准备失败原件保留。准备bundle实际0但未执行Workerd；待下一提交同SHA单次原手动Linux诊断。kernel积压不证明C++ pending-write分支或业务清理。',
'',
'直接证据：[collection](evidence/2026-10-06-native-retention-and-http-backlog-preparation/collection.json)。只保存本批新CI、候选、独立复核及Root必要原始记录，既有208/325/3357证据包不再复制。所有收集0不推导native/HTTP/G7/G8通过；原102主任务、54矩阵、G0–G8/E00–E08、211实际任务checkbox及其状态完整保留，真实身份/ACL写、资金/链、SSE取消、回滚和旧UI退役继续。',
'',
].join(nl);
const marker='## 6. 更新记录';assert.equal(next.split(marker).length,2);next=next.replace(marker,section+marker);
assert.deepEqual(scope(next),scope(text));
fs.writeFileSync(path.join(here,'checklist-before.md'),before,{flag:'wx'});
fs.writeFileSync(target,next);
console.log(JSON.stringify({updated:true,before:{bytes:before.length,sha256:sha(before)},after:{bytes:Buffer.byteLength(next),sha256:sha(Buffer.from(next))},scopeCounts:Object.fromEntries(Object.entries(scope(next)).map(([k,v])=>[k,v.length])),checkboxStatesChanged:false,nativeRuntimeExecuted:false}));
