# C04.7 v335：已入账收益的持久统计修复提案

2026-09-24；**隔离 PostgreSQL 原生夹具通过，提案未安装到正式迁移或运行环境，C04.7／C04.G 仍开放。** [机器摘要](./C04-postgres-shared-usage-repair-jobs-v335-results.json)固定本轮源码与原生报告 SHA。

v334 的汇总快路会在重复请求时重建，但收益入账后若进程退出且不再收到同一请求，落后的 `shared_keys` 统计没有持久的发现入口。本轮新增 [review-only PostgreSQL 提案](../../../../packages/core/migrations-proposals/postgres/shared-key-usage-repair-jobs.sql)：在已经安装 0073 与 v333 收益历史防护、且 migrator 于同一事务显式设置 `cinatoken.shared_key_usage_repair_activation='reviewed-v1'` 后，收益 `AFTER INSERT` 触发器按 Key 写入一条修复任务。任务写入与收益行、卖家余额及账本处于同一事务；任务写入失败时整笔回滚。修复函数先锁 Key、再锁任务，按已提交收益行重新汇总 input/output、净额与最后使用时间，并在同一事务删除任务。一次调用至多修复一个 Key；崩溃或提交回执丢失时，汇总和任务删除一起回滚或一起提交。

[隔离原生报告](./C04-postgres-shared-usage-repair-jobs-v335-report.json)来自新建的 loopback PostgreSQL **18.6**，加载全部 **73** 条正式迁移、v333 review-only 历史防护和本提案；最终复验 **1/1 PASS、9 阶段、cleanup PASS**。夹具验证：缺激活设置、信用触发器停用、历史 TRUNCATE 防护停用、将入账函数替换为 no-op，以及额外默认函数 `EXECUTE` 均使激活事务回滚；强制任务入队失败使收益行、余额和账本一同回滚；正常入账与任务一同提交；修复事务回滚保留任务，重试只重建统计、不二次入账；并发收益写入时修复按父 Key→任务的锁序等待，写者提交后汇总包含其收益；前 32 个到期 Key 被锁时仍可修复第 33 个。原生测试命令为 `GATEWAY_NATIVE_PG_BIN=<local-pg18-bin> node --import tsx --test scripts/db/cutover/postgres-shared-key-usage-repair-jobs.native.test.mjs`；测试已登记 Proxy dispatch safety CI，但 Linux CI 尚未运行。

交叉审查发现普通 runtime 的宽授权脚本重跑会重新开放新表和 definer 函数。现已在 [授权脚本](../../../../scripts/db/cutover/grant-postgres-runtime.ts)按可选对象完整性核验后精确收回表／函数权限，并反查有效权限与全部非 owner ACL；在原生夹具中执行真实授权重跑及普通密码 LOGIN 拒绝：runtime 无任务表读写权限，不能直接调用修复函数。独立的[授权回归夹具](../../../../scripts/db/cutover/postgres-shared-key-usage-repair-runtime-grant.native.test.mjs)在本机 PG18 **1/1 PASS**，覆盖可选对象缺件时整笔回滚、两次重跑、函数目录漂移、继承权限漂移，以及尚未继承的额外角色授权；脚本全量 TypeScript 检查通过。两个原生夹具都已登记 CI，Linux CI 尚未运行。提案还把三个上游触发器的事件／时机／函数归属与已审定函数体固定为激活门禁。首次 7 阶段报告已被这次审查与最终 9 阶段报告取代；原 `.wrangler` 报告仍保留。

普通 Windows 沙箱首次启动 `pg_ctl` 时返回 restricted-token error 87；其自有 `.wrangler/staging/pg-native-dispatch-tests/run-i6dCAd` 目录保留，未当作测试成功。受控本机复验的报告记录独立集群清理通过。没有远端 SQL、云调用或部署。

**仍需完成：**正式 expand／backfill／switch／contract 迁移审查、已有已入账收益的有界任务回填、独立且有最小权限的运行角色与调度器、失败退避／租约／监控、代表性数据量和索引写放大评估，以及真实 Workers／Hyperdrive 和 MySQL/D1 路径。当前修复函数只能由 migrator 调用，运行环境没有消费者；因此它只证明持久修复协议的一部分，不能宣称崩溃后的统计最终会自动修好。上游触发器函数体若未来正式变更，激活用的固定摘要也必须重新审查。不可变报价与经济 outbox 等 C04 其余门禁仍开放。正式迁移仍为 PG **73**／D1 **68**／MySQL **64**，生产保持禁用。
