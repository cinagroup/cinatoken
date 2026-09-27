# ADR-0002：派发、结果、结算与资源生命周期

- 状态：**ACCEPTED — C01.3 技术边界已批准；下述逻辑合同指导本地实现，尚非实现 / 集成 / 发布验收**。
- 日期：2026-09-21；版本：1。
- 决策依据：用户确认“派发认领或上游结果不明时不自动重发推理；恢复只处理同一份已持久化结算事实，并隔离过期执行者；客户端交付、上游结果、记账和资源释放分别记录”，且不决定 unknown 收费、不承诺跨网络 exactly-once。
- 前置：[ADR-0001 PostgreSQL 权威](./ADR-0001-production-financial-authority.md)。范围：C01.3；指导 C02、C03、C04、C05、C07–C09、C12、C15。

用户批准的是上述技术原则；以下状态、转移与接口要求是据此形成的工程规格，不把数值参数、财务政策、撤权时点或云端动作扩张为已获批准。逻辑状态不要求全部新增为数据库 enum；C03 负责映射到复用的现有表、不可变事实和受约束更新。

## 1. 身份与授权对象

同一个服务端 `request_id` 贯穿 admission、所有模型 / 路由 / credential fallback、用量与结算；每次候选出站有独立 `attempt_index`。HTTP 重试、客户端 Idempotency-Key 与跨请求去重由 C12 冻结，不能假设客户端重发自然复用同一 request。

派发上下文至少绑定租户范围、API Key、request / attempt、operation、最终 target、credential 引用 / 版本（适用时）、预算与授权 / 报价依据。当前 D1 原型只有 `user_id/api_key_id/workspace_id` 与上下文摘要等字段；完整 account / credential / quote / policy 关系仍须 C03 实现。摘要用于一致性，不是签名、授权或“已发送”证明。对象在跨 await 前复制 / 冻结；不能哈希后再读取调用方可变对象。

| 对象 | 授予什么 | 绝不授予什么 |
| --- | --- | --- |
| 预算 reservation | 某预算 epoch 的已预留额度 | 新的 dispatch 次数、最终收费、凭据解密权限 |
| credential / provider-account capacity lease | 有版本和范围的调度占用 | 资金余额、跨 credential 使用、未知上游已停止的证明 |
| dispatch claim | 一次、当前获胜调用者的发送认领；仍须满足其余准入 | 重新读回后的第二次发送、过期重开、自动 fallback |
| settlement recovery lease | 对固定结算事实尝试幂等提交的临时所有权 | 新推理、重新选择价格 / credential、改写原事实 |
| 本实例资源 hold | 对实际在途工作登记容量所有权 | 跨实例配额、数据库提交成功、物理内存已经释放 |

## 2. 独立状态维度

不能用单一 `success/failed` 或 HTTP 状态覆盖以下事实。公开响应状态是投影，不是资金或资源权威。

| 维度 | 逻辑状态 / 事实 | 终态含义与限制 |
| --- | --- | --- |
| request admission | `not_admitted → admitted → closed`，或准入拒绝 | closed 只阻止新业务出站；已有结算和清理可继续 |
| attempt intent | `prepared → dispatch_claimed → outcome_unknown`；`prepared → expired_before_dispatch` | 不允许重开 / 更换 claim；unknown 是保守历史分类，可由后续独立证据补充结果，不能倒退成新发送许可 |
| 上游结果 | `unobserved / known_not_sent / known_rejected / known_success / unknown`，并独立记录成功响应头 / 已输出事实 | 2xx 响应头不是完整成功；无日志不是 known_not_sent；迟到事实须可信、同身份且可审计 |
| 客户端交付 | `not_started / streaming / locally_finished / cancelled / failed` | locally_finished 仅表示本地交付器结束，不宣称客户端收到全部内容；取消不抹去上游或记账事实 |
| 结算事实 / 提交 | 无完整快照 → `snapshot_durable` + 可发现任务 → `committed`，或冲突 / 待核实 | 快照耐久不等于最终扣账已完成；ACK 丢失是观察不确定，不应创造新的经济事件 |
| 结算恢复任务 | `pending → leased → committed`；失败退避回 pending 或进入 blocked；过期 leased 可由新 fencing revision 认领 | blocked 不自动重置；恢复次数与上游 dispatch 次数分开计算 |
| 调度 lease | `reserved / dispatched / released / expired`，另保留未确认在途占用事实 | 到期撤销所有权，不证明上游结束；不能仅靠 TTL 归还未知在途容量或退款 |
| 资源生命周期 | `held → cleanup_pending → confirmed / unconfirmed` | confirmed 只覆盖已登记资源的结束证据；无响应 / 拒绝的 cancel 不等于物理释放；记账不等待此维度才可确认成功 |

预算仓储现有 `reserved/dispatched/settled/released/expired` 必须另行保留；它不是 attempt 状态。`markDispatched()` 的幂等 true 不能作为 one-shot dispatch grant。尤其现有 PostgreSQL `forfeitDispatched/expireBefore` 会按预留额处理过期 dispatched 预算，这是已有实现事实，**本 ADR 不把它批准为共享平台最终收费政策**。C01.5 / C01.6 未冻结前，不启用依赖该假设的新生产资金路径，也不在本轮悄悄改变旧算法。

## 3. 关键转移合同

### 3.1 出站前与发送认领

1. request 级出站次数 / 总 deadline 不因模型、目标或 credential fallback 重置；已消费的发送 permit 不退还。当前本地上限 3 是实现基线，不代替 C01.10 的全部参数签核。
2. 取得有范围的 intent、适用的耐久预算预留、调度容量及当前授权 / 政策依据后，才可竞争 dispatch claim。C03.4 须固定这些准备步骤的提交次序和失败补偿；未完成准备的 intent 没有发送权。
3. `prepared → dispatch_claimed` 通过完整身份、状态、revision、期限的原子比较与更新竞争。只有收到明确成功结果的当前调用者可继续一次发送；grant 是必要条件，不免除 C01.4 的消费时授权规则或 deadline 检查。
4. claim 前失败 / 0 行更新不能发送。claim 提交确认丢失也不能发送，**即使读回自己的 claim ID**。读回可以帮助分类，不能再次授予认领或更换 attempt 绕过 request 级不明状态。
5. claim 已提交但进程在发送前退出，可能发生“零次实际发送但保守 unknown”。这是接受的可用性代价，不用自动重放来弥补，也不据此确定费用。
6. 同一 attempt 的 claim 永不重新开放。过期 prepared 可归类为 `expired_before_dispatch`，但必须在所有出站均受 claim 约束的实现中才可解释为没有通过该路径发送；不能据此证明历史旧代码或旁路未发送。

### 3.2 fallback 与上游结果

- 明确、可信的未发送 / 拒绝证据，只有同时满足协议的安全重试分类、剩余次数、总 deadline、租户政策和新准入时，才允许**新的 attempt**。不能仅凭 429 / 5xx 数字推断厂商未接受；不重复已消费 attempt / target 的许可。
- claim 确认不明、上游结果不明、成功响应头、已开始向客户端输出、客户端取消或不可迁移的状态句柄均关闭该请求自动重放路径。取消不取消已成立的成功事实。
- unknown 可由与 request / attempt / provider identity 绑定的迟到权威事实补充；保留原始观察与解析版本，不覆盖冲突。矛盾事实进入待核实，不强行挑一个结果或清空 claim。
- 恢复消费者不调用推理、无权新建 attempt，也不凭“原请求没完成”调用另一个 credential 或 provider。

### 3.3 已批准的 Images SSE 成功点

沿用用户此前确认：网关验证到有效 completed 图片及**上游** `[DONE]`，且该 operation 所要求的格式 / usage 校验通过，成功结算事实不可因之后客户端取消而撤销。错误包装器生成的 DONE、只有 completed 而无上游 DONE、裸 2xx 响应头都不是成功点。

先耐久保存完整结算事实并确认恢复任务可发现，再交付成功 DONE；最终财务事务可以在独立、可恢复的通路完成。快照 ACK 不明时只对同一身份 / 摘要读回；不可确认则不冒充已耐久接受、不重发模型。不可逆成功点不等于客户端收讫、最终财务提交或资源释放。这一协议条件不能直接套用到未定义成功终态的其他模态；对应 driver 必须有自己的验收 fixture。

### 3.4 不可变结算与幂等提交

- 持久化完整、版本化、可校验的结算输入，绑定 request、attempt、claim、租户范围和事实摘要。恢复使用原事实 / 原价格依据，不读取当前目录价来重算历史事件。
- 相同身份且相同内容可确认同一快照；相同 request 但不同内容 / scope / claim 是冲突，不能覆盖。没有快照就不能凭未知请求伪造 usage、价格或金额。
- 快照与待处理任务必须在一个权威事务中成立，或采用经过证明的耐久 outbox 协议；禁止 DB 成功后只在内存排队而丢失可发现性。
- 最终财务写入、原子回执及恢复终态在同一 PostgreSQL 事务边界成立。回执绑定同一事件摘要与身份；已有同 request 的旧日志或仅有回执行均不足以认定成功，还须核验相应权威结果。
- 最终事务 ACK 丢失：允许只读确认同一回执 / 结果。无法确认时保留不明，不在原调用中盲目重新执行；之后仅由有界恢复路径按新的有效 lease 重试**同一事实**，让数据库唯一约束与 fencing 决定是否已有提交。
- “一次最终结算”指同一基础经济事件最多一份匹配提交，后续更正为独立、幂等关联的 adjustment，不重复基础扣账。adjustment 金额 / 审批规则归 C05，不由本 ADR 新增。

### 3.5 恢复 lease 与资源

- 认领、续期（若支持）、失败退避、完成均校验完整 scope / digest、token、revision 和有效期限；过期 / 被替代者不能提交，即使新持有者尚未提交。
- fence 必须在实际权威写事务内检查，不能仅在前置 SELECT 或客户端时钟检查。PostgreSQL 的时间语义、锁等待、事务内到期及旧写入竞态须在 C03 原生测试中证明，不由 D1 的 `unixepoch` 测试推导。
- 恢复 claim ACK 丢失不授予所有权。只允许到期后新 revision 的认领继续；恢复有上限、退避及 blocked 终态，不无限重试。
- 停止、超时和客户端断连首先阻止新 admission；已发出的 DB / RPC / 清理操作仍有独立持有者。全部登记操作达到合同终态前不能返还其容量；`Promise.race` 超时、STOPPED 或 active=0 不证明远端 SQL 已终止。
- 结算事实与资源确认相互独立：不能为了等物理清理而撤销已成立的成功结算，也不能因扣账完成就提前归还仍被持有的资源。

## 4. PostgreSQL 实现的验收矩阵

以下均为 C03 / 后续实现义务，**不是已经通过的 PostgreSQL 测试**。本轮本地 D1/SQLite 回归仅用于核实可复用的既有语义。

| 编号 | 故障 / 竞争场景 | 必须证明的结果 |
| --- | --- | --- |
| ST-01 | 同 attempt 并发 claim / 相同 claim 重复调用 | 仅一个明确 grant，无第二次发送权 |
| ST-02 | claim 提交前失败、提交后 ACK 丢失、进程退出 | 不明者不发送；新进程不凭读回恢复发送权 |
| ST-03 | 租户 / request / attempt / context / deadline / revision 不符 | 无 grant / 无跨租户读写；身份不可变 |
| ST-04 | unknown 后换 model / target / credential 或重建预算对象 | 不能绕过 request 级禁止自动重放与总次数 / deadline |
| ST-05 | completed 无 DONE、错误 DONE、成功点后的取消 | 前两者不变成成功；后者不撤销已成立成功事实 |
| ST-06 | 快照提交 ACK 丢失或任务入队失败 | 精确读回或拒绝确认；不能存在已接受快照但永不可发现的任务 |
| ST-07 | 无快照 / 不同摘要 / 当前价格变化 / 篡改内容 | 无凭空结算、无重算 / 覆盖；进入受控冲突处理 |
| ST-08 | 财务事务在回执、余额、预算、日志、任务之间失败 | 全部回滚或全部提交；不能部分扣账 |
| ST-09 | 提交 ACK 与读回同时丢失、恢复重复执行 | 后续同事件至多一次经济作用，匹配回执才确认 |
| ST-10 | 旧 lease 到期 / 被接管，新持有者尚未提交 | 旧持有者写入仍被拒绝；覆盖锁等待 / 事务内到期 |
| ST-11 | 旧预算 epoch、已有同 id 旧日志、错误后端 / schema | 不污染新周期、不认领旧日志为回执、不回落备用账本 |
| ST-12 | 断连 / 停止 / deadline 时 DB 或取消仍未结束 | 新 admission 停止；在途资源不提前释放，恢复不重发推理 |
| ST-13 | 重启后仅凭持久引用扫描恢复 | 不需要原请求 / 明文凭据 / 当前价格；最终提交可核实 |
| ST-14 | 财务 unknown 政策未批准或外部证据缺失 | 不自动把预留上限当作最终收费许可，生产相关路径保持关闭 |

## 5. 剩余决策和有限实施顺序

C01.4 撤权 / claim 消费时点、C01.5–C01.7 资金 / unknown / 价格、C01.9 完整首发模态、C01.10 数值参数仍未冻结。本合同不重新批准它们；未决能力不启用。不可跨网络 exactly-once，只能分别证明有界发送许可和权威数据库内的幂等提交。

第一有限工作包是 **C03.1 / C03.3 的 PostgreSQL dispatch intent 子集**：复用现有租户 / request 关系，先做独立草案 schema、原子 claim / 过期分类与本地数据库故障测试；不接生产 factory、不部署迁移、不将其当成预算或完整授权服务。[v291 实施证据](../implementation-evidence/C03-postgres-dispatch-intent-v291.md)已完成该子集的本地实现，ST-01–ST-03 仅有部分证据；下一项补隔离原生 PostgreSQL 并发 / 锁等待 / 连接故障验收。然后扩展不可变结算 / 回执 / 恢复数据模型与仓储；金额策略和完整准入依赖未决 C01 项，不能越过。现有 D1 staging 试验和 C02.G 未被删除或豁免。

## 6. 当前源码依据

实施补记（v295，2026-09-21，不改变上述批准范围）：[PostgreSQL 原账务事务/回执/fence](../implementation-evidence/C03-postgres-usage-commit-v295.md)已在 v293 事实/outbox 与 v294 jobs/lease 上完成本地子集验证；ST-08–ST-11 / ST-13 增加 PGlite 原子回滚、提交不明、事务内到期和干净重开确认的证据，不等于原生多连接/WAL 或生产验收。原生运行库阻塞尚未解除；后续有界 runner、DB 操作生命周期、无损日志表示、角色权限和迁移兼容继续按 checklist 推进，相关生产路径关闭。

- [intent / one-shot claim](../../../../packages/core/src/storage/recovery/dispatch-intent-d1.ts)、[D1 状态约束](../../../../packages/core/migrations-proposals/d1/request-dispatch-intents.sql)。
- [不可变快照与回执](../../../../packages/core/src/storage/recovery/usage-settlement-d1.ts)、[恢复任务与认领](../../../../packages/core/src/storage/recovery/usage-recovery-jobs-d1.ts)、[恢复消费者](../../../../packages/core/src/storage/recovery/run-usage-recovery-d1.ts)、[D1 事务内 fence](../../../../packages/core/migrations-proposals/d1/request-usage-recovery-jobs.sql)。
- [现有普通预算状态](../../../../packages/core/src/db/user-budget-reservation-types.ts)、[PostgreSQL 预算仓储](../../../../packages/core/src/db/postgres/user-budget-reservations.impl.ts)、[request 出站次数](../../../../packages/proxy/src/services/request-dispatch-budget.ts)。
- [Images SSE 驱动](../../../../packages/proxy/src/services/egress/openai-images-driver.ts)、[Images 恢复接线](../../../../packages/proxy/src/services/image-usage-recovery.ts)、[资源完成通道](../../../../packages/proxy/src/services/resource-completion.ts)。
