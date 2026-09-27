# C03 v304：CF 原始 Socket 关闭门禁的本地候选验证

2026-09-23；**LOCAL CF-BUNDLE LOOPBACK PASS / PRODUCTION DISABLED / C03 DOING**。本轮只收紧默认禁用的 postgres.js 3.4.9 实验候选，不代表真实 Cloudflare Workers、Hyperdrive 或原生 PostgreSQL 验收完成。[ADR-0002](../decisions/ADR-0002-request-execution-settlement-states.md) 的不明派发不重放推理、只恢复同一份结算事实、过期执行者隔离，以及交付、上游、记账、资源分别记录的边界不变。

## 问题与候选行为

v303 的 `primaryCloseObserved` 只观察 postgres.js 包装层 `close`。已安装的 CF polyfill 在读错误路径会先合成 `error`、`close`，即使其 `raw.closed` 仍未完成；若此时交还逻辑池槽，后续查询可能在原始 Socket 退役未获确认时开始。这个事件不能充当 DBL-06 资源解除凭据。

[候选构建器](../../../../scripts/db/diag/postgres-owned-cancellation.mjs)现在分别观察主连接 `primaryRawClosed`、辅助 CancelRequest 连接 `transportRawClosed`，并在快照中保留 `primaryRawClose`、`transportRawClose`。在 CF 分支，取消后包装层 `closed()` 捕获旧 `raw`；仅在该 `raw.closed` **fulfilled**、该连接尚未 `terminate()` 且未被移入 `ended` 队列时才调用原池 `onclose`，允许该槽建立新连接。包装层提前合成 `close` 时，若 `raw` 尚未显示关闭则请求 `raw.close()`；该调用本身或包装层事件均不解禁。`raw.closed` 缺失或 rejected 时保持池槽隔离。辅助连接合成关闭时也请求其 `raw.close()` 并独立观察 Promise；若失败发生在 socket 创建之前，两项辅助关闭观察均为 `not_started`，不让 owner 无故永久等待不存在的 socket。[内部 operation owner](../../../../packages/core/src/storage/recovery/postgres-recovery-operation-owner.ts)把主、辅两个原始关闭项分别纳入 `drain()`，但取消 lane 仍粘性返回 `unconfirmed`，即使原始关闭 fulfilled，也不据此判定 SQL 停止、事务未提交、资金可结算或 hold 可释放。Node ESM/CJS 分支无新的池释放语义；缺少原始 Socket Promise 时状态为 `not_observable`。

Cloudflare 的 [TCP Socket API](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)将 `Socket.closed` 定义为关闭时 fulfilled、发生错误时 rejected 的 Promise。这里使用的是这一信号的候选接线；本轮 **没有在 Workers 运行时观察真实 Socket**，也没有证明 Hyperdrive 的端到端资源解除。

## 本地验证与复跑

[v304 harness](../../../../scripts/db/diag/postgres-owned-cancellation-v304.test.mjs) 15/15 通过；完整 TAP 与输入摘要位于 `.wrangler/staging/postgres-owned-cancel-v304-run-sYd6LW/`，[机器摘要](./C03-postgres-cf-raw-close-gate-v304-results.json)保存可长期引用的计数及源码/产物 SHA-256。三入口双构建一致，语法检查 3/3、恢复器 TypeScript 检查通过，16 个受保护的依赖、锁文件、共享 dist、生产配置及安装驱动输入未变。

| 检查 | 结果与含义 |
| --- | --- |
| [CF 合成关闭测试](../../../../packages/core/src/storage/recovery/postgres-owned-cancellation-cf.wire.test.mjs) | **6/6**：已安装 polyfill 可在 `raw.closed` pending 时发合成 `close`；编译后的 CF 候选在 **Node loopback 模拟** 中使新查询等待主 `raw.closed` fulfilled 后换连接，rejected 时继续隔离；辅助 `raw.closed` 的 fulfilled/rejected 均被单独登记并阻止 `drain()` 提前结束；`end()` 后迟到的主关闭不会派发排队 SQL。此测试不运行于 Workers。 |
| ESM / CJS owner + cancel wire | 各 **37/37**；新增无 socket 的取消连接工厂失败时，`transportRawClosed` 为 `not_started` 且 owner 不永久等待，原候选取消协议亦回归。 |
| ESM / CJS 事务生命周期、普通 cancel | 各 **60/60** 和 **2/2**。 |
| owner、supervisor、原资金 SQL | **66/66**；既有本地 PGlite，不是原生 PostgreSQL。 |
| 安装驱动基线 / onclose 负例 | **2/2**；负例 **2 PASS / 1 FAIL** 为预期失败，说明现用驱动的内部空 `socket.write` 未被候选修复。 |
| 历史 v302 / v303 harness | v302 单测 **3 PASS / 1 SKIP**，v303 **0 PASS / 1 SKIP**；源码演进时跳过旧全量证据，保留历史报告而不重标为本轮通过。 |

对 `end()` 与迟到 `raw.closed` 的同一条定向回归，前一版 CF 构建产物（SHA-256 `cdec9368…`）**FAIL**：`end()` 已返回后仍派发排队 SQL；最终构建（`558d1930…`）**PASS**：不再派发。中间构建 `e7abe67d…` 也通过此定向回归，但已被无 socket 修复后的最终构建取代。这是独立的本地 A/B 诊断；最终构建通过项也包含于上述 CF 6/6，不能由此推断所有停机竞态或 Workers 行为已验证。

使用现有本地依赖复跑：

```powershell
node --test --test-reporter=tap scripts/db/diag/postgres-owned-cancellation-v304.test.mjs
```

脚本需要已有 `.wrangler/staging/pg-schema-v250/package/dist/index.js` PGlite 缓存，或 `GATEWAY_PGLITE_MODULE` 指向已有本地模块；不会自动安装或连接远端。测试父级 180 秒、子进程 45 秒及类型检查 25 秒均只是本地验证预算，不是生产 SQL 执行时限。

## 尚未越过的门禁

候选仍为默认禁用，生产工厂、正式依赖/锁文件、共享 dist、采用插件、运行器与观察器接线均未切换；没有受控 SQL allowlist，也没有自动取消或可信 DBL-06 容量解除。**已知存活性缺口**：`end()` 后的排队 Query 在上述回归中既未派发，也未 settle；测试明确观察 `nextSettled === false`，因此不能把“停止派发”写成“优雅停机完成”。下一有限步先解决此排队项在池关闭时的确定拒绝并保留旧候选反例，再仅对固定、只读扫描 SQL 进行运行级拥有权集成和故障注入；财务、claim、commit 及任意 `unsafe` 不应被这个实验入口默许接入。随后还需 DBL-05 全路径服务端时限、Workers/Hyperdrive 真实失败注入、原生 PostgreSQL/WAL、完整资源解除及最小权限/迁移兼容。`raw.closed` fulfilled 只给出底层 Socket 关闭信号，不是取消 ACK、服务端停止、事务未提交或跨网络 exactly-once 的证明。

本轮云管理、远端 SQL、部署、付费模型、KMS、资源增删与系统运行库更新均 **0**；Workers 运行时、Hyperdrive 和原生 PostgreSQL 测试均 **0**。v292 的本机 VC++ 运行库阻碍未变，本轮未安装、重启或重试 initdb。首轮 staging 累计费用上限仍为 **US$2**，不重置。
