# C03 v337：旧库 parent 切换账本并发锁窗

2026-09-24；**隔离 PostgreSQL 18.6 子集通过，C03.7／C03.G 仍开放**。承接 [v336 正式版本账本门禁](./C03-postgres-legacy-parent-ledger-v336.md)和 [v332 回填/锁窗夹具](./C03-postgres-replay-scale-lock-v332.md)。本轮没有执行远端 SQL、部署或云调用。

## 可复现缺口与修复

v336 bundle 在迁移 advisory lock 后比较准确的 73 个正式版本名，但普通 `SELECT` 不会等待另一会话对 `schema_migrations` 的未提交 `DELETE`。不遵守 advisory lock 的账本写者可先删除 `0041_workspaces.sql` 并保持事务；切换事务仍读到旧提交版本集，完成 parent/gate DDL；写者随后提交会让已切换的库留下缺失的版本行。

[bundle 生成器](../../../../scripts/db/cutover/build-request-legacy-parent-default-acl-activation.mjs)现在在账本比较前执行 `LOCK TABLE cinatoken_gateway.schema_migrations IN SHARE MODE`。它位于现有迁移锁之后、parent DDL 之前，受事务内 `lock_timeout = '2s'` 约束，并一直持有到切换提交或回滚。普通账本 `INSERT`／`DELETE` 的 `ROW EXCLUSIVE` 锁与它冲突；并发写者先占锁时切换会限时失败，并发写者后到时则须等切换结束。

## 本地验证

[原生报告](./C03-postgres-native-legacy-parent-ledger-lock-v337-report.json)来自夹具自行创建并清理的回环 PostgreSQL 18.6：**1/1 测试、12/12 阶段、cleanup PASS**，正式迁移仍为 73 份。双会话场景先使账本写者删除 `0041` 而不提交。负对照只在该夹具内移除新表锁，旧 bundle 在删除仍未提交时运行至末尾，由夹具主动回滚，证明旧版本集查询会读到删除前的提交状态。相同持锁场景下，新 bundle 在 **2,005 ms** 返回 `55P03`；parent 表未创建。写者提交缺版本后，新 bundle 再次在 parent DDL 前拒绝；恢复准确账本后，原有旧记录保留、parent/gate 原子切换与新旧 ID 断言全部通过。

生成器单测 **1/1**、包含它的现有 CI 单测命令 **3/3**、`scripts/tsconfig.json` 类型检查及定向文件空白检查通过。更新的单测和原生夹具已被 [现有 Linux CI 工作流](../../../../.github/workflows/proxy-dispatch-safety.yml)的相应步骤收集；本轮未运行 Linux job。[机器摘要](./C03-postgres-legacy-parent-ledger-lock-v337-results.json)固定源码及报告摘要。

此夹具只证明该事务能阻断**并发账本 DML**，并测得本地一个锁等待；不能证明历史 SQL 真正按这些版本名应用、目标 schema/函数/授权符合当前源码，也不能预测生产锁窗或旧库规模。生产旧 handler 全覆盖、真实 Workers/Hyperdrive/Queue、保留期与 contract、生产维护/回滚演练仍未验收。C03.7／C03.G 不勾选，恢复生产路径保持禁用。
