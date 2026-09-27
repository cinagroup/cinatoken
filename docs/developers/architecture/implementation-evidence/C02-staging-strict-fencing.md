# C02.B2.2 — 真实 Workers / D1 严格租约隔离

2026-09-07；Checklist v1.68。**两个普通非流式 Images 小请求（生成、编辑各一次）完成真实跨 Worker 严格 fencing 验证。** 新消费者已经认领、尚未提交时，旧生产者恢复写入，被真实 SQL 租约检查拒绝；账务与新租约不变。随后新消费者各提交一次，重复恢复无变化。本子集为 STAGING_PASS，C02.G 与完整物理容量仍未通过，生产默认关闭。

完整脱敏投影、所有阶段结果、91 个源码与 19 个操作产物摘要见 [JSON 证据](./C02-staging-strict-fencing-results.json)。机制见 [生产者准备](./C02-staging-fencing-preparation.md) 和 [消费者侧准备](./C02-staging-consumer-fencing-preparation.md)。本轮未修改已验证的运行时代码、财务算法、Core、SQL 草案或依赖。

## 部署与精确差异核验

只发布两个既有 staging Worker：

| Worker | 新版本 | 实验配置 |
| --- | --- | --- |
| cinatoken-proxy-staging | `2f3d3d28-08aa-4a5f-a84d-5f3e5001a4a1` | images-fencing-gateway.ts；生产者租约 5 秒，40 次探针轮询；启动 53 ms |
| cinatoken-staging-usage-recovery | `e386f210-43a8-4b03-b91e-f179cadf8354` | usage-recovery-fencing-worker.ts；消费者租约 30 秒，20 次轮询；启动 10 ms |

两者均保留原有 9 个绑定；Gateway 无恢复 RPC binding，消费者只有 staging D1 与固定参数。控制端和私有模拟上游版本保持。三份迁移草案已存在，本轮未重放 ALTER。5 秒租约与 64 MiB 单消费者分配仅用于实验，不是生产参数或已测得的物理上界。

发布阶段的初次收尾校验停止于消费者设置摘要变化。只读获取新旧版本并核验后确认：唯一设置差异为 `annotations.workers/triggered_by` 从 `upload` 变成 `version_upload`。将当前对象仅这一值还原，SHA-256 精确复现历史 `4e86afc5…504bf`；当前完整值为 `31b9554c…7e96`。新旧绑定、运行参数和命名 RPC 方法一致。没有笼统忽略设置变化；重新执行完整只读收尾核验通过后，才允许实验。

Gateway 实际上传 3713.56 KiB / gzip 669.33 KiB；消费者 342.97 KiB / gzip 67.08 KiB。发布前核验两组离线候选摘要，源码未变；记录实际上传大小，不声称它与历史离线输出字节数完全相同。

## 真实时序与账务证明

每个场景使用同一合成租户下两个不同的随机探针，消费者控制行只接受固定的 before-release 合同。API key / Access 密钥仅在操作者进程内，持久化报告不保存秘密。租约 token 只保存 SHA-256 对比值。

1. 发送一次 Images 请求，客户端收到 HTTP 200 与完整 EOF；生产者真实关键 batch 尚未提交并持有 revision 1 / attempts 1 租约。
2. 使用真实 D1 时钟观察租约自然到期；生成场景查询 3 次，编辑查询 2 次。未改任务、available_at、租约或数据库时钟。
3. 独立无参 RPC 认领 revision 2 / attempts 2、新 token、30 秒租约。消费者在真实 batch 前暂停；此请求仍无日志或回执。
4. CAS 释放旧生产者，真实 SQL 返回 `Settlement recovery lease invalid`，部署的有限探针记为 `stale-lease-rejected`。新消费者未提交，故不能由重复日志 ID 来解释该拒绝。
5. 前后账户、key、意图、快照、任务、预留、回执、日志、attempt、费用审计、统计和完整统计分片等 12 组投影完全一致。额外核对新 lease 的 revision、token hash、期限和状态均未改变，且仍未过期。
6. CAS 释放新消费者后，原生 batch 成功；最终每请求 job 为 committed / revision 3 / attempts 2，receipt lease_revision=2，日志、审计、attempt 各一份。

两个消费者 RPC 均 scanned=claimed=committed=1，其余数值计数为 0、capacityLimited=false。两次均返回 `admissionStopped=true`：已有工作跨过 5 秒新任务准入预算，但 host 仍等到已开始的结算完成。这符合执行器“只停止新准入”的合同，不是结算失败；操作者在第二轮前修正了对此标志必须为 false 的过严预期，没有修改运行时代码或放宽财务断言。

最终合成预算已支出为 200,000 微美元、预留为 0；这是测试账本的 US$0.20，不是真实费用。两份快照摘要/事件时间保持，每请求只有一次推理认领和一次 attempt 事实。第三次恢复 RPC 全部计数为 0，12 组投影与调用前完全相同；恢复消费者未调用模型。

## 失败尝试与收尾

首轮实验在 Access 保护检查中停止：错误令牌请求返回 404，未达到必须为 401/403 的条件，因此 **没有发送任何 Images 请求**。该轮 6 次公开 HTTP；入口关闭、令牌回收、精确样本清理、schema/表计数与生产指纹核验全部通过。

第二轮允许对传播期 404 做最多三次有界重试，仍只接受 401/403 且无应用响应。网关和控制端都分别通过无凭据及错误令牌检查后才发送 Images。第二轮 11 次 HTTP，包括 6 次保护检查、2 次 Images、2 次恢复及 1 次重复恢复。所有失败响应均保留，没有把 404 视为保护通过，也未重放已成功的 Images。

最终四个 Worker 均 workers.dev=false、previews=false，所查 service 自定义域名和 schedules 为空；两个既有 Access 应用恢复 deny-all / service_auth_401_redirect=false，临时令牌禁用后删除。释放自有暂停并等待在途 RPC 和 host 持有窗口结束，再按精确合成 scope 清理控制行、探针、恢复与财务样本。

最后复核 295 个实际 schema 定义摘要 `1bc2f703…56f9`、56 表计数、三项生产设置指纹以及其他 Access 应用摘要均保持。控制行不存在，全部 12 组合成查询为空。没有生产数据操作或生产写入。

## 本地回归、费用和剩余门禁

- 重新运行完整 staging 链 **465/465**，退出码 0，无失败、跳过或取消；七段 47、9、192、39、66、88、24。定向 staging 类型检查通过。
- 本轮新增本地业务测试 0，运行时代码相对 v1.67 未变；新增的是一轮真实平台证据与有界操作者脚本。
- 本轮公开 HTTP 共 **17**，首轮累计 **179**；模型/KMS 仍为 0。脚本可计数管理请求 351（含额外诊断读取 3 次，不含 Wrangler 内部请求）；REST SQL 86 次、398 条语句，rows_read=7,591、rows_written=339。Worker 内部 D1 元数据未计入这些 REST 数字。
- 首轮累计新增 **US$2** 上限不重置，不升级套餐、不充值；最终增量账单仍未核验。

按 Workers 最佳实践和 Wrangler 技能，保持独立绑定、请求所有权、有界操作及发布前后校验；参考 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。

该证据只覆盖一个旧生产者和一个新消费者、两个普通小请求的严格时序。它不证明所有跨实例并发排列、Workers 上“旧写入恢复 + 新消费者随后晚期失败”的组合、客户端确认不明、整实例回收、最大快照或完整物理内存容量。下一步继续客户端确认不明/其他 host 中断，再补最大工作集与跨消费者容量；C02.G 不关闭。
