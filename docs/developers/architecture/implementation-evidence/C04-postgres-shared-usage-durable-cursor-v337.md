# C04.7 v337：跨进程持久游标与原子修复任务回填

2026-09-24；**隔离 PostgreSQL 18.6 子集通过，C04.7／C04.G 仍开放，生产恢复保持禁用**。承接 [v336 历史收益回填页](./C04-postgres-shared-usage-backfill-v336.md)。正式 PostgreSQL 迁移仍为 73 份；本轮没有远端 SQL、部署或云调用。

新增 [review-only 持久游标模块](../../../../scripts/db/cutover/build-postgres-shared-usage-repair-durable-cursor.mjs)。显式 `reviewed-v1` 激活用**直接 migrator LOGIN**、当前 v336 来源/触发器/授权门禁和目标数据库 `CREATE` 权限，在独立的 `cinatoken_repair_maintenance` schema 创建 migrator 自有单例表。schema 与表均撤销 PUBLIC 和普通 runtime 授权；每页也检查归属、ACL、直连身份、`READ COMMITTED`，以及 runtime 对 migrator、`pg_read_all_data`、`pg_write_all_data` 的任何 `MEMBER` 关系。仅查继承使用权会漏掉 `INHERIT FALSE, SET TRUE`：普通 runtime 虽无当前隐式权限，仍能 `SET ROLE` 后读写私有游标。普通 runtime 的 gateway-schema 默认授权不会覆盖该私有 schema。

每次执行只接受 **1–500** 的 `limit`，不接受调用方游标。在一个 PostgreSQL 事务中先 `SELECT ... FOR UPDATE` 锁定并读取权威游标，再用 v336 的来源检查和有界 keyset 页为历史收益入队，最后推进该单例游标；COMMIT 确认后才返回页结果。页面回滚时任务和游标一起回滚。提交回执不明时，后续操作者从数据库重新锁定游标，不猜测上一页是否提交；独立读取函数也锁同一行。游标已越过的低排序新收益仍需依赖激活的 live INSERT 触发器。

[原生报告](./C04-postgres-shared-usage-durable-cursor-v337-report.json)使用夹具自行创建并清理的回环 **PG18.6**：**1/1 PASS、13 阶段、cleanup PASS**。负例证实：无 database `CREATE` 的 migrator、`SET ROLE` 委托、私有 schema 对 runtime 的宽授权均被拒绝。runtime 获得不可继承但可 `SET ROLE` 的 migrator 成员资格时，激活事务拒绝并回滚；获得两个内置全数据角色的同类成员资格时，读取与分页门禁均拒绝，任务和游标未动。夹具在回滚事务内实际执行 `SET ROLE pg_read_all_data` 读取和 `SET ROLE pg_write_all_data` 修改游标，确认这些成员资格的风险；撤权后正常分页恢复。页内故意回滚后任务与游标也均未推进。首个 2 行页面将任务与游标一起提交。第二页真实 COMMIT 后由夹具丢弃客户端成功结果，另一个本地 **Node 进程**重新连接并读到 `earning-04`／2 页的数据库游标；这是回执不明的模拟，未诱发物理丢包。

两个直接 migrator 会话的并发页在单例行出现实际 `transactionid` 锁等待：先行者处理 `earning-05..06`，后行者随后读取新游标处理 `earning-07`，没有重复或跳页。另一个持锁超过时限的负例在 **2,055 ms** 返回 `55P03`，任务和游标维持原值；此时操作者**必须重试**，不能假定并发页面总会连续成功。低排序迟到收益 `!late-h` 由 live trigger 入队，游标仍为 `earning-07`。最终 8 笔收益对应 8 笔卖家入账与 8 个修复任务，无二次入账。

新模块单测 **2/2**，连同 v336 基础回填单测 **4/4**；覆盖 500 接受、501 拒绝和 COMMIT 后返回。`scripts/tsconfig.json` 类型检查及定向文件空白检查通过。[机器摘要](./C04-postgres-shared-usage-durable-cursor-v337-results.json)固定源码与报告摘要。主任务已将以下两个测试命令登记到[共享 CI 工作流](../../../../.github/workflows/proxy-dispatch-safety.yml)；Linux CI 尚未运行：

```text
node --test scripts/db/cutover/build-postgres-shared-usage-repair-durable-cursor.test.mjs
node --import tsx --test scripts/db/cutover/postgres-shared-usage-repair-durable-cursor.native.test.mjs
```

`provision-postgres-roles.ts` 只为 migrator 授予目标数据库 `CONNECT`，没有授予创建新 schema 所需的数据库 `CREATE`；本地夹具先验证缺权失败，再由隔离集群管理员明确授予。真实环境须单独审查该权限及激活事务。本地独立进程共享同一回环数据库，**未验证不同物理主机的网络与权限路径**。2 秒锁超时要求调用方有可观测的重试流程；调度、自动全量完成判定、生产规模/锁窗、真实 Worker/Hyperdrive/Queue、C04 经济与跨库门禁仍未闭合。未改 repair jobs/failure SQL、grant/runner、quote SQL 或正式迁移。
