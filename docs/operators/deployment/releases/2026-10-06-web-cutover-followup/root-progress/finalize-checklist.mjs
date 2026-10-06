import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const temp = "C:/Users/cina/AppData/Local/Temp/cinatoken-migration-progress-20261006-541315903c5243bc9a08bbc8a3515df4";
const file = 'C:/cinagroup/cinatoken/docs/developers/architecture/web-frontend-migration.md';
const before = fs.readFileSync(file);
let doc = before.toString('utf8').replace(/\r\n/g, '\n');
function line(prefix, replacement) {
  const all = doc.split('\n');
  const matches = all.map((s, i) => s.startsWith(prefix) ? i : -1).filter(i => i >= 0);
  assert.equal(matches.length, 1, prefix);
  all[matches[0]] = replacement;
  doc = all.join('\n');
}
line('**可行性结论：可行。**', '**可行性结论：可行。** `packages/web` 的 React、Rsbuild 与现有 UI 已作为独立 `cinatoken-web` 部署，并于2026-10-05接管生产主入口及公开SSR。Admin继续提供认证、用户/管理API、BFF与兼容旧路由。2026-10-06当前c13版本匿名功能矩阵45/45及主题/中文/移动重载通过（5.74）；旧networkidle严格QA的31/45超时仍保留（5.73），根因未证明。真实身份/资金/链、完整双平台及旧页面退役继续按原门槛推进。');
line('当前推进：', '当前推进：切流已完成并于2026-10-06只读复核：Web仍为c13a64b9/2a0a2777、100%/29true，三路由及Workers.dev/Preview双false，Admin/Proxy保持34c742d1。当前生产独立functional v4匿名45/45与三交互通过，使用DOMContentLoaded＋页面/React/必需资源就绪；旧networkidle失败不追认为通过。PG14变量和PG17历史fixture修复已提交推送并在Linux实际通过，下一step20仍因81!=73失败，v364取消亦未通过。新增Docker SSR同5471899c的Linux实际87项/64匿名目录读及四容器一网络清理通过，Web37步骤/1596单测及现有Compose13步骤通过；完整Docker/TLS未完成。详见5.74。完整102任务/54矩阵/G0–G8/E00–E08/211任务checkbox保持，真实身份、资金链、来源、完整双平台和回滚退役继续待验。');
line('| P6 公开页与 SEO |', '| P6 公开页与 SEO | 当前匿名功能验收通过，整域待验 | 当前c13公开HTTP/HTML/137资源组合见5.73；生产functional v4匿名45/45含8公开页、预期模型404及主题/中文/390px重载通过，未知错误0（5.74） | 当前catalog为空/USD；旧networkidle31/45失败与根因未证明保留，功能就绪通过不证明真实Auth、非空目录/完整聊天、完整SEO、上游来源或G6。公开SSR由Web提供，兼容路由保留Admin。 |');
line('| P7 双平台部署 |', '| P7 双平台部署 | Cloudflare切流及独立Docker SSR冒烟通过，完整双平台待验 | 生产c13/2a0版本100%/29true及三Route/预览双false复核通过；新测试SHA5471899c的Web CI37步骤/1596单测、Docker实际SSR87项/64匿名目录读及四容器一网络清理通过，现有Compose13步骤成功（5.74） | 新测试SHA未部署，生产/Admin/Proxy版本保持；Compose仅PG/Admin/Proxy，SSR目录为受控HTTPfixture、无TLS。完整SSR/Admin/Proxy/TLS、真实身份/资金链、SSE/WebSocket、灰度/实际回滚与G7继续；原生PG20和v364取消失败保留。 |');
line('| P8 发布与退役 |', '| P8 发布与退役 | 切流完成，匿名功能验收通过，完整验收及退役未完成 | c13生产版本/Route/冻结137资产与原失败见5.73；5.74独立functional45/45/三交互通过且前后Cloudflare版本不变，保留旧networkidle失败、所有历史负面及资源保留约定 | 全矩阵真实业务、来源/许可、性能预算观测、完整双平台、灰度/实际回滚及旧UI退役继续；匿名功能通过不勾G8 |');
line('下表当前发布证据以5.73为准：', '下表当前发布证据以5.73、最新补验5.74为准：生产源码仍为c13a64b9、Web version2a0a2777 100%/29true及137资产/35server；生产functional v4 45/45与三交互通过，原networkidle31/45超时仍保留。新测试SHA5471899c的Web CI37步骤及真实Docker SSR87项通过，现有Compose13步骤成功；原生PG14/17已通过，PG20 schema81!=73和v364取消仍失败。Admin/Proxy保持34c742d1；匿名发布不证明真实身份、三库/链、完整Docker/TLS或灰度/回滚。');
line('| E06 | G6 公开页面与SEO |', '| E06 | G6 公开页面与SEO | 当前c13公开HTTP/HTML及137资源核对见5.73；5.74生产匿名functional45/45含8公开页/缺失模型404及主题/中文/390px刷新通过，精确解释所有console、未知0。 | 目录实际为空/USD；旧networkidle失败和超时根因未证明保留。真实Auth、非空目录/完整聊天、完整SEO、上游来源继续，G6未完成；历史下载失败与定向修复亦保留。 |');
line('| E07 | G7 双平台部署 |', '| E07 | G7 双平台部署 | 独立Web主/资源Route100%/29true、预览双false和Admin/Proxy不变后核通过；5.74同547测试SHA Web CI37步骤/1596单测及隔离Docker SSR87项/64匿名目录读/四容器一网络清理通过，现有Compose13步骤成功。 | 新测试SHA未部署；SSR受控目录不含真实Admin/Proxy/CinaAuth或TLS，Compose未覆盖Web。完整身份/角色写、三库/链、SSE/WebSocket、SSR/Admin/Proxy/TLS同源、灰度/实际回滚及G7仍待验；PG20和v364失败不豁免。 |');
line('| E08 | G8 全量发布 |', '| E08 | G8 全量发布 | c13已commit/push/deploy，生产版本/Route/冻结交付见5.73；5.74匿名functional45/45与三交互通过，旧strict networkidle失败/历史负面均保留。 | G8未完成、目标active：全矩阵真实身份/权限/资金链账本/非空目录、历史来源、三库、性能预算、完整双平台、灰度/实际回滚及旧页退役继续。完整102主任务/54矩阵/G0–G8/E00–E08及211任务checkbox原状态保持。 |');
const start = doc.indexOf('### 5.74 '), end = doc.indexOf('## 6. 更新记录', start);
assert.ok(start >= 0 && end > start);
const section = `### 5.74 切流后补验与原生 CI / Docker SSR 推进（2026-10-06，匿名功能与独立SSR冒烟通过，完整验收继续）

本批补验不改生产发布。Cloudflare前核、v4前核及后核均实际退出0；最终2026-10-06T00:00:19.495–00:00:25.476Z只读guard再次核对Web源码c13a64b9c3b2c90adcf736910ea408868d7854f1、version2a0a2777-d3b1-47f0-a0a7-88e701b4d2d9、deploymentfd24618f-121e-4640-9edf-f15d243a6d75、100%/29true。主Route和web-assets Route均属Web，API Route仍属Proxy、fail-open均false，Workers.dev/Preview双false；Admin/Proxy仍34c742d1。当前Git5471899c仅为测试/CI变更，不冒称生产新版本；下一发布仍须从5.73实际retained release衔接资源保留链。

三路网络诊断保留原45s networkidle、fresh anonymous、1440×1000/en-US/light、Chrome147/Playwright1.62.1、GET/HEAD守卫及180s总期限。2026-10-05T23:33:51.455–23:34:06.231Z唯一真实运行中，/account/withdraw、/admin/config/timezone、/en分别6.365/2.967/2.922秒、3/3完成，context/browser/process关闭。57 Playwright请求失败0、pageerror0，两个准确匿名401；59 CDP请求含两个favicon.ico取消net::ERR_ABORTED，不能称全网络失败0，logo最终200、pending0。Root与独立review查看三图正常gate/首页、无overlay。首次本地seal因Windows斜杠路径deepEqual退出1，浏览器未启动、生产请求0；原脚本不变，在新Temp用native路径封存后仅执行一次真实诊断。旧v2两轮及v3 31/45失败保留，三路通过不证明完整矩阵或旧超时根因。

独立functional v4在执行前由Root Babel与另一agent Acorn复核：原有序85个main断言和4个executor断言的AST/文本、45唯一tuple、37私有页精确401、GET/HEAD守卫、SW检查、四fresh anonymous context及45s导航/20s功能就绪/390s整体/420s外层预算保持。仅将四处generic导航等待改为DOMContentLoaded，20s从DOMContentLoaded开始共享原locator、当页全部必需JS/CSS与精确private401/Public React反应验证；公开SSR正文之外，还真实切换theme并验证React class/cookie后恢复原mode。原主题/语言/mobile三交互另按原断言执行。Playwright routing关闭HTTP缓存，无缓存恢复或产品性能改善主张。[Playwright官方API](https://playwright.dev/docs/api/class-page#page-goto-option-wait-until)不建议用networkidle作为测试就绪条件；这个新方法不重写旧networkidle失败，也不把功能就绪时间当正式P8-09预算验收。

唯一v4运行2026-10-05T23:51:56.478–23:52:31.751Z，actualExit0、35.273秒：45/45，HTTP200×44与预期缺失模型404×1；37私有页各有准确GET user/me401 Unauthorized/successfalse。38条console为37条准确匿名401及1条预期404，未知HTTP/console/pageerror/warn/拒绝写/Playwright请求失败均0；1003个GET最终全部完成，870个JS/CSS成功。48次功能就绪含45页和三交互导航，公开React反应11次；最大DCL2.454s/共享就绪3.916s/functional导航6.358s，属于本次routing禁缓存观测。37个ready checkpoint仍有logo.png pending，后来全部200/finished，close前四context pending0，不能把ready等同networkidle。公开目录实际为空/USD。深色→中文→390×844移动重载、cookie/lang/dark/nooverflow通过；7张实际截图Root/独立review均查看，身份/title/正文正常、无框架overlay。四context/browser/child最终关闭；所有新旧script、plan/config/liveproof前后字节一致。完整原raw4917392B/SHA256 bbeb36d178fb245f178ee2f8b47ed70f2db92b712c7dcb4ddea31d6a1980087a及闭合收据、AST审查、截图均保留。此结论仅为当前生产匿名功能矩阵通过；真实登录、业务写、资金链、非空真实目录和完整G8未获验证。

PG14 postgres-replay-scale-lock.native.test.mjs:163的未定义migrator最小改为migrator: sql，原owned loopback集群、独立holder、角色/ledger/锁/超时与其他断言保持；提交abe8eb89，纯builder2/2、语法/词法重现及diff实际0，Linux37389221454 step14成功，随后step17因81!=73失败。PG17仅把历史fixture的全部81迁移枚举替换既有严格PG73 corpus及grantPg73RuntimeFixture，保留assert73/ledger、角色属性、ACL42501、锁/Queue和240s期限；提交9ad3ccda，纯builder4/4、73 corpus/ledger pin及diff实际0。新同5471899c Linux37390678189实际step14/17/18/19成功，step20 runtime-grant历史fixture仍81!=73、native job失败。dispatch-safety step27仍v364取消8测试7通过1失败（null未观察cancel）；config13及admin15步骤成功，整条Proxy CI最终failure。现有workerd1.20260828.1配置已有enable_request_signal，公开upstream teardown/cancel修复候选尚未合并，源码高匹配不等于因果证明；不放宽原断言或改生产默认开关。下一批先准确处理step20角色/历史73 grant fixture，完整native与取消继续待验。

Docker新增docker/web/ssr-smoke.mjs和受控catalog-server.mjs，原静态smoke.mjs不变；提交5471899c，同一冻结manifest从入口/SSR逐一核对，以唯一--internal网络、零host port、只读mount启动Nginx入口、enabled SSR、disabled SSR及HTTP目录fixture四容器，并inspect网络/label/mount。真实87项包含四语言×8公开页GET/HEAD64、robots/sitemap4、404/503八项、manifest缺失/错配4、关闭开关2、直连SSR匿名2与redirect3；64次真实匿名目录读取均GET/JSON accept且无Cookie/Auth/workspace/body，violations[]。2026-10-05 Linux WebCI37390678029同SHA最终success，Web18＋Admin19共37步骤全部成功；Web1596/1596、types/lint/完整format/build/freeze、原静态smoke与新SSR actual87通过，状态200×70/308×3/404×6/503×8，四owned容器与独立网络逐项确认absent:true。manifest672c10dc8efae8a55bcb5a23652a48bddf5e487de4209bd5d6ed352b1b340542；artifact11380788781、6976082B、GitHub报告zip digest ef0a12b4fb5ed7e5700f49e4233c87d7984951c7906dfa90501387df7634ac17（未下载独立hash）、expiry2027-01-03T23:49:34Z。首次本地root Prettier2格式通过而Web workspace Prettier3 format退出1，原失败保留；仅workspace格式化，Acorn全部AST/literal/template/comment等价，复测完整Web format/语法/fixture format/diff实际0。Windows无Docker，不作本地Docker通过主张。

同SHA Compose37390677930最终success13步骤，原实际范围为PG16迁移/idempotency/fixture及Proxy/Admin health与root HTTP200、teardown，未包含Web/TLS。新SSR目录为受控非空HTTPfixture，https://web-ci.test仅canonical元数据；两条CI成功不等于完整SSR/Admin/Proxy/TLS同源、CinaAuth、授权业务写、SSE/WebSocket或灰度/回滚。所有闭合命令、原始负面、生产前后核、CI日志、script/plan、JSON与截图按原bytes/SHA封存；大raw使用lossless gzip，记录解压后原bytes/SHA与存储bytes/SHA，不改写失败。[本批补验记录](../../operators/deployment/releases/2026-10-06-web-cutover-followup.json)汇总准确范围。原102主任务/54矩阵/G0–G8/E00–E08/211任务checkbox均保持；真实身份/资金链、历史来源/许可、原生三库、性能预算、完整Docker/TLS与实际回滚退役继续。

`;
doc = doc.slice(0, start) + section + doc.slice(end);
line('2026-10-06：开始5.74', '2026-10-06：5.74切流后补验完成本批记录：生产c13/2a及三Route保持，匿名functional45/45与主题/中文/mobile通过，旧networkidle失败保留；PG14/17在Linux已过，PG20和v364仍失败。新同547 Web CI37步骤/1596单测与真实隔离SSR87项/64目录读/四容器一网络清理通过，现有Compose13步骤成功但完整TLS/身份/回滚待验。原102/54/G/E/211状态保持。');
fs.writeFileSync(file, doc);
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const after = fs.readFileSync(file);
const result = {at:new Date().toISOString(), actualExit:0, file, before:{bytes:before.length,sha256:hash(before)}, after:{bytes:after.length,sha256:hash(after)}, productionChanged:false};
fs.writeFileSync(temp+'/checklist-final-update.json', JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(result));
