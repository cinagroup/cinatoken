# C04 `recordUsage` 到 v2 经济事件桥接（v346，2026-09-25）

状态：**review-only / 默认关闭**。本轮没有修改正式迁移、部署配置或生产入口。应用未注入 `createPostgresSharedKeyEconomicProducer()`；单独设置报价开关或单独注入经济生产者时，Chat/Completions 在读取请求正文、发送上游请求之前返回 503。

## 实际接线

- Chat 将选中结果的精确报价引用连同整条请求的报价、发送边界和每跳结果交给经济生产者。选中共享 Key 却没有报价引用时拒绝走旧收益路径。已 claim 后普通用户预算在建立预约前拒绝时，delegated `RequestBudgetAdmissionError` 的 402 结果也带回该次局部报价引用；Chat 用它写入 `none/unknown`、零扣款的完整事件，不从其他 attempt 的捕获顺序推断引用。
- review-only 适配器调用真实 `recordUsage`。它从本次计算的 `chargedCost` 与普通用户预约结算推导 v2 买家依据，并把所有已捕获共享 Key attempt 放入同一个 `insertRequestUsageAndChargeTx` 调用；PostgreSQL critical writer 在该事务中提交买家预算、请求日志与经济事件。此分支提交后不再调用旧 `settleSharedKeyEarning`。
- `reserved/unknown` 只来自普通用户未知费用预约。`actual/actual` 要求与原始供应商用量严格匹配：选中共享 Key 时还要匹配该 attempt 的原始用量 SHA-256；较早共享 Key 失败、最终非共享路由成功时，买家可以使用最终路由的明确原始用量，同时较早共享 attempt 的用量与供应商成本保持 `unknown`。同时出现的 token 字段别名若互相矛盾则拒绝。普通预约 `actual` 零扣款也必须有供应商明确报告的零用量；只有零 charge 且无普通预约时可使用 `none/unknown`。
- 供应商成本没有被估算成实际账单。即使买家用量与扣款已知，各共享 Key attempt 的 provider cost 仍为 `unknown/null`。

## 验证

- `npx tsx --test packages/proxy/src/services/shared-key-economic-usage-handoff.test.ts packages/proxy/src/services/shared-key-quote-attempt.test.ts`：**20/20 PASS**。覆盖精确引用、402 admission 拒绝时返回同一引用且上游零发送、2xx 实际用量、普通预约实际零扣款、非共享终局、别名冲突、错误摘要与缺少报价角色的发送前拒绝。
- `npm run typecheck -w @octafuse/proxy`：**PASS**。
- `GATEWAY_NATIVE_PG_BIN=... node --import tsx --test scripts/db/cutover/postgres-shared-key-economic-producer-v2.native.test.mjs`：隔离 PostgreSQL 18.6 **1/1 测试，18/18 阶段、cleanup PASS**。[机器报告](./C04-record-usage-economic-bridge-v346-results.json)包括真实 `recordUsage` 写入买家日志和 v2 事件、旧收益查询调用为零、最终非共享路由的买家 actual 与较早共享 attempt seller unknown 分离、供应商报告零用量的普通预约实际零结算，以及故意提供错误报价版本后买家日志／余额／事件一同回滚且旧结算仍未运行。新增真实 `handleChatCompletion` Hono 回环在用户预算 `budget_max=0` 且无预约行时返回 402，上游 `fetch` 调用零次；同一 request 的 claim、buyer log、v2 `none/unknown` 事件各一行，买家扣款零、余额不变、旧收益查询零次。已建立后释放普通预约行的定向负例被 v2 SQL 的 `shared_key_economic_producer_buyer` 约束拒绝，买家日志和事件一起回滚。夹具使用 73 条正式 PostgreSQL 迁移及截至 v343 的 review-only 经济提案；v344 扣款回执与后续投递集成由独立夹具验证。

当前源 SHA-256：`usage-tracker.ts` `ced9a0e19edb5495b4897e38a6f89bc884d9fcc365502e28fbc90ee22c93ffa5`；`shared-key-quote-attempt.ts` `8b53eb78be9ef1568d5b3f4a3a7d3bb0429c5c06f340bd0f0352cf6e16205cf5`；`provider-usage-facts.ts` `71513bd2d3695135b459d466d206f5b716cce47294daeeb698c041ef08a68e9b`；`chat.ts` `a1f313b1f2461098fc10785821fe8f785baff2e85446b07509fdd47c69d83e0a`；`failover-dispatch.ts` `fa146e377af41d144b2e1ae1f83a057b0714c3f07001b520a111868222897803`；原生夹具 `4f43a332191c2aa253b0f5255b2a7bddda2dde26512b718d8b063949712cc2d3`。v345 Chat 用量事实与 v343 生产者文档中的旧 SHA 是各自执行时的历史快照，不能代表本轮改后的当前源码；旧结果不作改写。

## 保留门禁

本次闭合范围严格限于 claim 已提交、普通预算在插入预约行前拒绝、且 Chat 仍进入末尾记账的路径。若普通预约先建立，而 Guardrail admission 随后拒绝，补偿释放成功会留下 `released` 行，v2 SQL `none` 要求完全没有预约行；释放失败则可能保留 `reserved` 行。定向原生负例证实前一种情形会拒绝整个 critical write，这两种状态都尚无可信买家依据与终局策略。其他 Chat 提前返回、异常、明确非 2xx 零结算或无法验证最终非共享用量的已 claim attempt 也尚不能保证有买家日志和经济事件。它们需要持久孤儿 attempt 恢复与明确的买家依据／收费政策，不能靠拒绝后静默丢失事件。当前应用仍不注入适配器；测试中的供应商原始用量是合成响应，PG runtime 当前仍有直接资金写权限；真实 Workers、Hyperdrive、Queue、角色切换、完整成本账单、旧路径过渡、生产锁窗及 Linux CI 均未验证。C04.1–8／G 继续开放。
