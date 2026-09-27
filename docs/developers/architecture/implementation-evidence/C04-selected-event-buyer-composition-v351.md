# C04.5 选中共享 Key 门禁与买方 critical writer 组合（v351，2026-09-25）

状态：**本地 review-only、默认关闭**。没有远端 SQL、正式迁移、生产凭据或部署。

## 组合结论

[独立原生夹具](../../../../scripts/db/cutover/postgres-shared-key-selected-event-buyer-v351.native.test.mjs) 在隔离 PostgreSQL 18.6 中安装正式 PG73、v339 quote/attempt/outbox、后续 v2 debit/receipt、v346 买方权限拆分和 v347 买方 LOGIN 生产者，然后显式安装 [v351 门禁](../../../../packages/core/migrations-proposals/postgres/shared-key-selected-event-gate-v351.sql)。

实际 `recordUsage` 使用普通 runtime repositories 读取价格与用户事实、独立 `cinatoken_gateway_buyer_settlement` 客户端完成 critical write。选中 `provider_key_id='sharedkey:v2-key'` 的日志、买方扣款、v2 typed event 和 quote attempt outcome 在一个已确认事务中提交；同步旧卖家收益没有执行。直接使用买方 LOGIN 调用真实 `insertRequestUsageAndChargeTxPg`，但省去经济事件的旧式写入，在 COMMIT 时收到 v351 `shared_key_selected_event_required_v351`，日志和预算更新都回滚。普通 runtime 无法使用买方财务写权限。夹具还回归 v2 `none`、零用量预约和错误事件全回滚。

公开 Chat handler 的本地 Hono 回环现覆盖有限额度已耗尽、`budgetMax=null` 和聚合报价为零三种默认关闭的 quote 路径。三者都返回带 `gateway.budget_exceeded` body/header 的 402；实际 PostgreSQL quote claim 保留一行，异步 buyer writer 提交一个 `none`／零扣款的 typed v2 event，观察到的 handoff 仅为 `claimed_only`，推理 fetch、普通预算预约和用户扣款均为零。较早共享 Key 已到 fetch 边界、费用未知而最终转向非共享 Key 时，旧夹具曾接受 `actual` 买方扣款；当前代码会在买方日志或 event 写入前拒绝此缺少 `reserved` 扣款的 handoff。

[v357 精确选中 attempt 门禁](../../../../packages/core/migrations-proposals/postgres/shared-key-selected-attempt-identity-v357.sql)在上述组合之后安装。真实 `recordUsage` 将其选中的 quote attempt ID 写进买方日志的 `route_trace`；延迟数据库触发器要求该 ID 与同一请求的不可变 quote attempt、最终 `route_target_id`、选中共享 Key 和 typed v2 event attempt 精确一致。`actual` 买方扣款还要求该条选中 attempt 有 actual 用量、四类 token 数与买方日志相等、`raw_usage` 的 SHA-256 与事件证据相等；同一 Key、同一路由下更早的 `claimed_only` attempt 不能冒充最终选中项。提交后对日志的选中引用或路由目标的修改被拒绝。买方 critical writer 的经济事件重放还核对选中 Key、最终路由目标和完整 route trace，防止同一 request ID 换用另一有效 attempt 被误认为幂等成功。它固定的是买方写入的精确引用，物理 fetch 的最终目标仍须由凭据持有者证明。

v340 生产者为了函数调用授予 runtime 对经济 schema 的 `USAGE`，尽管不授私有事件表直接读写。v351 预检现改为拒绝该 schema 的 `CREATE` 和事件表直接读写权限，因此能在 v347 角色栈后安装，同时仍阻止 runtime 替换函数或自行写事件。

## 验证

```powershell
$env:GATEWAY_NATIVE_PG_BIN='C:\cinagroup\cinatoken\.wrangler\staging\pg-native-v292-binaries\extracted\pgsql\bin'
node --import tsx --test scripts/db/cutover/postgres-shared-key-selected-event-buyer-v351.native.test.mjs
node --import tsx --test scripts/db/cutover/postgres-shared-key-selected-event-gate-v351.native.test.mjs
```

[组合报告](./C04-selected-event-buyer-composition-v351-results.json)：**1/1 测试、29/29 阶段 PASS、cleanup PASS**，包含 v357 门禁默认关闭、精确选中引用、两个真实同 Key／同 route attempt 的重放冲突、买方 token 与事件证据摘要不符的回滚。[门禁报告](./C04-selected-shared-key-event-gate-v351-results.json)：**1/1 测试、14/14 阶段 PASS、cleanup PASS**。两份报告包含当前 SQL 和各自夹具的 SHA-256；组合报告还固定真实 critical writer、`recordUsage`、Chat handler 与报价捕获代码的哈希。

## 尚未证明

这项组合证明本地直连 buyer LOGIN 的真实生产者可以通过门禁，不能证明 Worker/Hyperdrive 凭据隔离、请求作用域关闭、生产迁移次序或真实供应商账单。Chat 回环注入了合成认证 Key 与 repositories，未运行公开 API 的认证中间件；夹具也临时授予旧 runtime 预约列权限，随后撤销并复验。较早共享 Key 尝试后回退自有 Key 的费用仍需 `reserved` 预约和后续账单调整，当前仅证明无预约时拒绝 `actual` 写入。v357 只能证明买方日志与事件中的精确引用一致；同一 Worker 仍可在没有独立派发授权的情况下伪造 route trace 或使用另一供应商凭据。门禁没有独立发送、支付或收益入账能力。完整 C04.5 与 C04.1–8/G 仍开放。
