# C02 — PostgreSQL 财务 SQL、函数解析与实际结算类型

2026-09-16；Checklist v1.150。LOCAL_PASS，未部署；C02.G / C01 / 后续依赖不放行。

## 本轮实现

在 v250 的 ORM 和普通用户预算预留基础上，显式限定 `cinatoken_gateway`：

| 路径 | 新限定的原始 SQL 表位置 |
| --- | ---: |
| `critical-writes.impl.ts` | 2 |
| `guardrail-budgets.impl.ts` | 20 |
| `storage/workspace-budgets.ts` 的 PostgreSQL 分支 | 9 |

工作区用量 SQL 合同测试的两个 matcher 同步更新。校验器与归档源码作精确比较：去除新加的 schema 前缀及下面的两处类型转换后，四个源文件内容一致；未改变 D1/MySQL 分支、预算算法、事务范围或添加写入重试。

新增 `0068_function_schema_resolution.sql`：现有 10 个 gateway 函数的 search_path 固定为 `pg_catalog, cinatoken_gateway, pg_temp`。包括三个范围/顺序约束触发器、五个收益/提现函数、append-only 拒绝函数和 retention 函数。未重写历史迁移，也不重建函数；catalog 实证核对 OID、函数体、owner、ACL 和 SECURITY DEFINER 标志不变。retention 仍拒绝 PUBLIC EXECUTE。迁移必须由迁移账号执行，本轮未在任何云端数据库应用。

仅限定调用方 SQL 不能固定 PL/pgSQL 内部表解析；省略 `pg_temp` 会使临时表隐式优先。因此使用新增迁移，而不是修改旧迁移或依赖连接会话的一次性 SET。[PostgreSQL 函数解析规则](https://www.postgresql.org/docs/current/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY)、[Hyperdrive 事务池语义](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/#pooling-mode)

## 引擎暴露的额外结算错误

实际费用结算的 `CASE` 两个结果参数没有明确 SQL 类型；在真实 SQL 引擎中被推断为 text，写入 bigint `settled_micros` 时报 **42804**。已分别加 `::bigint`，保留普通收费微金额和 BYOK 标准费用的原选择规则。当前 postgres.js 的 `inferType(number)` 返回未指定类型 0；此现象与 PostgreSQL 对全 unknown CASE 分支的 text 推断一致，不是靠放宽测试断言处理。[官方 CASE 类型解析](https://www.postgresql.org/docs/current/typeconv-union-case.html)

实际结算、保守预留结算、重复结算、BYOK 零买家扣款/标准费用扣 key 限额及事务末尾失败回滚均有独立断言。没有改变 Images 的成功结算边界。

## 验证方法与结果

机器记录：[v251 结果清单](./C02-postgres-financial-schema-v251-results.json)。使用本地 PGlite 0.5.8 / PostgreSQL 18.3 WASM，无 DSN、无外部数据库。财务夹具顺序执行 0001–0068 全部 SQL 文件，然后通过窄适配层运行真实 Drizzle postgres-js 生成 SQL和仓储 raw SQL。

同时建立 18 张同名 public 表与临时表，复制默认值、主键和唯一索引，置入不同账户/密钥/工作区数据。在 `public, pg_temp`、`pg_catalog`、`pg_temp, public` 三种路径下，逐项核对整个同名表内容摘要没有变化。public 首位和临时表首位分别覆盖，避免无意只测试 PostgreSQL 的隐式 temp 优先行为。

新增财务引擎 **77/77**（76 子测试 + 1 父测试），覆盖：多范围预算预留/幂等/冲突、旧日志计量、配置 epoch、派发/释放/到期/保守消费、route-key 扩展、普通/实际/BYOK 结算、缺业务表不回退、真实末尾约束失败后的全事务回滚、工作区 CRUD/用量/管理账号范围、请求日志与 assignment 触发器、预算排序、收益及提现、retention 参数限制、全部函数 catalog。18 张同名对照表不能被误写；函数退出后调用方 search_path 保持不变。

最终同一测试源码与夹具的两个独立对照：旧应用代码 + 新函数配置 **28 PASS / 49 FAIL**；新代码 + 旧函数配置 **36 PASS / 41 FAIL**；当前代码与迁移 **77 PASS / 0 FAIL**。这些失败不是线上故障统计，也不代表旧版本所有路径必然失败。旧代码对照使用更改前冻结的三个模块 bundle；依赖仍为当前锁定版本。

其他本轮实测：

- 新静态合同 4/4，接入 core `posttest:unit`；引擎接入显式 opt-in 的 `test:postgres-schema-engine`，未引入产品依赖。
- v250 既有引擎 70/70；core 主命令 454/454；SQL 相关脚本主体 136/136。
- dispatch 回归 4,176/4,176；Images SSE 结算/交付 41/41；dispatch 与 staging 两项类型检查通过。
- 测试集有重叠，不能简单相加；未运行完整仓库、完整 npm hook 链或远程 CI。新的 post-unit 合同在本轮单独执行。
- 重新构建 core Node bundle，冻结构建输入、68 个迁移和测试源码，运行前后核对摘要。既有 3,351 条记录按匹配摘要移至原始源码归档后验证，不改写旧 manifest。

中间失败保留：最初夹具遗漏普通预留上限、使用错误工作区状态、将 INSERT 触发器按 UPDATE 测试、未提供提现微金额，结果 46 PASS / 19 FAIL；修正夹具后 67 PASS / 4 FAIL，暴露上述三个实际结算错误；加类型转换后 70 PASS / 4 FAIL，剩余为 BYOK 测试缺完整 Generation metadata。随后补完整测试快照，并增加缺表对照。第一次迁移探针缺 bootstrap schema 的 3F000 及其修正记录也保留。早期运行不声称与最终测试源码完全相同。

## 不包含的证明与下一顺序

本地全套 SQL 执行不等于真实迁移 CLI、迁移角色权限、已有生产数据升级、多连接锁竞争、postgres.js wire/TLS、真实提交 ACK 丢失或 Hyperdrive 验收。append-only 函数本轮只核对 catalog 不变，并未新增其全部业务触发器执行矩阵。新函数配置不能授权 runtime 写入受保护 ledger。

当前 lexical 扫描仍有 PG 专用模块 **207** 处、混合驱动 **625** 处未限定候选（此前 229 / 634）；后者包含合法 D1/MySQL，不是同等数量的 PG 缺陷。动态 builder、别名、共享 SQL 和 catalog/regclass 仍需人工跟踪。下一项先处理鉴权及其共享存储原始 SQL，再继续其余路由/管理仓储；之后验证真实 PostgreSQL/Hyperdrive、数据库原生时限和使用后客户端终点。session 兼容设置暂时保留。

Workers 与 PostgreSQL 最佳实践技能促使本轮区分池化会话设置、静态表定位和服务端函数作用域，并使用真实 SQL 引擎验证而非仅断言 SQL 字符串；这些技能不替代目标运行时验收。

本轮云 API、部署、模型及 KMS 调用均 **0**；生产未改，首轮累计 **US$2** 上限不重置。远端最后观测仍继承 v232，累计公开 HTTP 422 / 真实模型和 KMS 0，未重新核验最终账单或远端状态。任何下一次云验均须重新冻结候选与复核隔离/预算。Images 始终保持有效 completed + 真实上游 DONE 才成功、先持久化再交付成功 DONE，后续取消不撤销费用。
