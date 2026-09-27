# C03 v330：旧库升级、删除兼容与保留期审查

2026-09-24；**本地子集通过，生产关闭，C03 DOING**。承接 [v329 Images HTTP→PostgreSQL→资金链](./C03-postgres-http-financial-chain-v329.md)。正式 PostgreSQL 迁移仍为 73 条；本轮只用自建回环 PostgreSQL 18.6、PGlite 和合成 HTTP/Queue 输入，没有远端 SQL、部署或云端模型/KMS 调用。

## 实现与边界

- 显式选中 PostgreSQL Images 恢复时，Node 在创建应用时检查 `DATABASE_DRIVER`；Worker 在请求入口、存储初始化前检查实际绑定的驱动。MySQL/D1 被拒绝，生产默认组合保持关闭。Worker 绑定只在请求到达时可见，这不构成 Worker 启动期或真实 Hyperdrive 验收。
- 默认关闭的 Queue owner 在连接打开失败、恢复结果不明或连接退役失败后，永久隔离该 owner 的**同一 isolate**容量，后续 wake 不再打开连接。它没有接入真实 Queue handler；正常返回仍会隐式 ACK，跨 isolate 排他、重试/DLQ 与物理关闭回执均未验证。
- PostgreSQL 两条 Key 删除仓储方法只把 `request_dispatch_intents_api_key_id_fkey` 的精确 `23001`/`23503` 映射为 `false`，其他 SQL/FK 错误继续抛出。实际管理路由因此沿用“有使用历史或在途请求则不能删除”的拒绝响应。0069 之前的库没有新增表引用，干净 Key 仍可删除。若将来在调用方显式 PostgreSQL 事务中捕获该 FK，调用方仍须回滚已失败的事务。
- PostgreSQL 管理工作区删除事务只把 recovery intent 对工作区或级联 Key 的两条精确外键拒绝映射为 `recovery_history`，HTTP 路由返回 400。整个删除、默认工作区归档与审计同一事务回滚；其他 SQL 错误继续抛出。D1 路径保持原有合同。
- 管理员删用户的 PostgreSQL 仓储新增同一事务内的审计写入和硬删除；仅精确 recovery intent 外键拒绝映射为服务层 HTTP 409。删除被拒、审计写入失败或其他 FK 失败时，两者一起回滚。D1/MySQL 保持原路径；这不消除其原有分步审计合同。
- 新[保留期只读审查生成器](../../../../scripts/db/cutover/build-postgres-recovery-retention-review.mjs)要求显式截止时间和最多 500 行，输出 `REPEATABLE READ READ ONLY` SQL、2 秒锁超时与 15 秒语句超时；预检正式迁移、可选 parent/单请求索引与 RLS 形态，分开盘点 parent 和旧 intent 孤儿。所有行的 `delete_allowed=false`。当前 parent/intent 是请求 ID 防重放屏障，没有获批准的保留期限和持久 tombstone，故没有 DELETE、归档或 contract 迁移。

## 本地验证

| 证据 | 结果 | 证明与限制 |
| --- | --- | --- |
| [修复前 Key 删除负对照](./C03-postgres-native-key-delete-negative-v330-report.json) | PG18.6，1/1、10 阶段、cleanup PASS | 三把无旧日志/活跃预留的 Key：两条旧删除方法分别成功；仅被新 intent 引用的 Key，两条方法均抛 `23001`。报告固定修复前源码 SHA，说明此前 512 条旧日志的 Key 不是有效对照。 |
| [旧库升级与 Key 修复报告](./C03-postgres-native-old-database-upgrade-v330-report.json) | PG18.6，1/1、10 阶段、cleanup PASS | 0040 前填充 512 条旧日志，经历真实 Workspace 迁移/回填至 0067；0069 与旧写事务争锁，约 2 秒 `55P03` 后原子回滚，普通日志写入继续。0068–0073 完成后原 512 行摘要不变，旧读写仍通；73 行页的可恢复 keyset 仅盘点，不回填。新 intent 后两条真实 Key 删除仓储方法返回 `false` 并保留 Key/intent。样本数据与本机时延不能确定生产维护窗口。 |
| [工作区删除原生夹具](../../../../packages/core/src/storage/management-workspaces.postgres-native.test.mjs) | PG18，2/2、owned cluster 清理 | 已撤销 Key 加新 intent 后，数据库实际报 `request_dispatch_intents_workspace_id_fkey`；服务返回 `recovery_history`，真实 HTTP 返回 400，工作区/Key/intent/审计均未误删。无 intent 的空工作区对照可删。该夹具只覆盖合成个人工作区和本地路由。 |
| [管理员删用户原生夹具](../../../../scripts/db/cutover/postgres-user-delete-audit.native.test.mjs) | PG18.6，1/1、owned cluster 清理 | 先在 0068 头验证删除和审计，再安装至 0073；新 intent 外键拒绝时成功审计为 0 增量。审计 CHECK 失败、无关 FK、干净删除与不存在用户均验证；干净删除后审计的 `user_id` 依旧规则置空，snapshot/payload 保留原 ID。原生夹具直接调用仓储，HTTP 409 由 Admin 定向单测证明。 |
| [只读保留期报告](./C03-postgres-native-retention-review-v330-report.json) | PG18.6，1/1、4 阶段、cleanup PASS | 73 条正式迁移和可选 parent 提案；拒绝读写事务和未来截止时间，盘点 7 个合成 parent 状态及 1 个旧孤儿 intent；所有记录不可删除，实际删除 0 行。合成历史行在隔离夹具内临时禁用触发器插入，不能替代真实旧库与授权审查。 |

本地组合测试 **27/27**、Queue owner **14/14**、Key 删除 PGlite **19/19**、保留期生成器 **1/1**、工作区既有 D1/路由 **5/5**、Admin 删用户 **8/8**，Admin 与 Proxy 类型检查通过。新命令和原生夹具已登记 [Linux CI 工作流](../../../../.github/workflows/proxy-dispatch-safety.yml)，尚无该 CI 的运行结果。PGlite 夹具依赖本地 ESM 文件，不在此工作流中运行；原生旧库夹具覆盖两条真实仓储删除方法。[机器可读结果](./C03-postgres-old-upgrade-retention-v330-results.json)固定当前源码及原生报告 SHA。

真实 Workers/Hyperdrive/Queue、全实例 origin 容量及生产授权、代表性旧库和全部旧 handler、实际 backfill/switch/contract、保留期/tombstone、DBL-04/05/06/08 仍开放。C03.4、C03.5、C03.7、C03.G 与 C01.G/C02.G 均不勾选；首轮 staging US$2 上限不重置。
