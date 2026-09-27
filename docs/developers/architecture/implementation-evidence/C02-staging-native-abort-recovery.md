# C02.B2.2 — 真实 Workers 原生执行上下文终止后的恢复

2026-09-07；Checklist v1.65。**六个普通非流式 Images 小请求完成真实 Workers / staging D1 的原生执行上下文终止恢复验证。** generations / edits 均覆盖正常提交、提交前 `ctx.abort()` 和提交后 `ctx.abort()`；四个终止样本均取得原生平台异常证据。两个未提交样本待租约自然到期后被独立消费者补齐，重复恢复没有新增记账。本子集 `STAGING_PASS`，不是整个 isolate 被回收、全部重启/未知结果或完整容量验收；C02.G 和生产默认开关保持未通过/关闭。

完整脱敏投影与 85 个源文件摘要见 [JSON 证据](./C02-staging-native-abort-recovery-results.json)；机制、探针及本地防线见 [v1.64 准备记录](./C02-staging-native-abort-preparation.md)。

## 发布与隔离

开始时复核 v1.64 的 83 个源文件和 5 个操作产物摘要，全部一致；新加两个仅供操作者使用的计划/对账与测试文件。没有更改原生终止探针、财务算法、SQL、恢复消费者、生产入口或配置。仅发布 staging Gateway，版本 **`cf14d8e4-028b-45b1-ae23-53dd83fa2411`**，启动 51 ms；上传 3712.41 KiB / gzip 669.10 KiB，与已验证的离线候选相符。

Gateway 仍使用 `scripts/staging/images-recovery-gateway.ts`、30 秒服务器固定租约、9 个原有绑定。数据库为独立 `cinatoken-staging` / `6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1`。私有模拟上游版本 `e9bb6c18-d99b-40ba-8b34-62fc95f598f6`、DB-only 恢复消费者和控制端版本/设置均保持；Gateway 没有恢复 RPC binding，消费者没有模型/网关能力。

发布阶段公开入口关闭；61 次脚本管理检查通过。实验阶段再次核验当前状态，创建仅在内存中持有秘密的临时 Access 服务身份，将两个既有 staging Access 应用限于该身份；两入口各先出现一次传播期 404，随后无凭据和错误令牌均为 401。只在保护检查通过后发送业务请求。未开放私有上游或消费者的公网入口。

日志会话仅针对 Gateway 的故障 header 过滤，以随机 probe 与计划精确关联。只保留路径、方法、状态、版本、事件时间和有界异常字段，不保存请求头、访问令牌、WebSocket 凭据、完整原始事件或日志正文。实际收到 4 个匹配事件、19,230 字节，未匹配事件 0；设单消息 256 KiB、累计 2 MiB 和有限事件数上限，异常则停止验收。

## 原生终止事实与账务结果

六个请求全部返回 HTTP 200 且读到完整 EOF，两个正常样本也正常提交。四个终止样本的事件 `outcome` 均为 `ok`、responseStatus 为 200，但 exceptions 均含原生错误 `Worker execution was aborted due to call to ctx.abort().`；scriptVersion 与新部署完全一致。**这次终止发生在响应交付后的后台结算阶段；不能只看 HTTP 200 或事件 outcome 判断结算成功。**

| 场景（生成/编辑各一次） | 独立恢复前实际状态 | 独立恢复后 |
| --- | --- | --- |
| 正常提交 | committed；revision=2，attempts=1；已有回执/扣费 | 不变 |
| 提交前原生终止 | leased；revision=1，attempts=1，last_error=null；无日志/回执/扣费，预留保留 | committed；revision=3，attempts=2；新 receipt lease_revision=2 |
| 提交后原生终止 | 真实 batch 已完成，回执触发器将任务原子置为 committed；revision=2，attempts=1 | 不变，原 receipt lease_revision=1，不重复扣费 |

提交前样本没有经过 ordinary catch 的 pending/backoff 路径：available_at=lease_expires_at，且均为 updated_at+30 秒。四个探针仅在精确合成租户的关键记账 batch 边界被一次性 CAS 命中；原生异常、probe/request ID 和 D1 状态联合构成证据，未将 marker 单独当成终止证明。

恢复前共 6 份不可变快照、4 份日志/回执，合成预算已支出/预留为 **400,000 / 200,000 微美元**。先关闭 Gateway 入口并撤销合成 API key，再做真实 D1 时钟检查：前两次观察第二项租约未到期，第三次两项才均到期；未改 available_at、租约、时钟或补造用量。

独立控制 RPC 的 scanned/claimed/committed 均为 2，其余计数为 0。恢复后 6 份日志/回执、6 个 committed 任务，合成已支出/预留变为 **600,000 / 0 微美元**。重复 RPC 所有计数为 0；账户、key、意图、快照、任务、预留、回执、日志、attempt 事实、费用审计、统计汇总及完整原始分片等 12 组投影完全不变。6 份快照 hash/事件时间在恢复前后保持，各请求只有 attempt_index=1 的推理认领和一份成功 attempt 事实。

本轮只发送 6 次 Images 请求，恢复不调用推理，不把已交付的成功结果重发上游。仍只支持本次显式启用的小型普通 Images 成功结算子集。

## 收尾与源码验证

2026-09-07 10:28:33–10:32:26 UTC 的实验执行最终退出码 0，所有收尾步骤通过。关闭两个公开入口；停止并删除临时日志会话；禁用服务令牌，取消两个应用的 service-auth 401 模式，恢复 deny-all 后删除无引用令牌并确认不存在。撤销合成 API key，等待 host 窗口、核验无活动租约后，按本轮 UUID/租户/探针及独占模型清理。

**删除的只有本轮合成用户/模型/账务样本、探针及临时身份/日志会话；合成数据可由 fixture 重建，没有删除真实用户或资金记录。** 最终四个 Worker 的 workers.dev / previews 关闭，自定义域名与 Cron 列表为空；295 个 schema 完整定义和 56 张表计数恢复基线。三项生产设置指纹、其他 Access 应用以及未发布的三个 staging Worker 均保持。无 DDL、迁移、全库回退或 ALTER 重放。

新增 [终止专用对账器](../../../../packages/proxy/scripts/staging/images-abort-live-fixture.mjs) 和 [4 项测试](../../../../packages/proxy/scripts/staging/images-abort-live-fixture.test.mjs)：验证新种子不预造已受理用量、恰好四个随机探针，拒绝普通失败状态/错误租约 revision、重复场景、篡改账务和伪造租户。对账器测试中的状态向量是明确标注的本地构造数据，不是平台证据；上表仅取自实际云端读数。

定向测试最终 4/4 通过，退出码 0；staging TypeScript 检查退出码 0。新测试在云端实验终止并收尾后加入常规测试命令，因此最终源码相对云端记录只有 package.json 的测试命令变化；部署运行时代码不变。完整 staging 回归 **47 + 8 + 167 + 39 + 65 + 88 + 24 = 438/438 通过**，无失败、取消或跳过；最后 24 项进程退出/恢复实际结束，耗时 197,499.3822 ms，最终退出码 0。详细结果见 JSON；完整 Core 类型检查未重跑，历史 32 条诊断保留，Node 22 未验收。

首次操作者命令直接用 Node 启动时因 TypeScript 参数属性在 strip-only 模式下不支持而退出；此时无结果文件、无云 API 调用。随后用已有 tsx 启动同一已审阅脚本。脚本生成过程也曾在本地编排代码中因临时变量误赋为布尔值而中止，尚未写出/执行脚本；修正后 `node --check` 通过。未因此重试任何 Images 或消费命令。

## 费用与剩余门禁

本轮管理 API **176 次**：发布 61、实验及收尾 115；其中 REST SQL API 35 次 / 176 条语句，返回元数据共读 4,742 行、写 211 行（包括索引影响，非业务行数）。Worker 内部 D1 行数和 Wrangler 内部 API 未计入该统计。公网测试 HTTP **14 次**：保护探测 6、Images 6、控制 RPC 2；首轮累计 **162**。发布 1 次，真实模型/KMS 及生产写入均为 0。

合成账面 0.60 美元不是实际费用；首轮累计新增 **US$2 上限不重置**，最终增量账单仍未核验。本轮未创建新的付费服务、充值或真实密钥。

下一项仍为 C02.B2.2：继续真实平台并发 fencing / 旧执行者恢复写入，以及 client unknown/幂等和其他 host 中断证据，再做最大快照及完整物理工作集。此次 `ctx.abort()` 证明当前执行上下文被原生终止，不证明整个 isolate 回收、OOM、CPU 限额或部署重启。成功响应已送达也不覆盖客户端确认丢失。SSE、失败/取消结果、多 scope/模态、非空复杂权益与卖家收益门禁仍开放。

按 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) 保留私有绑定、请求级故障所有权和独立持久化恢复；按 [实时日志接口](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/) 的平台事件与异常联合取证，不把 waitUntil 或日志 outcome 当作永久存活/记账保证。停止或回退入口不应删除真实耐久任务，也不能重新推理来补账。
