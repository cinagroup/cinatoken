# OpenRouter Batch API 生产级实现计划

状态：**Phase 3 输入验证账本及 Phase 4 的执行前置已在本地实现并通过聚焦测试；功能仍关闭**。Phase 1 的三库迁移、元数据仓储、幂等创建、租户隔离、游标分页与租约 CAS 已落地；Phase 2 新增默认关闭的 R2/Queue/DLQ 生成配置、私有对象键与校验和边界、最小 Queue 消息合同、DLQ 安全外壳和有界流式 JSONL 校验；Phase 3 新增 R2 Range 续读、每批最多 100 项的原始字节检查点、三库无正文 item 账本事务、租约续期、重复/非法输入失败关闭，以及以新 Queue 消息延续大批次验证。Phase 4 前置现已把每项精确 R2 字节范围写入三库账本，可按范围重载并复验单条 hash/ordinal/custom_id/model；提供只用不可逆 Key lookup hash 的三库当前权限查询，并复用同步数据面的预算周期懒重置，再按 batch 的 user/workspace 快照失败关闭；还新增三库一致的最早 item 租约认领和不可逆 `dispatch_started_at` 标记：标记前的崩溃可接管同一项，标记后的恢复只返回 `outcome_unknown`，不得越过或重放。当前 consumer 完成验证后仍仅进入 `in_progress` 并保留消息，不执行上游请求；公开 API、item 预算准入/真实出站/终态结算、价格证据、对象生命周期规则和生产验收仍未实现。本文仍是后续实现与发布门禁，不代表任何 Batch API 已上线。

## 1. 目标与兼容边界

首版实现 OpenRouter 当前公开的 Batch 形状：

- `POST /api/beta/batches`：提交 `endpoint`、`model` 与内联 `requests`，成功返回 `202` 和 `validating` 状态。
- `GET /api/beta/batches`：按当前账户与 Workspace 分页列出，按创建时间倒序；支持 `after`、`created_after`、`created_before` 与状态过滤。
- `GET /api/beta/batches/:id`：查询状态；终态返回逐项结果。
- 首版只接受 `/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1/embeddings`，同一批次只能使用一个 endpoint 和一个 model。
- 每项为 `{ "custom_id": "...", "body": { ... } }`；`custom_id` 在批内唯一。body 不含 model，或必须与批次 model 完全一致。
- 首版只接受文本请求；图片、音频、视频和文件引用在验证阶段拒绝。
- 不增加未经官方合同证明的下载结果端点。若后续官方公开取消端点，再单独补充取消 API；内部仍需具备运维终止和过期状态机。

兼容 DTO 与内部存储必须分离。公开响应不得暴露 R2 object key、Queue message、lease、内部 Route、Provider 凭据、预算 reservation 或数据库错误。

## 2. Cloudflare 拓扑

Batch 不能在一次 Worker 请求内串行完成。目标拓扑：

1. **Proxy Worker** 接受创建/读取请求，执行 Gateway Key、账户、Workspace 和输入边界验证。
2. **R2 私有 Bucket** 保存规范化输入与结果；不公开自定义域名，不生成长期公开 URL。
3. **Cloudflare Queue** 只发送小消息 `{ version, batch_id }`。不得把 prompt、documents、API Key 或结果正文写入消息。
4. **Queue consumer** 通过数据库租约领取 batch，按有界并发执行 item，写入 R2 与数据库状态。
5. **D1/PostgreSQL/MySQL** 保存元数据、状态、计数、对象摘要、授权快照、价格/预算引用、重试次数和 CAS revision。
6. **Scheduled maintenance** 处理过期、孤儿对象、超时租约与 30 天保留期清理。

Queue 是至少一次投递，因此 consumer 必须按 `batch_id + item ordinal/custom_id` 幂等；任何“消息只会执行一次”的假设都禁止进入设计。

## 3. 数据模型

三库迁移必须同步提供，并通过相同仓储合同：

### `batches`

- `id`：不可预测的 `batch_*`。
- `account_id`、`workspace_id`、`user_id`、`api_key_hash`：创建时不可变租户快照。
- `endpoint`、`model_id`、`route_group`。
- `status`：`validating | in_progress | finalizing | completed | failed | expired | cancelling | cancelled`。
- `completion_window`：首版固定 `24h`。
- `input_object_key`、`input_sha256`、`input_bytes`、`result_object_key`、`result_sha256`。
- `request_count`、`validation_next_ordinal`、`validation_input_offset`、`completed_count`、`failed_count`、`cancelled_count`。
- `prompt_tokens`、`completion_tokens`、`total_tokens`、`charged_cost_micros`、`byok_request_count`、`unknown_cost_count`，均使用 JavaScript 安全整数上限。
- `created_at`、`in_progress_at`、`finalizing_at`、`finalized_at`、`expires_at`、`retention_expires_at`。
- `lease_owner`、`lease_expires_at`、`attempt_count`、`revision`、`last_error_code`。
- 索引：`(workspace_id, created_at, id)`、`(status, lease_expires_at)`、`retention_expires_at`。

### `batch_items`

- `(batch_id, ordinal)` 主键，`custom_id` 批内唯一。
- `status`、`attempt_count`、`started_at`、`dispatch_started_at`、`completed_at`。
- `lease_owner`、`lease_expires_at`：item 级短租约，必须受父 batch 的当前 `in_progress` 租约和 revision 共同约束。
- `generation_id`、`reservation_id`、`request_start_offset`、`request_end_offset`、`request_sha256`、`result_offset/result_length` 或独立 result object key。
- 只保存脱敏错误码与有限错误摘要，不保存原始 prompt/response。

正文只放 R2。数据库中的 hash 用于完整性校验，object key 必须由服务端生成并包含不可猜租户分区，例如 `v1/workspaces/<workspace-hash>/batches/<batch-id>/input.jsonl`。

Phase 1 的仓储有意只创建 `batches` 元数据，不把完整请求数组先缓存在 Worker 内存，也不提前创建 item 正文。Phase 3 consumer 已按原始字节 Range 流式、幂等地初始化 `batch_items` 身份账本，只持久化 ordinal、`custom_id`、精确起止偏移和逐行 SHA-256；请求正文仍只存在私有 R2。Phase 4 前置加载器只读取该 item 的精确范围，并再次核对对象全量元数据、逐行 hash、ordinal、custom_id 与 model，不把相邻 prompt 读入内存。三库仓储现会在父 batch 活租约下按 ordinal 认领最早未终态 item，并把 `dispatch_started_at + generation_id + reservation_id` 作为一次性 no-replay 栅栏；栅栏前的过期租约可安全接管，栅栏后恢复只能进入未知结果处置。实际预算准入、出站、结果对象与计费事实留给后续阶段。

## 4. 创建事务与幂等

创建流程：

1. 在读取完整 JSON 前检查 `Content-Length`，并以流式累计上限再次约束；请求数量、每项大小、总字节、字符串长度和嵌套深度均设硬上限。
2. 校验 endpoint/model 一致性、唯一 `custom_id`、文本-only 和各目标协议现有 schema。
3. 解析 Gateway Key，固定 account/workspace/user/key hash；确认 Key 状态、到期、权限和 Workspace 状态。
4. 对规范化 payload 计算 SHA-256。可选接受 `Idempotency-Key` 作为 CinaToken 扩展，并以 `(workspace_id, key_hash, idempotency_key)` 唯一约束；相同 key 不同 body 返回 `409`。
5. 先写 R2 临时对象，再在数据库事务中创建 `validating` 行；提交后把对象提升为正式 key 并发送 Queue。任何中间失败都由补偿任务回收临时对象。
6. Queue send 失败不得把 batch 标成已处理；保留可扫描的 `validating` 行，由调度任务重投。

创建响应只在数据库行持久化后返回 `202`。列表与详情强制绑定当前账户和 Workspace；不存在与越权统一 `404`。

## 5. Consumer、租约与状态机

- consumer 用单条 CAS 更新从 `validating/in_progress` 获取或续租，比较 `revision` 和 `lease_expires_at`。
- 每个 item 在出站前重新验证 Key、Workspace、模型、Request Surface、Route、Endpoint 证据与预算，不能依赖创建时已经过期的可变权限。当前已完成 Key/User/Workspace/组织状态、CinaAuth 组织与非默认 Workspace 成员资格、Key 到期和 batch user/workspace 快照的三库一致查询与复用服务；尚未接入 consumer 的模型、Route、Endpoint 与原子预算准入。
- item 认领必须锁定父 batch 和最早未终态 item；只有尚未写入 `dispatch_started_at` 的过期 item 才能被新租约接管。Route/Endpoint/Guardrail/预算等可重试预检失败可通过 revision CAS 释放为 `pending`，但只允许发生在派发标记之前。一旦写入标记，释放必须失败，后续消费者必须得到 `outcome_unknown` 并停止，不得继续认领后续 item。标记应在预算 lease 转为 dispatched 和真实 `fetch` 之前提交；这有意牺牲少量“标记后但尚未发出”的可用性，以消除崩溃窗口中的重复上游调用。
- 不在 R2、Queue 或数据库保存明文 Gateway Key。异步执行使用受 Worker Secret 保护的短期签名 delegation，载荷只含不可变主体 ID/hash；消费时再查当前授权状态。
- item 调用必须复用同步数据面的解析、Guardrail、Provider 选择、Endpoint 证据、BYOK、预算 reservation/settlement、Generation 和安全日志函数，禁止维护第二套宽松路由器。
- 每项成功或终态失败后原子提交 item 状态；重复投递看到终态立即确认，不再次调用上游。
- 可重试失败采用 Queue backoff；已收到上游 2xx 但响应不可验证时遵循同步接口的 unknown-cost/no-replay 规则。
- 全部 item 终态后进入 `finalizing`，生成有界结果对象并校验 hash，再 CAS 到 `completed` 或 `failed`。
- 超过 24 小时仍未完成的 batch 进入 `expired`。运维终止使用 `cancelling -> cancelled`，已开始的不可安全取消请求允许结束，但不得启动新 item。

## 6. 定价、预算与账本

不能把“通常 50% 折扣”硬编码为全局倍数。发布前必须为每个支持的模型、Provider、operation 建立可验证的 Batch 价格证据：

- Endpoint 价格增加显式 batch price line/factor 与证据来源、有效期和 subject fingerprint。
- 缺 batch 价格证据的 Route 不进入 Batch 候选；不猜测缓存、Web Search、固定 request fee 或特殊 operation 的折扣。
- 每项使用同步请求相同的最坏成本准入和原子 reservation/settlement；批次 DTO 汇总 item 的 charged/metered/unknown 事实。
- 取消、过期、重试、BYOK 回退和 unknown outcome 必须各有账本测试。不得先“免费运行”再离线补扣。

## 7. 安全与隐私

- R2 Bucket 私有；所有读写经 Workspace 授权，响应加 `Cache-Control: private, no-store`。
- 输入和结果对象启用保留期清理；默认内部工件 30 天，到期先删除对象再写 tombstone，重试安全。
- 结构化日志只记录 batch/item ID、状态、大小、数量和错误码；prompt、response、凭据与签名 delegation 均不得进入日志。
- 限制压缩比、UTF-8、JSON 深度、item 数、总结果大小和单 item 结果大小，避免解压炸弹、内存放大和 R2 费用攻击。
- 写入与读取都校验对象 hash；对象缺失或 hash 不符时失败关闭并产生安全告警。
- Queue/DLQ 重放工具只能由管理员使用，且操作进入不可变审计日志。

## 8. 配置与部署

新增绑定应通过生成脚本写入环境配置，不直接手改生成产物：

- `BATCH_BUCKET`：R2 Bucket binding。
- `BATCH_QUEUE`：producer binding。
- Queue consumer：有界 `max_batch_size`、`max_batch_timeout`、`max_retries`、`retry_delay` 与 DLQ。
- `BATCH_DELEGATION_SECRET`：Worker Secret，不进入仓库或明文 vars。

当前 Phase 2 配置使用双门禁：默认 `BATCH_INFRA_ENABLED=false`，生成的 Proxy 配置中不会出现 R2/Queue binding；只有显式设为 `true` 才写入 `BATCH_BUCKET_NAME`、`BATCH_QUEUE_NAME` 与 `BATCH_DLQ_NAME`。即使基础设施已预置，`BATCH_API_ENABLED` 仍固定为 `false`，本阶段构建会拒绝尝试启用公开 API。`bootstrap:cloudflare -- --batch-infra` 可显式创建/复用上述私有 Bucket 与两个 Queue，但不会开放 Batch 路由。

部署顺序：

1. 三库迁移 + repository contract，默认功能关闭。
2. 创建 R2/Queue/DLQ 与权限最小化绑定。
3. 部署 consumer 和 maintenance，但保持创建 API 关闭。
4. 启用内部测试 Workspace，跑故障注入、重复投递、租约接管和账本对账。
5. 对一个有权威 batch 价格证据的真实 Provider 做小额 canary。
6. 灰度开放创建 API，再开放 SDK 文档；观察 Queue backlog、失败率、R2 增长、预算差异和 DLQ。

回滚只关闭新建；已接受 batch 必须继续可查询，并由兼容 consumer 完成或进入明确终态。禁止通过删除 Queue/数据库行“回滚”。

## 9. 测试与发布门禁

发布前至少通过：

- 三库 migration/repository parity、事务回滚与 CAS 冲突测试。
- OpenRouter 请求/响应 fixture、分页游标、状态过滤、越权统一 404。
- 重复 Queue 投递、consumer 崩溃、租约过期接管、R2 写成功/DB 失败、DB 成功/Queue 失败、DLQ 恢复。
- Key 吊销、Workspace 停用、Guardrail 变化、Endpoint 证据过期与 Route 变化时的消费期复验。
- 预算并发、取消/过期、unknown-cost、BYOK/共享容量回退与最终账本对账。
- 超大输入/结果、恶意 JSON、对象 hash 不符、日志脱敏与 30 天回收。
- 生产 canary：创建、轮询、终态结果、Generation 关联、账单与 Cloudflare 指标全部一致。

只有上述门禁全部通过，审计表才能把 Batch 从“Phase 3 验证与 Phase 4 执行前置已在本地实现”改为“完整本地实现”或“生产已验收”。

## 10. 权威参考

- [OpenRouter Batch API Quickstart](https://openrouter.ai/docs/batch-quickstart)
- [Cloudflare Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Cloudflare Queues batching and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Cloudflare Workflows Workers API](https://developers.cloudflare.com/workflows/build/workers-api/)
