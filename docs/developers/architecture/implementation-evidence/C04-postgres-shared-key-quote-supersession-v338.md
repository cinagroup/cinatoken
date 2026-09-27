# C04 v338：PostgreSQL 报价切换与撤销合同提案

2026-09-24；**仅供审阅，默认关闭，未接入真实派发或账务，也未部署**。[机器摘要](./C04-postgres-shared-key-quote-supersession-v338-results.json)和[原生报告](./C04-postgres-shared-key-quote-supersession-v338-report.json)固定本次源码及本机 PG18.6 结果。v337 的[有限区间证据](./C04-postgres-shared-key-quote-versions-v337-results.json)及其 SQL SHA `8f371631c14456077d37228535a3bd0415953cba69932174d2041de663b8c360` 是**历史快照**；当前同路径提案已替换为 v338 的状态切换合同，不应再把 v337 的 20 阶段报告当作当前源码验收。

## 合同

- [提案 SQL](../../../../packages/core/migrations-proposals/postgres/shared-key-quote-versions.sql) 仍在 `migrations-proposals`，未进入 73 个正式迁移。激活改为直接 `cinatoken_gateway_migrator` LOGIN 的单事务 `reviewed-v2`；锁住正式迁移账本并逐一核对 73 个版本名、表 owner/RLS 与四价精度。独立 schema 需要数据库 `CREATE` 权限，当前角色初始化只给 `CONNECT`，提案未授予该生产权限。
- `shared_key_quote_versions` 只追加完整的报价事实：seller、Key、四个 `NUMERIC(18,6)` 每百万 token 价格、佣金、USD、计价单位、billing mode、权益版本。`shared_key_quote_transitions` 只追加 `activate` 或 `revoke`，包含调用方声明的前驱、卖家快照、数据库分配的逐 Key 序号和生效时间。报价事实及状态事件都拒绝 UPDATE、DELETE、TRUNCATE；客户端不能指定历史生效时间或序号。报价版本只可激活一次。
- 每个事件先对正式 `shared_keys` 行取锁，再读当前事件头。旧前驱被拒绝，两个同 Key 操作因此串行化。READ COMMITTED 和单行 INSERT 是协议要求。即时改价追加完整新报价和 `activate` 事件；撤销追加不含报价版本的 `revoke`；重新启用追加另一个完整报价和 `activate`。无需改写旧行或预先规定结束时间。
- 已有报价历史的 Key 若变更 `seller_user_id`，延迟约束要求在**同一事务**中追加与最终 owner 匹配的新事件。历史事件和报价仍保留旧卖家。单独更新 owner 会回滚。当前实现只允许受信任 migrator 直接追加报价和事件；这不是已接入的 seller 管理流程。
- `claim_shared_key_quote_for_dispatch` 在 READ COMMITTED 下对 Key 取 `FOR SHARE`，返回当前完整活跃报价及 `transition_id`／`quote_version_id`；当前头缺失或已撤销时拒绝。若撤销事务已持有 Key 锁，领取会等其提交后再判断。**未来生产者必须在同一事务中领取并持久化 attempt 的两个 ID**，否则自动提交后释放锁仍会产生竞态；目前没有真实 attempt 调用该函数。

## 时间与财务边界

`resolve_shared_key_quote_at_sequence` 可按保存的逐 Key 序号重建原始报价和卖家；真实财务计算必须以 attempt 固化的 `transition_id`／`quote_version_id` 为权威。`resolve_shared_key_quote_at_time` 只供**提交后追溯审计**：事件的 `effective_at` 在 INSERT 时由数据库赋值，可能早于 COMMIT。原生夹具证明，在新事件尚未提交期间，另一会话仍看到旧报价；提交后用**同一个观察时间**做时间查询会得到新报价，但先前保存的旧版本引用和原价不变。因此时间回溯不能用于历史收益重算。

## 本地验证与未闭合项

[原生夹具](../../../../scripts/db/cutover/postgres-shared-key-quote-versions.native.test.mjs) 在自有 loopback PostgreSQL **18.6** 上实际执行全部 **73** 个正式迁移后为 **1/1 PASS、24 阶段 PASS、清理 PASS**。覆盖即时改价、撤销／重启、两会话 owner 转移可见性、竞争操作的旧前驱拒绝、未提交事件的旧版本捕获、撤销提交后新领取拒绝、伪造历史生效时间、缺字段／`NaN`、报价复用、跨 Key 关联、空与实际变更、SET ROLE、运行时有效 ACL 及宽 gateway grant 重跑。结果中 SQL/test/report SHA 分别为 `1249a7ff07f95b48c7b45a41833c96c9a028e4bfe3a47e44e9dc6b72c3c77246`、`a68472dd3a7e4ac77e67e63a99469b6651ffc553562ada1a664964f1cdc238f8`、`c470a98ed265fb3853f16b862071191bb18ba9501244923c69ec1eaec7472bd0`。现有 CI workflow 已登记该原生测试路径，Linux CI 尚未运行。

本提案没有可信报价生产者、真实 attempt ID 固化、确定性可计费用量、typed outbox、收益消费者或 D1/MySQL 对等合同；历史收益也未重算。当前 `SharedKeyRow` 不含权益版本、billing mode、币种、单位及版本 ID，不能仅凭现有路由数据推导。迁移角色作为对象 owner 仍可刻意修改 DDL／触发器，新授权需另审。没有运行远端 SQL 或部署。**C04.1/G 继续开放。**
