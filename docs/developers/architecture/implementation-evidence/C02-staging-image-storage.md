# C02.B2.2：真实 Workers / D1 提交边界与恢复缺口

2026-09-07。**故障观察 9/9 通过，但恢复门禁 NOT_PASSED**：5 次 Images 请求都返回 200，只有 4 条用量日志和 4 条尝试事实持久化。提交前故障的那一次没有自动恢复；这是待修复缺口，不是通过条件降级。C02 DOING、C02.G 未通过，生产容量池仍关闭。

Owner / 自检：Codex（当前任务）；独立 Reviewer 待指定。基线 HEAD `7eb59008f7d8e156e81fd18a57658fdef2553264`，包含已有未提交修改；本轮只新增 staging 故障探针、组合入口与测试，不修改业务结算算法、生产入口、schema 或依赖版本。[脱敏结果及文件摘要](./C02-staging-image-storage-results.json) 保留实际请求和 D1 记录；[前轮取消修复](./C02-staging-image-cancellation.md) 仍为历史版本证据。

## 1. 云端观察

编排时间 03:28:25–03:31:07 UTC，串行、小型合成 JSON。每个 Images 请求 108 字节，响应 1,082 字节；实际进入完整鉴权、模型路由、私有上游、定价和 D1 critical write。上游 AQID 是测试字段，不验证图片质量，也不调用真实供应商。

| 故障 / 对照 | 客户端 | 观察边界的日志数 | 最终观察与含义 |
| --- | --- | --- | --- |
| 提交前暂停 | 200，正文读完 | 0 | 客户端完成后，外部 CAS 释放；ack-returned，日志变为 1 |
| 提交后暂停 | 200，正文读完 | 1 | 外部 CAS 释放后 ack-returned；不增加第二条日志 |
| 提交前失败 | 200，正文读完 | 0 | failed-before-commit；后续正常请求完成后仍缺日志 |
| 提交后确认丢失 | 200，正文读完 | 1 | committed-ack-lost；真实事务已提交，错误不抹掉记录 |
| 后续正常请求 | 200，正文读完 | 不注入故障 | 独立成功日志，不是对前一请求的恢复 |

缺失的 generation id 为 `gen-e420ac4e-9fca-4538-92ce-492320ec8ac0`。`noAutomaticRecoveryObserved` 仅指本轮有限观察窗口，不是无限期监控结果，也不是跨进程重启实测。

另 4 项检查为测试前后无 Access 凭据均 401、授权健康 200、哈希 Gateway Key 读取本轮五模型目录。9 项 PASS 是“注入/观察/访问控制符合预期”，**不能写成恢复 9/9 PASS**。

4 条已提交日志均为 success、output_image_count=1、upstream_attempt_count=1；对应尝试均 available/accepted、HTTP 200。charged / metered / standard / budget_charged_micros 为零，正文日志为 NULL，raw_usage 94 字符、pricing_audit 2,943 字符。该模型 daily request_count 合计 4；合成用户余额/已花费/预留为零。使用中的合成 provider 已转为 enc:v2，不是 KMS 或 Vault 验收。

## 2. 故障范围与生命周期

[探针合同](../../../../packages/proxy/scripts/staging/images-storage-fault-contract.ts) 限制固定 UUID、四种模式和最长 190 字符的 `x-c02-d1-fault` header，不接受任意 SQL、URL 或无界延迟。[包装器](../../../../packages/proxy/scripts/staging/images-storage-fault.ts) 仅作用于本请求、且匹配 run 下 user/key/workspace 的真实用量 INSERT 批次；通过预置 `system_config` 行的 key + description + 旧 value CAS 一次性认领。没有 armed 行或所有权不匹配时不注入正常成功结果；重复匹配批次交回原 D1，幂等性仍由业务 SQL 负责。

包装器执行原生 prepared statement / batch；提交前模式在调用 batch 前暂停或抛错，提交后模式先等待真实 batch 成功，再暂停或抛错。**这是应用返回边界的可控故障，不是 Cloudflare 数据库宕机、真实网络丢 ACK、进程重启或平台强制终止实验。** 不伪造 SQL 成功结果。观察最多 20 次查询、每次等待最多 500 ms；数据库自身延迟另计，不把它称为严格 10 秒墙钟上限。Session 路径明确拒绝，当前 D1 read replication 关闭，不宣称覆盖副本一致性。

两种暂停模式均在客户端正文结束后由编排释放，随后真正完成 D1 返回边界，证明这个样本中的后台 Promise 继续受到生命周期保护。**容量池没有接入，因此不是 capacity lease 或物理内存回收证明。** 按 Workers 最佳实践保留显式绑定和请求所有权，不替换全局 fetch，也不在模块顶层启动 I/O。HTTP `waitUntil` 只有响应完成/断连后共享的最多 30 秒窗口，不能当可靠账本。[Workers 生命周期](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)、[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[D1 Sessions / 一致性](https://developers.cloudflare.com/d1/best-practices/read-replication/)。

## 3. 代码原因与本地对照

[D1 critical write](../../../../packages/core/src/db/d1/critical-writes.impl.ts) 已有预算 reservation 分支的提交后回查：批次报错后，若 reservation 终态及日志身份/金额匹配，可以认定之前已提交。**无 reservation 的零价分支不会走这段回查**；提交前失败没有留下可供后台重新领取的用量意图，提交后报错则可能把已成功写入记为处理失败。

[Images 路由](../../../../packages/proxy/src/routes/v1/images.ts) 已返回响应，再通过后台 Promise 写入用量；catch 记录错误并执行现有预算清理，不是持久化重试队列。因此“进入 catch”不能推导“数据库未提交”，客户端成功也不能推导账务已持久化。本轮只取证，不贸然改变未知成本、退款或重放政策。

新增 [10 项测试](../../../../packages/proxy/scripts/staging/images-storage-fault.test.mjs)：严格合同、原生 statement 转发、四种提交边界、未 armed / 其他租户 / 释放超时，以及正数合成 reservation 的确认丢失回查对照。最后一项仅在本地内存 SQLite 中模拟 100,000 micros：一次上游发送、一次已提交 critical batch、一条日志和 usage_charge 审计、reservation settled、预留归零且没有后台错误。它验证既有分支差异，不是实际付费服务结算。

本轮重跑：

- `npm run test:images:staging -w @octafuse/proxy`：35 + 7 = **42/42**，exit 0，无跳过。
- `npm run typecheck:images:staging -w @octafuse/proxy`：exit 0。
- 故障文件独立执行 **10/10**；与完整专项有重叠，不累加。前轮 2,686 项调度安全回归是历史结果，本轮未重新宣称执行。
- Node 24.14.1、Wrangler 4.127.1；现有 Workers types 5.20260829.1。另只读获取最新 5.20260907.1 并核对 D1 类型，无依赖升级；绑定类型不冒充真实运行时验收。

## 4. 部署、收尾与费用

仅 staging Gateway 更新到 `96f7e314-cf14-4cd7-9e12-14bdefd19b18`，部署 `00d3af1c-9400-43cb-83e7-e429a16f48e0`，03:27:02 UTC。九项绑定、独立限流、正文日志 off、compatibility date 2026-08-24 与 nodejs_compat/enable_request_signal 不变。无 Cron/Queues/R2/Hyperdrive；生产入口不导入故障包装器。私有上游仍为 `e9bb6c18-d99b-40ba-8b34-62fc95f598f6`，唯一 PROBE_DB 指向 staging D1，本次使用普通小响应、未启动取消观察器。

测试后 Gateway 公网/预览关闭；Access 恢复 deny-all、关闭 service_auth_401_redirect，临时 Access Token 禁用后删除并核验，Gateway Key 撤销。等后台窗口后，按准确所有权删除 **27 条种子 + 4 个探针键及其关联合成记录**；52 张非内部表计数恢复、外键无违规、quick_check=ok。保留 revoked 演示管理员 Key 1、迁移 68、库标识 1、system_config 12。合成数据可由 fixture 重建；没有删除正常运维日志或历史恢复数据。

私有上游保持关闭/版本不变，生产 Proxy/Admin/Chain 设置指纹前后一致。没有新增资源、表、迁移、订阅或生产部署。

本批 **9 次 HTTP**，首轮累计 **98 次**，不重置累计 **US$2** 上限。编排管理 API 130 次、D1 API 1,875 行读 / 161 行写；额外只读预检 20 次管理请求、发布编排 23 次，分别另有 D1 82 行读 / 0 写。不含 Worker 内部 D1 或 Wrangler 内部请求，不等于完整计费量。真实模型/KMS 调用仍为 0；最终 Cloudflare 增量账单未核验，不能报告实际 US$0 或剩余 US$2。

## 5. 下一步

继续 **C02.B2.2**，先完成 [持久化恢复边界与有限实施合同](../image-usage-recovery-boundary.md) 的本地合同/故障测试，再落到 C03/C04/C05 的对应持久化能力；这些依赖没有因本次观察通过而完成。保留平台期限/重启、大包与 edits/SSE 取消、超时、完整工作集及混合并发门禁。不增加推理重试、不以 TTL 自动退款、不把 Queue 发送成功误当作数据库与队列原子提交。
