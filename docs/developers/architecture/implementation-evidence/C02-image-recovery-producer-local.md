# C02.B2.2：Images 可信结算生产者与交付前持久化

后续更正（v1.53）：[真实路由重启/组合测试](./C02-image-recovery-restart-local.md) 发现本版原型移除 origin 会连带清空 BYOK 财务快照，导致私人 BYOK 的 Key 路由额度结算错误，现已修复。以下保留 v1.52 当时的实现/测试记录及摘要；其平台路线子集不能外推为私人 BYOK 验收。该原型从未在线上启用。

2026-09-07，Checklist v1.52，LOCAL_PASS 子集。C02 DOING，C02.G / 完整恢复与容量仍 NOT_PASSED。Owner / 自检：Codex；独立 Reviewer 未指定。[结构化结果与源码摘要](./C02-image-recovery-producer-local-results.json)。本轮没有发布、远端迁移、真实模型或 KMS 调用。

## 1. 已实现的接入

[生产者](../../../../packages/proxy/src/services/image-usage-recovery.ts)通过[应用工厂](../../../../packages/proxy/src/app.ts)的显式 `imageUsageRecovery` 参数接入[普通 Images 生成 / 编辑路由](../../../../packages/proxy/src/routes/v1/images.ts)。它只支持 D1 草案 schema，默认关闭，没有环境变量、请求头或用户正文开关；生产 Workers / Node 工厂和 staging 入口均未启用。

顺序为：检查恢复 schema → 保存 request/attempt 意图 → 原预算准入 → CAS 取得出站权 → 原驱动发送 → 准备既有结算 DTO → 等待快照及同事务任务确认 → 允许成功响应 → 尽力执行已领取任务。回执和经济写入继续使用原有事务与 fencing，不重新请求模型、不读取现价重算快照。[定价模块](../../../../packages/proxy/src/services/image-usage-charge.ts)拆成只准备 DTO 的函数和原默认写入函数；没有改动定价算法。

每次出站前检查九个所需触发器及任务/回执列，捕获不完整部署；这只是完整性预检，**不是 SQL 定义真实性检查或对数据库管理员的安全边界**。后续发布仍须核对审核后的 SQL 摘要。快照保存后再确认同请求、用户、Key、Workspace 与摘要的任务，任务缺失/blocked/回查失败不能返回成功；中途触发器消失亦不能仅凭孤立快照放行。不自动建表、补 trigger 或回退。

## 2. 故障和交付语义

| 断点 | 当前 opt-in 行为 |
| --- | --- |
| schema 不完整 | 在模型发送前拒绝；仍沿用原先未出站的安全清理路径 |
| 已有 dispatch claim，但快照/任务确认不明 | 取消待交付正文，返回 503 `gateway.image_settlement_unconfirmed`；固定提示、关联 request id、`outcome_unknown=true`、`retry_safe=false`，不进入旧记账或 forfeit 路径 |
| 快照与任务确认，最终记账暂时失败 | 可以交付已验证的普通响应；任务按既有 CAS/退避合同恢复，无重复预算、日志、尝试和统计 |
| 最终事务提交但 ACK 丢失 | 核对原子回执和同事件金额后确认，不再次扣费 |

不明响应不是“未调用”或“免费”。没有结果快照时，只能保留未知状态；原预算既有过期策略没有改变，不新增自动退款。当前 SDK 可能默认重试 503，**错误提示/metadata 不是跨客户端幂等保证**；尚无请求重试去重/查询恢复合同，部署前必须明确客户端处理方式。驱动边界中断后仍可能走既有通用错误响应，本次新增专用码只覆盖结果持久化确认失败。

显式 `stream:true` 的 SSE 保留原合同，普通恢复不覆盖已经发出的流字节；意外流结果在取得普通恢复 claim 后不得回退旧结算。尚未交付的普通结果，在客户端取消期间仍等待已开始的持久化操作，不以取消抢跑返回/释放；已确定的用量不会被随后断连逆转。需要真实 Workers 终止与 host 持有期验收，不能由本地 Promise 证明平台保活。

## 3. 审计投影与容量边界

仅新 opt-in 路径在复制前排除 request/upstream body、原始 usage 扩展、请求头、session、用户邮箱、Key label/fingerprint、自由错误文本、原始 routing/timing 诊断和 circuit alert 对象；usage 仅保存六个规范化计数。准备后清除完整用户 profile 审计副本，保留预算专用字段、价格事实、provider attempt、路由身份及现有经济规则。

这是**未启用原型的技术投影**，不是用户已确认的全产品审计保留政策。原默认路径仍保留旧元数据合同。保留的 provider/model 名称、价格证据与上游 request id 等仍来自可信配置或受限来源，不宣称对任意字符串提供通用脱敏。完整生产审计兼容/保留期限还需验收。

本路径暂不发送旧 writer 的错误 webhook，也没有可靠告警 outbox、卖家收益或 dispatch 前报价/权益/credential owner 快照；不能用结算成功表示这些完成。后台快路径由独立函数只接收有界引用，不接收原请求/响应/凭据/DTO；它只是尽力执行，独立扫描任务仍是恢复来源。

原 codec 的 256 KiB/字段/结构上限继续有效，不截断经济事实；这是技术载荷限制，不等于完整工作集。定价、用户预算读取、审计准备、哈希、SQL 参数和反压中的图片响应仍会同时占用资源，新增预检也有 D1 查询成本。未测量生产字节预留、D1 取消或跨事件共享池；生产容量关闭，50 / 20 / 32 MiB 外部合同不变。

## 4. 验证及未覆盖部分

[新路由/生产者专项](../../../../packages/proxy/scripts/staging/images-recovery-chain.test.mjs) **42/42**：真实共享 Hono 应用、Workers 存储解析与真实 SQLite 事务，全部外网 fetch 禁止。覆盖生成/编辑零价及 0.1 合成预算、dispatch 前 claim、确认前不返回成功、快照写前失败/ACK 丢失/两层回查失败、最终 batch 回滚/ACK 丢失、领取确认不明、独立执行器恢复及不按现价重算；覆盖三个不完整 schema、九个缺失 trigger、出站后 enqueue 消失、默认路径不依赖新表、usage 投影、取消期间持有、显式 SSE、十种身份冲突、输入复制及字段超限。

另新增两个单测：准备 DTO 不写资金/日志；专用不明错误码不泄露内部详情。本轮共 **44 项新增测试**。首次故障组发现通用错误码会被统一规范成 500 并隐藏提示，随后增加专用固定码；另修正了 per-image token 断言与预期的取消正文读取失败。schema 预检闭包曾失去 D1 类型收窄，捕获已收窄 binding 后定向检查通过。

回归结果（有重叠，不相加宣传为独立用例数）：

- `npm run test:images:staging -w @octafuse/proxy`：既有 **35+7**，新增 posttest 的路由/定价/错误组合 **90**，全部通过。
- `npm run test:dispatch-safety -w @octafuse/proxy`：**2,687/2,687**。
- Core 意图 → 结算 → 恢复链：**19 / 37 / 32**；Core 普通预算 **33**；Proxy 普通预算 **38**。
- Core 恢复、Proxy dispatch-safety / staging 三项定向类型检查通过。完整 Core 类型检查仍 **FAIL，32 条既有诊断**，Compiler API 对文件/位置/代码/消息逐项比对 v1.51 引用的基线，完全相同。

以上无失败、跳过或取消。新路由测试是 Node 24/SQLite，不是 workerd、云端 D1 或真实付费测试。既有仓储子进程退出测试已重跑，但**本轮没有新增真实路由进程退出样本**；多候选 fallback、端到端私人 BYOK / 非空 Guardrail、完整大包与 SSE 故障矩阵仍须补齐，不能从零价/0.1 平台路线外推。

## 5. 接续门禁

下一步仍 C02.B2.2：补路由生产者的进程中断/多候选与预算组合证据，再接受保护、有界、纳入容量持有的恢复触发入口；之后到独立 staging 验证 D1 确认丢失、平台期限/重启与混合工作集。三份 SQL 保留在 proposals，正式迁移仍 68 份。没有已部署恢复服务；[线上 5 次成功仅 4 条日志](./C02-staging-image-storage.md) 仍开放，C02.G 不勾选。

Cloudflare / Workers 最佳实践技能影响了关键决策：成功交付前显式等待耐久事实，不把 waitUntil 当可靠队列；使用 D1 binding 和既有原子 batch，将容量持有与超时/租约区分。[Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)、[D1 事务合同](https://developers.cloudflare.com/d1/worker-api/d1-database/)。Workers types 最新只读核对 5.20260907.1，安装仍为 5.20260829.1，未升级。

本轮云端管理、远端 SQL、发布、真实模型和 KMS 调用均 **0**；历史 staging HTTP **98**、真实模型/KMS **0**。首轮累计 **US$2 上限不重置**；最终增量账单未核验，远端关闭状态沿用历史证据，不冒充本轮复核。
