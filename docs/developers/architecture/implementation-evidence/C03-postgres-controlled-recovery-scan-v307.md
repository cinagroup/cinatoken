# C03 v307：固定只读恢复扫描的运行级 owner 候选

2026-09-23；**LOCAL CANDIDATE PASS，PRODUCTION DISABLED，C03 DOING**。本轮承接 [v306 本地关停围栏](./C03-postgres-local-shutdown-fence-v306.md)，在默认禁用的 postgres.js 3.4.9 候选上，把**仅两种固定只读恢复扫描**接入同一执行句柄和单次观察器。正式驱动依赖、锁文件、共享 dist、生产配置、公开驱动类型和部署入口均未切换。这里的“通过”只属于本地 Node 模拟及 PGlite 检查，不能等同真实 Workers/Hyperdrive、原生 PostgreSQL 或资金全路径验收。

## 本轮有限接线

[固定 SQL 目录](../../../../packages/core/src/storage/recovery/usage-recovery-jobs-postgres.ts)只接受 `unregistered` 与 `due` 两种非锁定 `SELECT`，分别为 all/tenant 范围固定四段 SQL 字节序列；scope 和 limit 先验证，租户标识通过绑定参数传递。目录不提供任意 SQL、注册、claim、资金写入或事务提交入口。[运行句柄](../../../../packages/core/src/storage/recovery/run-usage-recovery-postgres.ts)只有显式 `ownedScans: true`，且候选驱动的取消标记与新增 `ownedRecoveryScanFence: 'postgres-js-3.4.9-owned-scan-v307'` 同时匹配时才把受控扫描交给 owned-cancel 路径；[owner.ownedRecoveryScan](../../../../packages/core/src/storage/recovery/postgres-recovery-operation-owner.ts)也独立校验新 fence。v306 产物仅有旧标记，不会误入本轮扫描路径。默认路径仍用普通 SQL 和本地 operation owner。旧的仅返回 Promise 的 `runUsageRecoveryPostgres()` 拒绝 owned-scans 选项，避免观察者失去同一次执行的身份。

运行句柄只暴露当前固定扫描的**手动** `cancelActiveScan()`。超时观察器停止新工作准入，不自动发送 Cancel，也不重发扫描或推理。取消句柄的主 SQL、取消传输、包装层关闭、原始传输关闭和主连接关闭观察分别保留；取消失败、句柄畸形或主查询后来成功，均不得仅凭取消请求／观察超时解除不确定 lane 的容量 hold。发现后的 ensure/read、claim 锁、结算和失败写入保持普通 owner／事务路径，并未被改成 owned-cancel SQL。

[低层实验 `ownedStatement(query, params)`](../../../../packages/core/src/storage/recovery/postgres-recovery-operation-owner.ts)仍接受调用者给出的任意 SQL，**没有低层 allowlist**；它只用于协议诊断，不能因运行级固定目录存在就当成通用安全入口。正式采用插件、公开类型和对外调用面的强制封闭仍需另行完成。

## 本地验证及独立负对照

[v307 harness](../../../../scripts/db/diag/postgres-owned-cancellation-v307.test.mjs)的最终运行记录位于 `.wrangler/staging/postgres-owned-cancel-v307-run-oUZ722/results.json`；[持久机器摘要](./C03-postgres-controlled-recovery-scan-v307-results.json)保存检查数量、三个产物 SHA-256、32 个源码摘要和 16 个受保护输入摘要。外层 TAP **39/39 PASS**，其中 36 个记录的子套件均达到各自预期；源码在运行前后及报告复核时无漂移。ESM/CJS/CF 各重复构建两次，产物和 pinned 输入一致；三个产物语法检查与恢复器 TypeScript 检查通过。先前 `vjkvhk` 的 **38/38** 快照已被本次包含 scan fence 的最终运行取代，不作为当前验收结论。

| 检查 | 结果与边界 |
| --- | --- |
| [封闭扫描目录](../../../../packages/core/src/storage/recovery/usage-recovery-jobs-postgres-scan.test.mjs) | **5/5**。固定四段只读 SQL、绑定参数、无效 kind/scope/limit 在 SQL 前拒绝；非扫描 inspect 仍走普通 raw。 |
| [运行级 mock](../../../../packages/core/src/storage/recovery/postgres-recovery-owned-scan.test.mjs) | **21/21**。覆盖默认普通路径、显式候选门禁、仅有旧标记的 run／owner 同步拒绝、单次观察、同步 driver／cancel 异常、畸形取消句柄、非空结果后的普通写路径，以及取消后五类回执与容量保留。 |
| [固定扫描 wire](../../../../packages/core/src/storage/recovery/postgres-recovery-owned-scan.wire.test.mjs) | ESM/CJS/CF **各 4/4**：预派发取消、同一 Query 的取消、取消连接建立失败、观察超时不自动取消／重发。均为 Node 协议夹具；CF 入口由 Node 自定义 socket 注入，并非 workerd。 |
| [重入 wire](../../../../packages/core/src/storage/recovery/postgres-recovery-owned-scan-reentry.wire.test.mjs)与[独立负分支](../../../../packages/core/src/storage/recovery/postgres-recovery-owned-scan-reentry-negative.wire.test.mjs) | 三入口分别 **2/2 + 2/2**。debug/Bind 序列化器重入取消时不写主执行的 Query／Execute 帧；Bind 前的 Parse／Describe 可已携带固定 SQL 文本。Bind 期间重入 `pool.end()`、以及先取消后序列化器抛错，也不写 Execute／普通 Query、不发送取消包，保留不确定扫描 hold。 |
| [真实 v306 旧产物 scan fence](../../../../packages/core/src/storage/recovery/postgres-recovery-owned-scan-old-artifact-gate.test.mjs) | **3/3**：先核验 ESM/CJS/CF 旧产物 SHA，再以当前运行级代码导入旧 driver，`ownedScans: true` 均同步抛 `TypeError`；容量 `tryAcquire`、SQL、socket 均为零。CF 用进程本地 `cloudflare:sockets` hook 阻断网络，仍不是 workerd。 |
| v306 回归 | ESM/CJS owner＋取消各 **37/37**、原生命周期各 **60/60**、legacy cancel 各 **2/2**、局部关停各 **15/15**；CF 合成关闭 **6/6**、池等待队列关闭 **4/4**、局部关停 **15/15**、CF-only **1/1**、进程本地 socket import hook **5/5**。这些不证明真实物理释放。 |
| 既有恢复器／安装驱动 | owner、观察器及资金 SQL **66/66**，其中数据库检查使用本地 PGlite；安装驱动 cancel **2/2**，原安装驱动 onclose 负例仍是预期的 **2 PASS / 1 FAIL**，不能误称现用驱动已修复。v302 历史 harness **3 PASS / 1 SKIP**，v303–v306 各 **0 PASS / 1 SKIP**，是源码漂移后的有意历史跳过。 |

**旧候选重入负对照是 scan fence 加入前的独立历史观察，不属于最终 39/39 harness，也不是当前源码可复跑的失败。** 当时另行核验 [v306 证据](./C03-postgres-local-shutdown-fence-v306-results.json)所记录的 ESM/CJS/CF 产物 SHA 后，以 `--test-name-pattern='^v307 fixed scan:'` 对同一[重入测试](../../../../packages/core/src/storage/recovery/postgres-recovery-owned-scan-reentry.wire.test.mjs)分别运行：三入口均 **0 PASS / 2 FAIL，退出码 1，0 cancelled / 0 skipped**。旧产物的 debug 重入实际返回 `not_exclusive`，Bind 序列化器重入实际返回 `transport_closed`，均与新测试要求的 `not_dispatched` 不符；这是当时两项明确的状态断言失败，不能进一步推断未被该失败后续断言验证的服务端结果。现在当前源码会先因新 scan fence 缺失而同步拒绝旧产物，其结果由上述真实旧产物 **3/3** 门禁验证；不得再把历史 0/2 写成现源码的可复现行为。旧 SHA 为：

| v306 入口 | SHA-256 |
| --- | --- |
| ESM | `575b182b10d18ab47257581728316af17a09cf71b708f46b3198456fb34c62c6` |
| CJS | `dea841c24cd2e95172fd77bf154daee596a5c65690183e55ae987a5fddce5f25` |
| CF | `f3147efd782f73571caa11e433a80ec3d754b5a76565401554301dd63ab30747` |

本轮产物 SHA-256：ESM `e2e2385dd7543d557d64312be9ef1045cec57a094cfc1aeec882d4c356c25521`；CJS `5d08e70c604566c2d2ed9c84000008c8d13a15a9b04df268c9b3ef218154098b`；CF `5704f05aeb495cf78a97ae7d140d3a980007130736e0c8bc6b77ed90ec47d72d`。本次新候选三入口固定扫描 wire 各 **4/4**、重入 wire 各 **2/2**、独立负分支 wire 各 **2/2**。运行：

```powershell
node --test --test-reporter=tap scripts/db/diag/postgres-owned-cancellation-v307.test.mjs
```

脚本依赖已存在的本地 PGlite 缓存 `.wrangler/staging/pg-schema-v250/package/dist/index.js` 或显式提供本地 `GATEWAY_PGLITE_MODULE`，并依赖 v306 持久报告指向的本地 SHA-pinned 旧产物来核验 scan fence。本地运行时为 **Node v24.14.1**；旧 CF 产物的进程本地 hook 使用 `node:module.registerHooks`，**Node 22 备选未验收**。测试的 240 秒父进程、45 秒子进程和 25 秒类型检查预算**不是**生产 SQL 执行时限。

## 仍未闭合的门禁

DBL-04 仅获得默认禁用候选的**运行级固定扫描与有限协议故障**证据，尚不能正式采用。CF bundle 的 Node loopback 和进程本地 `cloudflare:sockets` hook 都不是 Cloudflare workerd／Hyperdrive；本轮真实 Workers、原生 PostgreSQL 多连接/WAL、数据库侧取消和物理连接回执测试均为 **0**。已取消 lane 的 `unconfirmed` 也不是退款、成功结算或可信资源解除。

必须继续封闭低层任意 SQL 入口的采用面与公开类型，验证认证/TLS/pooler、cursor/COPY 等未测 Query 模式和正式生产集成。DBL-05 的初始化、排队、查询、锁等待及事务收尾的服务端执行时限，DBL-06 的同一物理连接／执行代次可信解除，以及资金全路径、C03.G、C01.G、C02.G 均未通过。本轮不决定 unknown 计费、不授权不明推理重发，也不声称跨网络 exactly-once。v292 本机 VC++ 运行库阻碍未变；未安装、重启或重试 initdb。

云管理、远端 SQL、部署、付费模型、KMS、资源增删及系统运行库更新均 **0**；生产保持关闭，首轮 staging 累计费用上限 **US$2** 未重置。
