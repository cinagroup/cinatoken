import fs from 'node:fs';import assert from 'node:assert/strict';import crypto from 'node:crypto';
const t="C:/Users/cina/AppData/Local/Temp/cinatoken-native-g7-boundary-next-20261006-Zm6Z3E",p='C:/cinagroup/cinatoken/docs/developers/architecture/web-frontend-migration.md';
const before=fs.readFileSync(p);let text=before.toString();const baseline=fs.readFileSync(t+'/checklist-before.md','utf8');
assert.equal(crypto.createHash('sha256').update(before).digest('hex'),'7eec7bbefeef52ca19a5113526c8c441af681c426afc5659292bec83406ec404');
function line(prefix,value){const lines=text.split('\n');const found=lines.map((s,i)=>s.startsWith(prefix)?i:-1).filter(i=>i>=0);assert.equal(found.length,1);lines[found[0]]=value;text=lines.join('\n');}
line('当前推进：','当前推进：5.76继续原完整目标。已完成下一8个PG73 native fixture候选，409原assert、12原grant及171生产/helper/SQL字节保持；本地8syntax/原helper6控制流与独立peer通过，v356新增owned peer/session准备锁、释放后确认原proposal事务锁仍持有，原60×25ms等待保留。原生PG/MVCC/清理仍待实际Linux；上轮4d native37/v3648/7/1失败不洗。已修复Changesets fixed遗漏Web，实际CLI发布计划由5包变6包同2.9，当前所有manifest仍2.8、未发布。新的独立TLS组合及锁定runtime取消boundary包准备真实ownedLinux执行，不把合成身份、prepare、stub或skip当完整G1/G7/G8。上轮生产已核c13/2a0、100%/29true；本批未部署，原102/54/G0–G8/E00–E08/211要求完整保留。');
line('| NEXT-18 |','| NEXT-18 | P1、P8-01 | 下一8个历史PG73 fixture已实施并通过本地/独立源码审查，实际native待验 | 原126文件/65历史迁移及PG75盘点保留；当前正式链81。上轮b1ec/4d实际PG20、quote/orphan/selected/snapshot及v350通过，其余三共享fixture仍skipped；4d native37 v354:88的81!=73保留。5.76已为v354/v351/v356/v357/v359/v360/v361/v362接固定73语料及owned临时0074 helper，409原assert/12grant不改；v356用独立peer及session准备锁，原body获取xact锁后解session、只读确认原锁再跑原wait，不能由新增锁替代。8syntax/6惯性helper/peer通过不证明真实MVCC或全native；生产grant/helper/SQL保持。原v364失败及新boundary与三库/锁/ACL继续验收。 |');
const section='### 5.76';
assert.ok(!text.includes(section));
const record=`
### 5.76 下一批PG73真实验收与独立双平台推进（2026-10-06，候选已审，Linux执行待办）

本批从已提交并推送的6658ec978009afa5fe3f4beccf6bde358590b663继续；上一轮是实际进展：原生夹具修复、同源CI与生产切流后核及739份完整raw归档已完成，见5.75。当前目标仍是原102主任务、54矩阵、G0–G8/E00–E08与211任务checkbox，不缩成切流或匿名冒烟。

本批仅修复8个历史native测试的语料/授权夹具边界：ordinary-budget-recovery-v354、guardrail-budget-admission-login-v351、authenticated-request-capability-login-v356、authenticated-text-route-ceiling-v357、authenticated-text-route-source-fence-v359、authenticated-complete-text-quote-v360、complete-text-quote-budget-admission-v361、complete-text-attempt-grant-v362。它们继续使用原严格PG73数量/摘要和原proposal；生产grant、共享helper和SQL不变，不能把73改为81。Producer和独立peer核对409个原assert的AST及源、12次原grant调用、原timeout/skip及171个生产/helper/SQL文件均与Git基线精确相同。8syntax、固定语料73/corpus/MD5、既有6个惰性helper控制流与diff检查实际退出0；Windows没有PG_BIN或原生PG/Docker，八个native本机未执行，不以skip或模型当通过。原工具正则错误1、六条新增CRLF的首轮diff-check2及修复后的0完整保留。

v356单独解决原migrator max1事务队列和schema_migrations表锁：独立owned migrator peer先准备临时0074；本事务仅先用session advisory锁协调准备，再删本事务可见的临时ledger行，使原preflight仍看到严格73、外部grant仍见已提交0074。原SQL自行获取原xact key746923553后，明确解session锁并只读核同PID/精确key仍granted，随后原60×25ms等待断言及原Request-capability exact拒绝不变。失败finally解owned session或结束它，再settle peer helper后断client；原v359 membership GRANT/REVOKE finally不改。新增session不能代替原proposal锁；删除原body锁应失败的真实Linux负控、MVCC/等待/恢复与最终cleanup仍待实际native证据。

工程发布另查明真实缺口：6658的Release37398969003自动生成2.9候选仅更新根/Core/Tool Engines/Proxy/Admin五包，独立Web仍2.8；原版本校验要求六包一致。现将@cinatoken/web加入唯一fixed组，同步两处发布文档。实际安装的Changesets CLI在修改前输出5个release，修改后输出6个、全部2.8→2.9，前五条和原changeset内容精确保持；所有六个当前manifest仍与Git基线字节一致、版本2.8，本批没有涨当前版本或发布。Release原日志还证明仓库禁止Actions创建/批准PR，读取权限为read/false；未改仓库权限或秘密，版本候选/Release实际执行仍待验证，不能称全仓库CI通过。

独立Web/Admin/Proxy/PG/TLS组合和锁定Miniflare/workerd的取消boundary包正并行实现并准备同源ownedLinux执行。原37396338452实际1、五cancel-null及leftoverGroupKilled=true保持；新的无binding/直达holder/原binding比较均为baselineEligible=false，不替代原strict gate。上轮生产证据仍见5.75 c13/2a0、100%/29true；本批未部署、未写业务数据库。真实身份/认证写、完整SSE/WS、灰度/实际回滚、原生三库/资金链、性能与来源/退役门槛继续，不提前勾选G1/G7/G8。

`;
const marker='## 6. 更新记录';assert.equal(text.split(marker).length,2);text=text.replace(marker,record+marker);
text+='\n2026-10-06：5.76实施下一8个PG73 native候选及v356真实锁前置修复；409原assert/12grant和生产源保持，本地/peer通过、实际Linux待验。Changesets补Web固定版本组，CLI计划5→6包、当前2.8未发布；TLS组合与取消boundary继续，原完整范围/负面证据保留。\n';
const lines=s=>s.split('\n');
const scope=s=>({mainTasks:lines(s).filter(l=>/^- \[[ x]\] (?:P[0-8]-|SRC-)/.test(l)),matrix:lines(s).filter(l=>/^\| (?:PUB|AUTH|ACC|ADM)-[0-9]{2} \|/.test(l)),checkboxLines:lines(s).filter(l=>/\[[ x]\]/.test(l)),gateLines:lines(s).filter(l=>/^验收门槛 G[0-8]：/.test(l)),phaseLines:lines(s).filter(l=>/^\| P[0-8] /.test(l)),evidenceLines:lines(s).filter(l=>/^\| E0[0-8] \|/.test(l))});
const a=scope(baseline),b=scope(text);assert.deepEqual(b,a);assert.equal(b.mainTasks.length,102);assert.equal(b.matrix.length,54);assert.equal(b.checkboxLines.length,213);assert.equal(b.gateLines.length,9);assert.equal(b.phaseLines.length,9);assert.equal(b.evidenceLines.length,9);
fs.writeFileSync(t+'/checklist-before-native8-progress.md',before,{flag:'wx'});fs.writeFileSync(p,text);
const after=fs.readFileSync(p),hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const proof={at:new Date().toISOString(),closed:true,actualExitCode:0,allOriginalLinesAndStatesExact:true,mainTasks:102,matrix:54,literalCheckboxes:213,taskCheckboxes:211,gates:9,evidenceRows:9,before:{bytes:before.length,sha256:hash(before)},after:{bytes:after.length,sha256:hash(after)},sourcePreparedAt:'6658ec978009afa5fe3f4beccf6bde358590b663',nativeExecuted:false,productionChanged:false,completeGoal:false};
fs.writeFileSync(t+'/checklist-native8-progress-proof.json',JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(proof));
