import fs from 'node:fs';import assert from 'node:assert/strict';
const file='C:/cinagroup/cinatoken/docs/developers/architecture/web-frontend-migration.md',temp='C:/Users/cina/AppData/Local/Temp/cinatoken-migration-progress-20261006-541315903c5243bc9a08bbc8a3515df4';let text=fs.readFileSync(file,'utf8');assert.ok(!text.includes('### 5.74 '));
text=text.replace('最近更新：2026-10-05。','最近更新：2026-10-06。');const old=text.split(/\r?\n/).find(x=>x.startsWith('当前推进：'));assert.ok(old);
const current='当前推进：切流已完成并于2026-10-06只读复核：当前Web仍为c13a64b9/2a0a2777、100%/29true，三路由及Workers.dev/Preview双false，Admin/Proxy保持34c742d1。独立三路浏览器诊断3/3在原45s内完成，但旧完整31/45超时与原因未证明状态保留。PG73变量错误已以abe8eb89提交推送，Linux CI实际通过scale/lock测试，随后另一个历史fixture因81!=73失败；完整CI未通过。Docker实际SSR隔离冒烟与独立页面就绪QA正在实施，结果见5.74。完整102任务/54矩阵/G0–G8/E00–E08/211任务checkbox保持，真实身份、资金链、来源、完整双平台和回滚退役继续待验。';
text=text.replace(old,current);
const section=['### 5.74 切流后补验与原生 CI / Docker SSR 推进（2026-10-06，实施中）','',
'本批不改生产发布：2026-10-05T23:27:00.400–23:27:11.395Z实际Cloudflare只读版本/29开关核验actual0，23:30:47.738–23:30:53.355Z三路由/100%/预览关闭后核actual0。Web源码c13a64b9、version2a0a2777、deploymentfd24618f不变；Admin/Proxy34c742d1保持。不得把当前Git测试/CI提交当作已发布Web新版本。',
'',
'生产匿名三路诊断保留原Chrome147/Playwright1.62.1、1440×1000/en-US/light、fresh anonymous context、GET/HEAD守卫、每页45s networkidle与全局180s。在23:33:51.455–23:34:06.231Z唯一真实运行中，/account/withdraw、/admin/config/timezone与/en分别6.365/2.967/2.922秒，3/3完成，context/browser/process闭合。57 Playwright请求失败0、pageerror0；两个准确匿名user/me401解释。另59 CDP请求中两个favicon.ico由浏览器取消（net::ERR_ABORTED），不可冒称全网络失败0；两个favicon之外logo.png200、最终pending0。Root与独立复核三图均为正常匿名gate/公开首页，无框架overlay。首次本地seal因Windows斜杠路径deepEqual退出1，浏览器未启动、生产请求0；原脚本字节不改，在独占Temp以native路径封存后仅执行这一次真实网络诊断。旧v2两轮和v3 31/45失败仍保留，不能凭三路成功证明完整45项或推断旧超时根因。',
'',
'PG73 replay-scale-lock测试163行的未定义migrator已最小修复为migrator: sql；使用已有owned127.0.0.1集群的migrator单连接，holder独立连接、角色/ledger/锁/超时/回滚及其他原字节断言保持。语法、纯builder2/2（skip0）、独立词法重现与修后参数身份、diffcheck均actual0。本机没有原生PG通过主张。提交abe8eb89e8cdbac005bc085d61acf5d2213a2f23推送actual0；同SHA Linux CI37389221454的native-financial step14在23:35:57Z实际success，原ReferenceError解除。随后step17在23:36:06Z因postgres-shared-key-usage-repair-jobs.native.test.mjs:83的81!=73失败；不能将单项修复写成完整native或全仓库CI通过，后续按历史PG73准确corpus继续修正。',
'',
'Docker既有Web CI只build SSR镜像，smoke.mjs实际只起静态Nginx。本批新增隔离SSR实际启动冒烟，以同一冻结产物启动Web入口、enabled/disabled Node SSR与受控HTTP目录fixture，唯一--internal网络、无host port、只读挂载，检查四语八页GET/HEAD、SEO/404/503、manifest错配与缺失、关闭开关、匿名凭据剥离并验证owned IDs清理。当前尚待Linux实际执行，不把Windows无Docker、构建成功或fixture检查当作运行通过。受控目录不是实际Admin/Proxy或CinaAuth，https://web-ci.test仅canonical配置，不证明TLS；G7仍要求完整SSR/Admin/Proxy/TLS、身份/写、SSE/WebSocket及实际灰度/回滚。',
'',
'原45s networkidle来自临时浏览器harness，正式P8-09要求性能测量及预算记录，没有指定全网静默。Playwright官方API将networkidle列为不建议用于测试的等待方式。本批另准备独立functional-readiness矩阵，保留原85断言、45/20/390/420有界预算和37私有页精确401，以实际页面/控件与必需资源验证就绪；它不重写旧失败或标记原strict networkidle通过。待独立review与真实运行后补入结果，当前完整QA未通过。',
'',
'本批所有原始命令、负面结果和闭合收据将封存至同一release证据记录；102主任务、54矩阵、G0–G8/E00–E08和211任务checkbox状态不变。v364原生取消、真实CinaAuth/角色/业务、资金链、非空真实目录、原生三库、326历史来源、完整Docker与回滚退役继续待验。',''].join('\r\n');
text=text.replace('## 6. 更新记录',section+'\r\n## 6. 更新记录');text+='\r\n2026-10-06：开始5.74切流后补验；当前Cloudflare版本/三路由保持，三路诊断3/3通过但完整旧strict QA未通过。PG73变量修复已提交推送并在Linux实际通过，下一历史schema73/81失败继续处理；独立functional-ready浏览器与真实隔离Docker SSR正在推进。原102/54/G/E/211状态保持。\r\n';fs.writeFileSync(file,text);console.log(JSON.stringify({updated:file,scope:'top current progress + new5.74 + update log',state:'in-progress'}));
