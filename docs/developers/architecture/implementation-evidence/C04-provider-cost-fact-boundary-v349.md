# C04.2 / C05 逐跳供应商成本事实边界（v349，2026-09-25）

状态：**review-only / 默认关闭**。本轮没有供应商账单导入、正式迁移或生产开关。

`recordUsage` 的 `meteredCost` / `supplierCost` 由供应商用量、Model Endpoint 价格和路由倍率计算，是本地标价估算，不是逐跳供应商账单。[Chat 桥接](../../../../packages/proxy/src/services/usage-tracker.ts)现在要求每个共享 Key attempt 的 `providerCostCertainty='unknown'` 且 `providerCostMicros=null`，包括选中成功的一跳；若调用方构造了 `actual` 成本或在 `unknown` 下带金额，会在经济 critical write 前拒绝。较早、未选中的共享 Key attempt 也不能借最终响应的用量升级为 `actual`。既有 [capture](../../../../packages/proxy/src/services/shared-key-quote-attempt.ts)仍只对已观察 2xx 和完整原始用量的选中 attempt 记录用量 SHA-256，其余用量与全部成本保持 unknown。

定向 [Node 夹具](../../../../packages/proxy/src/services/shared-key-economic-usage-handoff.test.ts)构造同一请求先 429 后 200，两个响应都带 `usage.cost`；429 即使报告用量也不能成为该次 actual，200 的明确用量可成为买家和该次 seller 的用量事实，但两次供应商成本均为 `unknown/null`。夹具还把第一或第二次的成本篡改为 `actual`，以及在 `unknown` 下填入金额，并把第一跳用量篡改为 `actual`，均在桥接层被拒绝。`npx tsx --test packages/proxy/src/services/shared-key-economic-usage-handoff.test.ts packages/proxy/src/services/shared-key-quote-attempt.test.ts`：**21/21 PASS**；`npm run typecheck -w @octafuse/proxy` 与 `git diff --check`：**PASS**。

执行时 SHA-256：`usage-tracker.ts` `5fc27fda78922bd3e59643d9a9ae0f25281373032b20756f331d5beebebaa67d`；`shared-key-economic-usage-handoff.test.ts` `5e5643c1ac83688d52000db891a56f946097988478fe4b9a0c2e95fb859eadf0`。

保留缺口：现有 Chat 只将最终选中结果的用量对象交给 `observeProviderUsage`，不能从 429、超时或未收到响应的较早一跳推断零费用；[handoff](../../../../packages/proxy/src/services/shared-key-quote-attempt.ts)记录 attempt ID、报价引用、发送阶段及 HTTP 状态，但尚无逐跳供应商请求／消息 ID 和可验证账单映射。v2 生产者可保存调用方提供的成本确定性、金额和证据摘要，但结构校验本身不认证供应商账单。C05 仍需可信账单来源、按 attempt 的匹配规则、账单重复／矛盾／聚合差额处理，以及迟到事实的版本化调整与争议事件。本轮没有证明实际供应商费用或解决 C04.2／C05 门禁。
