# C02.B2.2 — 原生执行终止探针准备与权限复核

2026-09-07；Checklist v1.64。**本轮完成本地探针准备和 staging 只读权限复核，尚未发布或执行原生终止实验。** 上一轮 [6 次普通 Images 端到端恢复](./C02-staging-images-recovery.md) 的成功不扩大到本轮终止场景；C02.G、生产恢复开关和完整容量门禁仍未通过。

## 权限与基线

用户确认权限补齐后，2026-09-07 10:07:53–10:08:16 UTC 共做 15 次 Cloudflare 管理 API 只读检查，全部 HTTP 200 / success=true：四个 staging Worker 的 subdomain、custom domains、schedules 各一次，两个既有 Access 应用各一次，独立 staging D1 的身份一次。四个 Worker 的 workers.dev / previews 均关闭，域名和 Cron 列表为空；两个 Access 应用仍为单条 deny-everyone 策略，service-auth 401 模式关闭。D1 名称仍为 `cinatoken-staging`、UUID `6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1`。

这证明上述读取操作可用，不表示枚举或实际验证了全部写权限。本轮未发送部署、Access 写入、SQL、模型、KMS 或生产 API 请求；没有重新核验生产指纹、D1 schema 或表计数，不把 v1.63 的观察冒充本轮读数。开始编辑前，v1.63 的 80 个源文件摘要全部一致；本轮只改动 5 个 staging 源码/测试文件（2 个在原摘要集合内，另外 3 个既有故障文件本轮补入摘要；新集合共 83 个），不改财务算法、正式入口、配置或 SQL 草案。文件摘要及命令结果见 [JSON 证据](./C02-staging-native-abort-preparation-results.json)。

## 机制与实现边界

按 Workers 最佳实践先检索当前平台类型和实现：2026-09-07 下载的 Workers types `5.20260907.1` 中 `ExecutionContext.abort(reason?)` 存在；Cloudflare 的 [workerd 声明](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/global-scope.h) 和 [原生实现](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/global-scope.c%2B%2B) 表明它中止当前执行上下文并终止当前 JavaScript 执行。[IoContext 实现](https://github.com/cloudflare/workerd/blob/main/src/workerd/io/io-context.c%2B%2B) 将 context abort 和 isolate abort 分开。该原生实现证据不等于目标线上部署已经验证可用；通用 [Context 文档](https://developers.cloudflare.com/workers/runtime-apis/context/) 此次检索没有说明该方法。

因此只将其命名为“原生执行上下文终止”，不称为整个 isolate 被回收，也不替代部署切换、平台维护、OOM/CPU 限额、Durable Object 重启或其他 host 生命周期证据。

- 在现有 staging 故障合同中加入两个有限模式 `before-abort` / `after-abort`。沿用最多 190 字符的严格 UUID header、精确合成租户与一次性 armed 行；不接受任意延迟、SQL、目标或异常消息。
- 当前请求的 facade 只匹配该合成租户的真实关键记账 batch。提交前终止不发出该 batch；提交后终止必须先等待真实 batch 返回。
- 在调用原生方法前，CAS 写入 `abort-requested-before-commit` / `abort-requested-after-commit` 标记。标记只证明到达调用边界，不能单独证明终止成功。
- 保留原生 context 作为方法 receiver；不借用其他请求的 context、不加入全局可变状态。缺少原生方法时在网关准入前拒绝；返回的模拟方法必须抛出明确的 `NATIVE_ABORT_RETURNED` 实验失败，不能走成功分支。
- 现有 release/fail 模式不变；生产入口仍不导入 staging facade，恢复仍只能由可信服务器组装显式启用。没有重新推理、自动退款、改写租约或放宽生产开关。

## 本地验证

新增 14 项测试：两个模式的合同和能力检查；提交前后真实 SQLite 顺序、receiver 保真、返回模拟函数失败、未 armed/其他租户/所有权变化、请求内一次性及跨 facade 不可重放；完整 staging handler 在无原生能力时于准入前拒绝。测试中的抛错 spy 明确不是原生终止证明。

定向命令 `node node_modules/tsx/dist/cli.mjs --test packages/proxy/scripts/staging/images-storage-fault.test.mjs packages/proxy/scripts/staging/images-recovery-worker.test.mjs`：52/52 通过，退出码 0。`npm run typecheck:images:staging -w @octafuse/proxy`：退出码 0。完整 `npm run test:images:staging -w @octafuse/proxy`：47 + 8 + 163 + 39 + 65 + 88 + 24 = **434/434 通过**，最终退出码 0，无失败、取消或跳过；最后 24 项进程退出/恢复测试实际结束，耗时 198,318.9152 ms。详细结果见配套 JSON。完整 Core 类型检查本轮未重跑，历史 32 条诊断仍保留。

Wrangler 4.127.1 离线 `deploy --dry-run` 通过：3,801,510 字节 JavaScript，3712.41 KiB / gzip 669.10 KiB；未执行发布。沿用既有关闭入口的 staging 配置，用绝对 outdir 输出到 `.wrangler/staging/images-recovery-v164/bundle`。重新生成严格绑定类型后，9 个绑定的完整定义与已有生成文件逐字相同；未手写 Env 或更改依赖。Wrangler 提示可更新至 4.129.0，本轮未进行工具升级。

## 下一轮云端有限顺序（计划，未执行）

1. 单独实现原生终止实验的对账器；不要直接复用 v1.63 `before-fail` 的 pending/revision=2 断言。锁定新源码、关闭入口配置、现有四个部署版本、完整 schema/计数、生产只读指纹和预算边界。既有三份草案不得重放 ALTER。
2. 离线校验完成后仅发布 staging Gateway。用临时 Access 身份和新 UUID 合成租户，串行发送 generations/edits × normal/before-abort/after-abort 六个小请求。缺少 native abort、探针未命中、出现可捕获失败路径或不明数据变化时，不宣称通过、不自动重试 Images。
3. 对每个终止样本收集有界平台异常证据、客户端状态/EOF/网络异常、精确 probe/request ID，以及实际 D1 账务投影。客户端可能在后台终止前已收完响应；不能要求所有终止样本必然返回 500，也不能将 HTTP 200 当作恢复通过。
4. 提交前样本应保留 revision=1 / attempts=1 的 leased 任务与完整快照，没有日志/回执/扣款；不能发生 ordinary catch 的 pending/backoff 转移。提交后样本应已经由同事务回执触发器完成记账和任务 committed（revision=2），不能假设它仍是 leased。正常/提交后共 4 份账务，提交前仍保留 2 份预留。以上均是待验证预期，不是实测结果。
5. 先关闭 producer 入口并撤销合成 API key，再用真实 D1 时钟等待到期；不改 available_at/租约或补造快照。独立 DB-only 消费者应补齐两个提交前样本，预期新 receipt lease_revision=2、任务最终 revision=3 / attempts=2；重复 RPC 的全部账务投影必须不变。请求尝试事实、统计分片、快照 hash/事件时间一并对账。
6. 按既有顺序关闭入口、禁用 token、取消 service-auth 401、恢复 deny-all、删除无引用 token。成功后核验无活动租约并精确清理本轮合成样本；失败时先保留证据并确认入口关闭、host 窗口结束与 D1 租约已真实到期。已到期的 leased 行不等于仍有活动 owner，不得为满足旧脚本断言而伪造 pending/committed。无法证明无在途执行时暂停数据清理，禁止删除真实账务。

## 费用与剩余门禁

本轮公网业务/保护探测 HTTP **0**，累计仍为 **148**；只读管理 API 15 次。SQL、真实模型、KMS、部署、生产写入均为 0。离线 Wrangler 内部版本检查等请求不计入上述管理 API 数。首轮累计新增费用上限 **US$2 不重置**，最终增量账单仍未核验；本轮没有创造充值或新付费服务授权。

下一步仍为 C02.B2.2 的真实 Workers 终止恢复验收。本轮只是 `LOCAL_PASS` 探针准备，不关闭原生平台终止/确认不明、并发 fencing、最大快照/完整物理容量、SSE/取消/失败、client unknown/幂等或 Node 22 门禁。采用 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) 保留私有 binding、请求所有权与独立持久化恢复；`waitUntil` 不被当作永久存活保证。
