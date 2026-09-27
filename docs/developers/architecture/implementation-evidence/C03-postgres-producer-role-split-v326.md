# C03 v326：Images dispatch 与 fact 生产者角色分离

2026-09-24；**本地子集通过，生产禁用，C03 DOING**。承接 [v325 Images 预备载荷与 PostgreSQL factory](./C03-postgres-images-prepared-factory-v325.md)。本轮为同一 factory 的 parent claim 和 fact/outbox/job 写入分别建立数据库角色，并在隔离 PostgreSQL 18.6 中验证实际执行和越权拒绝。所有授权仍须显式审阅激活，不属于 73 条正式迁移。

## 分离的数据库权限

[parent grant 生成器](../../../../scripts/db/cutover/build-request-parent-producer-grant.mjs)现在仅向 `cinatoken_gateway_dispatch_producer` 授予 parent 的 prepare、claim、classify 三个函数 `EXECUTE`。`cinatoken_gateway_fact_producer` 和普通 runtime 均不能执行这三个函数；dispatch 与 fact 角色均无 parent、intent、API Key 的直接表或列权限。固定 SQL 摘要、角色属性、成员关系、有效权限和漂移预检仍在默认关闭的单事务 bundle 中核对。[原生报告](./C03-postgres-native-parent-dispatch-grant-v326-report.json)为 **2/2、17 阶段、cleanup PASS**，包括真实函数调用、直接和列级越权负例、漂移回滚及重跑。

新增默认关闭的 [fact/job grant 生成器](../../../../scripts/db/cutover/build-image-fact-job-producer-grant.mjs)，只有显式 `reviewed-v1` 才生成 SQL。它固定 0070–0073 正式迁移与 outbox definer 的源码摘要，检查表、列、trigger、FK、函数体、所有者、角色属性和现有有效 ACL 后，在单事务中仅授予 fact 角色所需的 **49 项列级权限**：fact `SELECT` 13／`INSERT` 12，outbox `SELECT` 3，job `SELECT` 16／`INSERT` 5。outbox 写入来自受审阅触发器，fact 角色没有直接 outbox `INSERT`、parent 函数、其他 gateway 关系或财务写权限；dispatch 和普通 runtime 没有 fact/outbox/job 权限。[原生报告](./C03-postgres-native-fact-job-grant-v326-report.json)为 **2/2、13 阶段、cleanup PASS**，覆盖成员、越宽列授权、dispatch 权限泄漏、trigger/FK 漂移的整体回滚，幂等安装及真实 fact→outbox→job 写入。财务回执、日志和余额未写入。

## factory 执行边界

[Images PostgreSQL factory](../../../../packages/proxy/src/services/image-usage-recovery-postgres.ts)仍为未接生产入口的显式候选。它在进入 dispatch 和 persist 前抽样检查普通 runtime、dispatch、fact 三个 `current_user`；随后把每次 parent 操作以及每条 fact/job SQL 与对应生产者角色检查绑定在**同一个 PostgreSQL 事务/会话**中。身份不符或查询失败会拒绝后续仓储工作；其[定向单元测试](../../../../packages/proxy/src/services/image-usage-recovery-postgres.test.ts) **8/8 PASS**，Proxy 类型检查通过。普通 runtime 检查只是抽样，因为本 factory 不通过该连接直接执行 SQL；不能把它当作其他 runtime 操作的会话绑定证明。

[组合原生夹具](../../../../scripts/db/cutover/postgres-image-recovery-factory.native.test.mjs)安装 73 条正式迁移与审阅提案，在两个独立的合成 `NOLOGIN` 角色下运行：dispatch claim 提交后，无 fact 授权的 persist 真实收到 `42501` 且 fact/outbox/job 均为零；应用审阅授权后，fact、outbox 和 pending job 各一条，并完成精确读回。财务日志／审计仍为零，预算余额未动。[组合报告](./C03-postgres-native-image-factory-v326-report.json)为 **1/1、7 阶段、cleanup PASS**。它的预算票据、入口摘要和 route 由夹具提供，未执行 HTTP/provider 请求或独立资金 consumer。

## 未闭合门禁

两个 producer 角色目前要求 `NOLOGIN/NOINHERIT` 且无成员关系；测试通过本机 superuser `SET ROLE` 执行。因此尚**没有可部署的普通登录凭据、直接连接来源或 Hyperdrive 映射**。下一步须设计彼此独立的登录身份和连接配置，调整固定预检并用实际新登录验证 `session_user/current_user`、跨角色拒绝、凭据轮换、角色默认时限及同实例 origin 容量；仅有本轮 `current_user` 检查不足以证明生产连接来源。C03.5 还包括 metadata 调度、凭据写入、受限解密、KMS 管理和数据库运维身份，这些尚无完整实际权限验收。

factory 尚未接应用入口；完整预算与 claim 可恢复协议、已知非 2xx 的真实结算事实、独立受限资金 consumer、旧库回填／保留期、代表性旧库锁与普通流量、真实 Workers／Hyperdrive／Queue 及 DBL-04/05/06/08 均未验收。C03.4／C03.5／C03.7／C03.G、C01.G／C02.G 保持开放。正式迁移仍为 73 条，生产禁用；本轮无远端 SQL、部署或云调用，首轮 staging US$2 上限不重置。[机器摘要](./C03-postgres-producer-role-split-v326-results.json)固定本轮源码与报告 SHA。
