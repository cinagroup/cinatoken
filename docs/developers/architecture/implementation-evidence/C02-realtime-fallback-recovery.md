# C02.B2.2 — Realtime 共享渠道、付费回退与提交边界

日期：2026-09-05。状态：**下列本地链路 LOCAL_PASS；C02 仍为 DOING**。执行与本地自检：Codex；独立 Reviewer 待指定。接续 [Realtime 路由/预算事务](./C02-realtime-ledger.md)，保留历史快照，不把新增测试称为商用验收。

## 1. 本轮范围

完善 [公开链路测试](../../../../packages/proxy/src/runtime/node-realtime-ledger.test.ts)及其 [SQLite D1-shaped adapter](../../../../packages/proxy/src/test-support/sqlite-d1.ts)。实际经过 Node HTTP Upgrade、鉴权、路由/定价、加密 BYOK/共享 Key 查询、预算 SQL、loopback WebSocket、用量记录与 critical write。应用 fetch 被限制为合成测试，不访问真实服务。

新增提交后 hooks：独立 SQL 执行后才等待/抛出 acknowledgement；batch 的 hook 在 COMMIT 之后、ROLLBACK catch 范围之外。不会把“响应丢失”模拟成实际回滚。取消场景使用真实客户端断开；deadline 场景仅推进 Date 后释放 SQL 确认，验证出站前检查，不冒充物理数据库超时。请求在确认返回前仍保有异步所有权。

共享 Key 使用真实本地 enc:v2 加解密，按 seller priority 从数据库展开候选；没有实现 Google KMS Vault。新增客户端状态、最终凭据种类、出站瞬间两本账及实际 SQL 的观察点。合成上游可延迟终态，以检查两个公开请求竞争同一用户预算。延迟响应的失败被观察，关闭后的 socket 不再发送。

没有修改生产运行时、Core 账务实现、schema/迁移、Admin、依赖锁、Wrangler、KMS 选型或原 V2.1。不会把供应商内部日志中的“calling provider”当成真实出站；测试以 loopback 上游实际收到的 Upgrade 计数。

## 2. 新增 56 项测试

两个 ASR operation 为 `audio.transcriptions.realtime.inference` 与 `audio.transcriptions.realtime.session`。金额为合成每秒 0.001 单位，601 秒预留上限为 601,000 微单位，不是商用报价。

| 范围 | 数量 | 验证结果 |
| --- | ---: | --- |
| BYOK → 平台 | 12 | 两 operation × Key 限额是否含 BYOK × actual/流异常/Ordinary 不足。首次 BYOK 不预留 Ordinary；付费候选发出前建立 Ordinary 和 Key 预留；不足时只发送 BYOK，明确 503 不变成收费 |
| Workspace 扩展 | 8 | 两 operation × BYOK 开关 × Workspace 容量是否充足；私有 BYOK 只占选定 Key 限额，付费回退增加 Workspace scope；已有 Key reservation 不重复，新 scope 拒绝时 Ordinary 释放 |
| 共享渠道 | 8 | 两 operation × 首 Key 成功/401/503/连接结果未知；401 仅使该 Key invalid，503 不永久禁用；明确拒绝可切下一 Key，unknown 不换 Key 或平台；日志归属最终 `sharedkey:` ID |
| 准入期间取消/超时 | 16 | 两 operation × Ordinary reserve/Guardrail reserve/Guardrail dispatch/Ordinary dispatch 四个真实提交点 × 断开/推进 deadline。确认延迟期间请求仍被持有；返回后零上游出站，预留和预算消费归零 |
| 提交确认丢失 | 10 | 两 operation × 上述四点及 critical settlement。reserve/结算通过既有重读确认，不重复发送或记账；dispatch marker 丢确认则停止出站，持久状态及 expiry 行为见第 3 节 |
| 并发容量 | 2 | 首请求已预留但上游终态延迟；第二请求不足以再预留 601,000 时拒绝，只有一次上游出站；第一请求完成后按 1,000 结算并释放容量 |

公开链路文件现在共 **104 项**（此前 48 项），其中 103 项经过本机 HTTP/WebSocket，1 项是已有 Hono route deadline callback 测试。不是 104 次真实云请求。并发证据仅覆盖同进程、真实内存 SQLite 的原子约束，不证明跨进程、PostgreSQL/MySQL 或托管 D1 一致性。

测试加强过程中，曾错误地预期平台 `provider_key_id` 为 null；核对 `model-router.ts` 的 provider ID 合同后修正为 `test-provider`，而不是改生产输出或放宽为任意值。最终日志仍明确区分 BYOK、共享与平台归属。

## 3. 已复现但未解决的发布边界

### 3.1 dispatch marker 丢确认不是“请求已确定收费”

| 丢失确认的写入 | 请求结束时 Ordinary | 请求结束时 Guardrail | 调用实际 expiry 后 |
| --- | --- | --- | --- |
| Guardrail dispatch | released，消费 0 | dispatched，仍保留 601,000 | Guardrail 转 expired、保守消费 601,000；Ordinary 仍 0 |
| Ordinary dispatch | dispatched，仍保留 601,000 | expired，保守消费 601,000 | Ordinary 也转 expired、保守消费 601,000 |

这两种情况下，loopback 上游接收次数均为 **0**，请求日志均未产生。已有实现以耐久 dispatch marker 保守处理，避免丢失预算事实或冒险重放；但预算消费不能当作已证实的供应商费用。与 [既有 unknown 口径](./C02-realtime-ledger.md#21-unknown-口径没有被改成确定收费)一致，本轮没有改成 Credits 最终扣款。

**C02 数据库写入恢复 / C03–C05 状态机与对账 / C08 耐久 dispatch 仍需处理**：区分 marker 提交未知、实际网络出站和可证实未发出；确认查询与独立恢复调度需有界、幂等且不可由不可信客户端驱动退款。测试中显式调用 expiry 不等于生产恢复任务已部署。Guardrail release helper 忽略零更新计数，可能把本地 owner 标成终态而实际 reservation 仍 dispatched；该问题仍需与跨数据库的确认/恢复合同一起修正，不把当前 LOCAL_PASS 扩张为所有权恢复完成。

### 3.2 共享音频卖家收益未闭环

六个共享成功用例均观察到买家预算按 1,000 结算、请求日志指向最终共享 Key，但 `shared_key_earnings` 为 **0 行**。源码核对：`recordAudioUsage` 没有调用共享收益结算；Core `settleSharedKeyEarning` 的费率和输入仅覆盖 token，对零 token 会提前返回，不能直接用于本例的秒数计费。

因此 **C04/C12/C17 必须补按计量单位的卖家报价快照、耐久收益事件和幂等对账，C15 前不得开放未验收的共享音频商用供给**。本轮不臆定卖家费率/佣金或写入虚构收益，也没有新增生产功能开关；“不能商用”是门禁要求，不声称现有线上供给已被关闭。

## 4. 最终验证与证据边界

Windows / Node.js **v24.14.1** / SQLite **3.51.2**，全部 **68 个 D1 迁移**在每个 fixture 的内存库执行。没有磁盘业务库写入，没有真实 KMS、OAuth、推理、付款、迁移、部署、远程 CI 或云账号访问。Node 22 / workerd / 托管 D1 / PostgreSQL / MySQL 本轮未验收。

| 命令 | 最终结果 |
| --- | --- |
| `node --import tsx --test src/runtime/node-realtime-ledger.test.ts`（Proxy 目录） | 退出 0；104 tests，0 fail/cancelled/skipped |
| `npm.cmd test -w @octafuse/proxy` | 退出 0；完整 pretest 链通过；主 suite 1,766 tests / 135 suites，0 fail/cancelled/skipped |
| `npm.cmd run test:dispatch-safety -w @octafuse/proxy` | 退出 0；1,391 tests / 50 suites，0 fail/cancelled/skipped |
| `npm.cmd run typecheck -w @octafuse/proxy` | 退出 0 |
| `npm.cmd run typecheck:dispatch-safety -w @octafuse/proxy` | 退出 0 |
| `git diff --check` | 退出 0；最终文档更新后复核 |

两套测试数量重叠，不能相加；Core 完整主套件未独立重跑。

HEAD `7eb59008f7d8e156e81fd18a57658fdef2553264`，本轮开始 149 个 dirty/untracked 文件。提交 hooks 和 fixture 扩展是此前尚未完成的本地准备；本轮在它们上面新增实际用例并修整合成上游的关闭处理。其他既有改动保留。[本轮快照](./C02-realtime-fallback-recovery-snapshot.json)记录当前受测相关文件，不覆盖历史快照。

Workers 最佳实践技能促使检查 Promise 所有权、提交后不能错误 rollback、关闭后不继续发帧及本地/真实平台的证据分层。公开依据：[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。最新 registry 获取失败，按技能 fallback 核验安装的 workers-types **5.20260829.1** 与 Wrangler schema；没有更新 binding 或配置。

## 5. 下一实施项

继续 **C02.B2.2 — Admin playground 辅助认证预算与取消合同**。17 个既有应用辅助认证调用点仍有该 1 处未接预算；保持 Admin 单路由、不写买家请求日志、不进入买家账本、无 failover 的独立语义，不为补预算把它接入另一套收费调度器。

随后回到全入口/上传/鉴权/数据库准备、headers/有效 TTFT/idle 及本页 marker 确认恢复缺口。进程崩溃、跨进程竞争、真实数据库故障/物理超时仍待覆盖。C02 复合条目和 C02.G 不勾选；C01 与 C03–C20 状态不变。GCP project `cinatoken` 不再重复询问；真实资源配置仍需 location/保护级别/身份/IAM 等授权。
