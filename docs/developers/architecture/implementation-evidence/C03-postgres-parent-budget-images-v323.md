# C03 v323：parent 函数适配器、Images 入口摘要与预算派发次序

2026-09-24；**本地候选与隔离原生 PostgreSQL 联调通过，生产禁用，C03 DOING**。承接 [v322 请求级 parent／grant→fetch 子集](./C03-postgres-request-parent-grant-fetch-v322.md)。本轮把 PostgreSQL parent 函数调用、可信 Images 入口摘要和两阶段预算票据分别落到代码，并用一个本地原生夹具组合 parent／预算／真实 Images generations driver。它们尚未组成生产请求入口或真实资金结算。

## 代码边界

[显式 opt-in 的 parent repository](../../../../packages/core/src/storage/recovery/dispatch-intent-postgres-parent.ts)只调用 v322 提案的 `prepare_request_dispatch_intent_v1`、`claim_request_dispatch_intent_v1` 和 `classify_request_dispatch_intent_v1`。调用前复制、校验请求与 attempt 标量；prepare 只报告已准备状态，不授予发送权；claim 必须等 `pg.begin` 的 COMMIT 回执后才返回 grant。claim 抛错统一视为回执不明，不读回、不重试、不转交发送权。它不从 Core 公共入口导出，没有安装运行时 EXECUTE grant，旧 attempt 优先直接 DML repository 保留且不能与 parent 混用。[PGlite 适配器测试](../../../../packages/core/src/storage/recovery/dispatch-intent-postgres-parent.proposal.pglite.test.mjs) **1/1 PASS**，在 73 条正式迁移和三份 review-only 提案上覆盖冻结、重复准备、期限、claim、unknown、丢失/延迟回执与坏输入；Core dispatch-intent 窄类型检查通过。

[Images 请求摘要 helper](../../../../packages/proxy/src/services/image-request-digest.ts)从服务端成功解析的 generations JSON、可信会话，以及 edits 已接受字段与 `MultipartFile` 的真实解码字节流生成版本化 SHA-256，限定分页、文件数、字节量和截止；不接受外部提供的 digest 或未经过 multipart parser 的 Blob／直接字节。只有显式声明 `requiresTrustedIngressDigest` 的恢复 factory 才让 [Images 路由](../../../../packages/proxy/src/routes/v1/images.ts)在 Guardrails 修改请求前计算并传入 `scope.requestSha256`；默认 D1 factory 不声明。入口摘要没有覆盖 Guardrail 变换后的最终上游载荷，route／payload 的 attempt context 绑定仍需完成。helper **6/6**、generations／edits 路由摘要实测各一项，完整 Images 路由 **422/422 PASS**。

[单次 grant 预算票据](../../../../packages/proxy/src/services/request-budget-admission.ts)先为选定 route 保留 Ordinary 与 Guardrail 预算，再把处理分成三条显式路径：确认 COMMIT claim 后标记两套账簿为 dispatched；明确无 claim 时释放预留；claim 回执不明时保留预留、禁止本请求再派发。既有 `beforeUpstreamDispatch` 默认语义保留。预算测试 **15/15 PASS**，其中新票据覆盖两账簿顺序、明确拒绝、回执不明和排除计费的 private BYOK。Images generations／edits 对显式 `singleCommittedRequestGrant` 的合成恢复对象在首次已知 503 后保留响应、route 和 usage，不重试；不声明该能力的 D1 风格路径仍按原有 fallback 运行。路由测试没有使用真实 PostgreSQL factory。

## 原生组合证据

[隔离本机 PostgreSQL 18.6 夹具](../../../../scripts/db/cutover/postgres-parent-budget-fetch.native.test.mjs)安装 73 条正式迁移及 v320 两份与 v322 parent 一份 review-only 提案，使用上述 parent adapter、两阶段预算票据、真实 `proxyImageGenerations`／Images driver 与假 fetch。**1/1 PASS、5 阶段、cleanup PASS**；[原生报告](./C03-postgres-native-parent-budget-fetch-v323-report.json)记录：已持久 claim 但客户端 COMMIT 回执未到时，两套预算仍 reserved、零 fetch；回执确认后两套账簿转 dispatched，恰好一次 fetch，首个已知 503 的原响应、route、usage 与上游请求 ID 保留；同一请求 sibling 明确无 claim 后两套预留释放、零 fetch、数据库只有一个 claim；模拟 claim 回执丢失时预算继续 reserved、零 fetch、不产生第二次发送权。

该夹具的预算 repository 是内存见证，request SHA-256 是合成输入，fetch 不是实际 origin；回执延迟/丢失是**真实 COMMIT 后的客户端 wrapper 模拟**，不是 wire／TCP 丢包。夹具只执行 generations driver，没有接真实 HTTP 恢复 factory、真实生产者身份/权限、资金 writer、结果事实或恢复协调器。路由入口摘要与原生 parent／预算组合是独立测试，不能合称完整端到端请求。原生一开始在 Windows sandbox 内遇 `pg_ctl` restricted-token 错误，随后在获准的本机隔离运行中通过；失败尝试不计业务通过。

## 留存门禁

[机器摘要](./C03-postgres-parent-budget-images-v323-results.json)冻结本轮源码与报告 SHA-256。Proxy 完整与 dispatch-safety 类型检查、Core dispatch-intent 窄类型检查、`git diff --check` 通过；Core 全量类型检查的既有无关错误不计本轮通过。正式迁移仍是 73 条，parent／授权／请求级 claim 提案仍 review-only、默认关闭。

下一步须把可信入口摘要、已认证身份、Guardrail 后真正发出的载荷与 route context、预算票据、parent prepare／claim、COMMIT 回执和 driver 回调接入一个**明确生产 factory**，并验证 HTTP generations／edits、已知非 2xx 真实结算及回执不明恢复。跨服务预算与 claim 无同一事务，本轮只证明局部次序，不证明崩溃后的持久补偿。还须验证 claim 后撤权、真实生产者权限与实时漂移、代表性旧库/保留期、真实 origin 容量、Workers／Hyperdrive／Queue 和 DBL-04/05/06/08。C03.4／C03.5／C03.7／C03.G 继续开放，恢复角色 `NOLOGIN`；没有远端 SQL、部署或云资源调用，首轮 staging US$2 上限不重置。
