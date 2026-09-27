# C02 — Images SSE 结果不明与重试安全合同

2026-09-08；Checklist v1.84，本地实现、尚未部署。接续 v1.83 普通 Images 传输异常修复；C02.B2.2 / C02.G 保持开放。

## 对外行为

Images generations 已接受上游 2xx SSE 后，网关生成的流内错误仍保持 `type: error`、原有脱敏 `error.message` 和安全格式的 `error.code`，随后以 `[DONE]` 终止；HTTP 已发送时不能改写成 502/504。

新增 `error.metadata`：

| 场景 | retry_safe | outcome_unknown |
| --- | --- | --- |
| 空 body、无效 JSON/事件、结构/大小/usage 拒绝、图片数越界、缺少图片/DONE/必要用量 | false | true |
| 上游流中断、网关 deadline | false | true |
| 尚无图片输出时收到含非空 message 的供应商 error | false | 省略 |
| 已观察 partial/completed 图片事件后收到供应商 error，或供应商 error 不完整 | false | true |
| 正常完成 | 不新增错误元数据 | 不新增错误元数据 |

公开入口的 `request_id` 来自网关已有 generation ID，与 `X-Generation-Id` 和日志主键一致。供应商的 metadata 不透传，客户端提交的同名请求头也不能替代它。内部调用未提供 ID 或 ID 超过 200 字符时省略，不生成虚构关联 ID；合法长度 ID 继续脱敏。

“结果不明”指网关无法完整确认本次生成/用量结果，不等于图片必然生成或供应商一定收费。`retry_safe: false` 要求客户端不要自动重放；ID 不是幂等键。没有 `outcome_unknown` 不意味着承诺零成本或可以重试。客户端已经断开、平台终止或网络丢失时，不能保证 error / DONE 被送达。

## 结算和容量边界

公开重试元数据与内部 `upstreamOutcomeUnknown` 账务标志分离。本次没有修改计价、预算释放/消费、退款、provider attempt 或耐久快照算法：属性名 / usage 容量拒绝继续保守消费原预留；其它失败与取消/超时继续原有零名义费用、零预算消费政策。新增公开标志不能被误当成新增扣费授权。

每个请求仅增加有界的可信 ID、图片输出及终止帧状态、已有短错误帧的引用，不缓存完整 SSE，不创建新的后台任务；沿用现有读取、取消、超时与结算所有权。依据 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)保持流式与有界处理。本轮已在线查询并下载最新 `@cloudflare/workers-types` **5.20260908.1**，检查 stream/source/controller 和 ResponseInit 类型；未更新项目依赖。

SSE 尚未接入普通 Images 的耐久恢复生产者。本地专项显式断言其 dispatch intent / snapshot / recovery job 均为零，而不是把普通响应恢复通过套用于 SSE。已有错误路径释放预算的业务政策、SSE 持久化失败恢复和客户端幂等仍需要后续工作包，不因此关闭门禁。

## 验证

新增 30 项 driver 专项、12 项完整 Worker handler + 本地 SQLite 合同及 8 项终态竞争测试已通过。覆盖错误分类、provider metadata 防伪、ID 缺失/超长/脱敏、8 MiB 事件拒绝、无活动 read / 有待决 read 的 deadline、客户端与 reader 取消、正常完成、transport 中断及先前图片输出。完整公开链核对同一请求 ID、一次出站/日志、预算金额、无 ordinary recovery job 及重复 recovery 不推理。

专项首次执行 28/30：两项 ID 省略断言错误地触发测试 helper 默认 ID。仅把期望的 undefined 改成 null 以明确表示省略，未修改运行时代码；随后 42/42 通过。失败发生在测试 oracle，不是已有结果被静默忽略。

首次完整版本化回归中，已有最大快照 after-claim 退避测试失败：恢复扫描为零，2 个 committed / 1 个 pending，未达到 3 个 committed。失败前通过 531 项，后续测试组未执行；完整输出保留在 `.wrangler/staging/images-v184-verification.json`。原测试独立重跑 3/3 通过；失败记录没有当时的数据库时钟二次读数，不能确认操作系统时钟漂移或定时器误差为根因。

原测试仅按首次 DB 时钟差值等待一次固定时长，再假定到期。现已增强本地 oracle：最多 32 次查询、7,500 ms 单调时钟上限，观察数据库原始 `available_at <= unixepoch('now')` 后才触发恢复；逐次确认 available_at / updated_at 未改写。不放宽提交数、金额、revision、回执、重复恢复断言，不修改生产恢复代码。修正后单独 3/3 通过，随后完整版本化本地链 746/746、另行 508/508 回归与两项类型检查通过；这一中间结果保留在 `images-v184-recheck-verification.json`，不作为后续终态修复的最终证明。

### 终止帧竞争的发现和修复

扩展诊断发现此前回归未覆盖的竞争：客户端读到错误后暂停、驱动预取并排入 DONE，deadline 到来时又排入 error / DONE，形成 `error → DONE → error → DONE`。done-only 与 early-EOF 两项均复现失败，输出和当时 driver 的字节归档保留在 `images-sse-terminal-before-fix-v184.json`。

修复只跟踪错误帧和 DONE 是否已被 enqueue：超时只补尚未排入的终止帧；DONE 后不再添加 error 或另一个 DONE。不把 enqueue 等同于网络收妥，也不提前改成成功结算。8 项新测试覆盖 done-only / EOF / transport 的有无预取、缺少权威用量、成功 DONE 已排入时的超时；核对帧序列以及原有 gateway_timeout、零有效图片和零用量结算。特别是成功 DONE 已排入但超时发生于旧结算边界前，仍沿用旧取消/超时账务，不能从看到 DONE 推定最终账务状态。

最终专项 50/50，加上原始两项复现再次执行共 52/52 通过（复现重复样本不累加为新增测试）。最终完整版本化 staging 本地链 **754/754**（656 + 24 + 24 + 50）、另行 driver / 生命周期 / 错误物化 **508/508** 回归通过；完整 Proxy 和 staging 类型检查退出码均为 0。所有最终测试组无失败/取消/跳过，136 个源码摘要在完整验证至发布期间保持不变。

[机器结果与摘要](./C02-images-sse-outcome-contract-results.json)记录 136 个源码、182 个操作 artifact、16 个历史证据依赖，共 334 项摘要。历史 v1.83 的 308 项按归档映射核验；中间绿色版本的 135 个源码摘要按终态修复前 driver 归档核验。最终完整输出为 `.wrangler/staging/images-v184-final-verification.json`，此前失败和中间结果均保留，不冒充最终源码证明。

driver deadline 使用确定性 mock clock；公开链 deadline 注入受信停止信号。它们不是实际 Workers 时钟、D1 远端事务、网络交付或物理容量证明。

## 发布与下一顺序

变更前 driver / proxy 按原字节归档在 `.wrangler/staging/images-before-v184-0.txt`、`images-before-v184-1.txt`，初始映射为 `images-v184-baseline.json`。旧最大快照进度测试另存为 `max-snapshot-progress-before-v184.txt`；合并映射为 `images-v184-recheck-baseline.json`。历史证据仍对应旧源码，不冒充新候选验收。

本轮没有部署、迁移、Cloudflare 资源写入或付费模型/KMS 调用。最近远端功能验证仍为 v1.77；此前权限复核仅确认 staging 入口、D1 身份与 Access 策略可读，不代表写权限或新代码验收。累计公开测试 HTTP 263、模型/KMS 0；首轮累计新增 US$2 上限不重置，最终增量云账单未核验。

下一顺序：完整本地回归通过后冻结 staging 候选，核对实际绑定、隔离、预算余量和测试入口，再做真实 SSE wire、取消/超时交付与 D1 结算验收。SSE 耐久恢复、整实例物理容量、生产 SLO、KMS/IAM、客户端幂等与退款政策仍未完成。
