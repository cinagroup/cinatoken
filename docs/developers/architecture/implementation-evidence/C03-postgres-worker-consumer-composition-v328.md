# C03 v328：Worker 生产者绑定与独立资金 consumer 本地组合

2026-09-24；**本地候选，生产关闭，C03 DOING**。承接 [v327 三个直连登录身份](./C03-postgres-direct-login-producers-v327.md)。本轮建立显式应用组合入口、Worker 绑定与私有资金执行入口；没有把任何候选接进默认生产 `fetch` 或 Queue handler。正式 PostgreSQL 迁移仍为 73 条。

## Images 应用与 Worker origin

[Proxy 应用](../../../../packages/proxy/src/app.ts)只有在服务端传入 `postgresImageRecovery` 与显式 HTTP 容量时，才为 Images POST 创建请求私有 producer owner；与 D1 recovery 同时配置会拒绝。Images 请求在 producer 打开前先通过真实 API Key 中间件，路由内再次鉴权；缺失/无效 Key 不占用 producer origin。仅 `/v1/images`、`/v1/images/generations`、`/v1/images/edits` 和 `/api/v1` 对应别名可进入此路径。普通 runtime 必须是 PostgreSQL；factory 仍对实际 SQL 会话的 `session_user` 与 `current_user` 作身份校验。请求完成后，两个 producer 的 close 观察加入请求容量拥有者；close 不明继续保留逻辑容量。这个观察不证明底层 socket 物理关闭。Node 入口只透传服务端显式选项，尚无生产 origin opener。

[Worker owner opener](../../../../packages/proxy/src/runtime/worker-postgres-image-producer-owner.ts)是独立的 review-only 入口，默认 Worker app 不调用。它在建 client 之前检查 runtime、dispatch、fact 三个 PostgreSQL URL 均存在、绑定对象与连接字符串互异，且 URL 最多有一个 `sslmode=disable|require` 参数；随后实际查询三条数据库会话的 `current_user`/`session_user`，分别要求匹配三个专用登录角色。Hyperdrive 在 Worker 中[生成动态连接字符串](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/)，[本地开发文档](https://developers.cloudflare.com/hyperdrive/configuration/local-development/)也允许 `sslmode` 参数，因此 URL 用户名**不被当作 origin 登录证明**；真正的角色证明来自 SQL，会在 factory 的每次生产者 SQL 所在事务内重复。opener 只为两个 producer 创建 `max:1` 的原始 postgres.js client，不通过会设置通用 runtime `search_path` 的 Core 工厂。两个 origin 的关闭完成分别等待；部分打开或预检失败且关闭不明时，专用错误使应用继续保留逻辑容量。Core 三个恢复仓储收窄到 `{driver, raw}` 类型，使专用连接无需伪造通用 Drizzle context。[Wrangler 生成器](../../../../scripts/deploy/gen-wrangler.mjs)仅在 `REVIEW_PRODUCER_HYPERDRIVE_BINDINGS_ENABLED=true`、PostgreSQL driver 和三个不同的规范 UUID 同时满足时，为 Proxy 生成两个额外 Hyperdrive binding；默认配置没有它们，Admin/Chain 也不会获得它们。运行时绑定不暴露 config ID，实际云端 ID 与 origin 的映射仍须另验。

## 资金执行候选

[一次性 financial consumer](../../../../packages/proxy/src/runtime/postgres-financial-consumer.ts)默认关闭，要求 invocation 私有 client 的 `session_user=current_user=cinatoken_gateway_financial_recovery_consumer`；预检及每次 SQL/事务都在同一实际会话检查角色，拒绝复用 runtime、dispatch 或 fact client。它复用已有有界 runner、保留不明 client 和容量，并且所有结果均为 `queueAckSafe:false`。它没有 Queue ACK/重投策略、跨 isolate 排他、服务端执行截止或物理关闭证明。[隔离 PG18.6 原生报告](./C03-postgres-native-financial-consumer-login-v328-report.json) **1/1、5 阶段、cleanup PASS**：73 条正式迁移与旧日志 guard 下，专用 SCRAM 密码 LOGIN 的会话默认时限、`session_user=current_user`、跨角色与 Key/日志/fact/迁移越权拒绝均验证；一次真实恢复结算形成 receipt/log/attempt/audit 各 1、用户累计 `1.250000`、job `committed`。角色创建和权限是测试夹具，尚无审查通过的生产 provisioning/grant。

## 验证与边界

本地 opt-in 应用 **5/5**、Worker owner **8/8**、consumer **10/10**，合计 **23/23**；三组单测与 Wrangler 生成器 **11/11** 已进入 [Proxy dispatch safety CI](../../../../.github/workflows/proxy-dispatch-safety.yml)。Core 收窄仓储 PGlite **88/88** 与四项定向类型检查、Images 路由相关 **457/457**、Proxy 类型检查通过。显式 Worker 组合的内存 bundle 通过，默认 Worker bundle 不含 opener；这只是编译检查。应用组合测试的存储是合成仓储，验证的是路径、鉴权、互斥与容量 close；不宣称完整 HTTP→PG→供应商→财务链。Worker owner 测试使用假连接，生成器测试只读写本地生成配置；不能替代真实 Workers/Hyperdrive 起源、连接配额和生命周期。原生财务夹具已登记官方 PG18.6 容器的独立 CI job；本机无法执行该 Linux job，CI 结果仍待首次运行，也不能推及真实 Queue。

待闭合：当前同实例 origin 全量库存、经认证容量和生产凭据；完整预算→claim→fetch→fact/outbox→财务 consumer 的代表性 HTTP 链；旧库回填及保留期；真实 Workers/Hyperdrive/Queue ACK、DBL-04/05/06/08、C03.4/C03.5/C03.7/C03.G 以及 C01.G/C02.G。生产保持关闭；无远端 SQL、云管理、部署、模型或 KMS 调用，首轮 staging US$2 上限不重置。[机器摘要](./C03-postgres-worker-consumer-composition-v328-results.json)固定源码与验证 SHA。
