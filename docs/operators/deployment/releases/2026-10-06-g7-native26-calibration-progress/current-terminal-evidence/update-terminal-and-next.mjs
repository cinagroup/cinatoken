import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const out=path.dirname(fileURLToPath(import.meta.url));
const filename='C:/cinagroup/cinatoken/docs/developers/architecture/web-frontend-migration.md';
const before=fs.readFileSync(filename,'utf8'),base=fs.readFileSync(path.join(out,'checklist-before.md'),'utf8');
const native=JSON.parse(fs.readFileSync(path.join(out,'native-terminal-analysis.json'))),g7=JSON.parse(fs.readFileSync(path.join(out,'g7-current-terminal-analysis.json')));
assert.equal(native.actualExit,0);assert.equal(g7.actualExit,0);assert.equal(g7.originalRuntimeActualExit,0);assert.equal(g7.fullG7Verified,false);assert.equal(g7.fullG8Verified,false);
const sha=b=>createHash('sha256').update(b).digest('hex');
let after=before.replace(/^当前推进：.*$/m,'当前推进：5.78修复已在473de5fc原Linux实际验证：新53–56四native及未改57–59全部TAP1pass/0fail/0skip，next60v374:125:14仍81!=73，原strict仍7/1，整体Proxy失败。Web两job、Compose、Release和版本校验success。G7真实37409541185整stage0成功，seed/Proxy081/Admin082观察0，64SSR+270资源请求与全部清理0；完整G7/G8仍false。5.79正在推进其余26历史PG73 fixture和绕Miniflare入口的direct-socket诊断，先保留全部原assert/权限/失败，再跑原Linux。生产c13/2a0版本继续100%，本轮未部署；102/54/211及来源、真实身份/认证写/资金链/SSE/回滚原门槛继续。');
after=after.replace(/^\| NEXT-18 \|.*$/m,'| NEXT-18 | P1、P8-01 | 17个修复PG73 native已在原Linux通过，继续26历史夹具与完整取消 | 4e2的8项、00858的5项和473de5fc新53–56四项原native成功，未改57–59也成功；next60v374:125:14严格81!=73和原strict7/1保持。已库存59–113全部55项，26同因接线/29排除；保留2233原assert/35grant/302保护输入并继续真实CI。G7 TLS/PG目录stage0已实际成功，完整身份/ACL/资金/取消/G7/G8仍待验。 |');
const terminal=`
473de5fc520fc7d64db700db88a76c7a6b45c241已提交推送全部8文件。同SHA原[Proxy run37409463636](https://github.com/cinagroup/cinatoken/actions/runs/37409463636)终态failure：native job112094395119原53–56四项于03:36:42–53Z全部TAP tests1/pass1/fail0/skip0，未改57–59也各1/1/0/0；next60原v374:125:14于03:37:04Z严格81!=73失败，其后未执行。dispatch job112094395070原step27严格8项7pass/1fail/0skip；config与Admin playground成功。整pipeline不能因四项局部成功翻绿。Web37409463664两个job、Compose37409463671、Release37409463701和版本校验37409463776全部success，完整raw已保存，不合并草稿或发布版本。

同SHA第三次[G7 run37409541185](https://github.com/cinagroup/cinatoken/actions/runs/37409541185)真实success，runtime03:39:14.898–40.749Z实际0，wire0、seed0、Proxy081及Admin082 observe都0，81正式迁移两遍与ledger一致、795schemaColumns/hash和8counts同seed。375wire行包括64真实PG-backed SSR及135资源GET/HEAD共270请求、原9案例和TLS/CA/SNI/Host/Origin边界。9容器/3网络/1卷共13清理对象全部absent，29条独立fallback0；193child=164runtime+29fallback，386原stdout/stderr各bytes/SHA核对。025/026 pg_isready原实际2及expectedNumericReadinessNonzero=true保留。artifact11387954568顶层598条目=597文件+1目录、递归599普通文件；ZIP 8b300225…520b0c仅remote reported digest，未声称本机ZIP校验。root首analysis误要求fallback不存在timedOut字段而实际1，改为新v2精确fallback原signal/error及QA actualExit/OOMKilled字段后analysis0，原脚本/日志保持。独立终态peer FINAL516312B/70b8cc42…77fd核全部raw、20原473输入/81SQL和清理，首次reader路径形态错误1亦保留。G7仅realLinuxDockerTLSPGCatalog=passed；PG16.15超级用户不证明PG18/受限ACL，signedOIDC、authenticatedWrites、subjectWorkspaceIsolation、proxySSEAbortWS、retainedGrayRollback、realCinaAuthIdentity均pending，fullG7/fullG8=false。首GH dispatch用fullSHA被422拒绝actual1，核remote main473后用main成功0并核handle SHA；它是启动接口错误，不伪称runtime失败或复跑成功。

`;
assert.ok(after.includes('### 5.78 '));assert.ok(!after.includes('### 5.79 '));
const next=`### 5.79 剩余历史 PG73 夹具与取消入口诊断（2026-10-06，运行验收待续）

针对5.78真实next60失败，先完整库存原native59–113共55项，26适用、29排除。新范围精确为60、61、66、69、71–78、80–86、88、95–99、106；只有step60当前有81!=73实际失败，其他25只是同因静态适配。26源仅接既有固定73 loader与owned grant桥，2233原assert/35原grant、2556模板/3236 SQL事务调用、原锁/角色/等待/timeout/skip/negative/cleanup/reporter和302未改输入保持；82–85原finally corpus长度/SHA/失败条件仍检查，81/83–85递归源readdir不删除，95/96两个幂等grant及split拒绝调用、99/106后置成功rerun不减少或改写。26syntax、源文/AST/全文reverse、固定73 hash和diff-check实际0，Windows没有执行原生PG。作者新FINAL210963B/48f61432…efda、42关闭回执40个0/2个1：规划step95重复锚点失败1发生在写源码前，首finalizer快照名ENOENT1也保留，最后v2封存0；独立复核和原Linux终态待续。

取消的下一因果分离保留原strict：既有bare/direct/binding均经mf.ready的core ENTRY_WORKER，其中固定flags无enable_request_signal；原RST路径已观察到holder/incoming signal-abort但cancel KV全null，故不可断言所有信号均未传播。新7文件只增加v364-direct-socket包与独立manual workflow：锁定Miniflare现有unsafeDirectSockets/unsafeGetDirectURL绕公共entry，对原bare与binding gateway各destroy/RST，并在真实worker中显式reader.cancel校准原async holder。原source/observer/flags/100×10ms窗口和4s尾部、原strict8测试与ASSERT全部不改，校准不等于HTTP取消；原baseline exit1必使aggregate保持1，5诊断不能关闭原门槛。bounded supervisor维持独占process group、subreaper/census与真实child exit/TERM-KILL/absence，mf.dispose不称graceful。作者FINAL32670B/49b83e20…d856与独立peer44060B/0e986237…2eaf冻结，13 AST/schema控制、2语法/Python AST/真实bundle/formatter0，初gen/stub/manifest/negative及Windows childnull原件保留；未在本机启动MF/Workerd或执行CI。提交后仅单次manual实际Linux验证，productionRequests保持0。

`;
assert.equal((after.match(/^## 6\. 更新记录$/gm)??[]).length,1);
after=after.replace('## 6. 更新记录',terminal+next+'## 6. 更新记录');
after+='\n2026-10-06：5.78真实终态：四新native与未改57–59成功，next60/strict仍失败；同473 G7实际TLS/PG目录/两个观察和全清理成功，完整G7/G8不提前完成。5.79继续26历史fixture与direct-socket诊断，原全部范围/状态/失败保留，未部署生产。\n';
for(const re of [/^- \[[ x]\] (?:P[0-8]-|SRC-).*$/gm,/^\| (?:PUB|AUTH|ACC|ADM)-[0-9]{2} \|.*$/gm,/^验收门槛 G[0-8]：.*$/gm,/^\| P[0-8] .*$/gm,/^\| E0[0-8] \|.*$/gm,/^.*\[[ x]\].*$/gm])assert.deepEqual(after.match(re)??[],base.match(re)??[]);
fs.writeFileSync(filename,after);const proof={at:new Date().toISOString(),actualExit:0,bytes:Buffer.byteLength(after),sha256:sha(Buffer.from(after)),originalScopeAndStateLinesExact:true,fullG7Verified:false,fullG8Verified:false};fs.writeFileSync(path.join(out,'terminal-and-next-checklist-proof.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(proof));
