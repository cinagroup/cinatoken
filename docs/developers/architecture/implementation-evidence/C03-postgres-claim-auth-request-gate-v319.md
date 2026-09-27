# C03 v319：声明时租户授权与请求级单次持久 claim

2026-09-24；**隔离本机 PostgreSQL 18.6 子集 PASS，生产禁用，C03 DOING**。承接 [v318 旧日志流量与登录时限](./C03-postgres-native-upgrade-traffic-login-timeouts-v318.md)。本轮只修改正式迁移之外的生产者 definer 提案，并新增默认关闭的请求级唯一索引提案；73 条正式迁移未增加。没有远端 SQL、云调用、部署或系统运行库安装。此版保留修改前报告与源码 SHA；本文的源码链接现指向 v320 工作树，v319 的实际受测字节以[机器摘要](./C03-postgres-claim-auth-request-gate-v319-results.json)为准。[v320 复核修正](./C03-postgres-claim-auth-request-gate-hardening-v320.md)收紧了 trigger 形状预检和 NULL 默认标志处理。

## 声明时租户授权

[intent definer 提案](../../../../packages/core/migrations-proposals/postgres/dispatch-intent-producer-definer.sql)让窄权限生产者通过已绑定的 trigger 插入 intent；它仍不取得六张授权表的直接读取权。此次将**派发 claim** 的检查扩展到当前 Key 的用户/Workspace 绑定、启用状态与过期时刻、有效用户和 Workspace。个人 Workspace 核对 owner；组织 Workspace 只接受 `cinaauth` subject、`active` 或 `pending` 组织、有效组织成员，非默认 Workspace 还要求有效 Workspace 成员。v319 对 `is_default=NULL` 的测试只覆盖没有 Workspace 成员的情况；成员存在时会通过，v320 才改为明确拒绝。按 Key→用户→Workspace→组织→组织成员→Workspace 成员锁序读取，等待后用数据库 `clock_timestamp()` 再核验 Key 与 intent 截止。

[PGlite 定向测试](../../../../packages/core/src/storage/recovery/dispatch-intent-producer-definer.proposal.pglite.test.mjs) **1/1 PASS**，覆盖授权通过、Key 禁用/过期、用户/Workspace 禁用、组织状态/subject/成员变化、无成员时默认标志 NULL、非默认 Workspace 成员撤销，以及生产者的直接表权限拒绝。[原生生产者报告](./C03-postgres-native-claim-auth-v319-report.json) **1/1 PASS、cleanup PASS**：73 条迁移、窄权限 intent→fact→outbox、Key 改属两个锁序、trigger 误绑定拒绝。原生测试没有逐项复跑上述授权负例；PGlite 不能证明多会话锁等待。claim **之后**的撤权/过期策略及已派发 I/O 的处理仍未定义；这些测试不构成零发送保证。

## 请求级单次持久 claim

旧结构的主键为 `(request_id, attempt_index)`，只锁本 attempt。原生测试在正式 0069 guard 下实测同一请求两个 attempt 都可持久 claim；应用内存停止后，另一进程仍可能对后续 attempt 取得 claim。新的[审阅专用索引提案](../../../../packages/core/migrations-proposals/postgres/request-dispatch-single-claim.sql)以 `request_id` 建立 `dispatch_claim_id IS NOT NULL` 的唯一部分索引。它要求显式事务内的 `reviewed-v1` 激活断言、迁移者/表/trigger 预检，以及正式 0069 invoker guard 或当前已审阅 definer guard 的**精确函数体摘要和安全模式**；旧库若已有双 claim，整体回滚并保留两行，不自行挑选、删除或修复。

[PGlite 索引测试](../../../../packages/core/src/storage/recovery/request-dispatch-single-claim.proposal.pglite.test.mjs) **1/1 PASS**，覆盖缺激活、guard 源码漂移、两提案组合回滚、旧双 claim 拒绝、首个持久 claim 后阻止兄弟 attempt（含 `outcome_unknown`）、首 claim 回滚与未 claim 先过期时可继续；v319 尚未检查同函数的 trigger 事件形状。[原生组合报告](./C03-postgres-native-request-single-claim-v319-report.json) **1/1 PASS、cleanup PASS**，在安装上述 definer 后装索引；两个真实连接的冲突等待记录为 `transactionid` 锁。持有者提交时，兄弟 attempt 留在 `prepared`，仅一行持久 claim；持有者回滚时兄弟 attempt 获准。旧双 claim 预检失败为 `P0001`，两行保留且索引不存在。

这是保守的 **一请求一次持久 claim** 门禁：即使第一 attempt 已知未计费，仍禁止自动 failover，待另行审阅持久结果证明与解除协议。索引只管数据库记录；请求级固定 deadline/预算、生产者身份接线、完整授权上下文、provider I/O、真实结果来源、unknown 财务归类和 D1 行为仍开放。当前 PostgreSQL repository 将唯一约束拒绝包为 `PostgresDispatchClaimUncertainError`，只表示**未授予 claim**；它尚未接入 Proxy，请求入口没有这项拒绝的显式处理。未来派发器必须将其 fail-closed，并保证一次 grant 仅一次 fetch。删除已 claim 的行会重新开放该 `request_id`，故保留期和清理是独立门禁。代表性旧库上的索引建造持锁、双 claim 处置尚未验收。

## 校验与边界

两个 PGlite 父测试 **2/2 PASS**，生产者 bundle 单测 **2/2 PASS**；原生生产者与原生组合测试各 **1/1 PASS**，两份冻结报告均 `cleanup: PASS`。原生组合报告记录 8 个阶段、PG18.6、73 条正式迁移、源码摘要和并发等待。迁移合同、语法与 `git diff --check` 通过；专属运行目录和私有 PG 进程均为零。源文件及报告 SHA-256 列在[机器摘要](./C03-postgres-claim-auth-request-gate-v319-results.json)。v318 的冻结报告记录的是当时旧版 definer 源码，不能当成本轮新 definer 的复跑证据。

下一步先确定独立生产者身份和执行入口、请求级准入/预算/unknown/事实来源合同，再审阅旧库重复 claim 的人工处置及索引维护窗口；随后以真实 origin、Workers/Hyperdrive/Queue 验证身份、连接预算、服务端期限、ACK/retry 和端到端一次发送。两项提案仍在正式迁移之外，生产切换默认关闭；C03.5、C03.G 与 DBL-04/05/06/08 保持开放。
