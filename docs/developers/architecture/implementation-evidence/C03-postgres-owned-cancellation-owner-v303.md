# C03 v303：实验 owner 接入可拥有取消，不释放不明容量

2026-09-23；**LOCAL CANDIDATE PASS / DEFAULT DISABLED / C03 DOING**。本轮仅推进 DBL-04 的本地应用拥有权，不代表恢复运行、物理资源解除或生产验收完成。C01.3 的 [ADR-0002](../decisions/ADR-0002-request-execution-settlement-states.md) 技术边界不变：不明派发不重发推理，只恢复同一份结算事实；客户端交付、上游结果、资金和资源状态分别记录。

## 本轮实现

[内部 operation owner](../../../../packages/core/src/storage/recovery/postgres-recovery-operation-owner.ts)新增显式 `ownedStatement(sql, params)`，在创建查询前验证 pinned 实验驱动标记，不支持的现用驱动在派发前拒绝。该入口保留原 Query；`completion` 和缓存的 `cancel()` 句柄指向同一次执行，不重新发起 SQL。主 SQL、取消结果、辅助取消连接 `close`、原主连接 `close` 分别登记为有限计数。`drain()` 等待已登记项，取消后一律粘性 `unconfirmed`；close 事件或主 SQL 成功均不释放该 lane。

[隔离构建器](../../../../scripts/db/diag/postgres-owned-cancellation.mjs)在原 v302 句柄中增加 `primaryCloseObserved`，同时继续保留 `result`、`transportClosed` 和冻结快照。三入口仍由 postgres.js 3.4.9 的九份源码摘要及 esbuild 0.27.3 约束，只构建到本地 `.wrangler/staging`。`ownedStatement()` 是内部、默认不用的实验入口；**没有运行时 SQL allowlist**，也没有通过任意 SQL/COPY 或公开驱动类型验收。[生产工厂](../../../../packages/core/src/storage/drizzle/client-postgres.ts)仍用正式安装驱动，[采用插件](../../../../scripts/db/diag/postgres-candidate-adoption.mjs)仍选 v300；运行器及观察器没有调用新入口。

## 验证与可复跑证据

使用真实 Node postgres.js 候选及有界 loopback 合成协议 peer；peer 不执行真实 SQL。新增五种 owner wire 场景：主查询先成功但辅助连接未关、取消写失败后辅助关闭仍挂起、派发前本地取消、重复取消仅一份句柄/包、以及主查询和辅助连接结束后原主 close 仍挂起。另有四项 owner 单测覆盖驱动前置拒绝、独立 pending、取消失败和 `drain()` 期间新登记；原三项 wire 基线在跨文件运行中重复，不能算新场景。

| 验证 | 结果 |
| --- | --- |
| [v303 本地 harness](../../../../scripts/db/diag/postgres-owned-cancellation-v303.test.mjs) | **13/13** |
| ESM / CJS 的 owner + 取消 wire | **各 36/36**，含新 owner 五项和跨文件重复基线 |
| ESM / CJS 既有事务生命周期 | **各 60/60** |
| ESM / CJS 普通 cancel 旧语义 | **各 2/2** |
| owner、观察器及原资金 SQL | **66/66**，其中 owner 单测 14 项；使用已有本地 PGlite，不是原生 PostgreSQL |
| 现用驱动取消基线 / onclose 负例 | **2/2**；**2 PASS / 1 FAIL，预期失败**，仍是内部空 socket.write |
| 历史 v302 脚本 | 三项单位测试通过；全量历史证据因源码有意演进而显式 **skip 1**，不冒充本轮通过 |
| 类型、语法、构建 | 恢复器 TypeScript 通过；ESM/CJS/CF 三入口语法通过，双构建产物和输入摘要一致；CF 未执行 |
| 保护输入 | 原 v302 的 16 个依赖/锁文件/共享 dist/生产配置/安装驱动输入摘要未变 |

完整 TAP 与构建输入见 `.wrangler/staging/postgres-owned-cancel-v303-run-2A3Ut5/`；[机器摘要](./C03-postgres-owned-cancellation-owner-v303-results.json)记录源文件及三入口摘要。可用现有本地依赖复跑：

```powershell
node --test --test-reporter=tap scripts/db/diag/postgres-owned-cancellation-v303.test.mjs
```

脚本使用现有 `.wrangler/staging/pg-schema-v250/package/dist/index.js` PGlite 缓存；没有缓存时可由 `GATEWAY_PGLITE_MODULE` 指向已有本地模块，不会自动安装或连远端。父级 150 秒、子进程 45 秒、类型检查 25 秒是本地验收预算，**不是生产 SQL 时限**。初次单跑旧 v302 全量脚本时触发其历史源摘要断言；现已在源漂移时明确跳过该历史全量步骤，并由独立 v303 harness 覆盖本轮，不修改 v302 历史报告。

## 未越过的门禁

`primaryCloseObserved` 仅是驱动 close 事件。Workers 的 postgres.js CF polyfill 在 error 路径可合成 close，`destroy()` 也不交还底层 close Promise；当前候选的 `onclose` 路径可能在物理退役未证实时重新开放逻辑池槽。因此 Node loopback 的 close 观察既不是 Workers 物理关闭凭据，也不能用于 DBL-06 可信容量解除。取消连接的 `transport_closed` 同样不是取消包发送 ACK，更不是服务端停止或未提交证明。[Cloudflare Workers 异步生命周期](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)、[PostgreSQL 取消协议](https://www.postgresql.org/docs/current/protocol-flow.html#PROTOCOL-FLOW-CANCELING-REQUESTS)

运行级恢复/观察器接线、受控 SQL 范围与公共类型、服务器执行时限、Workers/Hyperdrive 故障注入、原生 PostgreSQL/WAL、可信隔离和解除、无损日志、最小权限及迁移兼容均未验收。下一有限步先封闭 DBL-04 的运行级触发与 Workers 原始 socket 退役证据，再推进 DBL-05 全路径服务端时限和 DBL-06 资源解除；观察截止不得释放 hold 或重发推理。v292 本机 VC++ 运行库升级许可仍未取得，本轮不安装、不重启、不重试原生 initdb。云管理、远端 SQL、部署、模型、KMS、资源增删和系统更新均 **0**；首轮 staging 累计 **US$2** 不重置。完整目标仍在进行。
