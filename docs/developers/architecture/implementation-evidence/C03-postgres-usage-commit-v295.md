# C03 PostgreSQL 同事实结算回执与最终事务 fence（v295）

日期：2026-09-21。状态：**LOCAL_PASS / NATIVE_ACCEPTANCE_PENDING**；C03 整体继续 DOING，不放行 C01.G / C02.G / C03.G。依据为已批准的 [ADR-0001](../decisions/ADR-0001-production-financial-authority.md) 和 [ADR-0002](../decisions/ADR-0002-request-execution-settlement-states.md)，前置是 v291 intent、v293 不可变事实/outbox 和 v294 jobs/lease。

## 实际交付与范围

- [独立 SQL proposal](../../../../packages/core/migrations-proposals/postgres/request-usage-commit-receipts.sql)：不可变回执、同事实/任务/日志外键、committed 状态、事务内 lease 校验、提交阶段延迟校验，以及 fact-owned 日志的旧写路径防绕过守卫。
- [内部结算仓储](../../../../packages/core/src/storage/recovery/usage-settlement-postgres.ts)：只提交精确引用的既有事实；COMMIT 确认丢失后只读核对，不在同一次调用中重发写事务。
- [事务适配](../../../../packages/core/src/storage/recovery/usage-settlement-transaction-postgres.ts)：在原账务事务内插入回执、最后完成任务；跨 await 前拥有输入，校验完整快照摘要及文本可表示性。
- [既有 PG critical writer](../../../../packages/core/src/db/postgres/critical-writes.impl.ts) 增加可选第三参数。恢复仍执行原买家预算、普通 reservation、Guardrail、日志、attempt availability、统计和审计逻辑，没有新建平行账本或重新查询当前价格。
- [本地测试](../../../../packages/core/src/storage/recovery/usage-settlement.postgres.test.mjs)、[三进程 fixture](../../../../packages/core/src/test-support/postgres-usage-settlement-child.mjs) 和专项类型检查入口。

这是 V1 Images 最终请求事实的内部原型，不是完整报价、每 attempt 成本或卖家入账。生产模块确实新增了适配器 import 和可选分支，不能说“生产源码未修改”；但现有两参数调用不启用新分支，production factory / public export / 路由均未接线。未增加 runner、队列投递、定时器或推理调用。

proposal 须在 68 个正式迁移及前三份 proposal 后，由独立受控事务应用；不在自动迁移目录，不能当作可任意重复执行的迁移。它增加表并替换 jobs 守卫/约束，还在既有日志表加守卫；不声称无升级锁影响或旧读者兼容。未建角色、未授权、未回填账务数据。

## 一个事务中的边界

| 顺序 | 实际行为 |
| --- | --- |
| 事务前 | 读取并解码完整九字段身份绑定的事实/outbox；拥有参数，校验原摘要。已有匹配回执只读确认 |
| 事务开始 | 插入回执时锁定同一 job，锁后读取 DB 实时时钟；校验 token、revision、期限、scope、摘要和原记录时间；已有同 id 旧日志一律拒绝认领 |
| 原账务逻辑 | 复用当前事务的预算、reservation、日志、审计、Guardrail 与统计写入；使用原 recordedAt，不把恢复时间作为使用日期 |
| 最后业务更新 | 同一有效 token/revision 将 job 变为 committed；0 行或过期意味着整个事务失败 |
| 延迟约束验证 | 在默认 COMMIT 阶段再次检查期限，并验证回执、job 和原事实对应的日志结果；即使最后 UPDATE 已执行，事务此时到期也回滚 |
| COMMIT 后 | ACK 丢失只读核对同一回执/结果；连读回也失败则返回不明，后续可只读确认原提交，不重复扣费 |

回执与 job 终态不可通过普通 UPDATE/DELETE 改写；重复 ensure 不重开 committed，旧 proof 的 claim/fail 也不重置它。即使 job 尚未注册，只要已存在 fact，旧无回执日志写路径就会失败并回滚此前预算变更。已有历史日志即使金额一致也不能被新回执“收编”。

保留旧算法的预算 epoch、过期预留及 late adjustment 行为；这只是兼容既有代码，**不是批准 unknown 按预留上限收费**。当前 API Key workspace 与历史事实不一致时拒绝，不擅自决定 C01.4 的撤权/迁移语义。

### 时间与信任限制

内部 writer 保持约束 deferred 到 COMMIT，不向恢复调用者暴露任意 SQL 回调或 `SET CONSTRAINTS`。这里证明的是数据库验证点和同事务提交，不是“WAL 刷盘或 ACK 必须发生在墙钟 TTL 之前”。有效提交后 ACK 传输到达较晚，不撤销已提交结果。

精确读回校验了回执、事实、job、日志身份、历史日期、模型/供应商、状态、主要金额和 token 数；其余资金/Guardrail/审计/统计原子性由复用的事务及故障回滚测试证明。它不是能抵抗任意高权限 SQL 篡改所有账表的独立审计证明。原始 SQL 授权、最小权限、DDL/TRUNCATE/停用触发器防护尚未验收。

## 发现并保留的兼容边界

1. 首次测试发现 `1.0000025` 的差异：原 JS 算法得到 `1.000002`，直接 PG numeric 舍入得到 `1.000003`。新增的 verification-only SQL 函数镜像现有 JS 的二进制缩放/舍入及安全整数钳制，不修改历史收费。7000 多个去重边界/随机样本逐个与实际 `roundGatewayMoney`、`guardrailBudgetUnits` 对照通过；这是有界测试，不是全部 IEEE-754 值证明。
2. v293 快照能保留 JSON 转义的原始 NUL/孤立 UTF-16 代理字符，但它们解码后不能无损写入现有 PG text 日志列。本原型在财务 BEGIN 前拒绝，原事实完整保留；没有替换、裁剪或新公共 API 限制。合法 Unicode 配对及 JSON 字符串里的双重转义内容通过。**完整日志无损表示/读取兼容仍是启用前缺口**。
3. 回执与日志的外键影响归档/删除，后写日志字段也可能改变精确读回结果；保留期、迟到元数据更新、旧读者及在线迁移必须单独验收。测试确认修改已提交金额后返回冲突，绝不因此再次扣费。

## 本轮验证

Windows / Node 24.14.1；本地 PGlite 0.5.8 / PostgreSQL 18.3 WASM，68 个正式迁移和四份 proposal。均为合成身份和本地临时数据库。

| 执行 | 结果 |
| --- | --- |
| 首版新增 suite | 38 项：35 PASS / 3 FAIL，17,438.5591 ms；含失败父测试 |
| 修复后的 suite | 39/39 PASS，18,066.1462 ms |
| 增补重复调用、九字段引用、缺 schema、三进程重开 | 44/44 PASS，27,147.9124 ms |
| 最终同源码 suite，含 committed 终态不可重开 | **44/44 PASS**，33,788.0291 ms，0 skip，含父测试 |
| 既有 PG 财务 + jobs + facts 回归 | **164/164 PASS**（77 + 43 + 44），65,874.4516 ms，0 skip，含父测试 |
| settlement 与 recovery-jobs 专项类型检查 | 两项均退出 0 |

首版失败保留：一个 BYOK fixture 未提供既有 generation metadata 四字段组合；另一个为上述真实舍入差异，第三项是父测试失败。未删除问题用例或更改费用以让它通过。

新增测试覆盖十个已执行写入后的故障点（receipt/users/普通 reservation/log/attempt/stats/audit/Guardrail reservation/window/job）、COMMIT 前失败、ACK/读回丢失、事务内到期、最后 job 更新后到期、旧 epoch、旧日志、完整身份不符、输入拥有权、缺 schema、三种 search_path 阴影与回执不可变性。

三进程依次：① 保存原事实/outbox 和普通预留；② 新进程发现、注册、认领，提交原账务后模拟 ACK 与确认读同时丢失；③ 再次重开，仅从 DB 发现引用并只读确认已有提交。未在进程间传递原请求、金额参数或 lease proof；最终一个回执/日志/审计，原预算扣减 0.25、预留清零、历史统计日期不变，不重新认领推理。

PGlite 会串行执行事务，八个同时调用测试不等于原生独立连接竞争。ACK 故障来自适配层注入，三进程重开是正常关闭，不是网络 COMMIT 代理、突然崩溃/断电或 WAL 验收。ST-08–ST-11 / ST-13 增加了本地子集证据，不把整个 ST 项标为生产通过。原生业务测试本轮仍 **0** 项执行。

复跑：

```powershell
$env:GATEWAY_PGLITE_MODULE = (Resolve-Path '.wrangler/staging/pg-schema-v250/package/dist/index.js').Path
$env:GATEWAY_PG_FINANCIAL_BASELINE = ''
node --import tsx --test --test-concurrency=1 packages/core/src/storage/recovery/usage-settlement.postgres.test.mjs
node --import tsx --test --test-concurrency=1 packages/core/src/storage/postgres-financial-schema-engine.test.mjs packages/core/src/storage/recovery/usage-recovery-jobs.postgres.test.mjs packages/core/src/storage/recovery/usage-settlement-facts.postgres.test.mjs
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.settlement-postgres.json --noEmit
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.recovery-jobs-postgres.json --noEmit
```

v291/v292/v293 的 5/3/5 个源文件摘要未变。v294 五个文件中四个未变，jobs TS 有意增加 committed 解码；旧摘要不被改写，变化与当前八项产物摘要见[机器记录](./C03-postgres-usage-commit-v295-results.json)。既有 critical writer 的其他工作区改动保留。

三进程测试只在确认子进程结束并核实绝对路径/父目录后清理本次 mkdtemp 数据库；不明时保留。相应 settlement/jobs 临时目录剩余均 0。移除的是可重建合成 fixture，没有用户或 staging 数据。

## 下一有限步骤与未关闭门禁

1. 本地设计并验证有界恢复执行器的 admission、在途 DB 操作所有权、停止/超时和固定错误分类；不得仅用 Promise.race 宣称数据库操作结束，不调用推理，不自动接生产。
2. 原生 PostgreSQL 多会话、锁等待和真实连接故障仍优先验收；[v292 Windows 运行库阻塞](./C03-postgres-native-runtime-v292.md)及更新许可未解决，不重复 initdb，不安装系统运行库、不改连远端。原生通过后仍需 Workers/Hyperdrive 目标验收。
3. 无损日志表示、最小权限、迁移/保留期兼容、容量与公平调度、永久失败人工恢复继续开放；当前仓储方法不能冒充有界生产消费者。
4. C01.4–C01.10 未决项、完整报价/全部 attempt 成本/卖家入账与 C04 后续范围不因本轮而获批。

PostgreSQL 最佳实践技能影响了短事务、锁顺序、约束与权限边界记录；复用缓存的官方时钟/锁语义资料，本轮无新网络查询。无云管理、远端 SQL、部署、模型、KMS、系统更新或重启；首轮累计 **US$2 上限不重置**。完整 checklist 目标仍未完成。
