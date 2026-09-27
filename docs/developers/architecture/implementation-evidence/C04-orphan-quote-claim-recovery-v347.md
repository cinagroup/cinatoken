# C04 v347：已提交 quote claim 的孤儿恢复边界

2026-09-25。**Review only，默认关闭；没有自动扣买家、结算卖家或部署。**[原生夹具](../../../../scripts/db/cutover/postgres-shared-key-orphan-claim-v347.native.test.mjs)的[机器报告](./C04-orphan-quote-claim-recovery-v347-results.json)固定本轮 PG18.6 运行和源码 SHA。C04.2、C04.3、C04.G 继续开放。

## 源码逐路径审查

| 边界 | 当前持久事实 | 离开请求时可能丢失的事实 |
| --- | --- | --- |
| [`claimPostgresSharedKeyQuoteAttempt`](../../../../packages/proxy/src/services/shared-key-quote-attempt.ts) 提交后、调用方得到引用前 | append-only attempt、报价版本、seller、Key 和 route target | COMMIT ACK 不明或返回身份校验失败时，request-local capture 可以为空；函数明确禁止继续发送。独立 SQL 连接关闭失败也不能证明 claim 回滚。 |
| [`failoverDispatch` delegated `beforeFetch`](../../../../packages/proxy/src/services/failover-dispatch.ts) | claim 在预算 admission 和 dispatch budget consume **之前**提交 | 预算／Guardrail 拒绝、admission 非标准异常、deadline／dispatch budget 停止时，网络可能尚未发送；request-local `claimed_only` 不在 claim 表中。[预算协调器](../../../../packages/proxy/src/services/request-budget-admission.ts)的 Guardrail 拒绝可能发生在普通预约已插入且须补偿释放之后；释放失败又会改写终态。v346 bridge 已在无预约普通预算拒绝路径把精确引用传给 Chat 后台记录器；其他异常或已建立预约的状态仍可能成为孤儿。 |
| `fetchBoundaryPermitted` 后至响应头 | 仍只有同一 claim 行 | 传输结果、是否发出字节、是否产生供应商费用。超时、客户端取消、socket 错误只会在内存标为 `transport_ambiguous`；`RequestExecutionStoppedError` 向上抛出。 |
| 响应头、stream 用量采集、模型 fallback 之后 | 若尚未进入买家 critical writer，仍只有 claim | 2xx/非 2xx、原始 provider usage、每跳 unknown/actual、最终 route；这些在 request-local capture 或 Promise 中。最终成功的聚合用量不代表较早 Key 尝试的成本。 |
| [`handleChatCompletion`](../../../../packages/proxy/src/routes/v1/chat.ts) 的终态后台记录之前／之中 | claim 已独立提交 | dispatch 异常、响应 materialization 异常、output Guardrail 异常、进程终止、后台任务丢失或 critical writer 回滚，都可能使日志与 v2 经济事件缺席。错误 catch 仅处理预算清理，不持久化 quote claim 的终态。 |

现有 [`shared-key-economic-outbox.sql`](../../../../packages/core/migrations-proposals/postgres/shared-key-economic-outbox.sql) 只在**买家日志与经济事件同一 COMMIT**时保证 attempt 覆盖。无日志孤儿不满足此触发器的前提。经济事件的写入触发器又要求买家日志已存在，不能把事后插入的零金额事件冒充原来的结算。`claimed_at` 在 claim 事务内赋值，不是 COMMIT 时间。一个扫描时尚未提交的旧时间 claim 可在扫描后提交，因此纯 `(claimed_at, attempt_id)` 水位会漏检。

## 原生可复现反例

在自有 loopback PG18.6 上安装 **73/73** 正式迁移及 review-only quote、dispatch claim、v1 economic outbox，使用专用 quote producer LOGIN 与合成 Key。结果 **1/1 测试、10/10 阶段、cleanup PASS**：

- 真正调用 claim + failover，分别模拟预算拒绝和非标准 admission 错误，均零发送；后者向上抛出，claim 留在数据库但没有日志、经济事件或旧收益。
- 模拟 DB 已 COMMIT 但调用方未获 ACK：capture 没有引用、零发送，数据库仍有 attempt。
- 获准发送后 deadline 异常在内存成为 `transport_ambiguous`；另一个路径观察到 200 响应头后模拟 recorder 丢失。两者的持久经济事实与零发送路径同样缺席，不能由 claim 推导费用。
- Migrator 的只读 census 找到上述五个无日志 claim；它只能标成**待查**。长事务在 cutoff 前写入 `claimed_at`、扫描时不可见、cutoff 后 COMMIT，证实时间水位漏检。无日志时手工插入经济事件被 `shared_key_economic_log_required` 拒绝。

报告固定 SHA-256：PG73 corpus `23afef61a8a670e0af8c90e3a138f522e6b283b454e380a592bf85bca83108dc`；quote SQL `1249a7ff07f95b48c7b45a41833c96c9a028e4bfe3a47e44e9dc6b72c3c77246`；claim SQL `c89c79e803fd69a2d09d44b33be3301aeb8aa4ed72c5dff5518439ec29fafb83`；economic outbox SQL `f92835c72ff02cba23879ed90ad640832455ccb98764f28fe4ee04ce52aab1ac`；本夹具 `d239258d8f953875c801e3c0f160ff77c1aa7875d9cbc0a7fdab06871fa8dd59`。

## 恢复合同与阻断

1. 只读发现器可用 migrator 权限重复枚举已提交 claim、按 request ID 分组，并左连接 buyer log、v2 event 和旧收益。年龄阈值只能决定**何时检查**，不能决定“未发送”或“零费用”。当前表没有 commit-safe 扫描游标；实现增量扫描前，需增加可信事务序号／提交可见性围栏，或以有界重叠／全量重扫加持久覆盖证明避免漏检。
2. 每个候选请求在同一个 READ COMMITTED 事务中获取与 claim／日志相同的 request advisory lock，重新读取全部 attempt、日志及事件，再写独立的、幂等的 **unresolved/manual-review 工作项**。工作项只记录发现和重试状态，保留原 quote ID，不修改 append-only claim；lease、重领、死信、保留期及运营审计需要单独定约和原生并发验证。不能在持锁后只凭无日志就宣称请求最终不会恢复。
3. 生产者须在跨进程可恢复的持久介质记录 admission 结论、pre-fetch stop、transport 模糊性和每跳原始用量／供应商账单证据，并覆盖 Chat 的每个异常、提前返回及后台写入失败。若能证明没有网络发送，可把尝试关闭为 `confirmed_no_egress`；否则维持 unknown，不能把 429、超时或缺日志推成零。任何真实费用须有经核实的买家补正／卖家结算协议，含同一 request/attempt 幂等键、重复支付排斥及审批审计。
4. 当前 v1/v2 economic event 的同事务买家结算约束阻止**事后补造原事件**。因此本轮没有新增 SQL finalizer：缺失的是可信跨进程发送／usage 事实和授权的晚到 adjustment 合同，不是一个按时间扫表的 SQL 函数。自动买家扣费、seller credit、供应商成本推断及 claim 删除均保持禁止。

这份证据没有运行远端 SQL、Workers/Hyperdrive 或真实 provider 请求；夹具故意在几个边界放弃 request-local recorder，证明即使 v346 正常终态桥接修复，崩溃／异常路径仍要独立恢复。
