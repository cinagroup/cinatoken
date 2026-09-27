# C03 v310：初始化前单调截止与 DBL-05 服务端边界

2026-09-23；**LOCAL ADMISSION DEADLINE PASS，SERVER TIMEOUT NOT IMPLEMENTED，PRODUCTION DISABLED，C03 DOING**。承接 [v309 只读观察和 Queue owner 候选](./C03-postgres-observation-queue-owner-v309.md)。本轮只改默认禁用的本地候选与恢复 runner 的可选控制输入；未配置 Queue/Hyperdrive、创建数据库角色、连远端数据库或部署。

## 已实现的窄切片

[不可续期的调用截止](../../../../packages/core/src/storage/recovery/postgres-recovery-invocation-deadline.ts)由单调 `performance.now()` 或注入时钟创建，预算为 1–60,000 整数毫秒。初始时钟无效即拒绝；之后时钟倒退、非有限值或抛错均粘性 `clock_invalid`。剩余不足 1 ms 即视为到期，不会把 PostgreSQL 中表示“关闭超时”的 `0` 当成可派发预算。它仅决定**尚未开始的新工作能否准入**，不终止服务器 SQL、连接或已启动事务。

[Queue owner 候选](../../../../packages/proxy/src/runtime/postgres-recovery-queue-owner.ts)在 `openClient` **之前**创建这份截止，登记失败仍零 DB I/O；打开 client 前后各检查一次，并将**同一对象**传入 `openClient`、`startRun`。初始化已经耗尽时不启动 recovery，先等待候选退役动作；结果仍固定 `physicalClose: not_observed`。恢复已启动之后，即使截止到期，主返回 Promise 仍等待原 `run.completion`，不做 `Promise.race`、重启或推理重发。启用候选必须显式提供预算，禁用默认不变。真实 Queue 的 `busy`／`outcome_unknown`／截止诊断仍不能直接正常返回给 handler，否则会隐式 ACK；候选继续**无 handler、无绑定、不可部署**。

[PostgreSQL runner](../../../../packages/core/src/storage/recovery/run-usage-recovery-postgres.ts)新增可选的同一 `deadline` 控制输入：预算须与原 `runBudgetMs` 一致，禁止再提供第二个 `now` 重启计时；已在初始化期耗尽或时钟无效时，在容量获取、扫描与 SQL 前停止。原有不传 deadline 的路径及已启动 SQL/回调/资金完成归属未改。

## 本地验证

| 测试 | 结果 |
| --- | --- |
| 新截止对象与 runner 前置门禁 | 5/5 PASS：不可续期、亚毫秒/时钟负例、初始化耗尽零 SQL/hold、第二时钟拒绝 |
| Queue owner 原有及新增故障注入 | 11/11 PASS：初始化耗尽不启动、同一对象传递、运行中到期不提前返回、无效预算/时钟拒绝 |
| owner、观察、固定扫描目录回归 | 62/62 PASS |
| PGlite 原结算事实/原账务 runner | 31/31 PASS |
| type-only package 出口 | 1/1 PASS |
| Core recovery runner 与 Proxy 全项目 TypeScript | 均 PASS |
| 旧 v300 实际采用/构建/协议回归 | 9/9 PASS；含离线 Wrangler dry-run，不是 workerd |

现有 v308 harness 的历史源码 SHA pin 已因 v309 的 package 出口变化而不满足，且本轮又修改 runner；未把历史报告计为当前全套重跑。此处 9/9 是独立 v300 回归，不替代 v308/v307 全套验收。[机器摘要](./C03-postgres-preinit-deadline-v310-results.json)记录当前受影响源码 SHA。

## 尚未解决的 DBL-05 范围

当前截止只在 Queue 初始化边界和 runner 的高层准入点生效。`openClient` 内可能等待 socket factory/认证/TLS/初始化 SQL；owner 的 lazy `unsafe` 登记后，postgres.js 仍可在微任务、池队列、`Connection.initial` 或事务私有队列等待；驱动内部 BEGIN/COMMIT/ROLLBACK 也不经过应用的 `unsafe` 包装。注册 INSERT 后读回、claim/fail 行锁事务、事实/回执读回和资金原事务尚未逐操作接受同一截止。**已启动操作和 COMMIT ACK 不明仍归原 owner；不把超时错误当作未派发或可重试依据。** 本地准入通过不等于“全部 SQL 被服务器终止”或 DBL-05 通过。

完整服务端后备上限需要至少区分 `statement_timeout`（每条服务器命令）、`lock_timeout`（每次锁获取）、`idle_in_transaction_session_timeout` 和 PostgreSQL 17+ 的 `transaction_timeout`（整笔显式/隐式事务）。[PostgreSQL 17 参数语义](https://www.postgresql.org/docs/17/runtime-config-client.html)表明 `0` 是关闭，`transaction_timeout` 小于等于 statement/idle 时后两者较长的设置被忽略；[PG16 文档](https://www.postgresql.org/docs/16/runtime-config-client.html)没有 `transaction_timeout`，仓库 quickstart 目前用 PostgreSQL 16，所以不能默默宣称其满足整笔事务上限。[PostgreSQL 维护者澄清](https://www.postgresql.org/message-id/2164653.1758313260@sss.pgh.pa.us)：`transaction_timeout` 在事务**开始时**决定，本事务内 `SET LOCAL transaction_timeout` 不能收紧本次事务的绝对截止。短事务内 `SET LOCAL statement_timeout` 可考虑逐语句更紧预算，但它也不能代替整笔事务/本地池队列/连接建立的截止。

[Hyperdrive 事务池](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/)会重置归还连接的会话设置，因此初始化 `SET search_path` 或额外 `SET timeout` 不保证后续 SQL。独立恢复身份和数据库级角色默认值仍属**待选择/待验证设计**，不能改变共享 `cinatoken_gateway_runtime`。既有[连接预算记录](../../../operators/migrations/d1-postgres-cutover.md)显示生产实例过去曾因普通连接名额耗尽报 `53300`；新增恢复 Hyperdrive 前必须重测总连接余量，不能顺手创建。固定角色上限只约束到达服务器后的执行；精确单次绝对截止跨 Hyperdrive、事务与服务器的传播仍是未解决门禁。

下一有限顺序：确认恢复专用角色/目标 PostgreSQL 版本及总连接预算；再做每路径未派发准入与候选驱动最终派发门禁，覆盖初始化、两类扫描、注册/读回、claim/fail、资金事务/回执读回及内部 COMMIT/ROLLBACK；以原生多会话和隔离 Workers/Hyperdrive 验证 role defaults、新旧连接、锁等待、ACK 丢失、资源关闭与无泄漏。DBL-06 可信解除、Queue 持久 ACK/retry 和未知收费政策仍开放。首轮 staging 累计 US$2 不重置。
