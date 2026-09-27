# C03 PostgreSQL 不可变结算输入与原子发现入口（v293）

日期：2026-09-21。状态：**LOCAL_PASS / NATIVE_ACCEPTANCE_PENDING**，仅 C03.1 / C03.3 子集；C03 仍 DOING。依赖已批准的 [ADR-0001](../decisions/ADR-0001-production-financial-authority.md) / [ADR-0002](../decisions/ADR-0002-request-execution-settlement-states.md)，不新增 unknown 收费许可。

## 本轮结果与范围

新增 PostgreSQL 专用、生产未接线的 `persist / load / listForRecovery` 仓储，以及独立 schema proposal。复用现有 V1 Images **最终 request 的结果后结算输入**和 canonical codec，不建立第二套扣账算法。这不是派发前报价、全部 attempt 成本事实、卖家收益事件或最终财务回执；**C04.1–C04.8 不因此勾选**。

- [proposal](../../../../packages/core/migrations-proposals/postgres/request-usage-settlement-facts.sql)：在既有 68 个正式迁移及 dispatch intent proposal 之后，仅向本轮临时库应用；不加入自动迁移目录。
- [仓储](../../../../packages/core/src/storage/recovery/usage-settlement-facts-postgres.ts)：共享 codec 为每次输入复制、限长、验证、规范编码和计算摘要；读取时再验证完整内容。没有 `commit`、lease、完成标记、推理调用或 Queue 客户端。
- [数据库测试](../../../../packages/core/src/storage/recovery/usage-settlement-facts.postgres.test.mjs)与[独立进程 fixture](../../../../packages/core/src/test-support/postgres-settlement-facts-child.mjs)。

所有身份字段均绑定同一 claimed intent：request、attempt、user、API key、workspace、operation、context SHA-256、claim UUID。prepared、expired-before-dispatch 或缺失 intent 不能接受快照。unknown 可以接收同身份的迟到输入，但不会重开 claim、修改 unknown 分类或自行扣账；“可信上游事实”的真实性仍须入口与协议层验证，digest / FK 本身不是授权或签名。

## 原子性与故障边界

| 边界 | 本轮实现 / 实测 |
| --- | --- |
| 内容不可覆盖 | request 唯一；相同内容可确认，不同价格、usage、时间、operation、scope、claim 或 attempt 拒绝覆盖。事实及 outbox 均拒绝 UPDATE / DELETE |
| 快照与可发现性 | 单个 autocommit INSERT 触发 outbox 入队；反向 `DEFERRABLE INITIALLY DEFERRED` FK 要求提交时存在同 request / hash / DB 时间的 outbox |
| 入队报错 | 实际 SQL 触发器故障使两行一起回滚，既有资金表摘要不变 |
| 入队触发器停用 | 显式事务内 INSERT 可暂时成功，但 COMMIT 因反向 FK 失败；没有已提交而不可发现的快照 |
| ACK 丢失 | 不在仓储内重发写入；只精确读回同一事实及 outbox 并验证内容。两者无法确认时返回失败，不冒充接受 |
| ACK 与读回都失败 | 提交的事实仍可由新进程扫描发现；未产生资金日志或预算消费，不授予新的派发权 |
| 多次生产者调用 | PGlite 中 8 次异步提交保留一份事实 / 一份入口；不宣称原生连接并发已验证 |
| schema 阴影 | 三种 search_path 与 public / temp 同名表均不重定向读写；所有业务 relation 完整限定 |

`request_usage_settlement_outbox` 是不可变发现索引，**不是带退避、lease、ack、blocked 状态的完整恢复任务**。扫描按租户 / workspace 限定，每页最多 50 个轻量引用；载入快照才读取 payload。`created_at_ms/request_id` 游标仅用于一次完整扫描内分页，**不能持久化为“已处理高水位”**：事务可见顺序不同于创建时间，时钟也可能回拨。未来消费者必须周期性从头扫描并幂等登记独立任务；增量补投/完成记录尚未实现。

## Unicode 兼容修复与数据库合同

本轮发现真实兼容问题：现有 codec 接受 errorMessage 中的转义 NUL、孤立 surrogate 等 JSON 字符，而对整份 PostgreSQL `json` 使用字段提取会尝试解码非身份字段并报 `22P05`。[PostgreSQL 官方 JSON 文档](https://www.postgresql.org/docs/current/datatype-json.html)说明 JSON 输入验证与后续 Unicode 解码的差别；本地最小探针也确认 `json_typeof` 可通过而 `->>` 报错。

修复不清洗字符、不改写原字节、不放宽 codec：数据库根据列值构造 V1 固定规范前缀/后缀，用 `C` collation 精确比较；中间段必须由 PostgreSQL 解析为**一个完整 JSON object**。因此不能在 params 后注入第二个顶层 intent / claim / version，也不能用嵌套伪字段替代身份。完整原文仍存 TEXT，由数据库对其 UTF-8 字节复算 SHA-256；不转成会改变表示的 jsonb。

这不是另写通用 JSON 解析器；SQL 只固定 V1 外层 framing，内部语法交给 PostgreSQL，完整字段白名单、canonical 字节及金额一致性仍由共享 codec 在写前、读后验证。升级 codec 外层顺序/版本时必须同步 proposal 并迁移，不能静默兼容。数据库直接 INSERT 并不替代应用级完整 DTO 验证。

增强测试覆盖全部 32 个转义控制字符、孤立高/低 surrogate、中文、emoji、字面反斜杠、伪 JSON 字符串，以及重复顶层字段、错误 params 类型、尾随 token / 空白和非规范外层；Images edits 与 attempt=32 的既有 codec 边界也通过。32 只是存储兼容上限，不是新批准的出站次数。

## 验证记录

环境：Windows / Node 24.14.1；PGlite 0.5.8 / PostgreSQL 18.3 WASM；无远程 DATABASE_URL。

| 实际执行 | 结果 |
| --- | --- |
| 新增 facts + outbox suite | **44/44 PASS**，17,237.0988 ms；含父测试计数，0 skip |
| 既有 PostgreSQL dispatch intent + D1 usage settlement 回归 | **86/86 PASS**（49 + 37），48,692.2397 ms；0 skip；D1 结果不计 PostgreSQL 财务验收 |
| `tsconfig.settlement-facts-postgres.json` 类型检查 | PASS，退出 0 |
| v291 / v292 既有源文件摘要 | 分别 5 / 3 个全部未变 |

保留失败历史：首轮 41 项中 39 PASS / 2 FAIL（一个 leaf 和父项），因测试误用已禁止的 User-Agent NUL；改用现有允许的 errorMessage 后同计数再次失败，暴露上述 PostgreSQL 解码问题。修复后 41/41 通过。扩展为 44 项后 43 PASS / 1 FAIL，独立进程验证误把 numeric wire string `'0.000000'` 断言为数字 `0`；只修正 fixture 的显式 text 断言，随后得到上述最终 44/44。没有删掉失败边界或放宽产品校验。

复跑入口：

```powershell
$env:GATEWAY_PGLITE_MODULE = (Resolve-Path '.wrangler/staging/pg-schema-v250/package/dist/index.js').Path
$env:GATEWAY_PG_FINANCIAL_BASELINE = ''
node --import tsx --test --test-concurrency=1 packages/core/src/storage/recovery/usage-settlement-facts.postgres.test.mjs
node --import tsx --test --test-concurrency=1 packages/core/src/storage/recovery/dispatch-intent.postgres.test.mjs packages/core/src/storage/recovery/usage-settlement.d1.test.mjs
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.settlement-facts-postgres.json --noEmit
```

临时独立进程库在两个子进程结束后，仅对经绝对路径/父目录校验的本次 mkdtemp 目录递归清理；测试后对应临时目录为 0。删除的只是可重建测试数据，不涉及用户或 staging 数据。

## 门禁与下一有限步骤

1. ST-06 / ST-07 获得本地部分证据；ST-13 只证明干净进程关闭/磁盘重开后可发现并验证输入，**没有最终财务提交**。PGlite 不是原生多会话、网络 COMMIT、WAL 崩溃或 Workers / Hyperdrive 验收。
2. [v292 原生启动阻塞](./C03-postgres-native-runtime-v292.md)继续保留，系统 VC++ 更新仍待许可；本轮未重跑 initdb、安装运行库或重启。原生业务测试仍 0 项执行。
3. 下一独立本地工作包：恢复任务的引用绑定、有限重试/blocked、lease revision 和过期 fencing 模型；不实现新的 unknown 金额政策、不调用推理。其原生并发验收继续受 v292 门禁约束。
4. 恢复回执与最终权威写事务、全 attempt 报价、owner / grant / policy 关系、生产 factory / driver 接线都未完成。保持 C01.G / C02.G / C03.G 开放，C04 TODO。
5. 最小权限/RLS、DDL/TRUNCATE/停用触发器禁令、归档/删除和旧读者兼容、升级索引/约束的锁影响尚未验证。SECURITY INVOKER 不免除应用角色对两表所需 INSERT 权限测试。拥有运维权限者仍可绕过/删除约束，不能把 immutable trigger 称为防管理员篡改。

本轮按 PostgreSQL 最佳实践落实数据库约束、短写入、租户优先索引；索引计划仅在小 fixture 中验证可用，不宣称容量/延迟指标。Firecrawl 完成前两份公开官方文档抓取；之后本会话找不到命令，JSON 文档用备用只读网页工具查阅，未重装。参考 [SHA-256 二进制函数](https://www.postgresql.org/docs/current/functions-binarystring.html)和[延迟外键约束](https://www.postgresql.org/docs/current/sql-createtable.html)；本地缓存为 `.firecrawl/postgres-binarystring-v293.md`、`.firecrawl/postgres-createtable-v293.md`。

无 Cloudflare/GCP 管理、远端 SQL、部署、付费模型、KMS 或系统更新；既有首轮累计 **US$2 不重置**。完整 checklist 目标仍未完成。[机器摘要](./C03-postgres-settlement-facts-v293-results.json)
