# C03 v320：claim 授权与单请求索引激活预检修正

2026-09-24；**隔离本机 PostgreSQL 18.6 子集 PASS，生产禁用，C03 DOING**。本轮复核[v319 的默认关闭提案](./C03-postgres-claim-auth-request-gate-v319.md)时发现两处契约缺口，已修正并在新报告中重新验证。v319 报告保留原源码摘要作为历史证据；v320 报告冻结本轮源码。正式迁移仍为 73 条，提案未进入生产执行路径。

## 两处修正

第一，[单请求索引提案](../../../../packages/core/migrations-proposals/postgres/request-dispatch-single-claim.sql)原来只核对 trigger 名称、启用标志与函数 OID。绑定同一函数但只在 INSERT 时触发的漂移 trigger 仍可通过预检；这违反“claim 标志无法在 UPDATE 时清空”的激活前提。当前窄权限生产者和表约束下**没有证明**这种漂移能绕过索引，但不应接受它。现核对 `tgtype=23`、非 deferrable、无 `WHEN`、无列列表/参数/transition table，并保持函数体摘要与 `SECURITY DEFINER` 模式精确 pin。[PGlite 测试](../../../../packages/core/src/storage/recovery/request-dispatch-single-claim.proposal.pglite.test.mjs)在事务中换成同函数、仅 INSERT 的 trigger，预检拒绝且事务回滚；[原生组合报告](./C03-postgres-native-request-single-claim-v320-report.json)也记录 `P0001` 拒绝、索引未安装。索引提案同时将已审阅 definer 函数摘要更新至当前代码。

第二，[intent definer 提案](../../../../packages/core/migrations-proposals/postgres/dispatch-intent-producer-definer.sql)此前把 `is_default=NULL` 当成非默认组织 Workspace，若有有效 Workspace 成员就允许 claim。正式 schema 的列为 `NOT NULL`，但 schema 漂移时应明确 fail closed。现在在成员检查前直接拒绝 NULL；[PGlite 测试](../../../../packages/core/src/storage/recovery/dispatch-intent-producer-definer.proposal.pglite.test.mjs)故意移除列的 `NOT NULL`、为默认 Workspace 插入有效成员，再证明 NULL 仍拒绝。原生[生产者报告](./C03-postgres-native-claim-auth-v320-report.json)重新验证窄权限正例和 Key 改属锁序；它没有覆盖这条 NULL 负例的原生并发执行。

## 验证与下一门禁

修正后两个 PGlite 父测试 **2/2 PASS**、生产者 bundle 单测 **2/2 PASS**；原生生产者 **1/1 PASS、8 阶段**，原生单请求门禁 **1/1 PASS、9 阶段**，两者 `cleanup: PASS`。后者重新覆盖旧结构双 claim 反例、旧数据拒绝且不清理、两个真实连接的 `transactionid` 等待及 COMMIT/ROLLBACK 分支。迁移合同、语法、源码/报告 SHA-256 和进程清理见[机器摘要](./C03-postgres-claim-auth-request-gate-hardening-v320-results.json)。

这仍只是数据库提案。Images 当前共享的 300 秒期限和尝试预算属于单次 HTTP 执行帧内存对象；PG/D1 intent 未以 `request_id` 冻结跨 attempt 的期限与次数。PostgreSQL claim repository 尚未接入 Proxy，不能把索引拒绝等同于真实请求的停止重试。现有 failover 遇到首个明确非 2xx 仍可能选下一 route；保守单 claim 模式将来须在首个已授权上游响应后返回原响应、route 和 usage 并据此结算，不能只把内存尝试上限改为 1 或靠第二次 claim 拒绝。一次 grant 至多一次 fetch、确认响应丢失时零 fetch、未知结果的公开错误与持久事实均待验收。

生产者身份与授权上下文、request 级持久期限/预算、claim 后撤权政策、结果来源、历史双 claim 处置、删除/保留期、代表性旧库索引持锁、真实 origin/Workers/Hyperdrive/Queue 仍开放。两个提案保持默认关闭且在正式迁移之外，C03.5、C03.G 和生产启用门禁不勾选；无远端 SQL、云调用或部署，首轮 staging US$2 上限不重置。
