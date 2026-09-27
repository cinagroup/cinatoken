# C03 v332: PostgreSQL LOGIN 事务总时限的原生子集

2026-09-24；隔离本机 PostgreSQL 18.6 **1/1 PASS、3 阶段、cleanup PASS**。本证据仅运行[自有回环原生夹具](../../../../scripts/db/cutover/postgres-recovery-server-deadline.native.test.mjs)，没有远端 SQL、部署或生产凭据。[逐项报告](./C03-postgres-native-server-deadline-v332-report.json)记录源码 SHA-256 和检查结果。

夹具新建独立密码 `LOGIN`，仅在新连接上加载 `transaction_timeout=500ms`、`statement_timeout=5000ms` 等数据库用户级默认值，并核对 `session_user=current_user` 与 `pg_settings.source='database user'`。在自动提交的 `pg_sleep(1.5)` 和显式 `BEGIN`、`INSERT`、`pg_sleep(1.5)` 两条路径中，客户端均收到 `ECONNRESET`；原始后端 PID 从 `pg_stat_activity` 消失。服务器日志各有一条 `terminating connection due to transaction timeout`，显式事务的测试行最终为零，证明该局部场景的未提交写入回滚。

这补充了 v318 的新 LOGIN `statement_timeout` 证据。它不证明客户端拿到了物理 socket 关闭回执，也不覆盖真实恢复 runner 的内部 `BEGIN`/`COMMIT`/`ROLLBACK`、锁等待、连接池与管线、所有网络不明分支或 Worker/Hyperdrive。客户端的 `ECONNRESET` 不作为资金结果或容量解除依据。DBL-05、DBL-06、DBL-08 与 C03.G 仍保持开放；生产恢复保持禁用。

本机运行命令：`GATEWAY_NATIVE_PG_BIN` 指向仓库内私有 PG18.6 `bin` 后执行 `node --test scripts/db/cutover/postgres-recovery-server-deadline.native.test.mjs`。夹具只创建并清理其专属临时集群。
