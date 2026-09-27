# C03 v301：有限观察与完整执行拥有权

2026-09-21；**LOCAL PASS / DEFAULT DISABLED / C03 DOING**。上一轮 v300 已修复隔离候选的事务/写异常边界，本轮继续完整数据库生命周期工作，不把整个目标改成“本地测试通过”。

## 交付与证据变化

新增[生命周期合同](../postgres-recovery-lifecycle-contract.md)，将准入、有限观察、本地操作、取消传输、物理关闭、经济回执及逻辑资源释放分开；DBL-01–DBL-08 明确哪些已具备本地证据、哪些仍未实现。

实现入口：[执行句柄](../../../../packages/core/src/storage/recovery/run-usage-recovery-postgres.ts)、[观察器](../../../../packages/core/src/storage/recovery/supervise-usage-recovery-postgres.ts)、[操作拥有者](../../../../packages/core/src/storage/recovery/postgres-recovery-operation-owner.ts)。均为未接入生产导出/调度的内部原型。

恢复执行器现在可返回单次、冻结的执行句柄，观察 SQL / 事务外层 / 回调、尚未释放的 lane 和已知不明 lane；观察器截止只停止新任务，保留同一 completion。旧 async 接口仍等待完整完成，不提前返回，不重试推理、不关闭共享池。快照不携带 SQL/参数/原始错误；最终结果对象与内部状态隔离，调用者不能改写后续快照。

两个显式观察预算都只限制本地观察：截止后的额外观察期不是清理 TTL，不触发取消或返还容量。期限以初始绝对时间为基准，延迟计时器不会续期；完成/截止后取消监听和计时器失效，重复附着被拒绝。没有声称事件循环停顿或 isolate 被终止时仍能按墙钟准时返回。

### 为什么没有直接调用 cancel

安装的 postgres.js 3.4.9 `src/query.js` 的公共 `Query.cancel()` 丢弃内部取消 Promise，返回 null。独立 loopback 探针实证：即便直接观察内部取消传输 Promise，其已完成、取消连接已关闭时，主查询与 owner 仍 pending；随后主查询可正常成功。安装驱动与 v300 ESM/CJS 候选均如此。内部 canceller 只用于诊断，未用于生产接口。

这是**真实驱动 + 合成协议 peer**，没有 PostgreSQL 服务执行 SQL；peer 有意模拟取消无效。它不证明真实服务器取消延迟分布或目标隔离已通过。该观察符合 PostgreSQL 协议：取消没有直接成功响应，必须继续等待主查询，断连也不能保证工作未提交。[官方协议](https://www.postgresql.org/docs/current/protocol-flow.html#PROTOCOL-FLOW-CANCELING-REQUESTS)

### 真实本地 SQL 验证的关键边界

- 扫描观察截止：保留三个逻辑 hold 和 SQL 所有权；迟到扫描结果不注册或认领。
- claim COMMIT ACK 等待：回调已完成、外层事务仍 pending；截止后不开始资金结算，已确认的同一 lease 可 interrupted。
- 已开始资金事务迟到成功：仍写原事实、只扣一次；观察截止快照保持未完成，不被后来结果反写。
- 资金 ACK 丢失：只读确认可以使 committed=1，但资源仍 unconfirmed、一个 hold 保留；后续新一轮不会重复扣费。
- 外层断连拒绝：仍 pending 的 SQL/回调独立计数，观察结束不能释放其 lane，也不授予新的 claim。

PGlite 使用已有本地 0.5.8 / PostgreSQL 18.3 WASM 与既有迁移/proposal；不是原生多会话、WAL、TCP、Hyperdrive 或 Workers 验收。没有更改资金 SQL、migration/proposal、金额算法或 unknown 政策。

## 验证

最终报告目录：`.wrangler/staging/postgres-observation-v301-XruR4e/`，含每组 TAP、Node/Workers 产物及解析元数据。上一轮回归报告：`.wrangler/staging/postgres-lifecycle-v300-run-T8Vm3X/`。

| 验证 | 结果 |
| --- | --- |
| 新观察 harness | **7/7**，20599.4564 ms，含父测试 |
| owner + supervisor + 原资金 SQL | **62/62**，16412.7403 ms；10 owner、21 supervisor、31 SQL（含父测试） |
| 编译 Node 观察入口 | **21/21**，829.977 ms；与源码测试重复，不算新增独立场景 |
| 安装驱动取消探针 | **2/2**，741.6198 ms |
| v300 ESM / CJS 取消探针 | **各 2/2**，718.7443 / 705.9442 ms；与上项是同两种场景 |
| v300 生命周期 harness 回归 | **6/6**，11810.5418 ms |
| v300 ESM / CJS 事务 wire | **各 60/60**，3956.6769 / 3813.4379 ms，仍为 51 种场景 |
| 旧候选同一双反例 | **各 0 PASS / 2 FAIL（预期）**，1432.9379 / 1452.6695 ms |
| 安装驱动断连负例 | **2 PASS / 1 FAIL**，728.8547 ms，空 socket.write 原失败保留 |
| runner/supervisor 定向 TypeScript | 退出 **0** |
| 五个变更 JS 文件语法检查 | **5/5** |
| Node / Workers 隔离模块构建 | PASS；分别解析到 ESM / CF 候选，Workers **未执行** |

相对 v300 的 35 项 owner/runner 基线增加 27 项（owner 1、supervisor 21、SQL 5），加两种取消协议场景，共 29 种新增场景；不把子进程/编译重复和父测试累计成更多独立场景。

前两次完整新 harness（`...-WBKz5N`、`...-zqKa6k`）均 7/7，对应 61 项源码/SQL、20 项编译入口；最终审查增补返回结果隔离及测试后为 62/21。期间没有隐藏新套件失败；已知旧候选和安装驱动真实失败仍保留。前两次目录未删除，最终结果以 XruR4e 为准。

最终隔离产物 SHA-256：

- Node：`685c7764bd78e4a76655f6322d52a0c970b3c063447af9e6ec28ecfeca0b2a14`
- Workers 模块：`c1eef06b66f2cc9b09d3bd06d52623f0f96def3d72f209bbd56295ec7172545b`

v300 七个实现/测试源码摘要全部未变；正式依赖/锁/共享 core dist/生产配置等 13 个保护输入前后相同。本轮没有重跑 v299 实际工厂 60/初始化 7，也没有重新运行完整 Wrangler dry-run；不得把上轮证据冒充本轮结果。[机器摘要](./C03-postgres-recovery-observation-v301-results.json)

复跑：

```powershell
node --test --test-reporter=tap scripts/db/diag/postgres-recovery-observation.test.mjs
node --test --test-reporter=tap scripts/db/diag/postgres-transaction-lifecycle.test.mjs
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.recovery-runner-postgres.json --noEmit
```

第一条需要已有本地 PGlite 文件，或显式 `GATEWAY_PGLITE_MODULE` 指向可用安装；不会下载、启动原生数据库或连接远端。Node 24.14.1、postgres.js 3.4.9、esbuild 0.27.3；Workers 类型使用技能允许的已安装 5.20260829.1 fallback，无新增 Env / binding / 配置。

## 下一项及完整门禁

按合同 DBL-04 优先推进默认禁用候选的**可拥有取消传输结果与目标代次隔离**；再做 DBL-05 全路径服务器执行时限及 DBL-06 可信资源解除。本轮只有有限观察，不是完整 SQL 执行超时；不能让未确认容量无限保留却声称恢复服务已经完成。

原生 v292 系统运行库更新许可仍待用户批准，未重试安装/initdb/远端替代。Workers / Hyperdrive、完整容量、无损日志、最小角色、迁移/保留期及 C01 / C02.G / C03.G 等既有门禁均未通过。新的生产恢复消费者未启用。

按 Workers 最佳实践技能保留异步工作拥有权与独立运行时门禁，未以 Node 或编译代替 Workers。Firecrawl CLI 本轮仍未发现，未重新安装，改读官方公共网页。云管理、远端 SQL、部署、真实模型、KMS、云资源增删、系统更新均 **0**；首轮累计 **US$2** 上限不重置。全部本轮测试进程已结束，完整目标继续。
