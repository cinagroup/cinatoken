# C03 v339：legacy parent 切换中的 replay 函数 DDL 锁

2026-09-24；仅供审阅，默认关闭，未运行远端 SQL 或部署。[机器摘要](./C03-postgres-legacy-parent-function-lock-v339-results.json)与[PG18.6 原生报告](./C03-postgres-native-legacy-parent-function-lock-v339-report.json)固定本轮源码和结果。**C03.7／G 继续开放。**

v338 在切换 parent 表前核对 replay reserve 触发器和函数体，并锁住原表；但同一个受信任 migrator 的第二会话可在目录核对后、事务提交前改写函数。现有 parent gate 会自己替换 intent reserve 函数，因此真正缺少保护的是保持原定义的 log reserve 函数。生成器现在在原表锁之后、目录核对之前，对两条函数分别执行 `ALTER FUNCTION ... COST 100`。这两个触发器函数的 planner cost 不参与触发器执行；PostgreSQL 18.6 会对 `pg_proc` 元组持有事务锁，使另一会话的函数替换等到本事务结束。随后仍逐项核对 owner、语言、签名、`SECURITY DEFINER`、`search_path`、触发器绑定和原始函数体。生成 SQL 限定 PostgreSQL 18 主版本，未在其他主版本外推该锁行为。

原生夹具使用各自认证的两个 migrator 会话。移除两条 `COST 100` 语句的**负对照**表明，表锁与 advisory lock 已在手时，第二会话仍能替换 log reserve 函数。保留语句后，切换事务停在 parent DDL／目录核对完成、提交前；另一会话尝试替换 log 函数、替换 intent 函数和把 log 函数改为 `SECURITY INVOKER`，三次均在 500 ms 锁时限附近报 `55P03`。事务回滚后无 parent 表遗留。事先把 log 函数的 `search_path` 改成 `public` 仍在 parent DDL 前被拒绝，证明锁锚没有抹掉这项安全漂移。

本机自有回环 PostgreSQL **18.6**，全部 **73** 个正式迁移，原生夹具 **1/1 PASS、19 阶段 PASS、清理 PASS**；生成器单测 **1/1 PASS**，定向空白检查通过。独立设计探针还确认普通 migrator 无权对 `pg_proc` 执行 `FOR SHARE`，同 owner 的 `ALTER FUNCTION ... OWNER TO` 不会阻断替换，因此未使用这两种方式。

此证据只锁定所核对的两条函数在本次切换事务中的 DDL 竞争；提交之后，受信任 migrator 仍可主动修改它们。它不证明其他历史 SQL、生产锁窗口、所有 DDL 形式、旧数据原始事实、Workers／Hyperdrive 或跨数据库等价；正式迁移和生产切换仍需单独审查。
