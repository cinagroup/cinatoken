import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const temp='C:/Users/cina/AppData/Local/Temp/cinatoken-pg73-platform-followup-20261006-lAiHQC',file='C:/cinagroup/cinatoken/docs/developers/architecture/web-frontend-migration.md';
const before=fs.readFileSync(file);let text=before.toString('utf8').replace(/\r\n/g,'\n');
fs.writeFileSync(temp+'/checklist-before-source-batch.md',before,{flag:'wx'});
function line(prefix,value){const lines=text.split('\n');const ix=lines.map((s,i)=>s.startsWith(prefix)?i:-1).filter(i=>i>=0);assert.equal(ix.length,1,prefix);lines[ix[0]]=value;text=lines.join('\n');}
line('当前推进：','当前推进：独立Web切流保持100%/29true；2026-10-06T00:40:13–00:40:40Z只读复核c13a64b9/2a0a2777和三Route，Admin/Proxy仍34c742d1，5.74匿名functional45/45与历史networkidle失败均保留。本批5.75同b1ec8f33 Linux37394251894已实际验证PG20及quote/orphan/selected/snapshot四个修复通过，另economic-delivery/gap/store仍因后续中断而skipped；native第36步budget-admission 81!=73、v364严格取消8/7/1继续。正在补该单一历史fixture并加入独立手动Linux诊断；Docker内部目录origin、同值必填加密secret及29默认false入口开关配置已完成，32场景/22URL合同/4加密合同/格式通过，完整TLS/真实身份/认证写/SSE/回滚仍待实际拓扑。原102/54/G0–G8/E00–E08/211状态保持，继续原完整目标。');
line('| NEXT-18 |','| NEXT-18 | P1、P8-01 | 历史PG73与现行目录/授权兼容继续推进，完整native未过 | 原126文件/65迁移及PG75盘点保留历史；当前正式迁移81。同b1ec8f33 Linux37394251894已验证PG20真实通过（8桥接＋1准确成员拒绝、完整恢复）及quote/orphan/selected/snapshot四个修复通过；economic-delivery/gap/store仍skipped。第36步budget-admission-v350因81!=73失败，本批仅补其固定73语料和owned授权闭包，原assert保持、同SHA Linux待验；v364严格HTTP取消8/7/1仍失败，独立诊断保持原期望。其余原生fixture/角色/锁/ACL/三库不得由静态、stub或skip推定完成；生产grant/SQL不变，见5.75。 |');
text=text.replace('### 5.75 原生历史 fixture 与 Docker 完整拓扑推进（2026-10-06，实施中）','### 5.75 原生历史 fixture 与 Docker 完整拓扑推进（2026-10-06，PG20真实通过，完整验收继续）');
const marker='本批所有before/after、闭合命令与负面结果将与同SHA Linux证明封存；';assert.equal(text.split(marker).length,2);
const progress=`截至本批源提交前，b1ec8f33cf24edc07e8855c059c1498730a43113 的 [Proxy37394251894](https://github.com/cinagroup/cinatoken/actions/runs/37394251894) 已闭合failure。native112046320310在00:31:33Z完成PG20 pass1/fail0/skip0；quote/orphan/selected/snapshot四个修复亦实际pass1/fail0/skip0，config13及admin-playground15成功。economic-delivery/gap/store未执行，不写成七项都通过。第36步骤00:32:30Z的postgres-budget-admission-login-v350在原105行报81!=73，原pass0/fail1/skip0保留。本批单独把该历史语料改成既有listPg73Migrations，并在owned cluster/migrator范围定义授权闭包让原两次grant走既有临时0074桥接；保留原73/末项、成功与Buyer split拒绝断言，不修改生产grant或proposal。新源码本地证明及同SHA Linux结果随后补记。dispatch112046320270第27步骤仍为原严格v364 8测试7通过/1失败、cancel实际null，未取消原门槛。

Docker四文件配置现已完成并停止编辑：Admin默认内部http://gateway-proxy:8787，可显式覆盖自有HTTP(S)服务origin；Proxy/Admin要求同一个非空SHARED_KEY_ENCRYPTION_SECRET，应用仍检查至少32字符，env示例留空且既有加密值升级须保留。Web入口透传public/account/27admin共29开关默认false，公开SSR不注入未消费的私有变量。operator说明纠正密码登录410和CinaAuth统一Secure Cookie。32组实际YAML解析后的插值场景（并非Compose CLI）/22现有Origin-URL合同/4现有加密合同、完整Web格式/两YAML格式/范围diff均实际0。首个临时插值工具false类型错误及无写入的CRLF锚点失败保留；完整G7拓扑/真实TLS认证、流和回滚仍未实际执行。

独立手动Linux v364诊断保持原源码、锁定workerd1.20260828.1/Miniflare5.20260828.0-alpha/Wrangler4.127.1、原100次10ms轮询和observed断言。原严格两文件先执行并保留实际退出，然后区分Node destroy、TCP resetAndDestroy、fetch reader.cancel及仅观测包装；仅临时variant考察request_signal_passthrough，原frozen两配置不改，4s尾部观察不能升级通过。诊断无生产请求/真实身份/默认holder变更；手动workflow与原Proxy门槛独立，不以它替代原失败，实际执行结果随后补记。

生产2026-10-06T00:40:13.885–00:40:40.168Z两条只读复核实际0，再确认Web c13a64b9c3b2c90adcf736910ea408868d7854f1/version2a0a2777-d3b1-47f0-a0a7-88e701b4d2d9/deploymentfd24618f-121e-4640-9edf-f15d243a6d75/100%与29true，主站/web-assets属Web、API属Proxy、三fail-open false，Workers.dev/Preview false。Admin/Proxy版本保持34c742d1。这一批测试/诊断/Compose和文档变更不等于新生产发布，5.74功能验收不继承到未部署的新源码。

`;
text=text.replace(marker,progress+marker);
text+='\n2026-10-06：5.75同b1ec Linux验证PG20及四项修复通过，另三项仍skipped；第36步budget-admission与v364严格取消继续。Docker四文件配置本地检查完成，新增独立手动诊断待同SHA实际执行；生产08:40新复核仍c13/2a、100%/29true。原102/54/G/E/211状态保持。\n';
fs.writeFileSync(file,text);
const after=fs.readFileSync(file),hash=b=>crypto.createHash('sha256').update(b).digest('hex');fs.writeFileSync(temp+'/checklist-source-batch-edit.json',JSON.stringify({actualExit:0,before:{bytes:before.length,sha256:hash(before)},after:{bytes:after.length,sha256:hash(after)},nativeRun:'37394251894',productionChanged:false,fullGoalScopeHeld:true},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({actualExit:0,section:'5.75',sourceBatchStillUnderValidation:true}));
