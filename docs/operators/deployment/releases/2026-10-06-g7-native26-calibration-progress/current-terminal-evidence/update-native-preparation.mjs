import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const out = path.dirname(fileURLToPath(import.meta.url));
const filename = 'C:/cinagroup/cinatoken/docs/developers/architecture/web-frontend-migration.md';
const before = fs.readFileSync(filename, 'utf8');
assert.equal(before, fs.readFileSync(path.join(out, 'checklist-before.md'), 'utf8'));
const nativeReport = 'C:/Users/cina/AppData/Local/Temp/cinatoken-native-four-repair-38a94fb93d9842929dc7ae9cf6b378da/FINAL-native-four-pg73-preparation.json';
const peerReport = 'C:/Users/cina/AppData/Local/Temp/cinatoken-native-four-independent-peer-1f17397bef8049cb9cd030679e23dc70/FINAL-native-four-independent-peer.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(fs.readFileSync(nativeReport)), 'ae66339a066dc2522dc6e7617c5118a7bb7f33ee134d74db9755dcc90194c77d');
assert.equal(sha(fs.readFileSync(peerReport)), '3ed94c55060f7d908f4a6b5497852868ae2e4bc9049ce5a1c39aecc25fb61883');
let after = before.replace(/^当前推进：.*$/m, '当前推进：5.78继续完整迁移。独立Web仍为c13/2a0版本100%，03:13推送后Cloudflare三Route读回0；702c4d71已推送、Release与版本校验真实success。新step53–56四项PG73 fixture仅作历史夹具接线，410原断言/4grant及184保护输入经独立审计保留，本地准备0，原Linux运行待验证。G7 Admin观察依赖修复正在实施，07d19原wire0/Admin观察1/外层1与清理0保留；原strict取消、完整G7/G8、来源/身份/认证写/资金链/SSE/回滚继续，本轮未部署生产。');
after = after.replace(/^\| NEXT-18 \|.*$/m, '| NEXT-18 | P1、P8-01 | 13个PG73 native已在原Linux通过，新四项准备完成、实际运行待验 | 4e2的8项及00858的5项历史原Linux成功保持；原next53严格81!=73失败保留。新53–56仅接线到既有PG73 helper，410原assert/4grant、SQL/锁/等待/timeout/cleanup及184保护输入保持，独立peer actual0；不以准备0称原native通过。原strict取消/G7 Admin observe失败及真实三库、ACL/MVCC/资金链/完整G7/G8继续。 |');
assert.ok(!after.includes('### 5.78 '));
const section = `### 5.78 独立 Web 切流后的完整平台验收推进（2026-10-06）

本批仍推进原102主任务、54矩阵、G0–G8/E00–E08和211任务勾选，范围与原状态未缩减。03:13:11–17Z Cloudflare推送后只读核对实际0：主站与资源Route仍cinatoken-web、API Route仍cinatoken-proxy，c13/2a0唯一版本100%，deployment fd24618f不变、workers.dev/preview均关闭。文档/归档提交702c4d71379acb697024ef846725871582bff94f已推送；该SHA Release37407870624和版本校验37407870479已真实success，未合并版本草稿、未发tag或重复生产部署。

新native准备以702为源码基准，只修改step53–56的legacy-reaper-fence-v366、all-hold-renewal-v367、buyer-counter-cutover-v367和legacy-buyer-held-v368四个测试文件：迁移读取使用已有固定历史73 helper，原grant调用在proposal安装前使用已有owned-loopback适配。410个原assert与4个原grant、原SQL/锁/等待/负例/timeout/skip/cleanup原文及AST保持，反向整文件字节审计0。188库存输入准确区分184个未改保护源与4个允许目标；step57/58、helper、生产TS、正式和proposal SQL及原workflow保持Git字节。syntax4/4、固定73 corpus与ledger pin、本地审计和独立peer均实际0；Windows没有执行原生PG，step54–56只属同因静态推断，原next53失败未撤回。producer FINAL79877B/ae66339a…c77d与独立peer94330B/3ed94c55…1883在新唯一Temp冻结；所有14个producer关闭回执及stdout/stderr字节/SHA经peer读取，权限警告原stderr保留。接下来提交同批代码与本记录，运行原Linux pipeline并按实际终态续记。

G7下一实施点仍是Admin observe导入Core宽入口缺drizzle依赖；只读观察需采用真实镜像已有的postgres驱动并保持原全部ledger/schema/count/SQL和seed合同。当前生产与全部历史失败不变，准备/分析0不推导完整G7/G8通过。

`;
assert.equal((after.match(/^## 6\. 更新记录$/gm) ?? []).length, 1);
after = after.replace('## 6. 更新记录', section + '## 6. 更新记录');
after += '\n2026-10-06：5.78开始下一真实Linux批：53–56四项历史PG73 fixture完成本地/独立准备核对，原410断言和保护源保持，等待原CI；G7 Admin observe依赖修复继续实施，切流c13/2a0仍100%，未重复部署。原全部任务状态保持。\n';
const scopes = [/^- \[[ x]\] (?:P[0-8]-|SRC-).*$/gm, /^\| (?:PUB|AUTH|ACC|ADM)-[0-9]{2} \|.*$/gm, /^验收门槛 G[0-8]：.*$/gm, /^\| P[0-8] .*$/gm, /^\| E0[0-8] \|.*$/gm, /^.*\[[ x]\].*$/gm];
const counts = scopes.map(regex => { const oldLines = before.match(regex) ?? []; assert.deepEqual(after.match(regex) ?? [], oldLines); return oldLines.length; });
assert.deepEqual(counts, [102,54,9,9,9,213]);
fs.writeFileSync(filename, after);
const proof = { at: new Date().toISOString(), actualExit: 0, baseline: { bytes: Buffer.byteLength(before), sha256: sha(Buffer.from(before)) }, updated: { bytes: Buffer.byteLength(after), sha256: sha(Buffer.from(after)) }, counts, originalScopeAndStateLinesExact: true, nativeLinuxPassClaimed: false, fullG7Verified: false, fullG8Verified: false, productionDeploymentAttempted: false };
fs.writeFileSync(path.join(out, 'native-preparation-checklist-proof.json'), JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(proof));
