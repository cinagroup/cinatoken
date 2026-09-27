# C02.B2.2 — 诊断版单次资源执行器

2026-09-09，Checklist v1.130。发布时状态 STAGING_PARTIAL / 执行器 LOCAL_PASS；本证据封存执行前包，不是部署或原生验收回执。

新资源执行器使用诊断协调器、原窗口和原失败 finalizer；原始 primary 拒绝采集保留。候选摘要固定为 `dcde110b43d8c9c859c4a0dfab24f8ef0798f2ba6131f25709e71e5fab5e16ce`，累计公开 HTTP 基线固定 406。旧 V3 候选不能通过新鲜内容前检；不以新摘要替换旧前检结果。

独立 CLI 只接受 `--verify-local`、`--deploy-closed`、`--run` 三个固定模式，拒绝任意目标、生产、重放或 resume 参数。它绑定新 manifest、v230 的候选产物和新的 v231 尝试目录；尝试目录独占创建，日志 fsync，部署回执必须绑定同一 manifest / 候选 / 累计预算。旧 v227 目录与回执不能复用。线上推理仅在封闭部署成功和重新前检通过后执行。

从首轮未分配预留划出 US$0.05：既往及延迟费用预留 1.15、下一次合成试验 0.05、未分配 0.80，总计仍 US$2；这是操作预留，不是已测费用或新的充值授权。CLI 在任何云端动作前校验该预留及累计 406 基线。原云端前检仍要求 Workers / D1 账单可用且已报告成本为 0；实际模型 / KMS 继续 0/0。

新增 47 项运行检查（26 项 CLI、21 项资源链），2,439/2,439 联合回归及 staging 类型检查通过；旧 1,947 条摘要不变，封存 1,960 条摘要。真实本地 HTTP / WebSocket、Images handler 与 SQLite 恢复验证诊断随原 request ID 保存，日志失败停止发现、最多一次失败恢复、严格清理且不重放推理。管理 API、native host-stop / tail 和经过时间依旧是本地模型，不能称为线上验收。Node 22 / 远程 CI 未验证。

Wrangler 技能用于检查固定预构建产物、无 shell 子进程、隔离日志、`--dry-run`、关闭 autoconfig / provisioning 和部署前后独立复核。现有独立 staging 资源 ID 不变，未采用自动创建资源的通用建议。[Wrangler 命令文档](https://developers.cloudflare.com/workers/wrangler/commands/workers/)

截至此执行前清单发布：没有新 staging 云端调用、没有上传或试验，累计公开 HTTP 406，模型 / KMS 0/0，US$2 不重置，最终账单未核实。最新关闭读回仍 v228 的 2026-09-09T05:41:52.641Z；v230 dry-run 是历史本地产物证据，本轮没有重建 Worker。后续实际执行须以独立 journal / result 为准，不改写本文件的执行前范围。

下一步本地 CLI 完整性核验、独立 staging 前检、单次封闭上传及受控试验。完整物理 / 跨消费者容量、unknown / 幂等、C02.G、C01 和 C03–C20 继续开放。

[机器清单](./C02-images-sse-peer-diagnostic-operator-v231-results.json)
