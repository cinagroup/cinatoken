# C02.B2.2 — 公开 Images 生产者定价审计边界校准

2026-09-08；Checklist v1.78。**仅本地校准通过；不是新一轮 staging 验收，也不关闭 C02.B2.2 / C02.G。** [v1.77 真实认领中断与十项积压实证](./C02-staging-claim-delay-backlog.md) 原样保留，最后云端版本和累计 263 次公共测试请求未由本轮改变。

[机器可核验记录](./C02-producer-snapshot-calibration-results.json) 固化 122 个源码、120 个操作产物和 10 个依赖摘要。未修改运行时代码、配置、依赖或部署；只新增本地校准/发布脚本及证据。此前 **568 项 staging 回归**仍为 v1.77 的结果，本轮没有重跑，不把下述 20 个样本加成新的单元测试总数。

## 为什么不直接制造 256 KiB

公开生产者会把上游 usage 投影为六个计数，清空 timing metadata、路由诊断、用户快照等；消费者 exact-size fixture 正好通过这些字段填充，不能用来证明公开 route 的最大可达快照。

本次选用仍会进入快照的 catalog `verified_by` 字段。真实 endpoint 定价审计将同一身份复制四次，而最终 codec 将 pricingAudit 限制为 **65,536 UTF-8 字节**。只改变本地合成 endpoint 的这个身份，不改 DTO、codec、计费函数或快照。范围是六个固定输入族的边界，不是所有公开输入组合的全局最大值。

## 实际执行与结果

通过现有 Worker handler、鉴权、generations JSON / edits multipart 公开路由、预留预算、私有模拟出站、生产者 persist 和原子账务快路径；D1 使用 SQLite 测试绑定及其本地时钟。模拟上游完整消费小请求体后返回固定图片与 usage；全局外网 fetch 被拒绝。不会调用真实供应商、KMS 或 Cloudflare API。

每个 operation 先测基线，再按 ASCII / Unicode / 转义字符测一个单位、临界成功候选及相邻拒绝候选，共 **20 个样本：14 个 HTTP 200、6 个 HTTP 503**，全部断言通过、临时内存数据库全部关闭。

| operation | 身份字符族 | 成功 pricingAudit 字节 | 成功 canonical snapshot 字节 | 相邻拒绝的预计 pricingAudit 字节 |
| --- | --- | ---: | ---: | ---: |
| generations | ASCII | 65,533 | 70,241 | 65,537 |
| generations | Unicode | 65,529 | 70,236 | 65,541 |
| generations | 转义字符 | 65,521 | 132,981 | 65,537 |
| edits | ASCII | 65,535 | 70,182 | 65,539 |
| edits | Unicode | 65,535 | 70,183 | 65,547 |
| edits | 转义字符 | 65,531 | 132,995 | 65,547 |

成功值直接读取真实持久化 canonical JSON，并通过 decode/摘要校验。**拒绝列是按基线和实测单位增量推导，未持久化非法快照，也未直接读取被拒绝的 pricingAudit。** 每单位增量分别为 4 / 12 / 16 字节；这些步长使本次不能证明精确 65,536 与 65,537 的一字节对照。

转义字符在 pricingAudit 被封装进外层 canonical JSON 时再次转义，解释了相近审计字节下快照接近 133 KB、而 ASCII / Unicode 约 70 KB。这里给出的是实际样本大小；延迟等其他标量可能造成少量字节差异，不作为全局固定最大值或物理内存峰值。

## 账务与拒绝语义

每个成功样本只派发一次模拟请求、收取 0.1 合成费用，预留归零；意图、快照、job、回执、日志、尝试、审计及统计各一条。落库 pricing_audit 与原快照完全一致；私有 prompt/usage 扩展不进入快照，raw_usage 仅保留计数。重复恢复扫描/认领/提交均为 0，不增加账务记录或派发次数。

六个拒绝样本均在一次模拟出站后返回 **503 gateway.image_settlement_unconfirmed**，`outcome_unknown=true`、`retry_safe=false`。保留 dispatch_claimed 意图和 100,000 micros 的 dispatched 预留，已花费为 0；没有快照、job、回执、账务日志、尝试账务记录、审计或统计，没有回退 legacy writer，也没有自动退款。无快照恢复调用仍为全零，不重新推理。

这证明已观察的拒绝分支保持了原合同，不证明随后真实上游结果可重建；客户端未知结果与退款政策门禁继续保留。

## 失败记录与证据口径

首个脚本在首笔 HTTP 200 并已结算后，用普通对象与 SQLite 的 null-prototype 对象严格比较，导致校准断言失败。原脚本和失败记录保留；确认本地数据库已关闭后，仅在 run2 脚本将标量观察对象规范化，再以新记录运行。没有修改产品来让测试通过，也没有把旧失败覆盖成 PASS。

包含首次失败共 21 次本地模拟派发、1.5 合成账务；不是实际云费或充值。公共测试 HTTP / 云调用 / 真实模型 / KMS / 部署 / 生产写入本轮均为 **0**。首轮累计新增 US$2 上限不重置，最终云账单仍未核验。沿用 v1.77 最近一次关闭入口/精确清理的云端证据；本地校准没有重新核验远端实时状态。

## 下一有限顺序

1. 把当前操作脚本提炼成可复用的公开 producer 边界 fixture 和完整账务 oracle；增加精确 pricingAudit 65,536 / 65,537 字节，以及 retained 普通字符串 512 / 513 字节对照。可通过合法、单次进入定价审计的公开控制值细调字节，先验证路径可达，不改 codec 限制。
2. 为 generations / edits 分开补入入口字段/属性名拒绝、规范化上游 usage 上限、最大已验证样本的持久化/结算故障交接和重复恢复。把“出站前拒绝”“出站后持久化未确认”“已接受可恢复快照”分开断言。
3. 只把本地已校准的小矩阵送独立 staging，保持全局 US$2 授权及精确清理；随后继续跨消费者物理容量和生产 SLO。

本轮遵循 Workers 最佳实践的证据分层：真实 handler 的 Node/SQLite 结果不替代 workerd 或线上 Workers，不启用生产容量。Google Cloud KMS/IAM、Node 备选正式运行验收、其他模态和总发布门禁仍未完成。

