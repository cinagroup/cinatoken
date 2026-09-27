# C04 v337：PostgreSQL 共享 Key 报价版本合同提案

2026-09-24；**仅供审阅，默认关闭，未接入账务或部署**。[机器摘要](./C04-postgres-shared-key-quote-versions-v337-results.json)与[原生报告](./C04-postgres-shared-key-quote-versions-v337-report.json)固定本次源码及本机 PG18.6 验证结果。

## 合同与边界

- [提案 SQL](../../../../packages/core/migrations-proposals/postgres/shared-key-quote-versions.sql) 位于 `migrations-proposals`，不属于 73 个正式迁移。必须由 `cinatoken_gateway_migrator` **直接 LOGIN**，在一个事务中显式设置 `cinatoken.shared_key_quote_versions_activation=reviewed-v1` 才能应用。提案先取 `schema_migrations` SHARE 锁，再对照全部 **73 个正式版本名的精确集合**、表 owner/RLS、四个正式卖家单价的 `NUMERIC(18,6)` 精度。新独立 schema 还要求该 migrator 对目标数据库有 `CREATE` 权限；当前提案不授予这个生产权限，夹具先验证缺权限拒绝，再在自有库中临时授予。`2s lock_timeout` 使并发迁移 DML 阻断激活。
- 新表要求 version ID、shared Key ID、seller ID、四个 `NUMERIC(18,6)` 每百万 token 卖家单价、`NUMERIC(8,6)` 佣金、USD、`per_million_tokens`、`shared_seller_key` billing mode、权益版本及有限的生效起止时间。缓存读／写价都必须显式提供；正式 `shared_keys` 中可空的缓存价不能被默认为零。四价各自显式拒绝 PostgreSQL numeric `NaN`；有精度限制的 numeric 列会自动拒绝 Infinity。价格以 PostgreSQL numeric 字段持久化，没有 JS 浮点权威。`recorded_at` 可在 INSERT 请求中提供，但触发器会用数据库时钟覆盖。
- 同 Key 新版本通过 `shared_keys` 行锁串行化，READ COMMITTED 下检索半开区间 `[effective_from,effective_until)`；主键拒绝重复版本 ID，行锁后拒绝重叠区间。语句级触发器拒绝多行 INSERT、任何 UPDATE/DELETE（包括空结果）及 TRUNCATE。报价 FK 限制删除 Key/seller。无需 `btree_gist` 扩展；未来报价生产者必须遵守单行 INSERT、READ COMMITTED 和有限区间协议。
- 私有 `cinatoken_economic_quotes` schema 与当前 `cinatoken_gateway` 的宽 runtime grant 隔离。激活前拒绝 runtime superuser、继承 migrator 或 PG 预置读写角色；激活后检查 runtime 对 schema、表和函数的**有效**权限。普通 runtime 的 SELECT/INSERT 被拒绝，已有 gateway grant 重跑两次仍未取得报价权限。对象 owner 的 migrator 仍能更改 DDL／触发器，属于受信任运维边界；激活后的任意新授权也需要独立持续审查。

## 验证

在自有 loopback PostgreSQL **18.6** 集群实际执行全部 **73** 个正式迁移后，[原生夹具](../../../../scripts/db/cutover/postgres-shared-key-quote-versions.native.test.mjs) **1/1 PASS，20 个阶段 PASS，清理 PASS**。负例覆盖激活缺失、0073 缺失、保留 73 行及 0073 却伪造中间版本、正式价格精度漂移、DB CREATE 缺失、非 LOGIN migrator、SET ROLE 代理、runtime superuser／角色继承、预置宽 ACL 与安装后宽 ACL 回滚；14 个报价必填字段逐一缺失、四价分别传 `NaN`、非法价格／佣金／枚举／区间、错误 seller；重复版本、区间重叠、双会话同 Key 竞争（第二会话等锁后以 `23P01` 拒绝）、REPEATABLE READ、多行 INSERT、伪造 `recorded_at`、UPDATE／DELETE／TRUNCATE、父 Key 删除和宽 grant 重跑。另一会话持有 migration ledger DML 锁时激活以 `55P03` 在约 2 秒内失败。

[CI `native-financial-consumer`](../../../../.github/workflows/proxy-dispatch-safety.yml) 精确登记 `node --import tsx --test scripts/db/cutover/postgres-shared-key-quote-versions.native.test.mjs`。当前 workflow 内 failure-isolation 与 quote native 步骤各出现一次，另有 durable cursor 的 unit/native 各一步；Linux CI 尚未运行。

本提案没有可信报价生产者、route attempt 版本引用、确定性可计费用量事实、typed outbox 或收益消费者。现有 `SharedKeyRow` 缺权益版本、billing mode、币种、单位与正式版本 ID；`routeTrace` 和 `updatedAt` 不能倒推出这些值。六个公开 text `recordUsage` 入口之外，Audio/Realtime 与 Images 使用各自 usage 函数，也尚无这条报价链。由于结束时间必填、历史行不可改且同 Key 区间不可重叠，动态改价只能预排在旧区间结束后；提前改价／撤销及 seller owner 更换的 append-only supersession 协议尚未设计。D1/MySQL 对等合同、现有历史收益与生产并发均未验证。**C04.1/G 仍开放。**没有运行远端 SQL、供应商请求、生产资金写入或部署。
