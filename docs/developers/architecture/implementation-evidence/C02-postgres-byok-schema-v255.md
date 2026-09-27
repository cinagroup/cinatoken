# C02 v255：BYOK 与用户 SQL 隔离、创建参数类型修复

日期：2026-09-16。Checklist v1.154。限定范围 LOCAL_PASS_WITH_OPEN_FINDING，整体仍为 STAGING_PARTIAL；未部署，C02.G / C01 不放行。

## 实现与边界

`storage/byok-keys.ts` 的 PostgreSQL 专用 owner 谓词及分支共 45 处表位置，`db/postgres/users.impl.ts` 的硬删除及默认 Guardrail 保护查询 2 处表位置，固定使用 `cinatoken_gateway`。不修改 D1/MySQL、门户与管理密钥的权限职责、过滤策略、锁对象或事务范围。

真实 PostgreSQL 引擎还发现 BYOK 创建 SQL 的 provider 参数 `$3` 同时用于 varchar 写入和文本比较，报 `42P08 inconsistent types deduced`。在 INSERT 的该参数位置增加 `::text`，固定推断类型；不改值、绑定顺序或 128 字符校验，不采用会截短输入的 varchar(n) 显式转换。问题由旧模块及仅修 schema 的中间模块重现。[PostgreSQL 参数类型推断](https://www.postgresql.org/docs/current/sql-prepare.html)

修改前源码与 Node bundle 已归档；归一化换行、撤销固定前缀和这一个 cast 后与原源码一致。AST 合同检查 PostgreSQL 的 then 分支及专用 helper，明确排除后接的 MySQL else 分支。既有 BYOK SQL 合同的三处 PostgreSQL mock 匹配器及一处 JOIN 断言改为精确匹配限定表名，MySQL 断言不变；原七项测试另行通过。

没有新产品依赖、迁移、运行时 SQL 正则重写、重试或结算算法变更。继续保留 session 初始化兼容设置；还存在未迁移 SQL，不能宣布 Hyperdrive 已适配。[Hyperdrive 事务池语义](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/#pooling-mode)

## 新增本地验证

PGlite 0.5.8 / PostgreSQL 18.3 WASM，通过现有窄适配器执行全部 68 个迁移 SQL。新增 BYOK 对照表，使 public 与 pg_temp 各有 25 张带主键/唯一索引的同名表。每个场景比较它们的全部行摘要；搜索路径为 `cinatoken_gateway,public`、`public,pg_temp`、`pg_temp,public`，包括 pg_temp 隐式优先的情况。

36 个场景 × 3 条路径 + 父测试，共 109/109；静态合同 2/2。最终同一份测试源码对照：

| 被测产品源码 | 通过 | 失败 |
| --- | ---: | ---: |
| 修改前归档 | 18 | 91 |
| 仅限定 schema | 96 | 13 |
| 限定 schema + provider 类型修复 | 109 | 0 |

覆盖账户隔离/分页、密文不进入元数据与审计、管理/可信门户 actor、轮换、allowlist、软删除清空密文、完整排序交换、100 槽位整体重排、运行时最多 32 项、共享容量抑制策略、撤销/过期/停用/归档拒绝、跨账户及选定工作区约束、末尾审计失败真实回滚，以及用户硬删除保护、ORM 身份操作、用户与默认资源的原子创建、预算更新分支回归。

测试使用本地合成凭证与 Web Crypto 生成的信封，仅作为仓储的 opaque ciphertext；没有真实供应商密钥或 KMS 调用。门户 principal 仍按现有合同由入口每次重新授权，本套仓储测试不证明门户入口鉴权、端到端解密或 KMS 集成。

新增 `test:postgres-byok-schema` 接入 `posttest:unit`；第六组引擎加入 `test:postgres-schema-engine`。`GATEWAY_PG_BYOK_BASELINE_DIR` 仅用于测试选择归档模块，产品不读取。

## 必须继续修复：BYOK 排序槽位复用

独立边界探针已在本地 PostgreSQL 确认：100 个槽位占满后软删除非尾部凭证，live count 为 99、最大 sort_order 仍为 99。新增算法仍取 `MAX(sort_order)+1`，得到 100，违反数据库的 0..99 CHECK（`23514`）；新增及其审计事务回滚。不是数据库被写坏，但无法补回第 100 个凭证。

原版创建先被上述 `42P08` 挡住；本轮修复类型后暴露槽位问题，排序分配算法本轮没有变。证据为 `.wrangler/staging/pg-byok-v255/slot-reuse-results.json`，状态明确为 `REPRODUCED_OPEN_DEFECT`，不纳入“109 项通过”的正向覆盖。原探针对旧版预期到达 CHECK，实际先遇到类型错误；该断言失败和初始探针源码也保留。

下一步优先设计并实现 PostgreSQL/D1/MySQL 一致的槽位复用或压缩：保留现有优先级顺序、新增位置、完整排序唯一约束、审计原子性与并发语义；覆盖满额→删除→新增→重排的完整序列。未修复前不得把 BYOK 生命周期或整个 C02 标成完成。

## 中间失败与归档

首轮 0 PASS / 109 FAIL：fixture 同一参数写入 text ID 和 varchar name，未显式类型，所有场景在准备数据时失败（42P08）；静态合同 2/2。第二轮 66 PASS / 43 FAIL：真实产品 provider 参数冲突，以及若干鉴权/审计测试误传空 update patch，先触发输入校验。修正为有效 patch 后再验证拒绝或审计回滚；没有放松产品校验。

初始 helper/test、只修 schema 的源码与 bundle、两轮失败日志和最终结果均保留。最终既有引擎/合同 448/448、core 主集 454/454、SQL 相关脚本体 136/136、dispatch 4,176/4,176、Images SSE 41/41、dispatch/staging 两项类型检查通过。套件有重叠，不合计为独立覆盖。

历史 v254 的 5,101 条摘要按修改前归档核验；旧 manifest 不改写。新 core Node bundle 与输入、迁移、对照、开放缺陷和全部日志纳入 [机器证据](./C02-postgres-byok-schema-v255-results.json)。云端旧候选不代表本地新源码，旧 CLI 应拒绝当前漂移；后续部署必须新冻结构建。

本地 SQL 引擎不证明 postgres.js 协议/TLS、迁移 CLI、生产角色/升级、多会话并发、Hyperdrive、Workers 原生容量或 Node 22。完整 npm hook 链与远程 CI 未运行。

候选扫描剩余 664 处：PostgreSQL 专用文件 183、混合驱动 481；后者含合法 D1/MySQL，不能视为 481 个 PostgreSQL 缺陷。槽位问题之后继续其余路由/模型/供应商/管理 SQL，再完成真实数据库/Hyperdrive、原生时限、已使用客户端收尾与容量门禁。

本轮 Cloudflare 管理调用、部署、真实模型/KMS 调用均为 0，生产未操作。累计 US$2 上限不重置；v232 的最后云端关闭观察未重验。Images 仍以“有效 completed 图片 + 真实上游 `[DONE]`”作为不可逆成功点，先持久化结算事实再交付成功 DONE，后续取消不撤销费用。
