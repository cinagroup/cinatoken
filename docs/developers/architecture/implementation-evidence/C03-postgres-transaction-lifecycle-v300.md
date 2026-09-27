# C03 v300：正常事务封闭与写异常隔离

2026-09-21；**LOCAL CANDIDATE / NODE WIRE PASS；默认禁用；C03 DOING**。

承接 [v299 实际构建入口](./C03-postgres-candidate-adoption-v299.md)，本轮补全该轮指定的正常事务结束后遗留句柄及同步 socket.write 异常边界。C01.3 技术合同不变：不明状态不授予新的推理发送许可；账务和资源确认独立。没有启用生产恢复消费者，也没有决定 unknown 费用。

## 1. 三项已复现的问题

1. **正常完成的 tx 未封闭**：v298/v299 仅在断连时退役旧 begin。将正常 COMMIT 后保存的 tx 用在后续活跃事务，`unsafe` 实际 fulfilled，旧 SQL 进入同一物理连接的新事务。最终双分支负对照均复现，不依赖伪造 driver。
2. **写异常可能重复字节**：真实 Node socket 自定义包装先接受原字节再同步抛错；`execute()` 的 catch 尝试 `write(Sync)`，而 `chunk` 仍包含原 SQL。计数观察到 **2 次尝试、2 次接受**。这是受控故障注入证明的重发路径，不代表已发生真实资金事故。
3. **仅设置不可写标志不足以隔离池**：第一版 v300 已阻止再写，但 deferred flush 异常发生前，连接已经位于 busy 队列。暂停 destroy 的实际 close 后，新 root query 被挑到该连接并提前拒绝。为该 promise 及时附上观察者后，旧候选仍失败；补池队列隔离后通过。迟到 ReadyForQuery / drain 不能让该连接重新开放。

## 2. 修复边界

`scripts/db/diag/postgres-transaction-retirement.mjs` 增加两组原始源码摘要限定的转换。原默认 `buildRetirementCandidates()` 仍生成相同 v298 字节，用于长期负对照；显式 `{ lifecycle: 'completed', writeFailure: 'retire' }` 才生成 v300。`postgresCandidateAdoption()` 仅在显式 enabled 时选择 v300；默认仍返回空插件列表。

### 正常作用域结束

- 每个 begin / savepoint 回调具有独立的封闭状态，并检查祖先回调是否仍有效。
- 回调（含返回的 query 数组 / Promise）完成后先封闭业务 SQL，再使用独立内部控制通路执行合法 COMMIT / ROLLBACK / PREPARE；内部收尾仍受断连退役及祖先作用域约束。
- 旧 unsafe、先前创建的 lazy Query、tagged SQL、savepoint 和 prepare 被拒绝为 `TRANSACTION_ENDED`，不能污染新事务。
- detached 子回调在父级完成后不能继续发 SQL，也不能通过迟到 ROLLBACK TO 触及后续事务。它自身仍须结束；封闭不是取消其所有异步工作。

### 同步写异常

- 调用 socket.write **之前**移出并清空待写 buffer / timer。抛错后不通过 Sync 或已排程 flush 重发原字节。
- 错误被记录为该物理连接的不可写状态，连接立即从可调度队列移入 full 隔离队列；拒绝 active / sent / initial 工作，禁止新 execute / write、迟到 data / drain 再开放。
- 只请求销毁该故障连接，不关闭共享 pool。只有实际 close 后创建新 socket，才清除该连接的不可写状态；从未发送的池排队工作可在新连接执行。
- destroy 同步抛错不会被解释成关闭成功：连接仍隔离。CF polyfill 的异步 close / error 行为没有在本轮运行时验收，不把此 try/catch 当作完整清理协议。
- owner 的结果继续为 `unconfirmed`。驱动错误、socket destroy、同池后来查询成功都**不是服务器 SQL 已停止或应用容量可返还的证明**。

## 3. 验收范围与结果

新增 28 种场景：15 种作用域完成场景及 13 种写异常 / 恢复场景。四个文件合跑含原三项基线的重复执行，**60 个测试项、51 种场景**，不是 60 种独立场景。

| 验证 | 结果 | 层次 |
| --- | --- | --- |
| v300 生命周期 harness | **6/6**，12799.5163 ms | 含父级；三分支双构建哈希一致、原始源码 pin、非法组合拒绝 |
| Node ESM / CJS wire | **各 60/60**，4276.1619 / 4122.9445 ms | 真实 postgres.js + loopback 协议夹具，不执行 SQL |
| 同一套反例跑旧候选 | **各 0 PASS / 2 FAIL（预期）**，1558.6397 / 1573.7026 ms | 旧句柄误入和失败字节重发均保留 |
| 实际应用工厂 / session 初始化 | **60/60**，9047.3673 ms | 每个 peer 确认准确的 SET 和独立 initialization trace |
| 初始化错误 / 断连 / 成功关闭 | **7/7**，5177.0839 ms | database/context/worker 工厂在 Node 上运行，不是 Worker isolate |
| 应用采用 harness | **9/9**，21143.5151 ms | Node 默认字节一致、fresh-core 两阶段、Drizzle 间接入口、完整 Wrangler dry-run |
| v298 原回归 harness | **5/5**，6191.4577 ms | ESM/CJS 各 26/26；hook-only 双分支预期失败；原候选摘要未变 |
| owner + PGlite runner | **35/35**，14897.0066 ms | 不替代原生并发 / WAL / pooler |
| 定向 runner TypeScript、7 个 JS 语法检查 | **PASS** | 未宣称仓库整体类型检查通过 |
| 未修改安装驱动 | **2 PASS / 1 FAIL**，732.0361 ms | 原 `nextWrite` 空 socket 异常仍在，正式依赖没有被悄悄替换 |

写异常测试覆盖：接受前 / 接受后抛错，立即写 / 延迟 flush，BEGIN 不授予 callback，内部 COMMIT / ROLLBACK 不串入新连接，本地事务队列拒绝，暂停实际 close 时迟到 ReadyForQuery / drain 不复用，以及普通参数校验错误仍可在原连接恢复。合法返回 query 数组、正常 savepoint 和 rollback 后父级继续也通过。

## 4. 失败过程完整记录

- 最初两项反例为 0/2（2295.0317 ms），其中只有旧句柄反例有效；写异常测试把 owner 的 thenable 直接传给 `assert.rejects`，在真正发 SQL 前失败。改为 `Promise.resolve` 后重跑写异常，**0/1（1083.2456 ms）**，确认两次实际 write 接受。
- 第一版 v300（`postgres-lifecycle-v300-completed-retire-ZznUzB`）先通过 51/51（3578.6569 ms），但尚不包含后加的实际 close 暂停用例，不能算最终验收。
- 扩展写故障套件该版为 **15 PASS / 1 FAIL（1108.835 ms）**。测试对后续 root promise 的拒绝观察太晚，出现 unhandledRejection；及时观察后，旧版仍 **0/1（838.6966 ms）**，明确证实连接仍位于可选 busy 队列，而不是只消除测试告警。补池隔离后该文件 **16/16（1212.3579 ms）**。
- 首轮新 harness `postgres-lifecycle-v300-run-YmiojY` 为 **3 PASS / 3 FAIL（11961.8023 ms，含父级）**：ESM/CJS 正向各 60/60 已通过，负对照验证器错误地向 `assert.rejects` 返回 async Promise。已改为先 await 捕获失败 / 保存 TAP，再同步检查退出码、用例数和两个具体断言。最终 `...-yyrp3S` 6/6；原负对照 TAP 和失败目录未删除。
- 夹具另修正 `ROLLBACK TO` 仍在事务中的状态建模；不是更改业务数据库语义。

## 5. 产物、可复跑入口

[机器摘要](./C03-postgres-transaction-lifecycle-v300-results.json)。完整报告：

- `.wrangler/staging/postgres-lifecycle-v300-run-yyrp3S/results.json`：双分支正 / 负 TAP、候选与重复构建信息。
- `.wrangler/staging/postgres-adoption-v300-0JNH3d/results.json`：实际工厂 TAP、Node 输入摘要 / metadata、完整 Worker 产物及离线 CLI 输出。

| 最终产物 | SHA-256 |
| --- | --- |
| Node ESM driver | `11d254010752b959949f3c3848962f045d3f12a1dd3fe18a8bacf1dcaf2802a5` |
| Node CJS driver | `b0e352ca72d7a4d53653882a0de1d7fcd7184236c5f80858b8f9802b528576f8` |
| CF driver | `24b86aa39e3400b64c4c07b14d957b549513307c933f2968980251f033b703f9` |
| 实际 core enabled | `e9c3335691482fc14961c51b8490848c53103dc2144966f67aa0ad79619e1f02` |
| Node proxy + fresh scratch core | `c673deb429601a5f3611899bfedf51ba8c454a79c24012a39bd035f0e7a4d85b` |
| 完整 Wrangler Worker | `9ffcf044fca494cf7523bfaff6aa4f2d185889a28479a1b8d44293d538c5ac6a` |

core baseline/disabled 仍为 `8db61255…dfabe`，proxy 默认/旧配置 oracle 仍为 `b3d9e0c5…03825`，与 v299 相同。Workers 完整产物含生成路径，不声称不同 scratch 目录下其字节相同。

```powershell
node --test --test-reporter=tap scripts/db/diag/postgres-transaction-lifecycle.test.mjs
node --test --test-reporter=tap scripts/db/diag/postgres-candidate-adoption.test.mjs
node --test --test-reporter=tap scripts/db/diag/postgres-transaction-retirement.test.mjs
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.recovery-runner-postgres.json --noEmit
```

版本保持 Node 24.14.1、postgres.js 3.4.9、esbuild 0.27.3、Wrangler 4.127.1；读取安装 Workers types 5.20260829.1 作为技能允许的类型核验 fallback。无新增 Env / binding / runtime API。本轮依照 Workers / Wrangler 技能执行一次无绑定离线 dry-run；[官方文档](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy)的 dry-run 语义不能替代 [Workers 内测试](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。Firecrawl CLI 检查仍不可用，未重装；改用官方网页读取。Node v24 docs 获取失败不当作依据，行为结论来自安装源码与实际 Node 24 协议测试。

## 6. 下一有限工作包与不变门禁

下一项转到 **C03 完整数据库操作的执行 / 取消 / 关闭所有权与时限合同**：区分 admission 停止、已发送 SQL、取消请求、实际关闭与资源确认，先用有限故障矩阵验证；不得用超时 Promise、destroy 请求或 pool 复用伪造释放证明。

本补丁仍不是通用 postgres.js 完整支持证明：手工事务控制 SQL、COPY/cursor/reserve、真实认证 / TLS、CF 异步 socket polyfill 以及网络 / 服务端取消竞态须各自验证。尤其暂停 close 的测试保留了应用 owner 的 unconfirmed，未实现应用级资源回收。原生 PostgreSQL 运行库更新许可、Workers / Hyperdrive 运行时、无损日志、最小角色、迁移 / 保留期、未决 C01 政策及 C02.G 隔离条件继续开放。新的生产恢复路径保持关闭。

本轮正式依赖、锁文件、共享 dist、生产配置未修改；云管理 API、远端 SQL、部署、真实模型 / KMS、云资源增删均 **0**。首轮累计 **US$2** 上限不重置。全部进程已结束；失败目录与证据保留。
