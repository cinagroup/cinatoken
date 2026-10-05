import fs from 'node:fs';import assert from 'node:assert/strict';import cp from 'node:child_process';
const root='C:/cinagroup/cinatoken';
const report=JSON.parse(fs.readFileSync(root+'/docs/operators/deployment/releases/2026-10-05-web-resource-retention-production.json','utf8'));
assert.equal(report.checks.browser.strictPassed,false);assert.equal(report.checks.browser.v3.actualExit,1);assert.equal(report.checks.browser.v3.pages,31);assert.equal(report.checks.browser.v3.interactions.length,3);
assert.equal(report.production.access.enabled,false);assert.equal(report.production.access.previews_enabled,false);
const rel='docs/developers/architecture/web-frontend-migration.md',file=root+'/'+rel;
let md=fs.readFileSync(file,'utf8');const cutoff=md.indexOf('### 5.73 ');assert.ok(cutoff>0);
let top=md.slice(0,cutoff),tail=md.slice(cutoff);
const mappings=[
['本SHA严格浏览器正在运行，尚未标记通过；','本SHA原v2两轮25/23页超时、新v3 31/45页及三交互后actual1，完整严格浏览器未通过；'],
['新版本严格浏览器及发布后最终版本/路由后核仍待闭合，不沿用5.72旧版本的通过结论。','原v2两次总时限及新v3两页45s networkidle超时均封存，完整严格浏览器仍待验；最终版本/三路由和预览关闭后核actual0，不沿用5.72旧版本通过结论。'],
['严格浏览器运行中','严格浏览器31/45超时待验'],
['新SHA严格浏览器尚未闭合','新SHA新v3 31/45及三交互后超时，完整严格浏览器尚未通过'],
['本SHA严格浏览器/最终后核未闭合','本SHA新v3 31/45及三交互后两页45s网络等待超时、actual1；最终后核actual0'],
['新SHA严格浏览器仍运行中','新SHA新v3严格浏览器31/45及三交互后两页超时actual1、完整待验'],
['新SHA严格浏览器和最终版本/路由后核正在闭合，尚未标记通过；','新SHA新v3浏览器31/45及三交互后两页45s网络等待超时actual1、完整待验；最终版本/路由后核actual0；'],
['新SHA浏览器尚未闭合','新SHA新v3 31/45及三交互后超时，完整严格浏览器尚未通过'],
['新SHA严格浏览器和最终后核待闭合。','新SHA新v3浏览器31/45及三交互后两页45s网络等待超时actual1、完整待验；最终后核actual0。'],
];
for(const [a,b] of mappings){assert.ok(top.includes(a),'Expected current status: '+a);top=top.replaceAll(a,b);}
tail=tail.replace('### 5.73 旧 Web 资源保留修复（2026-10-05，已部署并复验资源，新SHA严格浏览器待闭合）','### 5.73 旧 Web 资源保留修复（2026-10-05，已部署，资源/最终后核通过，浏览器31/45超时待验）');
const a='本SHA严格浏览器仍在运行，最终版本/路由后核待闭合，本节不预写通过；5.72的3847955严格45/45及主题/中文/移动结果仅作为历史。Root完成后补充[本批生产发布记录](../../operators/deployment/releases/2026-10-05-web-resource-retention-production.json)及其原始证据。';
const b='本SHA原sealed v2两轮浏览器分别25/45和23/45页后触发原390s总期限、actual1，交互未执行；第二轮browser已关闭而context.close报目标已关闭（contextClosed=false），原始失败均保留。逐条独立重分类18/17条console全为精确匿名GET user/me 401 Unauthorized及缺失模型404，不以尚未执行分类的空数组冒称通过。Playwright routing关闭HTTP缓存；57.447s四导航小样中的CDP setCacheDisabled(false)未证明恢复缓存，因此未采用。新v3经独立审查仅把匿名直接导航分四个fresh context（8公开/10账户/14与13管理），保留GET/HEAD守卫、networkidle45s、locator20s、原51项页面/metadata/权限/console/HTTP断言及同390s/外420s预算，并新增精确tuple集合和逐私有页401核验。唯一新运行actual1、31/45：公开8项和深色→中文→390×844移动重载三交互、admin-a14项完成；account6/admin-b3后在/account/withdraw与/admin/config/timezone各触发原45s networkidle超时，非全局390/420超时。23个已完成私有页各有精确401，另两个失败入口各1，合计25，缺失模型404共1；finally在四context/browser真实关闭后重收集，26条console全部精确解释，所观察未知错误/警告/请求失败/写尝试均0。四context/browser/process及source/config/liveproof前后核闭合，但不以正常登录门槛截图、零未知错误或三交互代替完整45项通过，也不宣称缓存恢复、产品性能改善或真实登录。未继续盲重跑。独立字节对比121个static与33个server运行文件同384版本，仅2个server build-contract变化；最终Cloudflare只读后核actual0，确认c13/2a0版本100%、三路由归属和预览双false，Admin/Proxy版本不变。5.72旧版本QA仅保留历史。[本批生产发布记录](../../operators/deployment/releases/2026-10-05-web-resource-retention-production.json)封存全部原始命令、负面结果、缓存反证、新v3九截图及冻结manifest，状态为资源修复已部署、严格浏览器未完成。';
assert.ok(tail.includes(a));tail=tail.replace(a,b);md=top+tail;
const base=cp.execFileSync('C:/Program Files/Git/cmd/git.exe',['show','5a13f59e851ec7e2ef6a94b50e5d4d4da26e9462:'+rel],{cwd:root,encoding:'utf8',maxBuffer:5000000});
const section=(s,start,end)=>{const i=s.indexOf(start);assert.ok(i>=0);const j=s.indexOf(end,i+start.length);assert.ok(j>i);return s.slice(i,j);};
assert.equal(section(md,'### 5.71 ','### 5.72 '),section(base,'### 5.71 ','### 5.72 '));
assert.equal(section(md,'### 5.72 ','### 5.73 '),section(base,'### 5.72 ','## 6. '));
const boxes=s=>s.split(/\r?\n/).filter(l=>/\[[ x]\]/i.test(l));assert.deepEqual(boxes(md),boxes(base));
fs.writeFileSync(file,md);
const op=root+'/docs/operators/deployment/cloudflare-web.md';let operator=fs.readFileSync(op,'utf8');const sentence='严格浏览器新版本结果继续单独记录，详见';
assert.ok(operator.includes(sentence));operator=operator.replace(sentence,'本SHA原v2两次25/23页总时限超时actual1保留；新v3四个匿名上下文保留原51断言、GET-only守卫及390s/外420s预算，唯一运行31/45及深色→中文→390×844三交互后，账户/提现和管理/时区入口各在原45s networkidle等待超时、actual1。已完成页面正常、26条console精确解释、四context/browser/process关闭，不代替完整45项通过；未采用无效CDP缓存方案或继续盲重跑。最终只读后核actual0确认当前版本100%、三条Route归属和Workers.dev/Preview双false。完整严格浏览器、真实登录及回滚仍待验。详见');fs.writeFileSync(op,operator);
console.log(JSON.stringify({actualExit:0,checklistBytes:Buffer.byteLength(md),historical571572Unchanged:true,checkboxesUnchanged:true,browserStatus:'unproven-original-v2-and-v3-failures-preserved',productionTrafficPercent:100}));
