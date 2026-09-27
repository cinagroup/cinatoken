# C04.7 v336：修复任务专用 PostgreSQL LOGIN 授权

2026-09-24；**隔离 PostgreSQL 原生夹具通过；授权仍是 review-only 生成计划，未在远端执行。** [机器摘要](./C04-shared-key-usage-repair-direct-login-v336-results.json)固定本轮源码与报告摘要。

[授权生成器](../../../../scripts/db/cutover/build-shared-key-usage-repair-direct-login-grant.ts)要求显式激活值、固定 `cinatoken_gateway_shared_key_usage_repair_consumer` 身份、目标数据库、1–10 的连接限额和外部生成的强 SCRAM-SHA-256 verifier。它仅返回两阶段 SQL：DBA 以直接 LOGIN 创建无继承、无管理权限的专用角色及数据库用户级 30／15／5／10 秒事务／语句／锁／闲置事务超时；migrator 检查 0073、v335 修复提案的函数体、触发器、所有权、既有 ACL 和 runtime 拒绝后，只授予目标数据库 `CONNECT`、gateway schema `USAGE` 与 `repair_one_shared_key_usage()` 的 `EXECUTE`。SQL 不授予修复任务表、其他表／列／序列或其他函数权限，grant 后遍历 gateway schema 反查有效权限，任何漂移均使该阶段事务回滚。

[普通 runtime 授权脚本](../../../../scripts/db/cutover/grant-postgres-runtime.ts)现允许固定专用角色的单一修复函数 `EXECUTE` ACL，并继续禁止普通 runtime 及其他角色调用修复函数或访问任务表；它反查专用角色的直接 LOGIN 属性和零成员关系。安装顺序是：正式 0073／v335 历史防护／修复任务提案 → 普通 runtime 授权 → DBA 角色阶段 → migrator 精确授权阶段。该提案本身尚未进入正式迁移。

[Worker Cron 入口](../../../../packages/proxy/src/runtime/worker-handler.ts)在已有的每小时 `17 * * * *` 调用旁登记专用[有界 runner](../../../../packages/proxy/src/runtime/shared-key-usage-repair-worker.ts)。runner 默认关闭；仅配置精确 `SHARED_KEY_USAGE_REPAIR_ENABLED=reviewed-v1`、`DATABASE_DRIVER=postgres` 与独立 `REPAIR_HYPERDRIVE` 时建立连接。每一条任务各用一个事务核验专用 LOGIN 和数据库用户级超时后调用修复函数；默认每次至多 20 个 Key／25 秒新事务准入，函数返回 NULL 时不宣称任务队列为空。runner 单测 **5/5 PASS**，Proxy 类型检查通过。

[Wrangler 生成器](../../../../scripts/deploy/gen-wrangler.mjs)现仅在上述精确激活值和规范 `REPAIR_HYPERDRIVE_ID` 下向 Proxy 输出专用 Hyperdrive binding 与激活变量；它核验专用 ID 与普通／dispatch／fact ID 均不同，缺件或错误设置时先失败而不写配置。生成器单测 **13/13 PASS**，部署入口现有回归 **2/2 PASS**；本地默认生成 dry-run 后，`packages/proxy/wrangler.jsonc` 仍无专用 binding 或激活变量。没有调用远端 Cloudflare 或使用真实凭据。

[隔离原生报告](./C04-shared-key-usage-repair-direct-login-v336-report.json)在新建的 loopback PostgreSQL **18.6** 上加载 **73** 条正式迁移与两份 review-only 提案，最终 **1/1 PASS、7 阶段、cleanup PASS**。夹具验证：触发器禁用、修复函数体漂移、PUBLIC 列授权均阻止精确授权且事务回滚；直连角色仅有一个 gateway schema 函数的有效 `EXECUTE`，全 schema 表／列／序列权限均为零；普通 runtime 授权两次重跑仍封闭修复函数和任务表；真实密码 LOGIN 的数据库用户级超时来源为 `database user`；[独立 Cron runner](../../../../packages/proxy/src/runtime/shared-key-usage-repair-worker.ts)以该 LOGIN 完成一条真实收益任务的汇总与删除，普通 runtime 客户端被 runner 在执行前拒绝。[生成器单测](../../../../scripts/db/cutover/build-shared-key-usage-repair-direct-login-grant.test.ts) **2/2 PASS**，脚本 TypeScript 检查通过。两份测试已登记 Proxy dispatch safety CI；Linux CI 尚未运行。

仍需正式迁移、受控生产授权与专用 Hyperdrive 实例、Cron 实际运行和积压监测、[历史收益回填候选](./C04-postgres-shared-usage-backfill-v336.md)的持久游标调用方及全量完成观测、确定性失败退避，以及 D1／MySQL 对应协议；单机夹具不能证明远端连接来源和全实例连接预算。当前每小时最多处理 20 个不同 Key，持续超过此速率的入队会积压；单个持续失败的最早任务也可能阻断后续任务，必须在启用前完成吞吐与失败隔离门禁。没有远端 SQL、部署或云调用，C04.7／C04.G 继续开放。
