# C03 v305：池关闭准入门禁与等待项终结的本地候选验证

2026-09-23；**LOCAL CF-BUNDLE LOOPBACK PASS / PRODUCTION DISABLED / C03 DOING**。本轮延续 [v304 原始 Socket 关闭门禁](./C03-postgres-cf-raw-close-gate-v304.md)，只修改默认禁用、源码及版本摘要固定的 postgres.js 3.4.9 实验候选。它不表示真实 Cloudflare Workers、Hyperdrive、原生 PostgreSQL 或 DBL-04–06 已验收，也不改变 [ADR-0002](../decisions/ADR-0002-request-execution-settlement-states.md) 对不明派发、同事实恢复及资金／资源独立状态的边界。

## 修复范围与语义

v304 已在本地证明，`pool.end()` 后迟到的 `raw.closed` 不再派发排队 SQL；但同一测试也记录了原排队 Query **仍 pending**。本轮的 [候选构建器](../../../../scripts/db/diag/postgres-owned-cancellation.mjs)在调用 `end()` 时、首次异步让出前锁存 `ending`，立即拒绝 postgres.js **池级全局 `queries` 等待队列**；该队列同时含 Query 与等待连接的 `reserve()` 请求。已关闭池上新执行的 lazy Query 和新 `reserve()` 也拒绝，固定为 `CONNECTION_ENDED: Connection ended before dispatch`，不携带地址、端口、原始连接选项、SQL 或凭据。`onopen()` 在关闭期间不再从该队列派发，`onclose()` 将连接移向 ended 而不重连。重复 `end()` 不使等待项重新获得准入。

已派发的主 SQL **没有被这道门禁伪装为已取消或已完成**：可继续完成原 Promise；取消后实验 owner 仍持有同一 Query、辅助取消结果、包装层及原生 Socket 关闭观察，`drain()` 对取消 lane 仍返回 `unconfirmed`。这些变化不代表服务端 SQL 已停止、事务未提交、资金可结算、hold 可释放或底层 socket 已全部关闭。

CF 分支仍区分 postgres.js polyfill 的合成 `close` 与主／辅连接 `raw.closed`。主 `raw.closed` **fulfilled** 才可能解除正常运行中的退役池槽隔离；其 **rejected** 或 **缺失** 均不视为物理关闭回执。池已 `end()` 时，即使迟到 fulfilled，也不重开池槽、不派发旧队列。本轮故障注入覆盖了 pending 后 fulfilled、rejected、缺失，以及辅助连接合成关闭；均为 **Node 中执行 CF 编译产物的 loopback 模拟**，不是 Workers 原生 TCP socket 的观察。Cloudflare [TCP Socket API](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)将 `Socket.closed` 定义为关闭成功时 fulfilled、出错时 rejected；候选仅用它作指定 socket 的关闭信号，不用它证明服务端 SQL 或经济结果。

本次解决的是**全局等待队列**在池关闭时的有限存活性问题。独立负例已证实 `Connection.initial` 存在另一条未闭合竞态：连接工厂尚未交还 socket 时，该连接持有的初始 Query 不在全局队列；调用 `end()` 后放行工厂，初始 SQL 仍可在 `end()` **调用之后、返回的 Promise fulfilled 之前**派发并成功。另一独立负例证实事务本地队列在 `end()` 调用后仍会派发后续 SQL 和 `COMMIT`。第三个独立负例在已取得 reserve 连接的局部队列中，观察到 `end()` Promise fulfilled 后仍有等待 Query 未 settle。三者均不能被上述“全局队列已终结”覆盖。重连计时器尚无完整终结矩阵；对局部队列不声称 `end()` 均能确定 settle 或阻止派发。也未完成受控 SQL allowlist、运行级 `ownedStatement()`／观察器接线、生产采用或公共类型接口。财务、claim、COMMIT 及任意 `unsafe` 查询不能因该候选而自动接入。DBL-05 全路径服务端执行时限和 DBL-06 可信资源解除仍未完成。

## 本地验证

[v305 harness](../../../../scripts/db/diag/postgres-owned-cancellation-v305.test.mjs) **20/20 PASS**；详细 TAP 与输入摘要在 `.wrangler/staging/postgres-owned-cancel-v305-run-KXlxQA/`，[持久机器摘要](./C03-postgres-end-admission-barrier-v305-results.json)记录源码及三入口产物 SHA-256。ESM、CJS、CF 两轮独立构建的产物和输入摘要一致；语法检查 3/3、恢复器 TypeScript 检查通过，16 个受保护依赖、锁文件、共享 dist 与生产配置输入未变。

| 检查 | 结果与证明边界 |
| --- | --- |
| [关闭故障注入](../../../../packages/core/src/storage/recovery/postgres-owned-cancellation-shutdown.wire.test.mjs) | CF **4/4**：池级等待 Query／`reserve()`、关闭后新请求、主 `raw.closed` rejected／缺失均确定拒绝，无迟到 SQL 派发；ESM、CJS、CF 可移植的活跃 SQL／等待队列用例各 **1/1**，证明关闭等待项不直接取消已派发 SQL。 |
| [CF 合成关闭回归](../../../../packages/core/src/storage/recovery/postgres-owned-cancellation-cf.wire.test.mjs) | **6/6**：合成 `close` 不等于主或辅助 `raw.closed`；原主 fulfilled 才能在未关闭的池中重开，rejected 保持隔离；`end()` 后迟到 fulfilled 不派发排队 SQL，等待项现可拒绝。仅 Node loopback。 |
| ESM／CJS owner 与取消协议、事务生命周期、普通 cancel | 各 **37/37**、**60/60**、**2/2**。取消后 owner 的 `unconfirmed` 语义未放宽。 |
| owner／supervisor／既有资金 SQL | **66/66**；依赖已有本地 PGlite，不是原生 PostgreSQL、真实锁等待或 WAL 验收。 |
| 安装驱动基线／onclose 负例 | **2/2**；安装驱动的空 `socket.write` 负例 **2 PASS / 1 FAIL**（预期失败）仍保留，未把新候选误写为现用驱动修复。 |
| 历史 v302／v303／v304 harness | 分别 **3 PASS / 1 SKIP**、**0 PASS / 1 SKIP**、**0 PASS / 1 SKIP**；源码漂移后有意跳过旧全量证据，历史报告保留，不重标成本轮通过。 |

20/20 harness **没有覆盖** `Connection.initial` 连接工厂迟到这一竞态。随后对本轮 CF 产物 SHA-256 `ca3f0ee4be96155d5285b0f7ac3cfe436296b3ff73da726b77f3d4dd6b65d5ef` 进行了独立、只读负例：`beforeSocket` 返回未完成 Promise，初始 `select first` 等待建连；调用 `raw.end()` 后检查查询轨迹为空，再放行工厂。观察到 `BEFORE_RELEASE []`、`QUERY {"ok":true}`、`AFTER_END ["select first"]`，单个定向测试通过。这**证实门禁尚未覆盖 initial**，不是新功能通过，也不推翻上表针对全局队列的 20/20。复现命令仅引用本次 `.wrangler/staging/` 临时构建产物，不能假定该路径长期保留：

```powershell
node --import tsx --input-type=module --test-name-pattern=repro -e 'process.env.GATEWAY_POSTGRES_RECOVERY_DRIVER="C:/cinagroup/cinatoken/.wrangler/staging/postgres-owned-cancel-v302-y3QFEa/postgres-cf.mjs"; const test=(await import("node:test")).default; const {peer,tick,deferred}=await import("./packages/core/src/storage/recovery/postgres-recovery-operation-owner.wire.test.mjs"); test("repro initial socket factory after end",{timeout:5000},async t=>{const gate=deferred(),started=deferred(); const p=await peer(t,{beforeSocket:()=>{started.resolve();return gate.promise;}}); const query=Promise.resolve(p.raw.unsafe("select first")).then(()=>({ok:true}),error=>({ok:false,code:error.code})); await started.promise; const end=p.raw.end(); await tick(); console.log("BEFORE_RELEASE",JSON.stringify(p.queries)); gate.resolve(); console.log("QUERY",JSON.stringify(await query)); await end; console.log("AFTER_END",JSON.stringify(p.queries));});'
```

同一 CF 产物的另一个独立只读诊断使用 `maxPipeline=1`，暂留 `select first` 的 ReadyForQuery：调用 `end()` 前轨迹为 `[begin, select first, select second]`；调用 `end()` 后放行，最终轨迹又加入 `[select third, commit]`，均发生在 `end()` 调用之后、其 Promise fulfilled 之前。这是**事务局部队列**的确定反例，不属于 20/20 harness 所验证的池级全局队列；目前不能据此推断任何资金 SQL 的最终经济结果。

同一 CF 产物的第三个独立诊断先预热连接、取得显式 reserve 句柄，在 `maxPipeline=1` 下让第一条查询等待 ReadyForQuery，同时在该保留连接的本地队列排入第二、第三条。调用池 `end()`，随后释放 reserve 和第一条；等待第一、第二条及 `end()` Promise 均完成后，peer 的 `AFTER_END` 轨迹仍无第三条，而第三条在额外 **100 ms 有界观察**内仍 pending。该证据证明这一路径在 `end()` 已完成时**没有得到确定终结**，不声称它在任意长时间内永久悬挂；仍需持久回归和完整关闭矩阵。

使用现有本地依赖复跑：

```powershell
node --test --test-reporter=tap scripts/db/diag/postgres-owned-cancellation-v305.test.mjs
```

脚本需要已有 `.wrangler/staging/pg-schema-v250/package/dist/index.js` PGlite 缓存，或以 `GATEWAY_PGLITE_MODULE` 指向已有本地模块；不会自动安装、访问远端 SQL 或部署。父级 180 秒、子进程 45 秒及类型检查 25 秒是测试预算，不是生产 SQL 时限。v304 的排队 Promise 悬挂是历史报告中的独立观察；本轮证明该夹具下的终结，不把两版不同 harness 说成完整端到端 A/B。

## 后续门禁及外部边界

继续 DBL-04：先修复已复现的 `Connection.initial` 与事务局部队列在 `end()` 调用后仍派发 SQL，以及 reserve 局部队列在 `end()` 完成后仍有待定 Query，并保留这些负例；再覆盖重连计时器和其余关闭竞态。之后才为**固定、只读扫描 SQL**设计运行级 owned-cancel 入口及单次观察；在此之前不能开放任意 SQL 或生产采用。随后补 DBL-05 全路径服务端时限、DBL-06 同一物理连接／执行代次的可信解除，以及 Workers/Hyperdrive 原生故障注入与 PostgreSQL 多会话／WAL 验收。v292 的本机 VC++ 运行库阻碍未变，本轮未安装、重启或重试 initdb。

本轮云管理、远端 SQL、部署、付费模型、KMS、资源增删及系统运行库更新均 **0**；真实 Workers、Hyperdrive、原生 PostgreSQL 测试均 **0**。生产路径及正式依赖／锁文件／共享 dist 不变，首轮 staging 累计费用上限 **US$2** 不重置。
