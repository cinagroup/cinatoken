# C04.7 v335：按共享 Key 重建收益统计的索引与规模审查

2026-09-24。**review-only，本地 D1 规模与 PG 原生索引/多会话子集通过，生产迁移门禁仍开放；C04.7 不勾选。**本索引子集新增 [PG 索引提案](../../../../packages/core/migrations-proposals/postgres/shared-key-earnings-projection-index.sql)、[D1 索引提案](../../../../packages/core/migrations-proposals/d1/shared-key-earnings-projection-index.sql)及本地夹具，没有改变正式迁移、收益服务或部署。两库 `0027` 正式迁移仅有 `(seller_user_id, created_at)` 收益索引；v334 的四项 `shared_key_id` 汇总读缺少可用前缀索引。

## D1 完整迁移和 25,000 行实测

[本地 SQLite/D1 夹具](../../../../scripts/db/cutover/d1-shared-key-earnings-projection-index.test.mjs)加载全部 **68** 条正式迁移，插入 **25,000** 条收益、对应请求日志与账本，分布到 **100** 个 Key，每个 Key **250** 条。对仓储实际的四项 `SUM/MAX` 重建语句，提案前计划是三次全表 `SCAN` 加一次无索引限定的 `SEARCH`；提案后四项均为 `USING COVERING INDEX idx_shared_key_earnings_key_projection (shared_key_id=?)`。重建后的 input/output、净额和最新时间与收益明细聚合相等，外键检查为空。`node --import tsx --test scripts/db/cutover/d1-shared-key-earnings-projection-index.test.mjs`：**1/1 PASS**。

本机首轮五次重建的中位数由 **12.925 ms** 变为 **0.203 ms**，复跑为 **6.099 ms** 变为 **0.194 ms**；整个内存数据库的 SQLite page count 从 **39,743,488** 增至 **41,336,832 bytes**（增加 1,593,344 bytes）。这些数值只描述合成样本和本机缓存，不能外推 D1 生产延迟、索引配额或建索引时长。D1 提案是五列覆盖索引，读开销下降的代价是每笔收益写入多维护一份较宽索引。

## PG18 原生索引与多会话结果

[原生夹具](../../../../scripts/db/cutover/postgres-shared-key-earnings-projection-index.native.test.mjs)只使用 `startNativePostgres` 新建的私有 loopback 集群。修正夹具后，[最终报告](./C04-earning-projection-index-v335-native-report.json)记录 PG **18.6**、全部 **73** 条正式迁移、**10,000** 条合成收益和账本，**1/1 PASS、5 阶段 PASS、cleanup PASS**（报告 SHA-256 `142e2228c6bf1202c74694e6701d39cf4eb6d019872c30fc8a80b3ab1a21b728`）。

- 未索引时目标 Key 的 50 行聚合采用全表 `Seq Scan`，排除 9,950 行、187 shared buffer hits，执行 **1.336 ms**。
- 持 `ACCESS EXCLUSIVE` 锁时，并发建索引约 **520 ms** 返回 `55P03`，无残留同名索引。持有普通收益写事务时，并发索引建造等待 `virtualxid`；写者提交后建造成功，`indisvalid/indisready` 均为 true，索引大小 **688,128 bytes**。
- `VACUUM (ANALYZE)` 后，同一个聚合改为 `Index Only Scan`，51 行、**3** shared buffer hits、**0** heap fetch，执行 **0.076 ms**。随后另一收益写者先插入并持有事务，重建在父 Key 行锁上等待 `transactionid`；写者提交后重建包含该收益，收益行与账本各 **10,002**，Key 汇总与收益明细精确相等。

本机执行时间、规划器选择和索引大小只代表合成样本，不能当作生产规模承诺。夹具覆盖 PG 仓储锁及索引，不包含持久修复扫描。普通沙箱的首次启动在 `pg_ctl: could not create restricted token: error code 87` 停止，保留 owned 路径 `.wrangler/staging/pg-native-dispatch-tests/run-h6UKoK`；核查时无 `postmaster.pid`、`pg_ctl status` 为无服务，未删除该目录。两份后续受控运行记录了已修复的夹具问题，均为 `cleanup: PASS`：

- [首次受控报告](../../../../.wrangler/staging/pg-native-dispatch-tests/report-earning-projection-index-3933f016-2611-4019-a3d6-1ec33013f724.json)：10,000 条收益和账本均存在；未索引的 50 条目标 Key 聚合使用 `Seq Scan`，扫描 10,000 行，187 shared buffer hits，执行约 1.09 ms。之后测试提取器误将 SQL 注释当作 `CREATE INDEX`，没有进入索引验收。
- [第二次受控报告](../../../../.wrangler/staging/pg-native-dispatch-tests/report-earning-projection-index-e638495d-6710-47c1-a3da-1401547650c7.json)：相同基线通过；`ACCESS EXCLUSIVE` 持锁下 `CREATE INDEX CONCURRENTLY` 约 **508 ms** 返回 `55P03`，且未留下同名索引。随后测试未启动 postgres.js 的惰性索引查询便开始等待锁事件，5 秒后夹具失败。修正后最终报告完成了该交错验收。

PG 提案采用 `CREATE INDEX CONCURRENTLY`，`shared_key_id` 为搜索键，四个汇总列放在 `INCLUDE` 中；它是审查用提案，不是可自动套用的正式迁移。PG 文档说明并发创建可与正常写入共存，但会等待旧事务；失败可能遗留 `INVALID` 索引，且不能在事务块中运行。[PG CREATE INDEX 文档](https://www.postgresql.org/docs/18/sql-createindex.html) 还提示 `INCLUDE` 增大索引且禁用 B-tree deduplication。D1/SQLite 提案没有在线并发建索引保证；[SQLite CREATE INDEX 文档](https://www.sqlite.org/lang_createindex.html)说明同名 `IF NOT EXISTS` 会跳过校验，所以两份提案均故意不使用它。

## 正式迁移前门禁

先在目标库只读核对正式迁移版本、表/索引定义、PG `pg_index.indisvalid/indisready`、收益行数与每 Key 分布、写入速率、存储余量、备份和维护窗口。PG 需在**独立单用连接、事务块外**按审定锁/语句超时执行并监看 `pg_stat_progress_create_index`；若超时，检查有无 `INVALID` 索引，明确清理与重试方案。D1 建索引需要代表性数据的建造时间、写入受阻/配额和可恢复性证据。两库还需以目标规模重跑读计划、收益写入吞吐及原生并发/崩溃交错，再决定是否进入正式迁移。两个索引测试已登记 Proxy dispatch safety CI，**Linux CI 尚未运行**。无远端 SQL、部署或云调用；正式迁移仍为 PG **73**／D1 **68**／MySQL **64**。
