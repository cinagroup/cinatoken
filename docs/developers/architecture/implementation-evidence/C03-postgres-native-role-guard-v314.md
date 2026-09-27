# C03 v314：原生 PostgreSQL 恢复角色与旧日志双向切换

2026-09-24；**LOCAL NATIVE SUBSET PASS，PRODUCTION DISABLED，C03 DOING**。承接 [v313 正式迁移](./C03-postgres-formal-recovery-migrations-acl-v313.md)。本轮只使用隔离的本机回环 PostgreSQL 和 PGlite；没有对远端数据库执行 SQL、部署、创建云资源或启用 Queue。

## 受控旧日志切换

[切换正文](../../../../scripts/db/cutover/postgres-recovery-legacy-log-guard.activate.sql)位于自动迁移目录之外；[打包器](../../../../scripts/db/cutover/postgres-recovery-legacy-log-guard-bundle.mjs)只打印包含一次 BEGIN、SET LOCAL 激活断言、正文和 COMMIT 的 SQL，不连接数据库。切换正文要求迁移者拥有 schema、正式迁移到 0073、普通角色保有现有日志 INSERT 路径且对五张恢复表无表/列权限、原 Workspace trigger 有效、READ COMMITTED，并在持有两张表的写冲突锁后拒绝既有日志与事实的 request ID 重叠。失败事务不留下半套 trigger。

启用后，日志 INSERT 和事实 INSERT 的两个迁移者拥有的 SECURITY DEFINER trigger 使用固定 search_path、完整限定表名和同一 request ID 的事务 advisory lock。普通日志在无事实时继续写入；有事实时必须见同一活跃 lease 的回执；既有日志不能再变成恢复事实。原提案文件中的单侧 SECURITY INVOKER guard 仅是历史提案，不能作为切换程序。运行 grant 脚本重跑后也再次撤销普通角色直接执行两个 guard 的权限。角色草案要求两个函数的所有者、类型、执行权限和 trigger 元数据符合合同，继续为 NOLOGIN、runtimeCompatible:false。

官方 PostgreSQL 文档说明事务 advisory lock 在事务结束时释放，且固定旧快照可能早于取得的锁；因此切换与两个 trigger 都拒绝非 READ COMMITTED。[advisory lock](https://www.postgresql.org/docs/18/functions-admin.html) · [应用级一致性](https://www.postgresql.org/docs/18/applevel-consistency.html)。切换正文的 lock_timeout 限制单次等锁，statement_timeout 限制单条语句；它们不证明整笔切换事务有总时限。transaction_timeout 必须在事务开始前由受控会话建立，不能靠事务内 SET LOCAL 补设。[PostgreSQL 维护者说明](https://www.postgresql.org/message-id/2164653.1758313260%40sss.pgh.pa.us)。

## 本地验证

| 项目 | 结果 |
| --- | --- |
| 旧日志切换 PGlite：普通写入、事实/回执、旧账拒绝、权限与重叠负例 | **2/2 PASS** |
| 角色 SQL PGlite：73 条迁移后 admin/migrator 阶段、PUBLIC/trigger/函数/MAINTAIN 负例 | **1/1 PASS** |
| 只打印 SQL 的事务打包器；离线角色策略 | **1/1、6/6 PASS** |
| 原生 PostgreSQL 18.6 dispatch intent 多会话/锁/COMMIT 回执故障 | **12/12 PASS** |
| 原生 PostgreSQL 18.6 恢复角色、普通 grant 重跑、双向同 ID 争用及迁移锁演练 | **1/1 PASS** |
| PostgreSQL 迁移合同与 diff 检查 | **PASS** |

[原生角色/guard 报告](./C03-postgres-native-role-guard-v314-native-report.json)和[原生 dispatch 报告](./C03-postgres-native-role-guard-v314-dispatch-report.json)保留各自的检查项与清理结果。

原生服务来自已有 PostgreSQL 18.6 二进制与签名有效的私有运行库副本，只在工作区忽略目录的本机回环 fixture 中启动，结束后清理集群；没有安装系统运行库。原生 role/guard 测试执行 73 条正式迁移，验证普通角色无恢复表读取和 guard 直接执行权、NOLOGIN 恢复角色的超时默认值和窄 Key 锁函数；同 ID 两种插入顺序均观察到真实 backend 等锁，并阻止无回执日志或旧日志对应事实。0069 迁移在旧表写锁下 2 秒超时并原子回滚，再释放锁成功应用。此证据是本机子集，不能代替代表性旧库流量或生产角色验收。

## 保留的门禁

切换仍未在任何非测试数据库执行。双向 guard 会给**每条**普通请求日志 INSERT 增加 advisory lock；必须在代表性旧流量下测量延迟、死锁/重试和持锁时长，再审查切换维护窗口、总事务时限与回退。发生问题时应先停止恢复准入并核对事实/回执；不能直接删除 guard 重新开放事实拥有的旧日志写入。完整恢复资金 writer 尚未在专用角色下逐路径验收；当前角色仍无 LOGIN、无生产 origin 配额，不能据此启用。

原生 dispatch intent 负例还发现未来事实生产者身份的 0069 SECURITY INVOKER trigger 读取 api_keys FOR SHARE 会因缺 UPDATE 权限返回 SQLSTATE 42501；目前恢复消费者没有 dispatch intent INSERT，故本轮不扩大它的 API Key 权限。普通 runtime 与恢复角色均没有事实 INSERT；测试由隔离库迁移者准备事实，不表示生产事实来源已授权。未来 C03.5 生产者身份需独立的窄权限设计与并发测试。代表性旧库迁移/回填、Workers/Hyperdrive、真实 Queue ACK/retry/DLQ、DBL-04/05/06、C03.G、C01.G/C02.G 均开放；首轮 staging US$2 累计上限不重置。[机器摘要](./C03-postgres-native-role-guard-v314-results.json)包含本地验证与源码摘要。
