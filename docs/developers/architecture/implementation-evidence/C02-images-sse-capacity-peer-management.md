# C02.B2.2 — 固定管理传输与候选前检

日期：2026-09-09；Checklist v1.114。整体 **STAGING_PARTIAL**，candidateNativeResult / windowResult 为 NOT_RUN。本轮实现一次性操作器所需的管理传输和只读前检，没有部署或打开新云端窗口。

## 固定传输

`staging-sse-capacity-peer-transport.mjs` 使用原 session/单调时钟，仅连接固定 Cloudflare account。允许的目标为四个 staging Worker 的必要读取、固定 staging D1、两个既有 Access app、该轮自有 token/tail，以及三个生产 Worker 的 settings **只读**。没有生产写入、订阅更改、模型、KMS 或公开推理接口。

- 管理写入在发送前消费尝试并持久化 PENDING；正常阶段最多 240 次管理请求，总计最多 360 次，保留关闭资源的容量。切换 cleanup 后不可重新开放入口或创建 token/tail。
- 严格固定相对路径、禁止重定向；拒绝 URL/路径归一化绕过、任意数据库、生产修改与直接调用 D1 query API。请求体在 await 前快照，不因调用方修改而更换目标或内容。
- 响应头与响应体共同受原单调时钟截止时间和 AbortSignal 约束。一般管理请求 20 秒、最多 2 MiB，候选内容读取 60 秒、最多 12 MiB；这些是操作器自设限额。超时取消实际 reader，非协作的迟到 headers 会被丢弃并关闭 body，不重试原请求。
- 正常 API 写入按阶段/方法/路径消费一次；D1 写入按完整批次摘要消费。确认丢失、无效 ACK、超大 ACK 或缺少计费元数据均不能授权重发。精确且幂等的自有测试 key 撤销只允许在**上一调用已明确 ACK**后再次执行，以兼容 finalizer 和 reconciler 的独立撤销步骤；丢失确认后仍禁止再发。
- token/tail 的成功创建响应在后置日志前保留 ID，不记录 secret 或 tail URL。token 创建 ACK 丢失只能在此前确实尝试创建后，通过本轮完整唯一名称的只读列表结果恢复 ID；重复名称拒绝。tail 没有相同的归属证明时不猜测删除。
- Access token 列表逐页读取，每页 1,000、至多 20 页；每页独立计入原管理预算。校验 page/per_page/count/total_count/total_pages、跨页总数稳定、ID 不重复、实际总条数完整后，才判断本次名称唯一或不存在。缺少分页元数据、数量变化、重复 ID 或超出操作器限额一律失败，不把第一页为空当作完整列表。
- D1 先通过 UUID/名称检查；只读批次只接受无分号/注释的单条 SELECT。每批至多 256 条、每条 100 参数、SQL 100 KB、总请求 1 MiB，检查响应逐条 success 与非负整数 rows_read/rows_written。正常阶段沿用读/写累计控制，日志故障禁止账务写入；关闭阶段仅精确测试 key 撤销保留安全例外。

`batch(write:true)` 仍是供受信任的规范 seed、key revoke 和现有全字段 guarded reconciler 使用的内部接口，不是接受外部用户 SQL 的授权服务。管理传输不替代高层账务守卫，不拥有公开 HTTP/RPC 的独立新预算。完整入口须在 finalizer 接管前调用 `beginCleanup()`。

## 新鲜只读前检

`staging-sse-capacity-peer-preflight.mjs` 接受已封闭部署的不可变观察基线与候选摘要，执行当前远端读取；模块本身不部署、不创建资源，也不凭历史摘要直接授予写入准备状态。

1. 核对固定四个 staging Worker、三个生产只读目标和两个 Access app；网关必须为原 session 中唯一版本 100%。
2. 读取 D1 UUID/名称；核对所有 staging settings/deployments 和生产 settings 摘要；检查 staging 的 workers.dev/preview 关闭、无自定义域和 cron。
3. 核对 295 个 schema 对象摘要、56 表计数与恢复控制行缺席；这三个数字/集合是本项目冻结基线，不是 Cloudflare 平台额度。
4. 核对双 Access app 的完整摘要、固定目标与 deny-all 策略、redirect 关闭；确认本次及此前指定 token 不存在、网关没有已有 tail。
5. 通过实际 `/content/v2` 返回的内容检查候选字节；multipart 必须恰有一个匹配执行模块，不接受重复匹配。随后再次读取 settings/deployments，避免内容读取期间版本变化仍被当成原候选。
6. 读取当前 billable-usage，要求 Workers 和 D1 两个 family 都存在、币种 USD、ContractedCost 为 0；与 Cloudflare Date 比较测试 key 到期范围。该保守准入条件不能证明最终增量账单，账单延迟仍保留。
7. 严格持久化完整前检结果后才调用原 session 的 `preflightComplete()`；失败不授予写入准备状态。`run()` 仅执行一次，重复调用共享同一 Promise，不自动重做失败前检。

API 形式复核采用 [Cloudflare D1 query 文档](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)中的 `{batch:[{sql,params}]}` 和返回 meta 合同。技能参考中的旧批次示例没有覆盖当前形式，按官方文档与已验证项目传输处理；不采用技能示例中的过时价格、Sessions 或批次平台限额。[Tail API 文档](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/tail/methods/create/)用于核对固定创建路径和返回 ID/URL 合同；原项目私有 header 过滤配置保持不变。

本轮复核 [Access token 列表文档](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/service_tokens/methods/list/)时确认其分页合同，因此在发布前修正了初版传输忽略分页的问题。未带分页完整性检查的 v215 本地 1,790 项结果仅保留为历史观察；对应 transport 与 test 原字节存入 `source-snapshots/v1.114-pre-pagination/`，不将其通过结果用于当前源文件。

## 验证

新增 28 项测试，组合真实传输逻辑、原 session/单调时钟与前检模块；HTTP、配置、schema、计费、token/tail 响应均为本地模拟，**不是实际 Cloudflare 复验**。涵盖正常前检、版本/数据库/入口/控制行/tail/内容/账单偏离，路径越界、SQL 绕过、请求快照、日志丢失时归属、创建 ACK 丢失、非协作 headers/body 超时、管理调用关闭余量、幂等 key 撤销、重复模块、计费元数据缺失、超大 ACK 和主动取消；另覆盖第 1,001 个 token、缺少分页元数据、分页总数变化及跨页重复 ID。

联合回归 **1,794/1,794 通过**，失败/取消/跳过为 0，staging 类型检查通过；执行前后复核全部 1,713 条历史摘要、四个新增文件及两份精确历史源码快照。[联合验证记录](../../../../.wrangler/staging/sse-capacity-peer-v216-verification-result.json)与[机器结果](./C02-images-sse-capacity-peer-management-results.json)保留完整输出及摘要。本机 Node v24.14.1；Node 22/24 远程 CI 只定义，尚未执行。

## 下一步及不变边界

完整一次性云端入口仍需连接：封闭候选部署及后置版本记录、上述前检/管理传输、Access/tail 创建与 socket 生命周期、规范原子 seed、共享公开 HTTP 计数、窗口/finalizer 及最终隔离复验。不得重跑旧 v208 操作器，不得把各模块的本地通过标成完整入口或线上通过。

本轮没有 Cloudflare 管理请求、部署、公开 HTTP、远端 D1 写入、真实模型/KMS 调用或生产改动。首轮累计 HTTP **382**、真实模型/KMS **0/0**、**US$2 累计上限不重置**。最后实际云端观察仍为 v1.108 的 `2026-09-08T12:59:42.118Z`，容量 **INCONCLUSIVE_HELD**，最终增量账单未核验。

业务成功结算点仍是有效 completed 图片与上游真实 DONE 均已验证；该点后客户端取消不撤销费用。本轮不改生产结算算法。完整 C02.B2.2 物理容量、其他消费者、unknown/幂等、C02.G、C01 剩余决策及 C03–C20 全部保留，完整目标继续推进。
