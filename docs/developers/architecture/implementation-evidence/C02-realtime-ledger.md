# C02.B2.2 — Realtime 公开路由、预算事务与跨候选帧

日期：2026-09-05。状态：**本页所列本地链路 LOCAL_PASS；C02 仍为 DOING**。Owner / 本地自检：Codex；独立 Reviewer 待指定。接续 [Node Upgrade 入口](./C02-realtime-ingress.md)，不改写历史证据。

## 1. 本轮修复与边界

1. **Ordinary reservation 所有权**：Ordinary 预留成功后立即发布稳定 lease 的 delegate，不再等 Guardrail 准入成功。Guardrail 失败且第一次 Ordinary release 写失败时，外层仍能找到并重试清理。只有确认 release 成功，才恢复原来的 free/BYOK 视图；不以本地状态冒充落库成功。
2. **两本账独立清理**：Realtime route 以 `Promise.allSettled` 观察 Guardrail / Ordinary 的独立终结。任意一本写失败不跳过另一本、不替换原始 dispatch 异常，也不阻止已有 usage promise 被托管。持续写失败保留数据库 reservation，待恢复流程处理；不宣称所有失败均已即时修复。
3. **跨明确拒绝候选的未发送帧**：Node adapter 把队列提升到每个 accepted client 的生命周期，保存原始帧，不保存前一模型改写结果。新候选重新校验 PCM/操作/模型并改写，只有上游成功接受后才一次性发送。上游结果未知不重放；已发送帧不保留为重试输入。
4. **队列与清理上限**：待发原始内容及当前候选改写后的内容均限 4 MiB；队列另限 1,024 帧，避免零字节帧绕过内存限制。候选间隙也有收帧 owner。取消或会话终结时立即移除消息监听器，不等待 close acknowledgement。单帧、会话总量和输出 backpressure 上限继续生效。
5. **不续期路由时限**：移除 route 在模型/定价准备后重新设置 `Date.now() + 30s` 的覆盖，沿用 handler 起点。Node 入口更早的绝对时限继续取较小值。该变更不证明所有准备查询可立即取消，也未补齐 Workers 的鉴权前入口起点。
6. **日志最小化**：Realtime 结算/清理异常只记录 requestId、ledger 和固定 reason，不输出可能含 SQL 参数、密钥或正文的数据库异常文本。

没有修改 Core 账务合同、迁移、Admin、Wrangler、依赖锁、原 V2.1 或 KMS 选型。没有增加 binding、创建云资源、调用真实模型/OAuth/KMS、迁移生产数据、操作真实资金、部署或触发远程 CI。

## 2. 验证链路

新增 [完整路由测试](../../../../packages/proxy/src/runtime/node-realtime-ledger.test.ts)使用：

`真实 Node Upgrade → createProxyApp / auth → Realtime route → endpoint 证据和定价 → 候选选择 → Ordinary + Guardrail SQL 准入 → ws loopback → recordAudioUsage → Core D1 critical write`。

[测试专用 D1 adapter](../../../../packages/proxy/src/test-support/sqlite-d1.ts)在 Node SQLite **3.51.2** 内存库依次执行仓库全部 **68 个 D1 迁移**。repository 使用真实 SQL、触发器和事务；batch 失败执行 ROLLBACK。没有用假的 reserve / settle 返回值替代业务存储，也没有仅记录 SQL 意图。但这**不是 Cloudflare 托管 D1、workerd 或远程数据库验收**，不证明 D1 会话一致性、网络故障和远程并发行为。测试 adapter 明确不模拟 D1 sessions/dump，计时等元数据不是性能样本。

身份、provider Key、音频及价格均为合成数据。数据库只在内存，服务器绑定 127.0.0.1 临时端口；非 loopback 的应用 fetch 被测试拒绝。定价为测试用每秒 0.001 单位，601 秒 ceiling 对应 601,000 微单位，不是当前商用报价。BYOK 子集使用实际本地 enc:v2 加解密和真实查询，不等于新 Google KMS Vault 已实现。

新增 **53 项**：

| 范围 | 数量 | 关键断言 |
| --- | ---: | --- |
| 两公开前缀 × 两 ASR operation × 七种确定性 | 28 | actual=1 秒、显式零、无 upstream metric 但可验证 PCM、无 metric/PCM、异常关闭、握手结果未知、HTTP 503 明确拒绝；检查发送前两本账 dispatched、预留和终态 |
| 持久化故障 | 5 | Guardrail admission 失败 + Ordinary 首次 release 失败；Guardrail 持续清理失败不跳过 Ordinary；critical batch 在 log insert 后失败完全回滚；任一本 forfeit 持续失败时保留预留并由 expiry 恢复 |
| 跨候选完整公开链路 | 4 | 两 ASR operation：503 → actual；503 → unknown，且配置第三个可用候选但不再出站；只保留一套 reservation，模型改写和结束帧不重复 |
| 数据库加密 BYOK | 8 | 两 ASR operation × include_byok_in_limit 开关 × 成功/异常；余额 0 不阻止私有 BYOK；使用私有上游 Key；Ordinary 不预留/消费；启用 Key 限额时按实际或 unknown ceiling 结算 |
| 公开预算拒绝 | 2 | Ordinary 与 Gateway Key 余额不足均不进入上游，也不残留预留 |
| 共享 route 时限合同 | 1 | 实际模型准备后推进时钟 5 秒，传给 dispatch 的连接截止时间仍为原始起点 + 30 秒；此项使用可观察 dispatch callback，不是 native ws |
| Node 队列边界 | 5 | 候选间隙 PCM 帧、候选模型不支持 PCM、原始字节超限、空帧数量超限、改写后超限；重新校验不重复计量 |

完整路由文件共 48 项，其中 **47 项经过真实本机 HTTP/WebSocket 入口**，1 项为共享 Hono route 时限合同。另 5 项使用 Node socket double 精确控制候选间隙。既有建连生命周期套件继续检查 close 挂起时停止消息处理。

### 2.1 unknown 口径没有被改成“确定收费”

初始强断言发现：reservation / user budget 已按 601,000 微单位保守结算，但请求日志 `budget_charged_micros` 仍为 0。进一步核对 [Core 既有测试](../../../../packages/core/src/storage/user-budget-critical-write.d1.test.ts)及 [critical write](../../../../packages/core/src/db/d1/critical-writes.impl.ts)，现有合同明确区分实际费用与 reservation 保守扣减。

本轮保留该既有合同，分别断言两个值，不通过把 unknown 改成 actual 来让测试变绿。**日志实际费用不可单独用于重建 unknown 的预算消费**；C04/C05 仍需统一事实、未知暂估/调整与对账展示，并处理迟到 actual。请求日志 success 也不单独证明用量可计价。本轮不是 Credits / 充值 / 退款账本实现。

## 3. 失败复现与最终结果

修复前，两个清理故障用例失败；503 → actual 的两个真实公开链路均因第二个候选收不到先前帧而超时。修复后恢复。完整回归还捕获到新增消息 owner 在 close 挂起时未移除，以及 BYOK fixture 直接修改 readonly repository 的类型错误；修正后重跑最终完整套件，未跳过这些用例。测试超时清理也调整为先关闭本机 socket，再 drain usage，最后关闭数据库，避免失败 fixture 自身悬挂。

环境：Windows / Node.js **v24.14.1**；Node 22 未运行。

| 最终命令 | 结果 |
| --- | --- |
| `npm.cmd test -w @octafuse/proxy` | 退出 0；完整 pretest 链完成；主套件 **1,710 tests / 135 suites**，0 fail/cancelled/skipped |
| `npm.cmd run test:dispatch-safety -w @octafuse/proxy` | 退出 0；**1,335 tests / 50 suites**，0 fail/cancelled/skipped |
| `npm.cmd run typecheck -w @octafuse/proxy` | 退出 0 |
| `npm.cmd run typecheck:dispatch-safety -w @octafuse/proxy` | 退出 0，包含完整路由测试 |
| `git diff --check` | 退出 0 |

测试输出通过 PowerShell 末尾摘要展示并保留原始退出码。两套数量高度重叠，不相加。Core 完整主套件未独立重跑，真实 D1/PostgreSQL/MySQL、Workers 和 Node 22 均不从该结果推定通过。

## 4. 基线与技能影响

HEAD：`7eb59008f7d8e156e81fd18a57658fdef2553264`。本轮开始有 **143 个 dirty/untracked 文件**。仅改 8 个源码/测试/收集配置文件及本轮证据/Checklist 索引；其他既有改动保留。[当前快照](./C02-realtime-ledger-snapshot.json)包含 **119 个文件**：8 个变更文件、68 个迁移及相关保护文件。最后完整测试前记录受改动源码哈希，测试后复核一致；不覆盖历史快照。

Workers 最佳实践技能促使独立观察两本账清理、限制未发送队列并核验终结后的消息所有权。公开依据为 [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)；最新 registry 获取失败，按技能 fallback 使用安装的 workers-types **5.20260829.1** 及本机 Wrangler schema。没有把本地类型检查或 SQLite adapter 称为真实 Workers 验证。

## 5. 剩余门禁与下一步

**下一项仍为 C02.B2.2：补齐 Realtime 尚未覆盖的完整候选与准备取消链路，然后处理 Admin playground。**

- 本轮覆盖平台 route failover 和私有 BYOK 成功/unknown，尚未覆盖真实共享渠道数据库候选展开、共享收益、BYOK → 平台的完整公开付费回退/Guardrail extension；这些不能仅由已有独立 helper 测试替代。
- 带真实 SQL 的准入进行中取消/超时、提交后响应丢失、并发竞争、进程崩溃后的恢复仍需实测；当前注入的是可确认 rollback 的 SQL 失败与恢复，不伪称网络提交未知已覆盖。
- Workers 入口起点、整个鉴权/路由/数据库准备的及时取消、剩余 HTTP 入口/headers/有效 TTFT/idle 等仍未完成。当前 deadline 不证明数据库物理操作有界。
- 17 个既有应用辅助认证调用点中，Realtime 两处已接请求预算，剩余 Admin playground 1 处；不把测试 fixture 计入应用调用点。Admin 本轮未修改。
- Realtime TTS 继续拒绝，Qwen HTTP TTS 格式保留 C17/C15 门禁。C01 location/保护级别/IAM 等选择不变，未重复云账号核验。
- C02.1–C02.7、C02.G 保持未勾选；C03–C20 不从本子集推定通过。真实平台门禁和外部授权仍需分别取得。

回退仅可关闭/收紧未验收能力；不能恢复丢弃未发送帧、未知请求重放、跳过预算清理、明文凭据回退或删除预算事实。

