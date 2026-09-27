# C03 v318：旧日志流量下的生产者提案持锁与恢复角色登录时限

2026-09-24；**隔离本机 PostgreSQL 18.6 子集 PASS，生产禁用，C03 DOING**。承接 [v317 生产者预检与财务 COMMIT 响应丢失](./C03-postgres-producer-preflight-commit-response-v317.md)。本轮没有增加正式迁移，也没有远端 SQL、云调用、部署或系统运行库安装。

## 合成旧布局与并发提案

[可选原生测试](../../../../scripts/db/cutover/postgres-recovery-upgrade-traffic.native.test.mjs)在自建回环集群执行 73 条正式迁移，插入 512 条旧 `api_key_request_logs`，再手动启用默认关闭的旧日志双向 guard。它没有使用生产数据库快照。普通 runtime 身份在提案前、两次提案等待期间、成功的双提案事务持锁期间以及提交后，各完成三组旧日志计数查询与简单插入探针；两条探针会话设置 `statement_timeout=1200ms`。测试没有另行验证超时触发，也没有执行完整请求流程。

两次失败分支分别让迁移者事务先以真实 intent 或 fact writer 持有目标表的 `RowExclusiveLock`。随后同名 definer 提案请求 `ShareRowExclusiveLock`；`pg_locks` 和 `pg_blocking_pids` 记录了等待关系。约 2 秒后，提案以 `55P03` 回滚；核对的函数体摘要、definer 标志和普通 runtime 有效 `EXECUTE` 权限与原值一致，先前 writer 仍可提交。成功分支在**一个事务**中运行 intent→outbox 两提案，确认三张受影响表的锁仍持有时，旧日志读写探针继续成功；提交后函数为 `SECURITY DEFINER`，普通 runtime 无直接执行权。[逐项原生报告](./C03-postgres-native-upgrade-traffic-v318-report.json)记录了锁、时长和探针。

这验证了上述有限样本里的锁模式与旧日志兼容性。数据、连接数及速度均为本机合成，不能推出代表性旧库的持锁分布、生产日志延迟、无死锁保证或可接受维护窗口；成功事务还故意延长持锁以执行探针。两份 definer 提案依然只在测试库使用，未进入正式迁移。

## `SET ROLE` 与新登录默认值

[独立原生测试](../../../../scripts/db/cutover/postgres-recovery-login-timeouts.native.test.mjs)使用角色策略生成的 SQL 创建 `NOLOGIN` 恢复角色。目录中存在 `statement_timeout=15000` 和 `transaction_timeout=30000`；夹具 superuser 将本会话的 `statement_timeout` 明确设为 **4s** 后执行 `SET ROLE cinatoken_gateway_recovery`，会话仍是 `statement_timeout=4s`、`transaction_timeout=0`。另一个仅供夹具使用的 `LOGIN` 角色在新连接中加载 200 ms 的 `statement_timeout`，`pg_sleep(0.6)` 被服务器以 `57014` 取消。[逐项原生报告](./C03-postgres-native-recovery-login-timeouts-v318-report.json)记录了目录值、会话值和取消码。[PostgreSQL 18 `ALTER ROLE` 文档](https://www.postgresql.org/docs/18/sql-alterrole.html)明确角色设置只在登录时生效，`SET ROLE` 不处理这些设置。

因此 v314–v317 的 `SET ROLE` 专用恢复角色资金演练证明了权限与账务子集，但**没有证明**该角色的登录时限已作用于那些事务。当前角色仍 `NOLOGIN`、`runtimeCompatible:false`；本轮不创建生产登录凭据，也不把夹具 `LOGIN` 角色当作生产恢复身份。DBL-05 的实际服务端总时限仍开放。

## 验证与下一门禁

两项原生测试的最终运行均为 **1/1 PASS**，报告 `cleanup: PASS`；迁移合同和受测源码摘要见[机器摘要](./C03-postgres-native-upgrade-traffic-login-timeouts-v318-results.json)。升级测试的一次中途复跑在 `initdb` 启动时超时、未执行断言；确认该次专属目录无相关进程后清理，随后的单次重试通过。登录测试的首次调用缺少仓库 TypeScript loader 和显式私有 PG 路径，均未启动夹具；改正调用后通过。本轮验证不改变 C03.5、C03.G 或生产启用状态。

下一步需要在代表性旧库和普通流量上复验提案与切换的持锁时长、延迟和死锁；建立独立生产者与恢复连接身份，按当前 Key、用户、Workspace、组织成员资格在 claim 时授权，并把预算准入、请求级 unknown 门禁及结果来源绑定到事实写入。确认同实例全部 origin 连接预算后，还需以实际新登录身份验证服务器时限、内部事务控制和真实 Workers/Hyperdrive/Queue 生命周期。正式迁移推广须另行审阅；当前提案与切换保持默认关闭，首轮 staging US$2 累计上限不重置。
