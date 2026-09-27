# C03 PostgreSQL 恢复执行器与真实驱动断连反例（v296）

日期：2026-09-21。状态：**LOCAL_SQL_PASS / DRIVER_WIRE_FAIL / ACTIVATION_BLOCKED**。本轮有实现进展和改变下一步的失败证据，但不是可启用的完整执行器；C03 DOING，全部发布门禁保持开放。

前置：[v295 原账务事务/回执/fence](./C03-postgres-usage-commit-v295.md)、[ADR-0002 技术边界](../decisions/ADR-0002-request-execution-settlement-states.md)。没有改变 unknown 收费、预算算法或 Images 成功点。

## 交付的禁用原型

- [runUsageRecoveryPostgres](../../../../packages/core/src/storage/recovery/run-usage-recovery-postgres.ts)：一轮最多 50 项缺失任务注册、50 项候选消费，至多 4 个消费者；分别预留扫描列表与消费者的逻辑容量。所有参数显式提供，不把合成测试字节数当成 Workers 内存配置。
- [操作所有者](../../../../packages/core/src/storage/recovery/postgres-recovery-operation-owner.ts)：在调用驱动前登记 statement、事务外层和事务回调；lazy unsafe/values 只执行一次，停止后不提前释放已经发出的工作。
- [SQL 执行器测试](../../../../packages/core/src/storage/recovery/usage-recovery.postgres.test.mjs)、[所有者单元测试](../../../../packages/core/src/storage/recovery/postgres-recovery-operation-owner.test.mjs)及[真实驱动 loopback 用例](../../../../packages/core/src/storage/recovery/postgres-recovery-operation-owner.wire.test.mjs)。最后一组有明确失败，未 skip/todo 或删掉。

注册使用无高水位的 bounded anti-join，第一份引用列表使用完后清空，再扫描 due 候选；队列/周期调度未增加。调用者的 options/scope 在跨 await 前复制。预取消、无容量或只有扫描容量时不访问数据库；部分容量按实际取得的消费者数运行。

`runBudgetMs` **只限制新工作准入**，不是 SQL 执行、事务、回调或整个函数的完成时限。时钟无效、回退到上次观测之前、AbortSignal 或预算到期锁存停止状态。已确认认领但未开始结算可按同一有效 lease 记录 interrupted；已经开始的合法结算可继续完成，取消不会撤销其成功。

## 账务与资源分开处理

| 观察 | 原型处理及证据范围 |
| --- | --- |
| 原事实/结算提交确认成功，所有登记 DB 操作成功终结 | 可以报告 committed，并返还相应逻辑容量；不代表物理内存或跨实例容量验收 |
| 事务/SQL 返回拒绝，后来回执读回确认 committed | 可确认经济结果，但资源保持 unconfirmed，不因后来的 SELECT 覆盖前一个操作的不明状态 |
| claim ACK 不明 | 不授予 proof、不开始推理或结算、不在本轮重新认领；停止新候选准入 |
| 前一事务可能仍运行 | 不另写 fail 更新与它竞争；保留 lease 等期限恢复，计数不是退款或所有权证明 |
| 一个消费者失败，另一个仍未结束 | 等待已开始的消费者和可观测回调；不把第一个拒绝当成全部完成 |
| 无损日志表示不支持 NUL/孤立代理字符 | 保留原事实，使用固定 settlement_conflict 进入 blocked；不是把有效快照谎报为损坏，也不裁剪内容 |

普通驱动拒绝一律保守记为 unconfirmed，不凭 SQLSTATE 或异常文本当作远端取消 ACK。对应逻辑容量不返还；该原型尚无可信清理回执或人工解除接口。这是当前明确的可用性限制，**不是生产“永久占用就是恢复完成”的方案**。服务器自身时限、可信终结证据、容量解除与公平调度仍待实现/验收。

jobs 只导出已有 scope 拥有函数供复用，SQL/proposal 未修改。v295 文本不可表示异常由 TypeError 改成已有 SettlementConflictError，便于固定原因阻断；金额及持久快照不变。没有接入 production factory/public export/Proxy 路由，没有关闭或取消调用者共享连接池。

## 真实驱动失败：禁止启用

本机安装的 postgres.js **3.4.9** `src/index.js` 中，`begin()` 使用 `Promise.race([scope(connection, fn), onclose rejection])`。连接关闭可以先使外层拒绝，`fn` 仍在等待应用回调。原型因此把回调单独登记，并在外层失去所有权后阻止回调再发 SQL。

但这还不够：回调结束/拒绝后，驱动自己的 `scope()` 仍可能尝试 rollback；`src/connection.js` 的 `closed()` 已把 socket 清成 null，随后排队的 `nextWrite()` 调用 `socket.write()`，loopback 实测出现：

```text
TypeError: Cannot read properties of null (reading 'write')
    at Immediate.nextWrite (.../postgres/src/connection.js:255:22)
```

测试已确认外层 begin 拒绝时回调尚未结束、owner 等待回调、回调的业务 SQL 未再次发出；但驱动内部收尾仍产生异常，**整个用例 FAIL**，不能把前半段断言通过说成生命周期通过。增加两个事件循环轮次，使内部收尾先于测试专属客户端 teardown，仍出现同一错误；不把它归咎于测试主动过早关闭共享池。

这证明当前组合不满足可启用条件，尚不是对所有配置/运行时的普遍根因证明。尤其尚无 Workers、Hyperdrive、原生 PostgreSQL 多会话、实际 COMMIT 网络中断或服务端取消证据。这里使用真实 Node postgres.js 与本机有界协议 peer；peer **不执行 SQL，不是 PostgreSQL 服务**。它不能替代 [v292 原生验收](./C03-postgres-native-runtime-v292.md)。

初版协议 peer 仅支持简单查询，事务收尾使用扩展协议，造成额外的 fixture 失败；补齐 Parse/Describe/Bind/Execute/Sync 后，正常事务与 ReadyForQuery 用例通过，断连反例仍失败。没有修改 node_modules、升级依赖、拦截未捕获异常来伪造通过，或把失败测试标记为预期成功。

## 验证记录

Node 24.14.1、PGlite 0.5.8 / PostgreSQL 18.3 WASM、68 个正式迁移加四份既有 proposal；合成身份、本地临时数据库及 127.0.0.1 协议夹具。

| 执行 | 结果 |
| --- | --- |
| 初版 unit + SQL suite | 30 项，27 PASS / 3 FAIL，8,368.1547 ms；三项是 assert.rejects 不接受 thenable 对象的测试写法 |
| 修复测试并增补并行/回调/耗尽边界 | **35/35 PASS**，14,797.9699 ms；unit 9，SQL suite 26（含父测试） |
| 首版真实驱动 peer | 3 项，1 PASS / 2 FAIL，798.8478 ms |
| 补扩展协议后 | 3 项，2 PASS / 1 FAIL，779.1084 ms |
| 最终 wire，分离 teardown 调度后 | **2 PASS / 1 FAIL**，813.7801 ms；失败保留为启用门禁 |
| 既有 PG 财务/jobs/facts/commit 回归 | **208/208 PASS**（77 + 43 + 44 + 44），89,680.4483 ms，0 skip |
| recovery-runner / settlement 专项类型检查 | 两项退出 0；初版 TS7034/TS7005 的候选数组类型错误已修复 |

SQL 测试覆盖补建/有界分页、一次原金额提交、scope/输入拥有权、预取消/零容量、扫描中止、认领后中止、时钟回退、准入超时、固定错误分类、五次耗尽、claim/注册/资金 ACK 丢失、消费者故障隔离、回调迟到、事务后续确认与三种阴影 schema。PGlite 串行事务，不能声称验证了真实多连接行锁竞争。

复跑（最后一条当前预期仍实际报 FAIL，**不是通过标准**）：

```powershell
$env:GATEWAY_PGLITE_MODULE = (Resolve-Path '.wrangler/staging/pg-schema-v250/package/dist/index.js').Path
$env:GATEWAY_PG_FINANCIAL_BASELINE = ''
node --import tsx --test --test-concurrency=1 packages/core/src/storage/recovery/postgres-recovery-operation-owner.test.mjs packages/core/src/storage/recovery/usage-recovery.postgres.test.mjs
node --import tsx --test --test-concurrency=1 packages/core/src/storage/recovery/usage-settlement.postgres.test.mjs packages/core/src/storage/recovery/usage-recovery-jobs.postgres.test.mjs packages/core/src/storage/recovery/usage-settlement-facts.postgres.test.mjs packages/core/src/storage/postgres-financial-schema-engine.test.mjs
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.recovery-runner-postgres.json --noEmit
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.settlement-postgres.json --noEmit
node --import tsx --test packages/core/src/storage/recovery/postgres-recovery-operation-owner.wire.test.mjs
```

v295 八项产物中六项摘要未变，jobs scope 导出及文本异常分类两处有意修改；本轮八项产物和读取的两项驱动源码摘要见[机器记录](./C03-postgres-recovery-runner-v296-results.json)。既有其他工作区改动保留。回归产生的可重建 settlement/jobs 临时目录已清理，剩余均 0；没有用户或 staging 数据删除。

## 下一有限步骤

1. **优先修复/替换失败的事务收尾边界，再扩大恢复功能。** 从当前真实驱动反例出发，审计显式连接所有权、断连后内部 SQL、异常/回滚和归还语义；任何应用适配或依赖变更都必须令相同 wire 场景真正通过。不修改 vendor 文件、关闭共享池或隐藏失败来绕过。
2. 随后验证 DB 原生执行时限、可信终结与 unconfirmed 容量解除；当前 runBudget 不能冒充完整执行时限。再推进调度、公平性、监控和人工恢复。
3. Windows 原生初始化仍因 v292 阻塞而未复跑，系统运行库更新许可仍未取得。原生业务用例本轮 0 项执行；不自动切换远端或新建资源。
4. 无损日志表示、最小权限、在线迁移/保留期、C01 未决财务/授权政策与 C04 后续范围仍未完成；ST-12 只有部分本地证据，明确不通过。

PostgreSQL 最佳实践技能指导事务范围与连接所有权审计；真实驱动失败决定了暂停启用新路径，不是技能要求暂停整个目标。无新公网查询、云管理、远端 SQL、部署、模型、KMS、系统更新或重启；首轮累计 **US$2 不重置**。完整目标继续，不能标记完成或因本次可继续修复的故障标记整个目标 blocked。
