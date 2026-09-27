# C02.B2.2 — 真实 Images 生产者与独立消费者端到端恢复

2026-09-07；Checklist v1.63。**普通非流式 Images 的小型合成请求已在真实 Cloudflare Workers / staging D1 完成生产者到独立消费者的恢复验证。** 生成 / 编辑均覆盖正常提交、提交前失败和提交后确认丢失；原日志缺口在本次显式启用的实验入口可补齐，不需要重新推理。仅此子集 `STAGING_PASS`，C02.G、生产启用和完整容量仍未通过。完整平台投影、命令结果及 80 个文件摘要见 [JSON 证据](./C02-staging-images-recovery-results.json)。

## 发布与隔离

以前轮 [完整 Worker 本地组装](./C02-images-recovery-worker-composition.md) 的 78 个文件及产物摘要为基线，仅发布 `cinatoken-proxy-staging` 的恢复专用入口 `scripts/staging/images-recovery-gateway.ts`。版本 **`6b3f736b-2660-4ee0-a72f-059ba506492b`**，启动时间 50 ms；上传包 3711.31 KiB / gzip 668.88 KiB。生产 `src/index.ts` 和 legacy staging 默认仍不传恢复选项。

发布时公网及预览入口关闭。存储仅为 D1 `6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1`；私有模拟上游 `cinatoken-staging-images-upstream` 仍为 `e9bb6c18-d99b-40ba-8b34-62fc95f598f6`。恢复控制端 `cinatoken-staging-recovery-control` 及接收端 `cinatoken-staging-usage-recovery` 未重新部署，分别沿用 v1.61 核验的版本和设置指纹。网关没有恢复 RPC binding，消费者没有模型或网关 binding。

创建一枚仅在本进程内持有秘密的临时服务令牌，将两个精确 staging Access 应用临时限定到该身份；验证无凭据 / 错误令牌均被拒绝后才测试。最初一次无凭据请求为传播期 404，随后为 401；没有在保护未确认时发送业务请求。私有上游和接收端未开放公网。

## 真实平台结果

只创建本轮 UUID 命名的合成用户、Workspace、哈希 API key、模型/端点和 4 个一次性故障探针。合成账户预算 1 美元、每图价格 0.10 美元；不是充值、真实转账或付费模型。种子不插入意图、结算快照、恢复任务、用量日志或回执，这些均由真实 Images 路由与 SQL 触发器产生。

6 个串行小请求全部返回 200，分别为 generations / edits × normal / before-fail / after-fail。故障 header 仍受精确租户、随机 probe ID 和 armed 行控制；没有新增任意 SQL、延迟或生产开关。每次成功均先耐久接受快照与任务，提交前拒绝不撤销已完成的上游结果。

| 阶段 | 日志 / 回执 | 恢复任务 | 合成已支出 / 预留（微美元） |
| --- | --- | --- | --- |
| 6 次请求完成 | 4 / 4 | committed 4；pending 2 | 400,000 / 200,000 |
| 独立消费者恢复 | 6 / 6 | committed 6 | 600,000 / 0 |
| 确认后重复恢复 | 完全不变 | 未再领取任务 | 600,000 / 0 |

两个 `before-fail` 请求 revision=2、attempts=1、last_error=`execution_error`，available_at 比 updated_at 晚 5 秒；故障请求无部分扣费/日志/回执，预留保留。只有关闭网关入口、撤销测试 API key、确认数据库时间已到期后，才执行控制命令。此时两个 due 均为 1，没有改写时钟或重新调用 Images。

独立恢复 RPC scanned / claimed / committed 均为 2，其余计数为 0；两项任务使用新租约提交，最终 revision=4、attempts=2、receipt lease_revision=3。原正常与 `after-fail` 请求仍为 revision=2、attempts=1、receipt lease_revision=1，未重复扣费。重复命令所有计数为 0，12 组账务投影与上一次完全相同。

核验范围包括账户、key、意图、快照、任务、预算预留、回执、日志、尝试事实、费用审计、汇总日统计和原始分片统计。6 份快照摘要及事件时间在恢复前后不变；每个请求只有 attempt_index=1 的认领与一次成功尝试事实。整个操作只发送 6 次 Images 请求；恢复仅经已有 DB-only 私有消费者执行，没有增加推理请求。没有把单独 HTTP 200 当作账务通过证据。

## 清理与回归

关闭网关/控制端入口，禁用临时服务令牌；先取消两个应用的 service-auth 401 模式，再恢复 deny-all，解除引用后删除并核验令牌不存在。测试 API key 撤销；确认 host 窗口结束且无 leased 任务后，按本轮 UUID/租户/探针与独占模型精确清理。**移除的只有本轮合成数据及探针，可由 fixture 重建；无真实用户或资金记录被删除。**

四个 Worker 的 workers.dev / previews 最终均关闭，295 个 schema 对象完整定义摘要保持，56 张表计数恢复基线。没有新 DDL、正式迁移、重放 ALTER 或回退全库。三个生产设置指纹、其他 Access 应用保持。补充只读检查自定义域名、Cron 和上游绑定，结果见 JSON 证据。

新增 [操作对账与清理工具](../../../../packages/proxy/scripts/staging/images-recovery-live-fixture.mjs) 和 [3 项预演测试](../../../../packages/proxy/scripts/staging/images-recovery-live-fixture.test.mjs)，验证不预造用量、完整六请求恢复/清理、拒绝伪造租户。首轮本地检查误把日统计视为单行，其后一次检查误用了不存在的 id；按实际 `(stat_date,model_id,shard)` 结构修正为汇总加完整原始分片比较后通过。未修改业务统计或财务逻辑。新测试接入常规 staging 链，**35 + 8 + 161 + 39 + 65 + 88 + 24 = 420 项全部通过**，最后 24 项实际退出码 0，无取消或跳过；定向 TypeScript 检查通过。完整 Core 类型检查未重跑，历史 32 条诊断保留。测试命令在云端实验结束后更新，部署运行时代码未随之改变。

## 费用与剩余门禁

本轮新增公网 HTTP **13**（保护探测 5、Images 6、恢复控制 2），首轮累计 **148**。只部署一个 staging Worker；真实模型/KMS 和生产写入均为 0。合成账面 0.60 美元不是云费用；累计 **US$2 上限不重置**，最终增量账单未核验。操作脚本管理 API 共 **147 次**（发布核验 43、实验 95、补验 9），其中 REST SQL API 35 次 / 176 条语句，返回元数据读 4,753 行、写 211 行；后者包含索引影响，非业务记录数。Worker 自身 D1 行数与 Wrangler 内部 API 调用未计入这些统计。

下一步继续平台终止/重启、确认不明、并发 fencing 与完整物理工作集验证。这里的 `after-fail` 是真实提交后的一次返回边界错误，不是 Cloudflare isolate 被终止；普通小响应不能证明最大 256 KiB 快照或 64 MiB 实例容量。SSE、失败/取消结果、client unknown/幂等、其他模态和 Node 22 门禁保留。原漏日志事件仅在本次 opt-in 子集获得修复证据，默认/生产路径没有因此自动启用或关闭问题。

后续操作继续遵循 [独立 staging 流程](../../../operators/deployment/cloudflare-staging.md)。若停止或回退入口，已受理的耐久任务仍需消费者/对账收尾，不能删除真实任务或用重新推理补账。按 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) 保留私有绑定、请求级故障 facade、提前及独立后台持有；持久化恢复不依赖 waitUntil 永久存活。
