# C03 v322：请求级派发门禁与 Images grant→fetch 边界

2026-09-24；**本地分项验证通过，生产禁用，C03 DOING**。承接 [v321 保守 failover 候选](./C03-postgres-conservative-failover-v321.md)和 [v320 claim 授权／单请求索引提案](./C03-postgres-claim-auth-request-gate-hardening-v320.md)。本轮的 PostgreSQL parent 提案、原生 grant→fetch 夹具、Images 公共 unknown 响应是三项独立证据，尚未串成生产路径。

## 请求级 parent 提案

[review-only SQL](../../../../packages/core/migrations-proposals/postgres/request-dispatch-parent-deadline-budget.sql)在 `request_id` 下冻结用户、Key、Workspace、操作、调用者提供的 `request_sha256`、数据库首次创建时间、原始截止和总准备次数。V1 硬上限为 **3 次、300 秒**。各 attempt 的 `context_sha256` 可随 route 变化；重复准备不刷新原始期限或预算。prepare／claim／classify 函数按 parent→attempt 锁序运行；一次已提交 claim 后，即使分类为 `outcome_unknown`，请求级 claim 名额也不释放。v320 的部分唯一索引仍是第二道数据库约束。

提案只能在显式激活断言、73 条正式迁移和 v320 两份已审阅提案之上，以单事务手动安装。现存 intent 行没有可信原始请求预算，预检拒绝并保留数据，不猜测回填。非 owner 的直接 intent 写权限、默认权限带来的新表／`SECURITY DEFINER` 函数授权，以及非超级用户的 migrator 成员关系均使安装回滚；提案没有给 runtime 或 producer 授权。[PGlite 测试](../../../../packages/core/src/storage/recovery/request-dispatch-parent-deadline-budget.proposal.pglite.test.mjs) **1/1 PASS**，覆盖冻结、期限／次数上限、route 摘要、unknown、旧行、默认授权、角色继承及回滚。

[隔离原生 PostgreSQL 18.6 测试](../../../../scripts/db/cutover/postgres-request-parent-deadline-budget.native.test.mjs) **1/1 PASS、15 阶段**；[原生报告](./C03-postgres-native-request-parent-v322-report.json)记录 73 条迁移、激活和权限负例、四种双连接 sibling prepare／claim 的真实锁等待及 COMMIT／ROLLBACK、unknown 与清理 PASS。测试采用空库合成数据，没有代表性旧库持锁时长或回填证据。当前 TypeScript PostgreSQL repository 仍是 attempt 优先锁序与直接 DML，**不能与 parent 函数组合**；请求摘要仍由调用者给出，可信入口派生和身份绑定待实现。后续 GRANT／成员关系漂移、超级用户、删除与保留期也不由安装时审计永久解决。

## grant→fetch 与公共 unknown 响应

[原生 grant→fetch 夹具](../../../../scripts/db/cutover/postgres-grant-fetch-boundary.native.test.mjs)另行安装 73 条正式迁移及 v320 授权／唯一索引提案，**没有安装上述 parent**。它以真实 `proxyImageGenerations` 和 Images driver、假 fetch 执行 **1/1 PASS、6 阶段**：[报告](./C03-postgres-native-grant-fetch-v322-report.json)记录真实 COMMIT 后故意延迟客户端可见回执时零 fetch；确认 grant 后恰好一次 fetch，保留首 route 的原始 503 Response 和 10 token usage；旧 revision 拒绝、模拟 COMMIT 回执丢失都零 fetch；两个 sibling handler 合计一个持久 claim／一个 fetch。夹具中的拒绝与不确定错误映射为 403，仅用来观察停止派发；回执延迟／丢失由客户端 wrapper 模拟，不是 PostgreSQL 协议包或真实网络故障。它只覆盖 generations，不证明完整 HTTP 入口、真实 origin、实际收费或结算。

[Images 路由](../../../../packages/proxy/src/routes/v1/images.ts)现在对恢复对象抛出的 `PostgresDispatchClaimUncertainError` 在 generations／edits 返回规范的 `gateway.capacity_unavailable` **503**，仅公开请求 ID、`outcome_unknown:true`、`retry_safe:false`；不再尝试下一 route 或旧的预算终止／结算分支。其他恢复错误保持既有路径。[路由测试](../../../../packages/proxy/src/routes/v1/image-request-lifecycle.test.ts)以合成恢复对象覆盖两个操作、零 fetch 和元数据；完整路由回归 **414/414 PASS**，Proxy 类型检查与 dispatch-safety 类型检查通过。此处理没有导入或激活 PostgreSQL repository，且不能把夹具 403 说成真实路由的 503 端到端验收。

## 留存门禁

机器摘要和源码 SHA-256 见 [v322 结果](./C03-postgres-request-parent-grant-fetch-v322-results.json)。正式迁移仍是 73 条；两个 parent／grant→fetch 原生集群均 cleanup PASS，本机 owned `run-*` 目录为空。原生测试首次尝试遇 sandbox restricted-token／旧 v292 私有二进制启动失败；改用既有 v314 私有运行库并复跑通过，失败尝试没有计为业务通过。

下一步先改 PostgreSQL repository 与可信 Images 入口，使请求摘要、预算／guardrail 准入、parent→attempt 函数、已确认 COMMIT grant 和紧邻一次 fetch 的驱动回调组成同一受审阅路径；再验证已知非 2xx 的真实结算、claim 后撤权、真实 COMMIT ACK 不明、生产者权限、旧库迁移／保留期及代表性负载。Workers／Hyperdrive／Queue、origin 容量、DBL-04/05/06/08 与 C03.G 仍未验收。C03.4／C03.5／C03.7 不勾选；生产默认关闭，无远端 SQL、部署或云资源调用，首轮 staging US$2 上限不重置。
