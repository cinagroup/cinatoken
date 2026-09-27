# C02 — 公开 producer 精确边界与大快照结算故障交接

日期：2026-09-08；Checklist v1.79；状态：LOCAL_EXACT_PRODUCER_BOUNDARIES_AND_HANDOFF_PASS。C02.B2.2 / C02.G 未通过。

基于 [v1.78 校准](./C02-producer-snapshot-calibration.md)，新增可复用的本地 producer fixture 与 18 项测试。使用真实 Worker handler、鉴权、公开 Images routes、预算、耐久 producer 与恢复消费者，D1 由内存 SQLite 模拟、上游为有界合成响应。**不是 workerd / 线上 Workers 或物理内存验收。** [机器结果及摘要](./C02-producer-exact-boundaries-results.json)冻结 124 个源码、128 个操作 artifact、11 个证据依赖，共 263 个 SHA-256。

仅增加测试支持与证据；产品运行时、配置、依赖、部署、生产资源均未修改。旧证据和失败尝试保留。

## 结果

| 矩阵 | 新测试数 | 断言 |
| --- | ---: | --- |
| generations / edits × ASCII / Unicode / 转义定价审计 | 6 | 实际 producer 接受并持久化精确 65,536 UTF-8 字节；公开请求增加一个 quality 字节后返回不可安全重试的 503 |
| generations / edits × 三类 providerName | 6 | 实际保留 512 UTF-8 字节；513 字节出站后持久化未确认，预算保留 |
| generations / edits × 三类结算故障，转义大审计 | 6 | 提交前不可用、提交成功但 ACK 丢失、认领成功但 ACK 丢失；恢复不重新定价、不重复扣费、不重新推理 |

本轮新增 **18/18** 与既有恢复链 **48/48** 通过，两组子进程退出码均为 0，无跳过/取消。执行：

```powershell
node .wrangler/staging/images-producer-boundary-v179-run.mjs --run-local
```

该版本操作脚本的结果文件为排他创建，已经执行完成；复测应使用新的结果文件名，不覆盖旧证据。可单独重复执行测试：

```powershell
node node_modules/tsx/dist/cli.mjs --test packages/proxy/scripts/staging/images-producer-boundary.test.mjs
node node_modules/tsx/dist/cli.mjs --test packages/proxy/scripts/staging/images-recovery-chain.test.mjs
```

这不是完整 staging 回归重跑；不得将旧 568 项和本轮 66 项直接相加当作一轮完整通过。

## 精确字节与可达性

以实际小样本审计为基准，verified_by 保留四份，quality 保留一次。测试先按 UTF-8 和 JSON 转义计算 verified_by 填充，再用 1–4 个 ASCII 字符的 quality 补齐模 4 余数。该值符合当前网关的字符串类型/长度规则；**不是声明真实模型支持这些合成 quality 枚举**。

六份实际 canonical snapshot 的 pricingAudit 都是 65,536 字节。完整快照 ASCII/Unicode 约 70 KB，转义约 133 KB；两层 JSON 转义导致体积差异，时间标量可能造成几个字节波动。没有放宽 256 KiB codec 上限、512 字节普通文本上限，也没有恢复已剔除的任意 usage/请求正文。

65,537 的证据分两层：从实际成功 DTO 只给审计内 quality 增加一字节，直接测量 65,537 并验证 codec 拒绝；另用相同填充的公开请求增加一字节，确认对应出站后拒绝分支。**拒绝路由 DTO 没有落库或被直接捕获，其长度来自已验证的单字段构造推导**，不能描述为直接读回了非法快照。

providerName 的 512 / 513 测试覆盖 ASCII、UTF-8 多字节、引号/反斜杠，验证的是解码后文本的 UTF-8 字节，而不是外层 JSON 转义字节。其他 retained text 字段未逐个完成同等矩阵。

## 账务与恢复断言

成功样本核对八表各一条：dispatch intent、settlement、job、receipt、请求日志、供应商尝试、用户审计、日统计。用户已花费 100,000 micros、预留归零，日志费用 0.1、pricing_audit 与 canonical snapshot 完全一致；统计 request_count=1。请求/usage 私有 marker 不进入快照。每个 fixture 只出站一次。

拒绝样本为 `503 gateway.image_settlement_unconfirmed`，`outcome_unknown=true`、`retry_safe=false`；仅有出站意图，其他七表为零，100,000 micros 保留为 dispatched 预留、已花费为零。重复恢复没有扫描/认领/提交或账务变化，不自动重发、退款或回退 legacy writer。

三类结算故障发生在快照已接受之后：提交前故障留下 pending；认领 ACK 丢失留下 leased；提交 ACK 丢失已为 committed。之后将该内存 fixture 的 endpoint tariff 改为不可用，解除故障并推进模拟 DB 时间 11 秒，仍按原快照完成或识别已完成。canonical JSON/SHA 保持一致，只有一次扣费/回执，重复恢复全零。**模拟时间和 ACK 故障不等于本轮又验证了真实 Workers 原生终止。**

## 失败记录与资源口径

前两次均 12/18 通过，6 个普通文本测试在 fixture 设置阶段失败：第一次误用不存在的 `ids.provider`；第二次给多个 provider 设置同名违反唯一约束。最终改为选择两条 small route 共有的精确 provider，未改变数据库约束或产品实现。

首次失败构造没有预先登记 close，内存 DB 随已退出的测试进程释放；第二次起在设置前登记清理。失败源码快照/结果均保存。成功边界套件含基准样本共 42 次本地合成派发，前两次各 30 次；另 48 项旧链回归的派发数未汇总。这些不是实际模型调用或云账单。

本轮云调用、公共测试 HTTP、模型、KMS、生产写入、部署均为 **0**；累计公共 HTTP 仍为 263。首轮累计新增 US$2 上限不重置，最终增量云账单仍未核验。沿用 [v1.77 最近云端验证](./C02-staging-claim-delay-backlog.md)，本轮未重新核验远端实时状态。

遵循 Workers 最佳实践的证据分层：本地 Node v24.14.1 不是 Workers 验收，也不是 Node 22 备选验收。重读官方最佳实践，类型参考沿用此前取得的 5.20260907.1；本轮 npm 镜像访问 EACCES，未升级依赖、未为此修改系统权限。

## 下一有限顺序

1. 扩充此 fixture 的公开控制字段/属性名与规范化 usage 边界，分开验证出站前拒绝和出站后结果不明；补大快照持久化前/后与读回不明交接。
2. 对完成的小矩阵运行完整回归与 staging 候选预检，再在独立 staging 做精确样本和真实故障核验，保持累计 US$2 和精确清理。
3. 继续全部消费者/混合工作集的物理容量、生产 SLO、客户端幂等/退款政策，以及 KMS/IAM 与后续工作包。当前局部通过不代表完整 OpenRouter 对标或发布就绪。
