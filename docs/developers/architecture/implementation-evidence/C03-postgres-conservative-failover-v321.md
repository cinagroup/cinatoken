# C03 v321：保守单 claim 模式的本地 failover 边界

2026-09-24；**本地 opt-in 候选 PASS，生产禁用，C03 DOING**。承接 [v320 数据库提案复核](./C03-postgres-claim-auth-request-gate-hardening-v320.md)。v320 的部分唯一索引若将来用于 Images，首个已授权上游请求返回明确非 2xx 时，现有普通 failover 会继续选择下一 route；等第二个 claim 被索引拒绝才停，会丢失首个响应及其 route/usage 的结算机会。仅把内存派发次数改为 1 也可能生成下一 route 的合成错误。此次只增加未接线的本地选项，不连接 PostgreSQL、D1 或生产入口。

[failover 层](../../../../packages/proxy/src/services/failover-dispatch.ts)新增 `stopAfterFirstGrantedDispatch`。启用必须同时提供 delegated `beforeUpstreamDispatch` 回调；缺一则在派发前抛 `TypeError`。回调成功后，若上游返回已知非 2xx，直接返回**同一** `Response`、`chosenRoute`、`usagePromise` 和 `upstreamRequestId`，只设置 `failoverForbidden=true`，不因为保守模式把已知结果标成 `upstreamOutcomeUnknown`。已 grant 后抛出的已知失败也停止候选链；grant 之前的本地准备失败仍可选择后续 route。选项省略时沿用原 failover 行为。

[定向测试](../../../../packages/proxy/src/services/failover-dispatch.test.ts)新增五项 opt-in 用例，覆盖原响应/事实保留、默认行为、首个 grant 前的局部失败后继续、grant 后抛错停止，以及缺少 delegated grant 时零派发拒绝；整份测试 **59/59 PASS**。现有 TypeScript 编译器直接执行 `tsc -p packages/proxy/tsconfig.dispatch-safety.json --noEmit` 通过。受限环境中的 `pnpm -C ...` 包装命令因无法读取本机 auth 配置且请求交互式依赖清理而中止；未依赖该包装命令的结果。源码摘要与边界见[机器摘要](./C03-postgres-conservative-failover-v321-results.json)。

该选项只相信调用者回调的成功返回，**没有生成或验证持久 claim**。调用者仍须确保它代表已提交的单请求授权，且经过审计的 driver 在唯一一次 fetch 前紧邻调用回调；本轮没有证明一次 grant 最多一次 fetch、COMMIT ACK 丢失时零 fetch或跨进程请求级 deadline/预算。Proxy 仍未处理 PostgreSQL 的 `PostgresDispatchClaimUncertainError`；已知非 2xx 的真实 Images 结算、unknown 公开响应、生产者身份、origin 容量及 Workers/Hyperdrive/Queue 均待验收。C03.5、C03.G 和生产启用门禁保持开放。
