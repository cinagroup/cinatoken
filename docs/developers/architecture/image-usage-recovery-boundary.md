# Images 用量恢复：边界与有限实施合同

2026-09-21 技术合同补记：[ADR-0002](./decisions/ADR-0002-request-execution-settlement-states.md)已按用户确认冻结派发 / 恢复所有权和状态分离，作为 PostgreSQL C03 实现依据；现有 D1 原型及其测试只提供可复用语义，不是 PostgreSQL 验收。unknown 最终收费与撤权政策仍未签核。

2026-09-21 生产目标补记：[ADR-0001](./decisions/ADR-0001-production-financial-authority.md) 已选择 PostgreSQL 为预算 / 资金唯一权威。本文 D1 实现和 staging 证据保留，但不认证 PostgreSQL 恢复路径；当前 `createImageUsageRecoveryFactory` 仍明确拒绝非 D1。后续须在 C01.3 / C03 完成 PostgreSQL 的状态合同、持久化与恢复实现，不能只切驱动或回落 D1 完成生产记账。新选择不是部署 / 迁移授权。

2026-09-07，C02.B2.2 的待实现合同草案，不是部署授权或新增财务政策。依据 [真实 Workers/D1 故障证据](./implementation-evidence/C02-staging-image-storage.md)：5 次成功响应只有 4 条日志；仅延长请求生命周期无法补回提交前失败的用量事实。C02.G 保持未通过，C03–C05 未完成。

## 1. 必须区分的状态

| 可证明事实 | 恢复可做什么 | 不得推导 |
| --- | --- | --- |
| 尚无耐久 intent，且尚未 dispatch | 拒绝新出站；保留可解释的失败 | 内存 Promise 等同已持久化 |
| intent 已提交，dispatch 是否发生不明 | 进入明确的 unknown / 待对账路径 | 没有用量日志就等于未发送、零费用或可换候选 |
| 完整、版本化的结算输入已持久化，最终事务未完成 | 有界领取相同事件，幂等完成原事务 | 重新请求模型来重建用量，或按当前价格重算历史金额 |
| 最终事务已提交，返回确认失败 | 回查同租户/同事件的终态、身份和金额/快照后认定已提交 | 任意同 id 行都算成功，或报错就再次扣费 |
| 消费者退出、超时或失去 lease | 后续消费者依据持久化状态与 fencing 继续 | TTL 到期证明供应商未执行、允许自动退款或新增 dispatch |

“执行结果确定性”“结算进度”“客户端交付状态”是不同维度，不能压成一个 success/failed。现有 reservation、generation/request id、attempt 和日志主键应复用；不能另建无关联的平行资金账本。

## 2. 最小实现约束

1. **先记录可追踪意图，再取得出站权。** 将已有 reservation/attempt 身份与耐久记录建立关联；零价也需要恢复身份，不能依赖非零预算是否产生 reservation。intent 不足以恢复丢失的用量，dispatch 后缺少事实必须保留 unknown。
2. **区分意图与完整结算输入。** 后者固定价格/权益/credential owner 引用、实际计量投影、归因和事件版本，包含足以复用现有 critical write 的输入；字段与总量均有显式上限，不保存凭据、prompt、图片或完整响应。不得在恢复时读取现价覆盖历史快照。
3. **确定持久化断点。** 结果已拿到但结算输入尚未耐久时，重启仍可能丢失结果。必须在支持的返回模式下定义“交付成功前保证哪些事实”；流式 SSE 无法追回已发出的字节，需单独合同，不能用普通 JSON 的顺序偷偷覆盖。
4. **原子提交与幂等回查。** 用量/预算变化、尝试事实、统计、必要 outbox 及 intent 终态按支持后端的事务合同协调；同 id 不同租户、快照或金额是冲突，不是幂等成功。重复消费只能完成同一经济事件。
5. **恢复不依赖原请求存活。** 独立、有界扫描/消费者按 CAS revision + fencing 领取，限制批量、并发、重试与单次时限。Queue 只能作为触发方式；仅 await queue.send() 仍不能填平 DB/Queue 双写断点，需耐久 outbox 或等价可回查协议。
6. **平台持有与容量持有分别处理。** waitUntil 可用于当前请求尽力完成工作；实例 lease 覆盖实际持有的响应/后台资源，不以恢复记录 TTL 自动归还仍在运行的工作。独立消费者的内存/数据库预算也纳入矩阵。

## 3. 有限顺序与验收样本

1. C02.B2.2：本地固定上述状态/回查合同，逐项列明现有实现可复用处和缺口；先覆盖零价及已有正数 reservation 的事务边界。不改未知成本政策，不向真实模型发送恢复请求。
2. C03/C04 对应子项：冻结最小 schema、唯一约束、fencing 和不可变结算输入 / outbox。先本地迁移与各声明支持后端测试；数据库未支持时显式关闭新路径，不能回退为无保障成功。远端迁移另按已有审批门禁执行。
3. C05 对应子项：只使用已确认财务规则处理 unknown / 迟到 actual；尚未确认规则进入可查询、有限人工/对账流程，不自行确定退款和卖家收益。
4. 回到 C02.B2.2：用同一故障探针验证丢确认、重复消费、不同租户冲突、并发领取、旧持有者恢复、进程重启、超过 waitUntil 窗口；同时确认不新增推理发送、不重复日志/统计/费用，并核验所有权持有。

本地必须有红绿测试：intent 写前/写后失败；dispatch 前/后中断；结算输入持久化前/后退出；最终 batch 提交前失败/提交后丢 ACK；回查也失败；重复及并发消费者；事件内容不一致；队列不可用/重复投递；旧 lease 与迟到事件。普通成功对照与不重启的原进程重试不能替代重启实验。

首发数据库/区域/流式范围、unknown 终结规则、后台恢复 SLO 与容量参数仍取自 C01.9/C01.10。缺失商业决定不妨碍本地合同草案，但不允许开启付费/共享生产路径。这个文件不创建云资源、不勾选任何门禁，也不扩大 US$2 首轮预算。

## 4. 当前落地边界

[2026-09-07 本地意图基础](./implementation-evidence/C02-dispatch-intent-local.md) 已实现 request/attempt 级身份、前向 CAS、一次性出站认领和过期分类；19 项测试包括三项子进程退出。SQL 仍是未纳入自动迁移的草案，没有路由接入。context_sha256 仅是内部上下文关联字段，未实现规范化完整快照；不能凭摘要重建实际计量，也不能凭 claim 取代鉴权/预算/真实发送次数准入。

[2026-09-07 结算快照 / 原子回执本地基础](./implementation-evidence/C02-usage-settlement-local.md) 已补版本 1 的完整 critical-write 输入、256 KiB 总量限制、规范化摘要及单事件持久化/恢复入口；同一 batch 写入回执、日志、尝试、统计和原有预算结算。37 项测试含八项子进程退出，零价/正数、预算周期变化和 Guardrail 回滚已覆盖。SQL 仍在 proposals，路由未接入；这些技术限额不是已启用的公开限制。

[2026-09-07 有界恢复执行器本地基础](./implementation-evidence/C02-usage-recovery-consumer-local.md) 已补同事务 pending 任务、索引标量扫描、CAS 租约/fencing、最多五次领取与退避、blocked 对账状态及 D1 持有期容量；32 项测试含六项子进程退出。租约按数据库时钟在账务事务内检查；准入窗口不是 D1 硬取消或物理容量归还。SQL 仍在 proposals，没有已部署的触发消费者。

[2026-09-07 Images 生产者 / 交付前持久化本地接入](./implementation-evidence/C02-image-recovery-producer-local.md) 已加入默认关闭的普通生成/编辑路径：schema 预检、出站前意图/CAS、结果快照及原子任务确认后才交付成功；结果保存不明返回专用 503，保留未知事实和原预算，不回退旧记账。新增 44 项测试；SSE 保留旧合同，审计投影仅为 opt-in 原型策略，生产/云端均未启用。错误提示不能阻止 SDK 默认重试，尚非客户端幂等合同。

[2026-09-07 真实路由重启/组合本地子集](./implementation-evidence/C02-image-recovery-restart-local.md) 新增 24 项进程断点、14 项 fallback/私人 BYOK/Key/Workspace 预算组合及 6 项防线。发现 v1.52 删除 origin 会清空 BYOK 财务快照并低结算 Key 额度，已保留规范网关 origin、拒绝不完整 BYOK 快照并核对固定凭据引用；不是新增计费规则。旧版平台子集不能外推 BYOK。普通路径依旧默认关闭，SSE 和全部不确定/拒绝组合尚未验收。

[2026-09-07 私有 RPC / 独立 host 本地子集](./implementation-evidence/C02-image-recovery-trigger-local.md) 新增 60 项测试。独立命名能力入口无参数触发，HTTP 固定拒绝；仅绑定隔离 staging D1 的禁用配置，无模型/KMS 凭据。先登记 waitUntil，再有界扫描；实例只保存数值池/运行标记，不缓存请求/绑定/任务。异步 D1 未结束不归还容量，不把实例互斥当成分布式锁。Wrangler 类型检查及离线打包通过；没有受保护控制调用方或真实 Workers RPC 授权/取消证据。

[2026-09-07 恢复控制入口本地子集](./implementation-evidence/C02-image-recovery-control-local.md) 新增 87 项测试。独立控制 Worker 核对配置 audience 对应的原生 ctx.access，不解析/信任自报 JWT、Cookie 或身份 Header；服务端只发送一次无参数命名 RPC，HTTP 不接受命令体/查询参数或浏览器 Origin。提前登记平台持有，RPC 未结束时不因禁用/断连释放实例 gate；不明结果不自动重试。生成类型隔离模块作用域，避免控制/接收 Worker 的 Env 合并；控制包只含两个源模块，没有 D1/Provider/KMS。专用 Access 应用/最小策略、真实空 POST 表示、RPC 生命周期与平台权限仍需云端验证，源配置继续关闭。

[2026-09-07 schema/source artifact 本地子集](./implementation-evidence/C02-image-recovery-schema-local.md) 新增 67 项测试。锁定现有迁移输入，校验四张恢复表及其 24 个表/索引/触发器的完整定义 SHA-256；不只验证名字或长度，额外对象与超长定义也拒绝。单次 SQL 最多返回 25 行、每条 SQL 文本最多 4,096 字节；实际正确定义合计 10,072 字节。独立消费者取得容量后核验，超时/取消不能提前释放此读取；生产者出站/保存/快速结算前重新核验，无成功缓存。它不是防御 DBA、并发 DDL、TEMP shadow 或全库数据篡改的边界，不证明回填执行完成，仍需受控发布与远端核验。

下一项具体实现为**专用 Access 策略与封闭实验双 Worker 发布**，继而验证真实 Workers 无体 POST/RPC/D1、授权、平台终止恢复及完整工作集。最新 [staging schema 与容量候选证据](./implementation-evidence/C02-staging-recovery-schema.md) 已完成隔离 D1 的三份草案、24 个定义对象及空输入回填核验；非空旧数据回填仍未证明。32 MiB 候选被 Node 密集审计样本反驳，64 MiB 仅为待测分配，源配置/生产工厂仍禁用。D1 管理绑定无表级/租户级 IAM，环境字符串不是身份核验；审计保留、错误 outbox、完整财务 unknown/BYOK/guardrail、预先报价/权益/owner 和卖家收益等门禁仍保留，C02.G 与 C03–C20 不因此通过。
