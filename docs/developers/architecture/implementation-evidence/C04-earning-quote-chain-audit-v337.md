# C04 v337：共享 Key 报价与收益链只读审查

2026-09-24；**只读审查，C04.1–5/G 均未通过**。[机器摘要](./C04-earning-quote-chain-audit-v337-results.json)固定当前源码 SHA。没有业务改动、测试运行、远端 SQL 或资金写入。

## 当前事实

1. [`expandAttemptsWithSharedKeys`](../../../../packages/proxy/src/services/shared-key-pool.ts) 读取 active `SharedKeyRow`，将每把 Key 克隆为一条 route。克隆只携带 secret、`sharedkey:<id>`、标签及指纹；读取时已有的 `sellerUserId` 与四个每百万 token 卖家价格没有进入 `RouteResult`。原 route 的 endpoint／price override 留在 clone 上，但不代表卖家报价。
2. 六个公开入口 [Chat](../../../../packages/proxy/src/routes/v1/chat.ts)、[Gemini](../../../../packages/proxy/src/routes/v1/gemini.ts)、[Messages](../../../../packages/proxy/src/routes/v1/messages.ts)、[Responses](../../../../packages/proxy/src/routes/v1/responses.ts)、[Embeddings](../../../../packages/proxy/src/routes/v1/embeddings.ts)、[Rerank](../../../../packages/proxy/src/routes/v1/rerank.ts) 直接调用 `recordUsage`。它用选中 route 的 endpoint/buyer 价格计算成本，在 [`insertRequestUsageAndChargeTx`](../../../../packages/core/src/storage/critical-write-paths.ts) 写请求日志与买家预算。`routeTrace` 是 surface/pool/target 等路由审计，`pricingAudit` 是这一路的买家／供应侧成本；当前没有可被收益消费者验证的卖家 quote reference。已有 `providerAttempts` 是尝试可用性事实，不含每跳卖家报价与确定性可计费用量。Audio／Realtime 走 `recordAudioUsage`，Images 走 `recordImageUsage`，它们各自调用 critical write，**不经过** `recordUsage` 的共享 Key 收益调用。
3. [`recordUsage`](../../../../packages/proxy/src/services/usage-tracker.ts) 在 critical write 返回后才调用 [`settleSharedKeyEarning`](../../../../packages/core/src/services/shared-key-earnings.ts)。后者按 `sharedkey:<id>` **重新读取当前** `shared_keys` 行与当前 `SHARED_KEY_COMMISSION_RATE`，再计算 gross、fee、net。其三次有限内存重试与日志提交分离；缺当前 Key 或失败会遗留待补事实。正式 [`SharedKeyRow`](../../../../packages/core/src/db/shared-keys-types.ts) 没有不可改写的报价版本、权益版本、billing mode、币种、计量单位或正式生效时间。`updatedAt` 可随原行修改，不能伪称 quote version。
4. PG、D1、MySQL 的 [`shared_key_earnings`](../../../../packages/core/src/storage/drizzle/schema.pg.ts) 明细存 key/seller、token、gross/fee/net、USD 与时间，不存原单价或原佣金。PG/D1 的 0029 trigger 在收益插入事务内更新余额与 journal；MySQL repository 自己在事务中插入明细、更新余额。三者以 `request_log_id` 唯一键防止相同日志二次入账，**请求日志与收益写入仍非同一事务**。没有 typed 共享收益 outbox、消费标记或将旧同步写与未来消费者统一的经济事件幂等键。

## 最小下一步与资金边界

先在 review-only PostgreSQL 提案中定义 append-only、严格类型的 `shared_key_quote_versions` 合同与负例夹具：明确 seller/key、四价、佣金、币种、单位、billing mode、权益版本、生效区间、版本 ID，拒绝原地 UPDATE/DELETE、缺字段与版本冲突。随后才能让每个已派发 attempt 持有其版本引用，并与 usage/certainty 的 typed outbox 在请求日志事务内提交；消费者再据版本计算并沿用统一经济事件幂等键。这一步只建立可审查的数据合同，不给历史行虚构报价，不改变当前账务、不部署；D1/MySQL 对应合同、运行时选取、每跳事实、outbox/消费者与原生并发验收仍需后续完成。

仅把当前 `shared_keys.updated_at` 或 `routeTrace` JSON 改称“不可变报价”会掩盖缺失字段和后写风险。历史日志缺原始报价／owner／佣金证据时必须保持待审核，不按现价补算。[v333 历史防护](./C04-earnings-history-guard-v333.md)已在管理员入口施加这一边界。
