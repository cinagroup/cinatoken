# C02 v267：固定 staging Access、入口与失败收尾适配器

2026-09-21，Checklist v1.166。ACCESS_LOCAL_PASS / STAGING_PARTIAL；完整操作器和原生验收未完成。用户的独占 staging 授权尚未线上行使，C02.G / C01 不放行。

## 实现边界

新增主机模块 `scripts/deploy/byok-d1-access.mjs`，只操作既有账户下固定 gateway / recovery-control 的 workers.dev 开关、两个既有 Access app 的固定单一策略，以及本次 run 的临时 Access service token。不提供任意 URL、资源 ID、SQL、部署、应用整体更新、tail、新 Worker / 数据库或生产写入能力；没有可直接执行云操作的 CLI。

单次创建固定 run 名称、请求时限为 `1h` 的临时令牌。先完整检查分页，拒绝名称碰撞；列表每页最多 1,000 项、总共最多 20,000 项，创建前预留新令牌所需的一项空间。创建结果中的 ID 在后续日志确认前保留，client ID / secret 仅返回调用者内存，不写日志或快照。服务端创建响应、独立列表读回与主机日志 ACK 是不同确认点。

Access 只允许从 deny-everyone 改为本次单一 service-token 的 `non_identity`，随后独立读取应用确认。保持应用其他字段不变，不开启 `service_auth_401_redirect`；worker 开启前后都验证 Access，preview 始终 false。策略关闭同样核对固定 app ID / audience / domain / destination / 唯一 policy ID，再写固定 deny-everyone 并独立读回。

新增 journal 步骤 `create-token`、`open-controller-access`、`open-controller`；全部写操作之前使用原有排他目录和 PENDING 刷盘。开启 gateway 必须先确认预检、关闭观察、令牌创建及 Access ACK。开启 controller 还必须先完成十用例验证、STOP、封闭数据库围栏、关闭 gateway 与其 Access、fresh 关闭观察和 maintenance permit；controller 仅承担清理。可信完整操作器提供的同步 `assertReady(step)` 在每次开启类写入前重新检查部署身份、套餐、许可剩余时间和预算，Promise 不能冒充通过。**本模块不生成这些证明**，journal 步骤名字本身也不是完整预检。

每个操作整体最多 60 秒、48 次 HTTP；单响应最多 2 MiB / 4,096 次读取，请求正文最多 8 KiB。使用单调时钟检查和取消信号，拒绝重定向、非 JSON、坏长度、失败 envelope 和不完整分页。错误只给固定类别，超时后的响应取消释放，不继续下一条写入。没有自动重试，跨对象重建不能恢复凭证所有权或重发步骤。

`contain()` 在当前操作结束后，分别尝试关闭两个公开入口、关闭两个 Access 策略并撤销自有临时令牌；一个失败不阻止其他步骤。已尝试步骤不重发，即使日志刷盘失败也保留独立关闭机会。不会 STOP / 封闭 D1 / 清理数据，这些仍由既有独立模块承担。

令牌创建 ACK 丢失时，仅能基于创建前无同名项、确实尝试过创建，以及当前完整列表中的唯一精确 run 名称，寻找待撤销项；不接管创建前同名项，不猜测重复项，不删除替换 ID。创建不明且当前列表为空时，**不能排除远端晚到创建，因此撤销仍记为未确认**。进程崩溃后的自动恢复未提供；不能删除主机排他占位后另起一轮。

未知开启写入也可能在远端晚到。即使关闭请求均有 ACK，`contain()` 仍不证明云端静默、不授权数据删除，也不会消除 journal 的 poisoned 状态。必须由后续完整操作器独立重新观察；本轮没有宣称解决这类分布式顺序问题。

## 本地验证与未复现异常

- 最终 Access 源码 **59/59**，同源 Node bundle **59/59**。
- 相关回归 **243/243**：主机日志 18、安装链 52、管理适配器 40、主机用例 42、清理调用 22、入口关闭观察 28、Images SSE 成功边界 41。staging TypeScript 检查通过。
- 覆盖完整合成开启/清理/关闭顺序、固定资源漂移、开启顺序、许可失效、分页缺失/重复/变化、空分页、满额拒绝、创建/策略 ACK 丢失、写 ACK 但未生效、跨对象重放、日志 fsync 故障、独立失败收尾、坏响应、超时、取消和零字节 chunk 洪泛。
- 本机 Windows Node 24.14.1，模拟管理 API；没有 native Access、Workers 或 D1 验收。es2022 打包不是 Node 22 实测。Worker 入口/配置本轮未改，未重复 Wrangler dry-run；没有运行完整 npm hook 链或远端 CI。

首轮源码/打包各 55 项通过，但既有安装测试出现 **45 PASS / 6 FAIL / 1 CANCELLED**：部分期待 503 的路径得到 409，一项取消检查未命中，两实例竞争等待超时。安装器、gateway 和安装测试源码均未改。后续同源码带时钟/409 分类观测的 52 项通过，常规最终复测也 52 项通过；另 20 次独立诊断的 JS/SQLite 秒级时间一致且均进入预期批次 guard。**首轮异常原因未确认，不把复测通过写成根因已修复**；后续预检/原生准入仍保留这一限制，不放宽时钟或取消规则。诊断脚本初次相对路径错误在执行前退出，修正后才运行，没有数据库/网络副作用。

首轮失败报告、TAP、修改前 Access 源码及诊断均保留。最终回执为 `.wrangler/staging/byok-access-v267-local-final/result.json`；机器清单为 [v267 manifest](./C02-byok-d1-access-v267-results.json)。修改前核验 12,626 条普通摘要和八条链接目标；只归档并映射变更前的 journal 文件，不改写旧 manifest。真实项目的 BYOK 执行占位未创建。

## 官方依据与授权状态

使用 Cloudflare 技能约束固定资源、API token、禁用写入重试及独立读回，查询了[Access policy 更新](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/subresources/policies/methods/update/)、[Worker subdomain 开关](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/create/)、[service token 创建](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/service_tokens/methods/create/)、[完整分页](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/service_tokens/methods/list/)与[令牌删除](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/service_tokens/methods/delete/)。Firecrawl CLI 不可用，直接读取官方文档；没有账户管理 API 调用。

本轮云管理请求、公开 Worker 请求、部署、实际凭证创建、D1 写入、模型/KMS 和生产写入均为 0；无新增云资源。最后完整云观察仍 v257；v264 完整代码读取失败保留，不以本轮合成测试替代。公开 HTTP 累计 422；首轮累计 **US$2 不重置**，US$1.20 历史/延迟预留及 US$0.80 未分配预留不变，二者不是实际剩余额度；最终账单和实际套餐资格未确认。

## 后续有限顺序

1. 接固定现有资源的部署适配器与完整操作器，把预检、候选部署/身份、安装、基线、用例、STOP、封闭、许可、清理、最终独立回读串起来；禁止散调用模块替代操作器。
2. 处理双轮 55 次关闭观察的时延、维护许可时间窗口，以及独占结束后的受控恢复。Access 写后完整应用摘要需重新记录，不能沿用旧 updated_at 摘要；默认保留关闭围栏和关闭入口，不自动恢复其他实验。
3. 冻结完整候选，追踪本轮安装测试异常，重新取得完整代码/版本/隔离/套餐/预算预检；满足条件后才执行已授权的独占 staging 原生验收。不自动升级套餐，不重放未知/失败 fixture。
