# C03 v308：固定 v307 驱动候选的显式本地采用门禁

2026-09-23；**EXPLICIT ADOPTION BUILD PASS，PRODUCTION DISABLED，C03 DOING**。承接 [v307 固定恢复扫描](./C03-postgres-controlled-recovery-scan-v307.md)，本轮只让本地评估插件在显式 `enabled: true, candidateRevision: 'v307'` 时选择同一份 postgres.js 3.4.9 候选。普通 `enabled: true` 仍选择 v300；未启用时仍返回空插件，不触发候选构建。正式依赖、锁文件、共享 dist、生产 build 命令、Wrangler 配置、运行时工厂、公开类型和部署入口均未切换。

## 采用范围和防旁路

[评估插件](../../../../scripts/db/diag/postgres-candidate-adoption.mjs)只接受显式 Node/Workers 目标及 v300/v307 修订。v307 构建沿用 [已测试的变换器](../../../../scripts/db/diag/postgres-owned-cancellation.mjs)，在返回插件前核对 ESM、CJS、CF 三份冻结产物 SHA-256；加载时同时核对实际文件字节、候选元数据与私有冻结 SHA，以及 v302 取消和 v307 扫描双标记。即使调用者在候选创建后篡改公开返回的 artifact 路径/SHA，旧 v300 字节与旧 SHA 也不能作为 v307 加载。esbuild 元数据审计仍要求选中对应运行时分支、有实际输出字节、没有安装版 `postgres` 混入或外置导入；Wrangler 的物理 alias 另做输入与输出元数据审计。

这一 alias 会替换**整个 bundle** 内解析到的 `postgres` 模块，不是仅替换两条扫描。两种固定只读 SQL 的边界仍由 [运行器](../../../../packages/core/src/storage/recovery/run-usage-recovery-postgres.ts)和[封闭目录](../../../../packages/core/src/storage/recovery/usage-recovery-jobs-postgres.ts)执行；低层 `ownedStatement(query, params)` 仍接受诊断 SQL，不能对外发布为通用受控接口。v307 构建器的 scratch 目录名和 banner 保留历史 `v302` 字样；本轮不靠名称判断版本，只按 source/query pins、冻结产物 SHA 与实际工厂能力核对。

## 本地验证

[v308 独立测试](../../../../scripts/db/diag/postgres-candidate-adoption-v308.test.mjs)最终复跑 **6/6 PASS**、0 fail/skip；scratch 报告 `.wrangler/staging/postgres-adoption-v308-7JFfws/results.json`，采用后的 core 工厂固定扫描 wire 输出在同目录 `adopted-core-fixed-scan-wire.tap`。同轮 [既有 v300 采用测试](../../../../scripts/db/diag/postgres-candidate-adoption.test.mjs) **9/9 PASS**。16 个受保护输入在 v308 测试前后均与 v307 冻结报告一致，未修改安装驱动、锁文件、共享 dist 或默认部署配置。

| 检查 | 结果及限制 |
| --- | --- |
| 禁用/历史默认 | `postgresCandidateAdoption()` 仍返回空插件；普通显式 `enabled:true,target:'node'` 的三份 v300 artifact 与旧构建器一致，且不同于 v307。默认 core/proxy 与禁用插件的 SHA-256 各自相等。 |
| v307 真实性与负例 | 三分支原始 `index`/`connection`/`query` 的 source pins、esbuild 版本、冻结 artifact SHA 与实际工厂的双能力标记一致。错误 artifact SHA、以旧 v300 字节+旧 SHA 替换、错误目标/修订、缺少 metafile、插件排在外置器之后均拒绝。 |
| Node 实际采用 | scratch core ESM、CJS、完整 proxy Node 构建均经元数据审计；core 重复构建字节一致。由 scratch core 的实际 `createPostgresDatabaseClient()` 初始化/关闭本地协议 peer，并用该工厂包装器运行既有两种固定扫描 wire **4/4**。这不是原生 PostgreSQL。 |
| Workers 构建 | CF 分支经 esbuild 审计；完整 proxy Wrangler 入口只做带断网守卫的 `deploy --dry-run`、关闭 routes/workers.dev/preview，物理 alias 的输入与输出字节核对通过。CF artifact 可在 Node 本地 hook 下检查工厂标记，但**没有执行 workerd/Hyperdrive 请求**。不同 scratch alias 路径可能使整个 Wrangler bundle SHA 变化，不把它宣称为跨目录字节确定性。 |

本轮 artifact SHA-256：ESM `e2e2385dd7543d557d64312be9ef1045cec57a094cfc1aeec882d4c356c25521`；CJS `5d08e70c604566c2d2ed9c84000008c8d13a15a9b04df268c9b3ef218154098b`；CF `5704f05aeb495cf78a97ae7d140d3a980007130736e0c8bc6b77ed90ec47d72d`。本轮插件与新测试源码 SHA-256、测试计数和默认/采用构建 SHA 见[机器摘要](./C03-postgres-explicit-candidate-adoption-v308-results.json)。运行环境为 Node v24.14.1；Node 22 未验收。

## 未通过门禁与后续顺序

DBL-04 **仍未闭合**：本轮只是默认禁用的构建采用门禁，没有正式包导出/公开类型、真实 fetch/Queue/Workflow 生命周期、认证/TLS/pooler/Hyperdrive、完整 Query 模式或物理关闭证明。现有本机最小 workerd 启动探针在业务模块加载前即以 `0xc0000005` 退出，且二进制 SHA 与[先前诊断](./C02-workers-startup-diagnostic.json)一致；不能归因于 v307，也不能将 Node hook 或 dry-run 算作 Workers 验收。可在获准的 Linux/隔离环境先用 SHA-pinned CF 产物和本地合成协议 peer 验证，再另行安排具备独立数据库角色、绑定、预检与预算的 staging Hyperdrive 验收；本轮未触发 CI 或云端测试。

DBL-05 **尚未实现**：`runBudgetMs` 及观察截止只阻止新准入，不限制本地排队、服务器执行、锁等待或内部 COMMIT/ROLLBACK。下一有限项先冻结专用身份和服务器时限的作用域/版本前置，并逐路径覆盖初始化、两类扫描、注册、claim/fail、资金事务及 ACK 读回。Hyperdrive 的事务池会重置会话状态；不能把初始化 `SET` 当作后续 SQL 的时限或 schema 保证，也不能把整个恢复运行包成长事务。[Cloudflare 事务池说明](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/)与[PostgreSQL `SET LOCAL` 作用域](https://www.postgresql.org/docs/current/sql-set.html)限定了这一设计。DBL-06 可信资源解除、原生 PostgreSQL 多会话/WAL、资金全路径及 C03.G 仍未验收。生产保持关闭；没有云管理、远端 SQL、部署、付费模型或 KMS 调用，首轮 staging 累计 US$2 上限未重置。
