# C03 v317：生产者提案预检与财务 COMMIT 响应丢失

2026-09-24；**隔离本机 PG18.6 子集 PASS，生产禁用，C03 DOING**。承接 [v316 窄权限生产者提案](./C03-postgres-fact-producer-proposals-v316.md)。73 条正式 PostgreSQL 迁移未增加或修改；提案仍只在隔离测试库执行。没有远端 SQL、云资源、部署或系统运行库安装。

## 提案发布前检查

审阅发现旧版提案会覆盖同名但函数体已变化的 guard，且出站提案对既有不可变 trigger 和互引外键的预检不完整。两份提案现核对原正式迁移函数体的换行归一化摘要；outbox 提案还核对事实 guard、不可变函数、trigger 的事件/参数/WHEN 形状，以及互引外键的列序、动作和延迟属性。上述漂移都会使事务回滚，需单独审阅旧库差异。

预检还拒绝普通 runtime、合成生产者通往 migrator 的角色成员关系，并检查生产者对 Key 或 outbox 的有效权限；替换后核对两项 definer 函数对 runtime/生产者的有效 `EXECUTE` 已撤销。仅检查直接 ACL 不足以排除继承权限；[PostgreSQL 角色成员规则](https://www.postgresql.org/docs/18/role-membership.html)说明成员可以通过继承或 `SET ROLE` 使用其他角色权限。测试中的生产者仍是合成 `NOLOGIN` 角色，没有实际调用者或租户授权。

原 SQL 片段自身依赖调用者开启事务。会话级 `SET` 能满足激活断言，而逐句自动提交会让 `SET LOCAL` 和事务锁失效，可能使 `CREATE OR REPLACE` 早于 `REVOKE` 提交；[PostgreSQL `SET` 文档](https://www.postgresql.org/docs/18/sql-set.html)明确事务块外的 `SET LOCAL` 无效。因此新增[只渲染的单事务打包器](../../../../scripts/db/cutover/postgres-fact-producer-proposals-bundle.mjs)：固定 intent→outbox 顺序，输出一个 `BEGIN`、两项 `SET LOCAL` 激活断言和一个 `COMMIT`，拒绝片段内的顶层事务控制语句。打包器不连接数据库、不执行 SQL；单独运行原片段仍不是受支持的发布方式。两份提案依然**不是正式迁移**。

## 本地验证

| 验证 | 结果 |
| --- | --- |
| 两份提案 PGlite 回归 | **2/2 PASS**；包含原函数体、guard/不可变函数、trigger `WHEN`、外键列/动作、角色成员和继承授权漂移拒绝 |
| 单事务打包器单测 | **2/2 PASS**；固定次序、单个事务、不打开数据库、拒绝空/畸形/事务命令片段 |
| 打包器 PGlite 集成 | **2/2 PASS**；73 条正式迁移后整包安装；第二提案预检故意失败时，第一提案的函数替换和权限撤销也一起回滚 |
| 原生生产者提案复跑 | **1/1 PASS**；PG18.6、73 条正式迁移、窄角色 intent→fact→outbox、Key 改属两种锁序、越权与误附着拒绝 |
| 原生资金 COMMIT 协议响应丢失 | **1/1 PASS**；代理转发一次 `BEGIN`/`COMMIT`，截留 PostgreSQL `CommandComplete(COMMIT)` 和 `ReadyForQuery`，另一后端在断开前确认收据/日志/余额；客户端见 `CONNECTION_CLOSED`，恢复角色新连接只读确认并重放同一回执，仍仅一次扣费 |
| 迁移合同、摘要、清理 | **PASS**；两套原生报告 `cleanup: PASS`，结束后私有 PostgreSQL 进程及自建运行目录为 0 |

[生产者原生报告](./C03-postgres-fact-producer-proposals-v317-report.json)和[资金协议响应丢失原生报告](./C03-postgres-native-commit-response-loss-v317-report.json)记录逐项断言与受测源码摘要；[机器摘要](./C03-postgres-producer-preflight-commit-response-v317-results.json)固定本轮文件和报告的 SHA-256。

资金测试丢失的是 **PostgreSQL 协议级 COMMIT 响应**，没有操纵 TCP ACK 数据包。代理在截留响应时已通过独立数据库连接看到持久结果；这比 v316 的应用层结果丢失更接近真实连接断开，但仍是本机合成故障。资金事实由夹具迁移者准备，专用恢复角色以 `SET ROLE` 运行；它不证明生产事实来源、真实网络中间件或 Workers/Hyperdrive 行为。

## 保留门禁

正式迁移推广、生产者身份、调用者/租户授权、预算准入、请求级 unknown 门禁、结果来源、代表性旧库与普通流量持锁、真实 origin 容量、Workers/Hyperdrive、Queue ACK/retry/DLQ、DBL-04/05/06、C03.G 与 C01.G/C02.G 仍未验收。C03.5 不勾选；切换与恢复角色继续 `NOLOGIN`、`runtimeCompatible:false`，首轮 staging US$2 累计上限不重置。
