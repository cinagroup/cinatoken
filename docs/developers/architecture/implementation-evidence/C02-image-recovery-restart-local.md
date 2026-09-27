# C02.B2.2：真实 Images 路由重启与组合结算

2026-09-07，Checklist v1.53，LOCAL_PASS 子集。C02 DOING，完整 Workers 恢复/容量与 C02.G 仍 NOT_PASSED；Owner / 自检：Codex，独立 Reviewer 未指定。[结构化结果与源码摘要](./C02-image-recovery-restart-local-results.json)。没有启用生产/云端恢复路径，没有新增远端迁移或资源。

## 1. 测试发现并修复的财务回归

v1.52 原型在[生产者](../../../../packages/proxy/src/services/image-usage-recovery.ts)复制输入前删除 `requestOrigin`。但[完整 USD 快照构造](../../../../packages/proxy/src/services/generation-metadata-snapshot.ts)在 origin 缺失时会连同 `isByok` 一起清空。[D1 既有结算](../../../../packages/core/src/db/d1/critical-writes.impl.ts)使用 `isByok` 决定是否按路由标准价结算 `gateway_key_route`，于是私人 BYOK 本应计入 Gateway Key 限额的 0.1 合成成本被错误结算为 0。平台用例只检查 charged cost，无法揭示这一缺口。

新组合组首次 **2/14 PASS、12/14 FAIL**：平台/fallback 日志 BYOK 标记为 null，私人 BYOK include-in-limit 场景还出现限额结算 0。没有放宽这些断言或修改原计费规则。修复为：

- 保留严格规范化的网关 HTTP(S) origin；拒绝凭据、路径、query、非法 scheme 和超长 origin。它不是用户 `HTTP-Referer` / `User-Agent`，后两者仍不进入本原型恢复快照。
- 私人 BYOK 缺少完整已验证 USD/BYOK 快照时，在持久化前拒绝，不把 null 当作“非 BYOK”。
- 出站前固定非秘密 `providerKeyId`，将其纳入 context 摘要和最终结算身份匹配；同 provider/target 但换了凭据也不能冒用最后一次 claim。

这是对 **v1.52 未启用原型**的修复，不是历史资金修复；没有声称现有默认/线上路径出现这一问题，也没有修改旧日志或放宽预算政策。v1.52 的源码摘要和原测试记录保留，不能把旧平台子集通过外推为私人 BYOK 验收。context 摘要仍不等于完整报价/权益/credential owner 快照。

## 2. 新证据

[进程矩阵](../../../../packages/proxy/scripts/staging/images-recovery-process.test.mjs)新增 **24 项**：普通生成和编辑 × 零价/0.1 合成预算 × 六种断点。每个样本让[真实共享应用子进程](../../../../packages/proxy/scripts/staging/images-recovery-process.fixture.mjs)处理鉴权、选路、预算、合成上游、生产者与事务，再以退出码 73 退出。

| 真实退出边界 | 可恢复事实 / 验证 |
| --- | --- |
| dispatch claim 已写、确认未回到驱动 | 上游发送 0，claim 保留；不因没有日志而取得第二次发送权 |
| 上游完成、快照 INSERT 之前 | 上游发送 1，没有结果快照；消费者不编造用量或经济写入 |
| 快照 INSERT 已提交、确认未返回 | 同事务 pending 任务存在，新进程独立扫描并提交 |
| 最终账务 batch 开始、回执 INSERT 之前 | 进程退出使未完成事务回滚；后续新租约恢复一次 |
| 最终账务 batch COMMIT 之后 | 日志/回执/尝试/统计/预算已提交；消费者不重复收费 |
| 本地 Response 消费端已读到 200 及 EOF、后台领取 ACK 被悬挂 | 原进程退出后仅凭持久化任务完成账务；不是靠原请求 Promise 存活 |

两个后续消费者分别在独立进程运行，只接收数据库路径和测试时钟，**不接收原请求、Key、DTO 或事件引用**。第二个消费者确认没有重复领取。无快照场景保持未知、预算按现有状态保留；测试窗口未经过原预算过期，不据此修改既有过期策略。所有存在快照的样本最终恰好一条日志/回执/尝试与一份统计，金额准确，SQLite foreign-key check 通过。仅清理测试自己新建目录中的固定 allowlist 数据库文件和空目录，没有删除用户数据。

[组合矩阵](../../../../packages/proxy/scripts/staging/images-recovery-combinations.test.mjs)新增 **14 项**：两个不同 provider 的 fallback 保留两次真实 attempt 和最终 endpoint；普通生成/编辑 × 平台/私人 BYOK/私人拒绝后付费 fallback × Key 是否计入 BYOK。使用本地合成 AES 密文经真实仓储解密，不使用真实模型凭据或 KMS。Key 与 Workspace 预算通过真实 Guardrail 表/事务执行；最终 ledger 写入失败后，独立执行器恢复而不重发推理。

私人 BYOK 用户普通余额保持 0；include-in-limit=true 时 Key 路由额度准确结算 100,000 micros，false 时不创建该额度 reservation。平台与付费 fallback 的普通、Key、Workspace 预算按原规则各自结算 100,000 micros，不混淆它们的计费范围。

原[生产者专项](../../../../packages/proxy/scripts/staging/images-recovery-chain.test.mjs)另增 **6 项**：凭据引用冲突、不完整 BYOK 快照及四种非法 origin。该组由 42 扩至 **48**，本轮总计 **44 项新增测试**。共同[测试夹具](../../../../packages/proxy/scripts/staging/images-recovery-test-support.mjs)已抽出，默认仍为内存 SQLite，显式路径仅供测试子进程重开。

## 3. 验证边界

- `npm run test:images:staging -w @octafuse/proxy`：既有 **35+7**，posttest 路由/组合/定价/错误 **110**，嵌套进程矩阵 **24**；无失败、取消或跳过。
- `npm run test:dispatch-safety -w @octafuse/proxy`：**2,687/2,687**。
- Core 意图 → 结算 → 恢复 **19 / 37 / 32**，普通预算 **33**；Core 恢复与 Proxy dispatch-safety/staging 三项定向类型检查通过。
- 完整 Core 类型检查仍 **FAIL：32 条原诊断**；Compiler API 文件/位置/代码/消息与 v1.52 引用基线完全一致。没有排除新模块或删除旧诊断来宣称全包通过。

测试数包含重叠，不合并宣传为独立总数。Node 24 / 真实 SQLite、合成密码材料和受控进程退出，不是 Workers isolate 终止、Cloudflare D1 并发或付费资金验收。Response 在生产者子进程内消费，没有网络 socket / 反向代理交付确认样本。进程仅退出，不模拟操作系统断电/文件系统丢失。1,024 字节消费者容量是逻辑计数夹具，不是生产工作集估计；保留完整 origin/USD 快照增加的持有也须纳入测量。

## 4. 未完成与下一步

本轮原计划继续触发入口，因发现上述财务回归，先完成红绿验证和真实路由故障矩阵；**受保护的有界触发入口尚未实现/部署**。下一步接专用运行入口及授权/环境隔离、单次准入与容量持有；继续补预算拒绝/不确定结果/多 scope 故障与 SSE 合同，然后独立 staging 的平台期限/重启、真实 D1 和完整工作集。

本轮组合不代表任意自定义 Guardrail policy、共享卖家收益、所有默认参数、模型级 fallback 或全部失败路径已验收。审计保留兼容、错误告警 outbox、请求重试去重、SQL 定义真实性与财务 unknown 终结政策仍未完成。仅有已冻结结果 DTO 时才能恢复；原缺失事件仍不能凭探针补账。[线上 5 次成功仅 4 条日志](./C02-staging-image-storage.md) 保持开放。

Cloudflare / Workers 最佳实践技能促使本轮把跨请求恢复输入与原进程所有权分开，并核对参数化 D1 binding/原子事务及故障后的财务一致性。[Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)、[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/)。最新 types 只读核对 5.20260907.1，安装仍 5.20260829.1，未升级依赖。

三份 SQL 仍在 proposals，正式迁移 **68** 份，生产容量池和恢复接入均关闭。本轮云管理、发布、远端 SQL、真实模型/KMS 调用均 **0**；历史 staging HTTP **98**、模型/KMS **0**、首轮累计 **US$2 不重置**。最终增量账单未核验；远端关闭状态沿用已有证据，不冒充本轮复核。C02.G / C03–C20 不因上述局部证据完成。
