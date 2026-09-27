# C03 v309：只读观察类型与默认禁用的 Queue 生命周期候选

2026-09-23；**LOCAL CONTRACT PASS，QUEUE CONSUMER NOT DEPLOYABLE，PRODUCTION DISABLED，C03 DOING**。承接 [v308 显式候选采用](./C03-postgres-explicit-candidate-adoption-v308.md)。本轮没有部署、创建 Queue/Hyperdrive、连接远端 PostgreSQL 或调用模型/KMS。

## 实际边界

1. [普通 PostgreSQL recovery owner](../../../../packages/core/src/storage/recovery/postgres-recovery-operation-owner.ts)的返回对象不再含接受调用方任意 SQL 的 `ownedStatement`；四个固定、有界、绑定参数的扫描仍经私有闭包调用它。任意 SQL 探针单独留在**未进入 package exports** 的 `ownPostgresRecoveryOperationsForDiagnostics()`，仅供协议测试。普通 owner 仍携带内部 raw SQL client，**整个 owner 不能作为公开能力**。
2. 新 [package 类型入口](../../../../packages/core/src/storage/recovery/postgres-observation-types.ts)只有 `types` 条件；公开视图仅有同一 `completion` 与只读 `snapshot()`，无 SQL、取消、stop、release、client 或 driver 能力。[观察器](../../../../packages/core/src/storage/recovery/supervise-usage-recovery-postgres.ts)在内部另持有最窄的准入控制接口。TypeScript 负例和 Node 运行时 package export 拒绝均已验证。这**不是**公开可执行恢复 API，不能据此启用驱动。
3. [独立 Queue owner 候选](../../../../packages/proxy/src/runtime/postgres-recovery-queue-owner.ts)未被 Worker 入口、Wrangler、生产构建或 package exports 引用。默认禁用；显式启用时只接受 staging 固定 Queue 的单条无身份 wake，客户端由调用者按 invocation 单独打开，Queue 处理器**主返回 Promise**必须等待原 `run.completion`，观察截止不会替代它。完成后才调用候选退役动作，但结果固定 `physicalClose: not_observed`；`resources=unconfirmed`、保留 hold、执行/退役异常均报告 `outcome_unknown`。本地 `active` 只防同一 isolate 内重入，不是跨 isolate 锁。

**不得直接把该候选接为真实 Queue consumer。** Cloudflare [Queue ACK 规则](https://developers.cloudflare.com/queues/configuration/batching-retries/)规定 handler 正常返回即隐式 ACK；当前 `busy`、`outcome_unknown` 等诊断结果也正常 resolve，直接接线会丢失 wake。仍须先设计持久调度、同事实幂等、未知结果的 ACK/retry/DLQ 策略，并证明不会重发推理。Cloudflare [运行时限制](https://developers.cloudflare.com/workers/platform/limits/)显示 HTTP 断开/响应后的 `waitUntil` 最多延长约 30 秒、Queue 调用墙钟上限 15 分钟；当前同时向 `waitUntil` 登记只是早期归属检查，不是长期运行保证，也不能使卡住的 SQL 结束。

## 本地验证和诚实负例

| 检查 | 结果 |
| --- | --- |
| 普通 owner 运行时不暴露任意 SQL；owner mock | 15/15 PASS |
| 观察器、固定扫描运行级、扫描目录 | 47/47 PASS |
| PGlite 同事实原账务恢复 runner | 31/31 PASS；首轮未设置 `GATEWAY_PGLITE_MODULE` 时 1 项夹具启动失败，按已有本地 ESM 文件设置后重跑通过 |
| 类型-only package export + Node 运行时拒绝；Core/Proxy TypeScript | 1/1 PASS；两项类型检查通过，另有 recovery runner 类型检查通过 |
| Queue 候选故障注入 | 8/8 PASS：禁用/非法 wake/登记失败零 DB、同一 completion、busy、unknown、预算停止、异常遮蔽 |
| 历史 v300 采用回归 | 9/9 PASS |

原[v308 harness](../../../../scripts/db/diag/postgres-candidate-adoption-v308.test.mjs)的第一次源码 pin 检查现按设计失败：`packages/core/package.json` 已新增类型-only 出口，当前 SHA-256 `cc046ecde422957902dcb5a24f45f48d3235916ee4c0042adf3ca0d42efce919`，历史固定值 `b9cbde48c8b70ff1e95db5a9dc772c366c16a218851f5e61b946f9a1ee24fbbb`。**不改写 v308 历史报告，不称其当前复跑通过**。v308 的三份候选 artifact 字节经本轮重新读取仍分别为 ESM `e2e2385dd7543d557d64312be9ef1045cec57a094cfc1aeec882d4c356c25521`、CJS `5d08e70c604566c2d2ed9c84000008c8d13a15a9b04df268c9b3ef218154098b`、CF `5704f05aeb495cf78a97ae7d140d3a980007130736e0c8bc6b77ed90ec47d72d`；但这不等于 v308 全套新源码重新构建验收。[机器摘要](./C03-postgres-observation-queue-owner-v309-results.json)含源文件摘要与验证计数。

## 尚未通过的门禁

DBL-04 尚无真实 Queue/Workflow/fetch 的可靠执行寿命、持久 ACK 策略、跨 isolate 排他、认证/TLS/pooler/Hyperdrive 与原生 PostgreSQL 验收；Windows 本地最小 workerd 仍有此前记录的启动崩溃，未把 dry-run 计作运行。DBL-05 仍未给初始化、本地排队、固定扫描、注册、claim/fail、资金事务和内部 COMMIT/ROLLBACK 配齐服务端时限，`runBudgetMs`/观察截止只阻止新准入。DBL-06 仍无同一物理连接/执行代次的可信清理与解除证据。未知收费政策未决定，跨网络 exactly-once 未承诺。首轮 staging 累计 US$2 上限不重置。

下一有限项先冻结 PostgreSQL 版本与专用恢复身份的服务端时限配置范围，并设计同一绝对截止在本地队列和服务器各阶段的传播；不直接修改共享生产角色或把初始化 `SET` 当作 Hyperdrive 事务池保证。随后做真实 Queue ACK/重试持久化、资源解除及隔离 Workers/Hyperdrive/原生故障矩阵。
