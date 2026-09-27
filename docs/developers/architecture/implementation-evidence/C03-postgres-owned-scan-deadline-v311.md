# C03 v311：同一截止的 owner 准入与固定扫描末次派发门禁

2026-09-23；**LOCAL FIXED-SCAN ADMISSION PASS，SERVER TIMEOUT NOT IMPLEMENTED，PRODUCTION DISABLED，C03 DOING**。承接 [v310 初始化前单调截止](./C03-postgres-preinit-deadline-v310.md)。本轮只改默认禁用的恢复 owner 和独立 postgres.js 3.4.9 候选构建；没有连接远端数据库、创建角色或 Hyperdrive、部署或启用 Queue 消费者。

## 本地切片

[恢复操作 owner](../../../../packages/core/src/storage/recovery/postgres-recovery-operation-owner.ts)现在接受 v310 创建的**同一**不可续期截止。普通 lazy `unsafe()` 在实际消费时检查，本地事务在调用底层 `begin()` 前检查；时钟无效、耗尽或剩余不足 1 ms 均拒绝新的调用，不把它当作驱动已失败或服务器已执行。已开始的 SQL／事务仍由原 completion 和 lane drain 拥有，不因截止释放 hold。`runUsageRecoveryPostgres()` 将同一对象传给每条 lane；未提供截止的旧路径不变。

显式 `ownedScans: true` 且带截止时，运行器在容量、SQL 和 socket 创建前要求新 `ownedRecoveryDeadlineFence` 标记；旧 v307 候选不能假装具有最后派发门禁。只有封闭目录生成的 `unregistered`／`due` 两种固定只读扫描（各 all／tenant）通过 `{ owned_cancel: true, admission_deadline: deadline }` 把**同一对象**交给 [v311 独立候选](../../../../scripts/db/diag/postgres-owned-scan-deadline.mjs)。候选在构造好执行帧后、首次写出前复查；需先 Describe 的参数查询在 Bind／Execute 写出前再次复查。带截止的扫描在检查后同栈写出，避免小报文 `setImmediate` 延迟绕过门禁；检查期间同步重入的取消和池关停仍须先于写出。过期本地拒绝不能被理解为取消已派发 SQL，驱动退役观察亦不是可信物理关闭回执。

Describe 之前的 Parse／Describe **可能已经发送**；在此之后截止只保证受控测试路径不再写出 Bind／Execute，不能声称零协议字节或服务端完全未见 SQL 文本。候选的本地拒绝仍归原 Query/owner 处理；已派发工作不被追溯取消。普通注册、读回、claim/fail、资金事务及驱动内部 BEGIN/COMMIT/ROLLBACK 目前只有 owner 调用边界的准入检查，**没有**同等的最终派发门禁或服务端超时保证。

## 本地验证

| 验证 | 结果 |
| --- | --- |
| owner、v310 deadline、固定扫描 mock | **47/47 PASS**；含 lazy 消费时过期、事务开始前过期、时钟无效、旧 v307 能力拒绝及同一对象传递；已启动 SQL 到期仍等待原 completion |
| v311 ESM/CJS/CF 独立候选 | 各 **13/13** 定向 Node loopback wire；冷连接、池排队、debug/serializer、Describe 后到期、时钟抛错、同步取消／池关停重入（含 Describe 后重入）、CF 底层关闭观察、已派发 Query 不追溯取消；双次构建摘要一致 |
| 旧 v307 固定扫描与重入在 v311 产物上 | ESM/CJS/CF 各 **6/6 PASS**；无截止路径保留旧语义 |
| PGlite 原资金事实、jobs 与 runner | **162/162 PASS**。首轮未设置现有本地 `GATEWAY_PGLITE_MODULE` 时夹具 0/7；设置已有 `.wrangler/staging/pg-schema-v250/package/dist/index.js` 后完整重跑通过；不把首轮失败隐藏为通过 |
| 原 v300 采用回归 | **9/9 PASS**；默认禁用 core/proxy 构建字节不变，离线 Wrangler dry-run 仅是打包证据 |
| Core recovery runner、Proxy TypeScript | 均 PASS |

候选专项首轮曾因 CF Node 夹具没有注入 socket 而在业务帧前失败；随后修正了把已发送 Parse 误当成违规的断言，以及把合成 close 误当作 `raw.closed` 的夹具假设。最终 13/13 按“允许已有 Parse／Describe、禁止到期后的 Bind／Execute”复验；这些首轮失败不计作通过。

本地 loopback 包含 CF **编译产物在 Node 注入 socket**，不等于 workerd 或 Hyperdrive。现有 v308 历史全量 harness 的源码 SHA pin 已受 v309/v310 后续改动影响，本轮不冒称复跑通过。v311 候选尚未纳入正式依赖或采用插件，生产默认仍关闭。

## 仍开放的门禁

这只是 DBL-05 的**本地准入子集**。服务器端需要确认目标 PostgreSQL 17+、独立最小权限 recovery 角色的固定 `transaction_timeout`／`statement_timeout`／`lock_timeout`／`idle_in_transaction_session_timeout` 后备上限及 origin 总连接余量；当前 quickstart 是 PG16，生产版本与余量未核实。事务内 `SET LOCAL transaction_timeout` 不能缩短该事务开始时已确定的截止；Hyperdrive 的事务池不能依赖会话级 `SET` 保留。逐路径最终派发、锁等待、资金事务、ACK 不明、可信资源解除（DBL-06）、真实 Queue ACK/retry/DLQ、原生多会话和 Workers/Hyperdrive 验收仍未完成。C03.G 不勾选，C01.G/C02.G 也不放行。

没有云端 API、远端 SQL、部署、模型或 KMS 调用；首轮 staging 累计 US$2 上限不重置。[机器摘要](./C03-postgres-owned-scan-deadline-v311-results.json)记录本轮测试与源码摘要。
