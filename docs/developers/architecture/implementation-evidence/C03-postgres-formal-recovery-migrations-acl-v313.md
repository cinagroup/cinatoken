# C03 v313：正式恢复迁移与结算日志权限收敛

2026-09-23；**LOCAL SCHEMA/WRITER PASS，ROLE PREFLIGHT ONLY，PRODUCTION DISABLED，C03 DOING**。承接 [v312 的末次派发与离线角色草案](./C03-postgres-statement-deadline-role-preflight-v312.md)。本轮没有执行远端 SQL、创建角色或 Hyperdrive、部署或启用 Queue 消费者。

## 正式迁移与关闭状态

PostgreSQL 迁移链现登记 `0068`–`0073`。[`0069`–`0072`](../../../../packages/core/migrations-postgres/0069_recovery_dispatch_intents.sql)从 dispatch intent、不可变结算事实/outbox、有限 lease job 和原账回执提案抽出扩展式迁移；`0071` 显式命名初始生命周期约束，`0072` 替换为 receipt-aware 约束。每份迁移在事务内设置 2 秒 `lock_timeout`，并在普通 runtime 角色存在时撤销其对新恢复表的默认授权；[普通 runtime grant](../../../../scripts/db/cutover/grant-postgres-runtime.ts)每次重授后再次撤销五张表及恢复专用函数权限。[迁移 Worker](../../../../scripts/db/cutover/postgres-migrations-worker.ts)和 [Hyperdrive 探针](../../../../scripts/db/cutover/hyperdrive-access-probe-worker.ts)已对齐 73 条目标迁移，并检查普通角色的表级、列级及函数禁权。

自动迁移**没有**在既有 `api_key_request_logs` 上安装 `request_usage_log_recovery_guard`。普通旧写入可继续；恢复角色的 grant 预检要求该触发器，因此目前仍不能启用专用恢复身份或声称完整事实所有权。正式迁移也没有回填、调度或切换资金路径。

## 行锁与角色边界

[资金 writer](../../../../packages/core/src/db/postgres/critical-writes.impl.ts)保留 `api_keys` 行锁：普通分支原样锁读，恢复分支在同一结算事务内调用 [`0073` 的迁移者拥有函数](../../../../packages/core/migrations-postgres/0073_recovery_api_key_workspace_lock.sql)，按 key ID 锁行后比较 Workspace，仅返回布尔值。函数固定 `pg_catalog, pg_temp` 搜索路径，显式引用业务表，在创建事务内撤销 PUBLIC 与普通 runtime 的执行权。恢复角色草案只申请精确 EXECUTE，不取得 API key UPDATE 权限。

普通与恢复结算现均以普通 SELECT 读取 append-only 请求日志，保留同一 request ID 的 `user_budget_reservations FOR UPDATE`、日志主键冲突及整笔事务回滚。这样与普通 runtime 已有的日志 UPDATE 禁权一致；不为行锁放宽日志的不可变权限。[角色 SQL 草案](../../../../scripts/db/cutover/postgres-recovery-role-policy.ts)还预检十个完整性触发器的表、函数、事件/时机、延迟属性和无条件作用范围。它仍固定 `runtimeCompatible:false`、`NOLOGIN` 且只输出供审查 SQL，没有在数据库执行。

## 本地验证与未关闭门禁

| 验证 | 结果 |
| --- | --- |
| 正式迁移空库、0068 旧库增量、旧日志兼容、默认授权负例及实际 committed receipt | PGlite **4/4 PASS** |
| 原提案四套回归 | PGlite **167/167 PASS** |
| 普通财务引擎与恢复结算（含普通日志读取、回滚、重放、冲突及三进程夹具） | PGlite **125/125 PASS** |
| 最终代码的正式迁移与恢复 runner；函数/catalog；角色策略 | **35/35、1/1、6/6 PASS** |
| 静态迁移合同、Core settlement/recovery/migrate 与 Proxy 类型检查、diff 检查 | **PASS** |

PGlite 不能替代原生 PostgreSQL 的实际角色 ACL、多会话行锁、WAL 或服务端超时。新外键涉及旧 `users`、`api_keys`、`workspaces`、`api_key_request_logs`；迁移 Worker 把待执行文件放在一个事务内，2 秒 `lock_timeout` 只限制**取锁等待**，取得的锁可能保留至整批 COMMIT。C03.7 仍需代表性旧库并发写入/持锁时长演练及维护窗口判断。[PostgreSQL 锁文档](https://www.postgresql.org/docs/17/explicit-locking.html)与 [CREATE TABLE 文档](https://www.postgresql.org/docs/17/sql-createtable.html)是该门禁的依据。

此外，旧日志 guard 的受控安装、真实 PG17+ 实例与登录角色超时/权限负例、同实例 origin 连接预算、Workers/Hyperdrive、真实 Queue ACK/retry/DLQ、DBL-04/05/06 和 C03.G 均未通过。本机原生 PostgreSQL 仍受旧 MSVCP140 运行库阻塞；本轮没有安装系统运行库。生产恢复关闭，首轮 staging 累计 US$2 上限不重置。[机器摘要](./C03-postgres-formal-recovery-migrations-acl-v313-results.json)记录局部结果和源码摘要。
