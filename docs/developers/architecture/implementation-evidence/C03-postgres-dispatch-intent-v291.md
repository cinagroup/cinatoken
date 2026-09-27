# C03 v291：PostgreSQL dispatch intent 本地实现

2026-09-21，Checklist v1.188。**C03 DOING；C03.1 / C03.3 的 Images dispatch intent 子集 LOCAL_PASS；整项和 C03.G 不勾选。** 实现依据是已批准的 [ADR-0001](../decisions/ADR-0001-production-financial-authority.md) / [ADR-0002](../decisions/ADR-0002-request-execution-settlement-states.md)，不是新增收费或派发授权。

## 产物与边界

- [PostgreSQL 草案 DDL](../../../../packages/core/migrations-proposals/postgres/request-dispatch-intents.sql)：独立于自动迁移目录；在 68 个既有迁移后的本地库应用。14 列，仅保存执行身份、摘要、状态、revision、claim 与时间，不存凭据、请求正文或金额。
- [独立仓储](../../../../packages/core/src/storage/recovery/dispatch-intent-postgres.ts)：prepare、inspect、claim、有界过期扫描及 classifyOverdue。没有生产 factory / 包入口接线，也没有 provider I/O、后台重试或资金写入；不支持其他数据库回退。
- [引擎测试](../../../../packages/core/src/storage/recovery/dispatch-intent.postgres.test.mjs)、[独立进程 fixture](../../../../packages/core/src/test-support/postgres-dispatch-intent-child.mjs)、[专项类型配置](../../../../packages/core/tsconfig.dispatch-intent-postgres.json)。[机器摘要](./C03-postgres-dispatch-intent-v291-results.json)记录本轮结果与五个新增代码文件摘要，不冒充完整发布冻结。

复用既有 Images 身份类型（仅 type import，无 D1 运行时依赖）：request / attempt、user / key / workspace、operation、context digest。全局 request+attempt 主键阻止同一尝试覆盖其他身份；所有仓储读写均匹配完整身份。claim 唯一，状态单向，身份和 deadline 不可变，revision 每次加一。创建时校验并锁定真实 API key 的 user/workspace 关联；这是**创建时的身份快照**，不代表当前成员、撤权或完整 dispatch 授权。

沿用当前原型 ID 上限 200、attempt 语法范围 1–32、扫描最多 50 项；32 不是允许发送 32 次，现有 request 出站基线仍为 3。这里只限于两个 Images operation，不宣布 C01.9 / C01.10 首发范围和参数已冻结。

## 时间、认领和索引

claim 的短事务先以完整身份 `SELECT … FOR UPDATE`，取得锁后再 UPDATE；触发器现场取 `clock_timestamp()`、检查到期并写时间。只有事务提交确认返回后才给 grant；UPDATE 返回行不等于提交成功。数据库时钟小于已有更新时间则拒绝该次变化，不人为延长 deadline。

这一选择基于官方的[当前时间语义](https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT)：事务开始时间在事务内固定，而实时钟可在语句执行中变化；[行锁语义](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS)说明冲突锁会等待，并一般保持至事务结束。本地测试另将触发器临时改成事务开始时间作为反例，真实延迟跨过 deadline 后出现错误 grant；还原正确函数后相应场景拒绝。反例只修改测试自有内存库，源文件与草案没有切换为错误实现。

prepare 确认丢失可读回完全一致的身份和 deadline；返回已有行仍无发送权。claim 任意事务异常一律返回不明错误，不读回重授、不自动重试；过期分类只改变执行元数据，不决定收费、退款或资源释放。一个延迟的成功 ACK 不能保证真正出站仍在 deadline 内，未来 dispatcher 仍须检查总时限、当前授权与 request 级 unknown 禁止重发条件。

按 PostgreSQL 最佳实践技能采用数据库约束、短事务和部分索引：`(user_id, workspace_id, expires_at_ms, request_id, attempt_index)` 只收录 prepared/claimed，避免终态持续膨胀待恢复索引；本地 EXPLAIN 证明可使用该索引满足范围与顺序，**不是规模或吞吐基准**。所有表显式绑定 `cinatoken_gateway`；触发器是 SECURITY INVOKER、固定 search_path，并撤销 PUBLIC 的函数执行权限。

## 实际验证

环境：Node 24.14.1；本机既有 PGlite 0.5.8 / PostgreSQL 18.3 WASM。直接运行测试，不读取 `.env`，不访问远端数据库。

| 组别 | 结果 | 主要覆盖 / 限制 |
| --- | --- | --- |
| 新增 PostgreSQL dispatch intent | 49 / 49，19,666.9338 ms | 包含一个父测试；ST-01–03 的本地子集、确认丢失、过期、身份冻结、影子表、索引、独立进程重开 |
| 既有 D1 dispatch intent | 19 / 19，7,276.4659 ms | 本地 SQLite 回归，不是原生 D1 |
| 既有 PostgreSQL 财务 schema | 77 / 77，16,760.426 ms | 含父测试；既有财务 SQL 回归，不是新恢复/收费规则验收 |
| 专项 TypeScript | exit 0 | `tsconfig.dispatch-intent-postgres.json` |

首轮新增测试为 45 PASS / 2 FAIL（一个错误叶断言连带父测试失败）：误将 14 列写成 15 列。已改正断言，并新增时钟反例和精确整数解码检查；49/49 通过后，最终复核补齐包含终态记录的 user 外键索引，再复跑为上述 49/49。不隐去首轮失败，也不将既有 96 个回归计作新增覆盖。

可复跑命令（PowerShell，项目根目录）：

```powershell
$env:GATEWAY_PGLITE_MODULE = (Resolve-Path '.wrangler/staging/pg-schema-v250/package/dist/index.js').Path
$env:GATEWAY_PG_FINANCIAL_BASELINE = ''
node --import tsx --test --test-concurrency=1 packages/core/src/storage/recovery/dispatch-intent.postgres.test.mjs
node --import tsx --test --test-concurrency=1 packages/core/src/storage/recovery/dispatch-intent.d1.test.mjs
node --import tsx --test --test-concurrency=1 packages/core/src/storage/postgres-financial-schema-engine.test.mjs
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.dispatch-intent-postgres.json --noEmit
```

## 未通过的门禁

1. PGlite 串行化事务；Promise 并发不等于独立原生连接。锁后延迟是合成插入，不是第二连接真实锁等待；子进程为提交确认丢失后干净关闭/磁盘重开，不是强杀、主机故障或原生 WAL 耐久性证明。ST-01–03 **未整体验收**。
2. 没有 PostgreSQL wire / Hyperdrive / Workers 目标运行时、角色/RLS、原生 statement/lock timeout 或客户端断开验收。创建触发器中的 key 行锁所需权限必须在 C03.5 明确并实测；不能只凭 SECURITY INVOKER 就宣布最小权限通过。
3. proposal 的 RESTRICT 外键会影响旧 key / workspace / user 删除路径，保留/删除协议、在线索引与升级锁影响待 C03.7 验证。本轮没有部署角色；不存在“应用不能绕过 DELETE/TRUNCATE/DDL”的已验证结论。
4. 没有 request 级耐久 unknown gate、跨 attempt 预算、完整 credential/policy/quote 关联、不可变结算快照/任务/回执或过期恢复 lease。单个 attempt 的仓储不能被直接用作完整派发服务。
5. C01.4–C01.10 其他未决项仍开放；特别是不因现有财务回归中的旧 forfeit 行为而批准 unknown 按预留上限收费。C01.G / C02.G / C03.G 未通过，C02 云端阻塞与累计 US$2 不变。

## 下一有限步骤

先补原生 PostgreSQL 多会话认领、锁等待跨到期和提交/连接故障的隔离验收入口，确认本机是否有可用的隔离数据库；不默认连接环境中的 DATABASE_URL，不自动操作远端或新增云资源。之后扩展不可变结算事实与恢复数据模型，仍不接未批准的授权/收费规则。

本轮公开文档抓取 2 次（Firecrawl）；Cloudflare/GCP 管理调用、远端 SQL、部署、模型/KMS 调用均为 0。仅清理测试自行创建、绝对路径校验后的临时数据库目录；未删除用户文件或 staging 现场。完整 C00–C20 目标不变。
