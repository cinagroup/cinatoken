# C02.B2.2：不可变结算输入与原子回执（本地基础）

2026-09-07，子集 LOCAL_PASS；C02 DOING，C02.G / 完整恢复与容量未通过。Owner / 自检：Codex；独立 Reviewer 未指定。当前 HEAD 与源码摘要见 [结构化证据](./C02-usage-settlement-local-results.json)。没有部署、远端迁移或真实模型/KMS 调用。

## 1. 本轮实际交付

- [版本化 codec](../../../../packages/core/src/storage/recovery/usage-settlement-codec.ts)：保存完整的原 D1 critical-write DTO，包括实际计量、原定价审计、金额、归因、尝试事实及预算结算输入；规范化 JSON + SHA-256 标识同一内容。类型字段白名单随 DTO 编译检查；异步前复制，不在等待后重读调用方可变对象。
- [D1 仓储](../../../../packages/core/src/storage/recovery/usage-settlement-d1.ts)：按 user/key/workspace/request/digest 保存和读取；只接受与已 claimed / unknown 的耐久意图一致的最终 attempt/claim/context。结果持久化的确认丢失可精确回查；没有重新授予 dispatch 权限。
- [critical write 的可选参数](../../../../packages/core/src/db/d1/critical-writes.impl.ts)：只在新入口显式传入时，将唯一回执作为原 batch 的第一条写入。原日志、尝试、统计、普通预算/Guardrail 与审计仍使用原事务。默认调用不访问新表、不改变已有财务规则。
- [SQL 草案](../../../../packages/core/migrations-proposals/d1/request-usage-settlements.sql)：不可变输入表、提交回执表、归属 trigger、关联唯一约束和外键。位于 migrations-proposals，依赖上轮意图草案，不属于 68 份正式迁移，也不通过正式 schema 门禁。

回查不仅查同 id：要求快照摘要、租户/Key/Workspace、模型/供应商、operation、金额、预算 micros 和原事件时间匹配。旧路径仅凭 reservation + 同 id/金额返回，也必须再经过新回执核验；没有回执的 legacy log 不自动认领。重复或并发处理同一输入仅能有一个 batch 提交，其他调用回查后确认；中途任何 SQL 失败会连同回执一起回滚。

恢复固定日志创建时间、统计归属日期及预算窗口的缺省事件时间；账户/预留记录的处理时间仍取实际执行时刻，不把旧事件时间写回实时账户 updated_at。原预算 epoch、过期后迟到 actual 和一次竞争重试规则复用；未增加退款、卖家收益或 unknown 财务终结规则。

## 2. 明确的边界

这份载荷是**结果后的完整 critical-write 输入**，不是完整的调度前报价、权益版本或 credential owner 冻结合同。它能够重做现有用户用量事务，不能凭空重建尚未持久化的模型结果，不能代替 C04 卖家收益快照/outbox。

当前技术限额：规范化 JSON 最多 256 KiB；rawUsage/pricingAudit 各 64 KiB；其余 JSON 审计字段各 32 KiB；一般文本 512 字节；树深度 8、节点 4,096、数组最多 128。复用 providerResponses 的 32 条/32 KiB 和既有尝试事实校验。身份与最终 attempt 沿用意图草案的 1–32 边界；它不是新推理次数许可。超限拒绝，不静默截断财务事实。

requestBody/upstreamRequestBody 必须为 null，未知顶层字段和访问器被拒绝。保留既有审计 JSON 和允许的元数据；**codec 不是内容脱敏器**，JSON 内可能仍有现有业务元数据/个人信息。未来生产者必须先提供可信、已脱敏且符合留存政策的审计投影，不能直接接受客户端提供的结算 JSON，也不能把摘要当鉴权。这里没有新增 HTTP API、实际凭据、正文或生产个人数据。

256 KiB 限制的是持久化 JSON，不代表 Worker 内存只用 256 KiB；对象、编码和 SQL 参数持有仍需测量。没有队列、定时触发、有界恢复扫描/领取、lease/fencing、重试调度、死信状态或路由接入；只有可由新进程调用的单事件 commit。MySQL/Postgres 未实现此新路径。

## 3. 验证与失败记录

[新增专项](../../../../packages/core/src/storage/recovery/usage-settlement.d1.test.mjs) 最终 **37/37 PASS**，无跳过。原意图 19/19、普通预算 33/33、Images staging 42/42 回归通过；两项定向类型检查通过。`test:dispatch-intent` 的 posttest 接入新专项，既有 Core pretest 链会执行；本轮没有声称运行整个 Core unit suite。

覆盖：

- 68 份完整迁移后应用 proposals、外键启用与零违规、quick_check；错误 tenant/claim/operation/内容重放拒绝、输入/回执不可修改。
- 完整 DTO 规范化、重复键/非规范 JSON/坏摘要拒绝；拒绝未知 credential 字段、正文、访问器、非有限金额、错误尝试事实、无效 JSON、字段和总量超限；异步修改输入/引用不影响已持有身份。
- 零价及正数 reservation：12 个同进程并发调用、重复消费者、回执/log/stats/attempt/audit 写前失败；预算已经变更后的 Guardrail 失败仍整体回滚。
- 提交后 ACK 丢失可立即回查；回查也失败时不会报告成功，后续新仓储确认一次入账。legacy log 无回执、单独伪造回执或错误日志身份/金额不能视为完成。
- 原事件跨日归属不变；沿用旧预算 epoch 保护，过期竞争后的迟到 actual 仍单次结算；不读取当前模型价格重算。
- **八项真实子进程退出**：结果持久化前/后、最终 batch 提交前/后，各覆盖零价和正数。退出码 73，由另一子进程重新打开 test-owned SQLite 文件并 commit；提交前缺少载荷时必须失败，保留已认领意图，不重建 usage、不调用供应商。其余阶段恢复后恰好一条日志/尝试/回执、金额正确。临时文件仅固定 allowlist 精确清理，空目录移除；无用户数据删除。

第一批 29 项全通过，随后补账务回滚/周期/引用/缺表等至 36 项。自检新增“预计算预算 micros / 最终 route 与 DTO 冲突”测试曾 **FAIL（缺少预期拒绝）**，补交叉字段校验后该测试 PASS，最终 37 项全通过。保留这个红绿过程，不将第一批通过视为完整覆盖。

**完整 Core 类型检查仍 FAIL：32 条诊断。** 通过 TypeScript Compiler API 对当前完整程序重新检查，与 v1.49 保存的诊断文件/位置/代码/消息逐项完全一致；没有排除本轮修改来声称全包通过。定向检查 exit 0 不替代完整 Core 通过。

这些是 Node + 真实 SQLite SQL/事务测试，不是 workerd、Cloudflare isolate 终止、多实例并发或线上账务验收。

## 4. Workers 与外部操作

按 Cloudflare / Workers 技能采用 D1 binding、参数化 SQL、显式 await、独立请求所有的有界 JSON；复用 [D1 batch 事务](https://developers.cloudflare.com/d1/worker-api/d1-database/) 和 [主库读一致性](https://developers.cloudflare.com/d1/best-practices/read-replication/)，没有全局请求状态或 Worker 内管理 REST 调用。官方 Workers types 最新版本已只读核对为 5.20260907.1；项目依赖仍为 5.20260829.1，没有升级、新增绑定或改动运行配置。

本轮没有 Cloudflare/GCP 管理操作、发布、远端 SQL 或真实模型/KMS 调用。首轮历史 HTTP 仍 **98**、模型/KMS **0**、累计费用上限 **US$2 不重置**；最终增量账单未核验。最后已验证的 staging 关闭状态仍引用 [前轮收尾](./C02-staging-image-storage.md)，不冒充本轮重新查询云端。

## 5. 下一项及停止条件

继续 C02.B2.2：实现有界独立恢复执行的扫描/领取/fencing、重试上限/退避、冲突终态和容量持有，再把可信结算生产者/普通 Images 路由接到持久化断点，最后回到独立 staging 测试。普通 JSON 与 SSE 交付合同分开；路由接入前应核对本地技术限额与既有业务 DTO，避免隐式改变兼容行为。

上轮“5 次成功响应仅 4 条日志”的线上问题仍开放；生产容量池仍关闭，C02.G 及 C03/C04/C05 不勾选。新表缺失或校验失败时新入口拒绝，不回退无回执成功；回滚时保留已接纳输入/回执供对账，不删除或重置账务事实。现有其他 dirty 修改原样保留，无提交。
