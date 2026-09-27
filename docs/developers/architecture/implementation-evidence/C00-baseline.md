# C00：实现、测试与发布基线

日期：2026-09-05。状态：**LOCAL_PASS（基线工作完成；不表示系统生产验收通过）**。

执行 Owner：Codex（本任务）。本地复核：Codex 自检；未进行独立人员签核，生产 Reviewer 由项目负责人在相应门禁前指定。

## 1. 本次结果

- 基于当前 HEAD `7eb59008f7d8e156e81fd18a57658fdef2553264`，提交说明为 `feat: expand OpenRouter compatibility and stabilize CinaAuth login`，不沿用此前 dirty worktree 的完成状态。
- 开始时有 27 个未提交文件；记录了这些文件和关键实现共 52 个文件的 SHA-256。本任务不修改其业务代码，不清理既有变更。
- Core Node 入口重新构建、Proxy 类型检查通过。
- 35 个专项测试文件：196 tests、17 suites，196 pass、0 fail、0 skipped、0 cancelled；报告耗时 57,867.1057 ms。
- PostgreSQL/MySQL 迁移合同检查、各包版本一致性检查通过；没有连接真实 PostgreSQL/MySQL，也没有运行任何远端迁移。
- 从实际 `createProxyApp()` 枚举到 123 个非 ALL handler、109 个不同 method/path 注册组合，包含兼容别名。该数值不是 109 个已完整兼容或已生产验收的 API。
- 另执行 6 个进程内 HTTP 合同探针：错误路由、过大请求、BYOK/Analytics/Rerank 未认证、未注册 Batch 均得到预期状态。
- 35 个选定测试均可通过根 `test:unit` 的 npm pre/main/post 调用链到达；但仓库 GitHub workflows 未配置该单元测试入口，不能据此声称远端 CI 已覆盖。

证据：

| 文件 | 内容 |
| --- | --- |
| [C00-baseline-snapshot.json](./C00-baseline-snapshot.json) | HEAD、时间、Node/npm、27 个既有变更、52 个摘要、本地迁移链 |
| [C00-validation-results.json](./C00-validation-results.json) | 本次命令、退出码、35 个测试路径、结果和未执行范围 |
| [C00-api-baseline.json](./C00-api-baseline.json) | 实际 app 注册清单，去重 method/path 与 handler 数 |
| [C00-api-contract-fixtures.json](./C00-api-contract-fixtures.json) | 无数据库/无上游的最小请求与响应样本 |
| [C00-ci-inventory.json](./C00-ci-inventory.json) | npm 调用链与选定测试映射、工作流静态检查 |

## 2. 环境与证据强度

| 项目 | 当前证据 | 限制 |
| --- | --- | --- |
| 本地运行环境 | Windows / PowerShell；Node `v24.14.1`、npm `11.11.0` | 仓库 `.nvmrc` 为 `22`；本次没有证明 Node 22 下同样通过 |
| Core 生成入口 | `build:node-index` 成功 | 仅刷新本地 `dist/index.js`；没有执行带递归清理的 full prebuild |
| Proxy 类型 | `tsc --noEmit` 成功 | 类型检查不执行 Workers/Node 网络或数据库协议 |
| D1 仓储测试 | `node:sqlite` 内存 SQLite + D1 适配器 | 不是 Cloudflare 远端 D1 服务测试 |
| PostgreSQL/MySQL SQL 合同 | fake client 捕获 SQL/参数、静态迁移规则 | 不证明真实锁等待、事务隔离、索引性能与现网迁移 |
| HTTP/API fixture | Hono 进程内 request，显式空环境绑定/仓储 stub | 没有启动服务、发送认证 secret 或模型请求 |
| Provider/流式边界 | mock fetch/ReadableStream 等已有专项测试 | 不是实际供应商账单、延迟、流式断网 canary |
| Admin | 读取 AGENTS.md、入口/包脚本以及既有变更摘要 | 未运行 Admin 全量类型检查、构建或浏览器 UI 验收 |
| 生产/云资源 | `UNKNOWN_NOT_QUERIED` | 未读生产连接串、secret 值、业务正文；未访问账号 API |

Cloudflare 技能用于检查本地 Workers/Node 数据库与部署边界；未依据缓存参考中的配额数字作新的生产结论，也未调用 Wrangler remote、deploy、bootstrap 或付费服务。

## 3. 当前公开入口 → 服务 → 存储 → 测试矩阵

本矩阵固定“当前实现子集”，不替代 C01 的首发范围和合同决策。授权成功后的完整协议兼容，只有在相应 fixture/真实集成覆盖时才成立。

| 入口/能力 | 核心实现与数据 | 当前状态 / 本轮证据 | 后续落点 |
| --- | --- | --- | --- |
| `/v1` 与 `/api/v1` 的 Chat、Completions、Responses、Messages、Embeddings | route → model router/failover → egress → reservation/logs | 入口存在；别名认证与部分 text dispatch/abort 测试通过，不宣称完整协议全测 | C02、C04–C10 |
| `/v1beta/models/...` 原生 Gemini、DashScope 专用入口 | 原生 route/driver；共享权限和部分计量服务 | 源码注册存在；本次仅部分 text/stream 边界覆盖，专用实时生产能力未验证 | C01 固定支持范围 |
| `/api/v1/models`、`/providers`、`/model/:author/:slug` | public catalog、modelRouting、endpoint/evidence/performance 查询 | 公共目录入口存在；别名测试验证空目录形状，不等于有可用生产供给 | C12、C16 |
| `/api/v1/models/:author/:slug/endpoints` 与旧 `/v1` 发现接口 | canonical Management 与 legacy Gateway 鉴权边界 | 已有不同鉴权合同；不能把二者混成统一匿名入口 | C00 fixture 基线、C16 |
| `/api/v1/key`、`/keys` | current-key、management-keys → hash-only Key/限额仓储 | 当前 Key 查询与 Management CRUD 专项通过 | C11 资金语义不能用预算替代 |
| `/api/v1/workspaces`、成员、预算 | Management workspace/budget → 三库 owner/成员/预算 | 路由专项通过；不能由此证明外部组织同步和实际资金账户完成 | C01、C11 |
| `/api/v1/guardrails` | strict Management、默认/成员/Key assignment、预算/检测 | 当前路由专项通过；账户默认继承不是“未实现” | C14、C16 |
| `/api/v1/byok` CRUD/reorder | Management → BYOK storage/encryption；runtime pool/filter | 路由、D1、SQL 捕获、排序/隔离测试通过；正式费用仍暂免 | C06–C09、C12 |
| `/api/v1/analytics/meta`、`/query` | strict Management → requestLogs/query SQL | 路由和 D1/SQL builder 测试通过；不是完整 Activity/classifier 或真实 OLAP 验收 | C16 |
| `/api/v1/presets` 与 `/v1/presets` | Gateway auth → 可见版本/配置捕获 → preset repository | 路由专项通过，捕获配置不应 dispatch 推理 | C16 / 公开合同维护 |
| `/v1/rerank`、`/api/v1/rerank` | guardrail/router → rerank driver → 现有计量 | 入口、输入验证及 driver 专项通过；仅 search_units 的真实精确收费仍缺失 | C17 |
| Images、Audio、独立搜索/抓取工具 | 专用 route/driver/tool engine 与费用服务 | 注册存在；本次不是这些能力的完整生产对账验收 | C01、C17、C19 |
| Batch | 三库 batches/items、R2、JSONL、Queue lease/dispatch fence | 存储/授权/验证专项通过；executor 仍 staged，公开 API 未注册 | C18 |
| `/api/v1/credits`、`/api/v1/activity`、通用 Files、OAuth Apps | 当前公开 app 没有相应注册 | 不把相近门户功能或登录客户端算作已实现同名公开产品 | C11、C16、C19、C20 |

关键源文件：

- [公开 app](../../../../packages/proxy/src/app.ts)、[管理鉴权](../../../../packages/proxy/src/middleware/management-auth.ts)、[错误 fixture](../../../../packages/proxy/src/app-global-errors.test.ts)。
- [BYOK](../../../../packages/proxy/src/services/byok-key-pool.ts)、[Analytics](../../../../packages/proxy/src/routes/v1/analytics.ts)、[Batch consumer](../../../../packages/proxy/src/runtime/batch-queue.ts)。
- [Runtime 数据库选择](../../../../packages/core/src/storage/runtime-database-config.ts)、[Node 入口](../../../../packages/proxy/src/runtime/node.ts)、[Workers handlers](../../../../packages/proxy/src/index.ts)。

## 4. Runtime / 数据库 / 本地迁移基线

| Runtime | 支持的数据库路径 | 选择规则 | 本轮证明范围 |
| --- | --- | --- | --- |
| Workers | D1 | 未指定 driver 默认 D1；需要 `DB` | 解析合同测试通过，未连接远端 |
| Workers | PostgreSQL / Hyperdrive | 显式 `DATABASE_DRIVER=postgres`；只用 Hyperdrive 绑定 | 缺绑定拒绝、双绑定不自动切换的测试通过 |
| Workers | MySQL | 当前实现显式拒绝 | 不能因 Core 有 MySQL 仓储就宣称 Workers MySQL 支持 |
| Node | PostgreSQL / MySQL | 默认 PostgreSQL；显式 driver 与 URL 协议一致 | 源码存在；本次未启动真实数据库服务 |
| Workers Queue/Cron | Batch consumer / retention | `src/index.ts` 注册 queue/scheduled | 注册存在不等于基础设施已部署；Batch 真实执行仍未完成 |

| 后端 | 本地 SQL 文件数 | 本地链尾 | 远端已应用 |
| --- | --- | --- | --- |
| D1 | 68 | `0068_batch_jobs.sql` | UNKNOWN_NOT_QUERIED |
| PostgreSQL | 67 | `0067_batch_jobs.sql` | UNKNOWN_NOT_QUERIED |
| MySQL | 64 | `0064_batch_jobs.sql` | UNKNOWN_NOT_QUERIED |

迁移合同测试通过只是文件/规则一致性证据。未来核查远端时，必须读取实际 `schema_migrations`、目标数据库身份、runtime 绑定和部署版本；不能通过执行迁移来猜测原状态。

## 5. 测试收集与 CI 的实际差距

### 5.1 已收集：不能再误报这些测试未接入口

| 测试组 | npm 可达入口 |
| --- | --- |
| Core BYOK 类型、D1、SQL contract | Core `pretest:unit → test:management-keys` |
| Core Batch 类型、D1、SQL contract | Core `pretest:unit → test:batches` |
| Core Analytics SQL、runtime config、加密/Key hash | Core `test:unit` |
| Proxy BYOK、Analytics、Management、当前 Key | Proxy `pretest:unit → test:management-keys` |
| Proxy Rerank route + driver | Proxy `pretest:unit → test:rerank` |
| Proxy Batch 四类 helper + consumer | Proxy `pretest:unit → test:batch` |
| Proxy text/abort、别名/错误/CORS、Preset | Proxy `pretest:unit` 的各专项入口，部分也在 main test |
| Proxy BYOK pool/费用、admission、收益、熔断 | Proxy `test:unit` |

根 `test:unit` 会按工作区运行各包测试；本次静态递归追踪含 npm pre/post hooks，共访问 39 个 scripts，选定 35 个文件无缺失。这里没有声称枚举了整个仓库所有未被收集的测试文件。

### 5.2 待修复问题

| ID | 当前证据 | 影响 | 后续处理 |
| --- | --- | --- | --- |
| CI-01 | 仓库 `.github/workflows` 没有 npm unit/typecheck 或 Node test 的执行入口；现有流程主要是版本检查、构建/发布和 Compose smoke | 本地 npm scripts 的覆盖不等于 PR 自动回归；外部 CI/branch protection 未访问，状态未知 | 增补独立 PR/local-safe 测试工作流，固定 Node 版本、Core 生成顺序与测试子集；不在 C00 把 workflow 文件写出即标为 CI 已跑绿 |
| CI-02 | `docker-compose-smoke.yml` 仍检查 `schema_migrations COUNT = 30`，runner 会扫描全部 SQL，本地 PG 链已经 67 | 即使迁移全部成功，固定 30 的断言仍与当前 schema 链不一致 | 改成来自受版本控制 manifest/真实 SQL 清单的期望，并同时验链尾/幂等；不能仅把 30 改为下一次又过时的常量 |
| ENV-01 | `.nvmrc=22`，本地实际 Node 24.14.1 | 本轮不能背书 CI/生产 Node 22 的行为；SQLite 特性与依赖需要对应 runtime 验证 | 在 CI 或获准的隔离环境跑固定 Node 22；不为基线擅自更换用户全局 Node |
| VERIFY-01 | 本次 SQL 仓储用 mock，D1 用内存 SQLite | 不证明真实 PG/MySQL 锁/事务、Workers 并发、迁移与数据权限 | 留给 C03/C10 的真实集成门禁 |

源码依据：[Compose smoke](../../../../.github/workflows/docker-compose-smoke.yml)、[PG runner](../../../../packages/core/src/migrate/postgres.ts)、[Core manifest](../../../../packages/core/package.json)、[Proxy manifest](../../../../packages/proxy/package.json)。

CI-01/CI-02 是 C00 已识别的发布基线问题，不是本轮新增回归。本包按清单要求记录，不修改工作流、数据库或已有业务代码。它们在进入依赖自动回归的发布门禁前必须解决；不阻塞 C01 的本地设计决策。

## 6. 架构缺口复验：保持后续优先级

| 事实 | 当前源位置 | 必须进入的工作包 |
| --- | --- | --- |
| 真实 dispatch 仍遍历全部展开候选，8 仅是 trace 截断 | `failover-dispatch.ts` 的 `MAX_DISPATCH_ATTEMPT_TRACES` 与 `attemptIndex < attempts.length` | C02 |
| 共享渠道读取全部 active Key，仓储 `Promise.all` 解密 | `shared-key-pool.ts`、`shared-key-encryption.ts` | C06–C09 |
| 健康/熔断仍为进程 Map | `provider-circuit-breaker.ts`、`shared-key-pool.ts` | C07 |
| 收益结算读当前 Key/佣金，有限内存重试 | `shared-key-earnings.ts` | C04–C05 |
| 私有 BYOK 仍 `fee_waived_until_entitlement_v1` | `byok-billing-policy.ts` | C12 |
| Rerank 已返回 search_units，但缺独立计量结算 | `openai-rerank-driver.ts` | C17 |
| Batch 仍 `batch_executor_staged` | `runtime/batch-queue.ts` | C18 |

上次审计中的核心风险仍有当前源码支持。本包没有因为测试通过而将它们改成“已修复”。旧 parity 文档若仍把账户默认 Guardrail、私有 BYOK、Analytics、Rerank 列为完全缺失，应在后续文档同步时改成当前真实状态；本报告不覆盖原文。

## 7. 当前开关和后续开关管理

| 名称 | 当前源码语义 | C00 状态 |
| --- | --- | --- |
| `DATABASE_DRIVER` | 选择指定 runtime 支持的数据库；Workers/Node 默认不同 | 已核对逻辑，未核对现网值 |
| `CINATOKEN_MAINTENANCE_MODE` | Workers HTTP 在存储访问前拒绝新请求 | 已读取实现；不认为它会自动停止 Queue/Cron 或适用于所有 Node 路径 |
| `REQUEST_BODY_LOGGING` | 默认 off，策略控制正文日志 | fixture 显式 off；现网未知 |
| `BATCH_INFRA_ENABLED` | 部署生成器显式 opt-in 基础设施 | 只读核查，未打开 |
| `BATCH_API_ENABLED` | 当前生成器拒绝 true，产物固定 false；没有公开 Batch route | 保持关闭 |
| `ANALYTICS_RATE_LIMITER` | 可选 Workers binding；缺失时跳过该限流器 | 不能假设 Node 或现网已有限流绑定 |
| 凭据迁移/Broker/新资金开关 | 本次未见完整实现 | C01/C03 定义合同，不能在部署配置中先写假开关 |

每个后续工作包必须登记：开关 owner、默认值、控制流量范围、关闭后的在途/账务处理和回滚版本。不允许把清单中的计划名称当成当前存在的可操作开关。

## 8. 探针偏差与非业务失败记录

- 首次额外 Hono 探针漏传第三个环境绑定参数，使缺凭据分支在访问 `c.env` 时返回 500。该 harness 与现有别名测试不同；补齐显式空 bindings 后，三个认证探针均为 401。此为本次验证夹具修正，不修改业务代码，不计入 196 项正式测试的失败，也不将初次结果当作已确认生产故障。
- 尝试用 `git -c core.excludesFile=NUL` 消除全局 ignore 文件读取警告时，Git 报不接受 NUL。随后使用普通 `git status` 获取成功的基线，未修改 Git 配置或文件。快照只声称覆盖其实际列出的变更与关键文件。
- 全仓 unit、Admin UI/构建、真实 DB、Docker smoke、云账号状态、付费推理与 KMS/Broker 集成都未执行，见验证结果 JSON 的 `notExecuted`。

## 9. C00 完成映射与下一步

| Checklist 项 | 证据 |
| --- | --- |
| C00.1 | snapshot：HEAD、27 个既有变更与摘要；没有覆盖/清理用户文件 |
| C00.2 | 第 3/4 节支持矩阵与实际 route inventory |
| C00.3 | 第 5 节与 CI inventory；已区分 npm 可达与工作流未调用 |
| C00.4 | validation results：Core、Proxy、196 个专项测试及迁移合同 |
| C00.5 | migration count/链尾；远端明确 UNKNOWN；未来只读核查要求 |
| C00.6 | route inventory、6 个最小错误/认证 fixture、旧审计时间漂移记录 |
| C00.7 | evidence README 的 owner/模板与第 7 节开关登记 |
| C00.G | 本地基线可按记录重现，范围不外推；下一工作包 C01 |

下一步：**C01 — 冻结当前实现所需的架构/账务决策与首发范围**。技术默认值可以先形成版本化草案，但资金权威、收费责任、供应商共享权限、真实 KMS/云资源选型和费用授权不能凭空标记为业务批准。

整体线程目标仍在推进；C00 LOCAL_PASS 不表示 C01–C20 完成，也不表示满足公开收费、海量凭据或严格合规的生产门禁。
