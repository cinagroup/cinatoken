# C02 — 大 producer 快照的持久化失败与确认不明交接

日期：2026-09-08；Checklist v1.80；状态：LOCAL_LARGE_PRODUCER_PERSISTENCE_HANDOFF_PASS。本地专项 30/30、完整版本化 staging 本地回归 616/616 通过。C02.B2.2 / C02.G 保持未通过。

[机器结果与摘要](./C02-producer-persistence-boundaries-results.json)冻结 125 个源码、132 个操作 artifact、12 个证据依赖，共 269 个 SHA-256；发布前逐一复核。

接续 [v1.79 精确边界](./C02-producer-exact-boundaries.md)。新增一个测试文件，复用已冻结的真实 Worker handler / 鉴权 / Images producer fixture；产品运行时、配置、迁移、依赖、部署和生产资源均未改动。

## 观察矩阵

generations / edits × ASCII / Unicode / 转义字符 × 以下五种故障，共 30 项。每项先独立校准，再发送一次被测合成请求；数据库与预算不跨 fixture 共用。

| 故障 | 公开响应 | 实际快照 / job | 故障解除后的恢复 |
| --- | --- | --- | --- |
| INSERT 执行前失败 | 503，结果不明 | 均无 | 全零；不补造快照、不重发推理，保留已出站预留 |
| INSERT 已提交但 ACK 丢失，精确读回正常 | 200 | 存在且可确认；fast path 已提交 | 识别已完成，不重复扣费 |
| INSERT 正常，随后快照读回不可用 | 503，结果不明 | 存在；job pending | 原快照结算一次 |
| INSERT ACK 丢失，同时快照读回不可用 | 503，结果不明 | 存在；job pending | 原快照结算一次 |
| 快照可读，enqueue/job 读回不可用 | 503，结果不明 | 原子 enqueue 实际存在；job pending | 原快照结算一次 |

六个成功确认、二十四个 503；其中六个真正未写入，十八个持久化成功但客户端结果不明。测试断言区分这三类，不将 503 自动视为“未计费”或“可安全重试”。

## 直接证据与财务不变量

测试在实际 SQL INSERT 绑定处、数据库执行前捕获 canonical JSON 与 SHA-256，验证字段位置/类型、codec 内容身份与 `pricingAudit` 精确 **65,536 UTF-8 字节**。三类完整快照约 70–133 KB；转义样本明确大于 130,000 字节，全部不超过 256 KiB。

已写入时，捕获值与数据库存储 JSON/SHA 完全一致；未写入时，捕获值只是测试观测，绝不注回数据库或用于恢复。它不改变生产持久性，也不能被当成真实服务有可恢复输入。

每项断言一次 provider 派发、一次 INSERT 尝试以及确实触发对应故障；组合故障触发两次，其他各一次。未确认前用户已花费为零、预留 100,000 micros，reservation 为 dispatched；快照/job 存在与否按故障模式精确区分，回执、日志、供应商尝试账务记录、用户审计、日统计均不提前写入。

后续仅将该内存 fixture 的 endpoint tariff 改为不可用、解除故障，不更改快照、job、租约或用户余额。应恢复的十八项均提交一次；已确认的六项不再提交；未持久化的六项恢复全零。

成功结算最终八表各一条，日统计 request_count=1，charged_cost=0.1，用户已花费 100,000 micros、预留归零，reservation 为 settled。日志定价审计等于原快照，canonical JSON/SHA 不变。再次恢复均全零，不重复计费、推理或按新价格重算。无输入的六项继续保留意图/预留，不自动退款或回退旧 writer。

## 验证与范围

首次专项命令退出码 0，30/30，无失败、取消或跳过：

```powershell
node node_modules/tsx/dist/cli.mjs --test packages/proxy/scripts/staging/images-producer-persistence-boundary.test.mjs
```

完整回归由 `.wrangler/staging/staging-regression-v180.mjs` 执行 v1.77 完整版本化 staging 命令，并加入 v1.79 的 18 项和本轮 30 项。此次实际重跑 17 组、616/616、退出码 0，无失败/取消/跳过；不是把跨轮历史结果相加。它保存命令、分组计数、退出码、完整有界输出与每个新矩阵的诊断。结果文件为排他创建；复跑使用新文件名，不覆盖历史。该命令不是整个仓库的所有测试，也不是线上测试。

本轮是 Node v24.14.1 / 内存 SQLite 的真实路由逻辑验证，不是 workerd 或 Cloudflare D1 的故障证明。helper 会读取响应并排空后台任务，因此**没有测量真实客户端收到响应头的精确时点**；不得据此宣称大快照的交付屏障已在线验证。D1 session、分布式读一致性、真实执行上下文终止、物理内存和生产 SLO 继续开放。

遵循 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)区分平台与模拟证据；采用已取得的 Workers types 5.20260907.1 核对 D1 调用签名。本轮未升级依赖，最新 registry 检索不可用不妨碍纯本地测试，也不构成新的线上权限验证。

## 资源与下一步

专项 smoke 包含基准共 60 次本地合成派发；完整重跑中的此新矩阵另 60 次。其他既有回归的合成派发未汇总，不冒充实际推理或账单。

本轮云调用、公开测试 HTTP、付费模型、KMS、部署、生产写入均为 **0**。累计公开 HTTP 仍为 263；首轮累计新增 **US$2 不重置**，最终增量云账单仍未核验。最近远端验证仍为 [v1.77](./C02-staging-claim-delay-backlog.md)，本轮未重新读取远端状态。

下一有限顺序：

1. 补公开控制字段/属性名、规范化 usage 的边界及出站前/后分类；JSON 的 UTF-16 控制长度/256 单元属性名，与 multipart 的 64 KiB 单字段/128 KiB 累计字段字节是不同合同，不跨路径误用。
2. 使用完成的有限样本做独立 staging 候选预检与真实 producer/持久化交接，另测响应交付时点；保持费用上限和精确清理。
3. 继续全局可达快照上界、混合消费者物理容量、生产 SLO、KMS/IAM、客户端幂等/退款政策及后续工作包；不以此次子集关闭总门禁。
