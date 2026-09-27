# PostgreSQL schema 限定与 Hyperdrive 验收边界

版本：C02 v256，2026-09-16；本地分阶段实现，尚未完成 Hyperdrive 验收。

## 当前实现

业务数据固定属于 `cinatoken_gateway`，与现有迁移一致，不由请求、租户输入或连接串动态选择 schema。

- `storage/drizzle/schema.pg.ts` 的全部 46 个导出表使用 `pgSchema(...).table`。包括未列入 `pgCoreSchema` 聚合对象的表；字段、约束、索引和表名不变。
- `db/postgres/user-budget-reservations.impl.ts` 的全部 9 处原始 SQL 显式限定 `users`、`api_keys`、`user_budget_reservations`。只改变表的定位，预留、派发、释放、过期、幂等读回及金额算法不变。
- v251 继续限定结算事务 2 处、Guardrail 预算仓储 20 处及工作区预算 PostgreSQL 分支 9 处 SQL；不改 D1/MySQL 分支。实际结算的 `CASE` 两个金额分支补 `::bigint`，修复全 unknown 参数被解析为 text 后写入 bigint 失败；普通实际费用与 BYOK 标准费用的选择、微金额和舍入规则不变。
- v252 限定推理密钥仓储的管理/用量/删除 SQL 22 处，以及独立 Management API key PostgreSQL 分支 15 处。包含 owner/工作区关联、审计事务和删除保护子查询；鉴权条件、密钥哈希、事务范围及 D1/MySQL 分支不变。
- v253 限定组织身份投影 9 处、默认工作区事务 17 处和共享访问查询 7 处既有表位置。共享模板按内部固定方言选择 schema，D1/MySQL 七条生成 SQL 与参数保持一致。引擎另发现 PostgreSQL 账户默认 Guardrail 创建缺少有效 user/subject 关联；补一个限定 schema 的 users JOIN，阻止被拒绝 principal 的创建副作用，与其他创建语句及 D1/MySQL 对齐。
- v254 限定管理工作区生命周期及私有 PostgreSQL 鉴权谓词 28 处、管理成员列表/增删 PostgreSQL 分支 23 处表位置。事务、绑定、权限规则和 D1/MySQL 不变；静态合同同时排除在其他方言分支引入 PostgreSQL 前缀。
- v255 限定 BYOK PostgreSQL 分支/owner 谓词 45 处、用户硬删除与默认 Guardrail 保护 2 处；D1/MySQL 不变。引擎确认 BYOK 创建的 provider 参数类型冲突，增加一个 `::text` 固定推断，修复 42P08；不改过滤、权限、排序或费用算法。
- v256 修复三方言满额删除后的 BYOK 槽位复用：仅当尾部序号耗尽且 live 数不足 100 时，保持原顺序压紧并追加。压紧、新增及审计同一事务；PostgreSQL 新增 3 处限定 UPDATE、移除 1 处 MAX 子查询，BYOK 静态表位置现为 47。MySQL 四条管理写路径同时补齐 JOIN/WHERE 重复 ID 的缺失绑定，鉴权谓词不放宽。详见 [槽位复用证据](../architecture/implementation-evidence/C02-byok-slot-reuse-v256.md)；原生三引擎与并发验收仍待完成。
- v256 还修复 D1 在 batch 内密钥到期造成的“写入成功但无审计/返回失败”，以及零写入伪审计。首条实际写入仍做完整当前有效期鉴权，后续仅凭同一原子 batch 紧邻 DML 的实际 changes 继续；不缓存授权或放宽账户/工作区/状态检查。此为 D1 授权完成边界的显式变化，非仅 schema 限定；真实 D1 平台仍待验证。
- 新增迁移 `0068_function_schema_resolution.sql`，为现有 10 个 gateway 函数设置 `pg_catalog, cinatoken_gateway, pg_temp`。保留函数体、OID、owner、ACL 和 invoker/definer 模式；尤其保留 retention 的 PUBLIC EXECUTE 撤销。由迁移账号执行，不授予运行时迁移权限，不改写旧迁移。`pg_temp` 必须显式置后，否则临时表可能隐式优先于 gateway 表。[PostgreSQL 函数安全解析](https://www.postgresql.org/docs/current/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY)、[CASE 类型解析](https://www.postgresql.org/docs/current/typeconv-union-case.html)
- 初始化的 startup 设置和显式 `SET search_path` 暂时保留，以维持未迁移原始 SQL 的直连兼容行为。它不是 Hyperdrive 修复保证，也不能因 ORM 已限定就删除。
- 不添加运行时 SQL 正则改写器，不把整个推理请求包入长事务，不新增不确定业务写入重试。除 v256 跨方言槽位/绑定修复外，schema 限定不改 D1/MySQL；历史迁移和运行时配置未修改，新增迁移尚未部署。

Hyperdrive 使用事务池，后端连接归还时会重置设置；客户端 `max: 1` 不能使一次性 `SET` 对后续查询持续生效。显式限定表名避免这部分表定位依赖会话状态，但不解决其他 session 设置或服务端函数解析问题。[Cloudflare 池化语义](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/#pooling-mode)、[Drizzle schemas](https://orm.drizzle.team/docs/schemas)、[PostgreSQL schemas](https://www.postgresql.org/docs/current/ddl-schemas.html)

## 本地验证能证明什么

v250 的 47 项合同测试覆盖所有表的 CRUD SQL 生成、外键目标及自连接的两个物理表位置。独立 PGlite 0.5.8（PostgreSQL 18.3/WASM）测试在同名 `public` 表和 `search_path=public` / `pg_catalog` 下执行生成的 SQL：46 项 ORM 子测试和 22 项预算子测试，加两个父测试共 70 项。预算测试实际应用迁移 0040，覆盖事务回滚、合成提交 ACK 丢失后的只读确认、禁止第二次事务、缺表不回落至 public。[PGlite 本地内存引擎](https://pglite.dev/docs/)

v251 新增 4 项静态合同和 77 项财务引擎测试（76 个子测试、1 个父测试）。财务引擎顺序应用 0001–0068 全部 SQL 文件，真实执行 Drizzle 生成 SQL、原始 SQL 和 PL/pgSQL。对照表同时存在于 public/临时 schema，并有主键、唯一索引及不同数据；逐项核对 18 张同名表完全未变。搜索路径分别为 `public, pg_temp`、`pg_catalog`、`pg_temp, public`。覆盖多范围预留/续租/释放/过期、实际与保守结算、BYOK、重复请求、事务末尾失败回滚、缺表失败关闭、工作区 CRUD/用量与账号范围、账务触发器；函数 catalog 核对全部 10 项配置。详细证据见 [v251](../architecture/implementation-evidence/C02-postgres-financial-schema-v251.md)。

这不是 Hyperdrive、多连接池、postgres.js 网络协议、TLS、真实 ACK 丢失、并发锁等待、真实生产角色或 Workers 原生容量证明。v250 ORM 使用最小合成表；v251 财务测试虽执行全套迁移 SQL，但未验证实际迁移 CLI、升级已有生产数据或角色权限。仓储通过窄适配层提交 SQL 给引擎；没有将 PGlite 加入产品依赖或部署包。

v252 新增 118 项鉴权/管理 SQL 引擎检查（117 子测试 + 1 父测试）和 2 项静态合同。扩展到 22 张 public/临时同名表，验证账户隔离、成员状态、凭证类型分离、明文迁移、用量/限额查询、删除保护及真实审计失败回滚。仍非并发撤销或 Hyperdrive 证明，详见 [v252](../architecture/implementation-evidence/C02-postgres-auth-schema-v252.md)。

v253 投影引擎 70/70（69 子测试 + 1 父测试）、静态/方言合同 5/5。24 张 public/临时同名表，覆盖事件收件记录与投影原子性、乱序/墓碑、默认资源创建、访问偏好和无效身份零写入。同测试源码的旧模块为 6 PASS / 64 FAIL；只修 schema 为 54 PASS / 16 FAIL，暴露上述身份副作用。详见 [v253](../architecture/implementation-evidence/C02-postgres-projection-schema-v253.md)。

v254 管理工作区/成员引擎 100/100（99 子测试 + 1 父测试）、静态合同 2/2；覆盖账户边界、默认资源/墓碑、成员角色、活跃密钥保护及末尾审计失败真实回滚。24 张同名表逐项保持不变，不证明并发删除/撤销。中间补丁应用和夹具失败保留，详见 [v254](../architecture/implementation-evidence/C02-postgres-management-schema-v254.md)。

v255 BYOK/用户引擎 109/109（108 子测试 + 1 父测试）、静态合同 2/2。25 张同名表下，最终同源码旧模块 18 PASS / 91 FAIL，只修 schema 96 PASS / 13 FAIL，最终全部通过；并不覆盖门户入口重新授权、真实解密/KMS 或并发语义。独立探针另确认满槽删除非尾项后无法补回凭证的 OPEN 缺陷，不能把本轮通过扩大成 BYOK 全流程验收，详见 [v255](../architecture/implementation-evidence/C02-postgres-byok-schema-v255.md)。

v250 普通合同纳入 core 的 `test:unit` 主命令；v251–v255 静态合同接入 `posttest:unit`，可单独运行 `test:postgres-financial-schema` / `test:postgres-auth-schema` / `test:postgres-projection-schema` / `test:postgres-management-schema` / `test:postgres-byok-schema`。六组引擎测试接入 `test:postgres-schema-engine`，需要显式指定本地 PGlite ESM 文件，而非数据库 URL：

```powershell
$env:GATEWAY_PGLITE_MODULE = 'C:/cinagroup/cinatoken/.wrangler/staging/pg-schema-v250/package/dist/index.js'
npm run test:postgres-schema-engine -w @octafuse/core
```

v256 在该入口追加 BYOK 槽位的 SQLite/PostgreSQL 引擎测试，并提供 `test:byok-slots` 同时运行槽位、MySQL 合同与 D1 到期/零写入测试。MySQL 与到期测试也接入 `test:management-keys`。`GATEWAY_BYOK_SLOTS_BASELINE` / `GATEWAY_BYOK_SLOTS_ENGINE` 仅为测试对照与方言选择，不参与生产配置。

归档目录仅用于固定版本验证；其他机器应先按官方方式准备本地测试包并调整路径。`GATEWAY_PG_SCHEMA_BASELINE_DIR`、`GATEWAY_PG_FINANCIAL_BASELINE`、`GATEWAY_PG_FINANCIAL_BASELINE_DIR`、`GATEWAY_PG_AUTH_BASELINE_DIR`、`GATEWAY_PG_PROJECTION_BASELINE_DIR`、`GATEWAY_PG_PROJECTION_COMPARE_DIR`、`GATEWAY_PG_MANAGEMENT_BASELINE_DIR` 和 `GATEWAY_PG_BYOK_BASELINE_DIR` 只用于旧源码/旧函数及跨方言的测试对照，生产代码不读取它们。

## 后续顺序与未通过门禁

1. 已完成上述 schema 限定子集及 BYOK 创建类型修复；v256 已实现槽位复用与 MySQL 管理绑定修复。SQLite/PostgreSQL 本地引擎验证排序/审计回滚，MySQL 仅 SQL/绑定/驱动合同，仍需原生三引擎、多会话并发及 Hyperdrive 验收，不能将其标为全流程放行。
2. 再覆盖路由、模型、供应商、sticky、日志、共享市场和管理查询；追踪拼接 SQL、共享查询生成器、`unsafe`、Drizzle `sql` 原始片段、别名/CTE、catalog/regclass 检查。
3. 多驱动文件必须区分 PostgreSQL 分支和共享模板，保留 D1/MySQL 行为。不得对混合文件做全局表名替换。检查迁移创建的触发器/函数自身的名称解析；限定调用者 DML 不自动限定函数内部 SQL，不能悄悄重写历史迁移解决。
4. 补真实 PostgreSQL/Hyperdrive 的不同后端连接、同名 public 对照、全部仓储及事务验收，然后才评估是否移除 session 兼容设置。之后继续数据库原生时限、已使用客户端终点、剩余消费者和全工作集容量。

最近一次候选扫描（v255）发现 PostgreSQL 专用模块仍有 183 处未限定候选，混合驱动文件另有 481 处候选（v254 为 185 / 526）；后者含合法 D1/MySQL，不能当作 481 个 PostgreSQL 缺陷。v256 未重扫该清单；该扫描只分析 SQL 字符串片段与已知迁移表名，不能证明覆盖动态 SQL 或所有调用路径。

Images 的成功点始终为“有效 completed 图片 + 真实上游 `[DONE]`”，先持久化结算事实再交付成功 DONE，之后客户端取消不撤销费用。仅 completed 而无上游 DONE 不提前成功。本轮另行复测相关 41 项，未修改 Images 实现。

C02.G、C01 和后续依赖保持开放。当前仍为分阶段 schema 修复；云端旧候选不代表本地新源码。新验收必须重新冻结候选、复核隔离与剩余预算；首轮累计 US$2 上限不重置。
