# C03 v338：legacy parent 切换前的 replay reservation 目录校验

2026-09-24；仅供审阅，默认关闭，未运行远端 SQL 或部署。[机器摘要](./C03-postgres-legacy-parent-replay-catalog-v338-results.json)及[原生报告](./C03-postgres-native-legacy-parent-replay-catalog-v338-report.json)固定此次源码及本机结果。

生成器在原有 advisory lock 与完整 73 版本 ledger 锁／核对后、创建 parent 表前，先对 `request_dispatch_intents`、`api_key_request_logs` 和永久 reservation 表取 `SHARE ROW EXCLUSIVE` 锁，再检查两条 replay reserve 触发器。校验包含表 owner/RLS、触发器启用状态、BEFORE INSERT ROW 绑定、无 WHEN／参数／transition table／延期，以及目标函数的 migrator owner、PL/pgSQL、SECURITY DEFINER、VOLATILE、固定 `search_path`、签名和 `prosrc`。函数体从 SHA-256 固定的 reservation 提案提取，直接与 PostgreSQL `pg_proc.prosrc` 比对，避免仅凭触发器名字接受已改成 no-op 的实现。

自有 loopback PostgreSQL 18.6 应用全部 73 个正式迁移后，原生夹具 **1/1 PASS、16 个阶段 PASS、清理 PASS**。未提交的旧日志 UPDATE 使新表锁在 `2s lock_timeout` 下报 `55P03`；关闭 intent 触发器、将旧日志触发器重新绑定到 no-op 函数、分别把两个 reserve 函数体改成 no-op，均在 parent DDL 前拒绝且不留下 parent 表。恢复原定义后，正常原子切换及旧 ID 阻断仍通过。生成器单测 **1/1 PASS**，并核对目录校验位于 parent DDL 前。[原生夹具](../../../../scripts/db/cutover/postgres-legacy-parent-activation.native.test.mjs)及[生成器](../../../../scripts/db/cutover/build-request-legacy-parent-default-acl-activation.mjs)可复验。

这是关键 replay reservation 子集的目录校验，不能证明每一条历史 SQL 均未经修改。表锁阻止源表写入和触发器 DDL 竞争，但不会阻止另一个受信任 migrator 在校验后修改函数体；对该受信任角色的并发运维仍须单独约束。本地合成数据不证明生产锁窗口、规模或跨数据库等价。**C03.7/G 继续开放。**
