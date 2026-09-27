# C04.7 v336：已入账收益的有界修复任务回填

2026-09-24；**隔离 PostgreSQL 18.6 子集通过，C04.7／C04.G 仍开放**。正式迁移保持 PostgreSQL 73／D1 68／MySQL 64；没有远端 SQL、部署或云调用。

v335 的 `shared_key_usage_repair_jobs` 提案只为激活后新插入的收益入队，历史已入账收益没有修复任务。本轮新增 [review-only 回填页生成器与执行函数](../../../../scripts/db/cutover/build-postgres-shared-usage-repair-backfill.mjs)：按受历史防护约束的 `shared_key_earnings.id` 主键顺序扫描，每页 **1–500** 行，单独事务向按 Key 去重的修复任务表 `ON CONFLICT DO NOTHING` 入队。执行函数仅在 `postgres.js begin()` 的 COMMIT 被确认后返回 `nextEarningId`；调用方必须在此之后保存游标。提交回执不明或进程崩溃时，以**上一已确认游标重放**，重复页不覆盖较新的收益触发器任务，也不再产生第二笔卖家入账。没有新增进度表，因此普通 runtime 的宽授权脚本不会重新暴露一张回填进度表。

每页在 `ROW EXCLUSIVE` 关系锁下检查直接 migrator LOGIN、`0073` 末尾版本标记、收益 `id` 主键、目标表归属/FK/ACL、历史 UPDATE/DELETE/TRUNCATE 防护、入账与新收益入队触发器的精确形态及目标函数体 MD5。本地提案源码 SHA 固定在生成器中；目标目录内容另行反查，避免只固定本地文件却接受被替换的数据库函数。关系锁与普通收益 INSERT 兼容，但单页仍有 2 秒锁等待和 15 秒语句上限；代表性生产锁窗未实测。

[原生报告](./C04-postgres-shared-usage-backfill-v336-report.json)来自夹具自行创建并清理的回环 PostgreSQL **18.6**，加载全部 **73** 条正式迁移及 v335 两份 review-only 提案，最终 **1/1 PASS、9 阶段、cleanup PASS**。夹具用 5 笔历史收益、2 笔新收益和每页 2 行验证：激活后历史任务初始为零；`SET ROLE` 的非直接 LOGIN、目标 enqueue/history 函数体漂移、带 `WHEN (false)` 的入队触发器、停用触发器及宽 runtime ACL 均拒绝页面；COMMIT 回执丢失后从旧游标重放不覆盖新任务；页面回滚后重试只入队一次；低排序并发新收益**仅靠 live INSERT 触发器**进入任务；最终 5 个 Key 统计与 7 笔收益一致，卖家余额及账本均为 7 笔，没有二次入账。生成器单测 **2/2**；unit/native 已精确登记现有 Proxy dispatch safety CI，YAML 本地解析通过，Linux CI 尚未运行。[机器摘要](./C04-postgres-shared-usage-backfill-v336-results.json)固定源码与报告 SHA。首次原生夹具将插入低排序新 ID 后的重放页面结束游标预期写错，失败报告保留在 `.wrangler`；修正预期及增加目录门禁后最终复验通过。

**剩余边界：**此模块不连接外部数据库、不调度任务，也不持久化跨主机游标；它不能自动完成全量历史回填或证明最终完成观测。历史游标已越过的新收益只由 live 入队触发器覆盖，不能靠旧页补扫。目标 SQL 内容、运行时授权及触发器的未审查变动应阻断执行；现有预检不能替代真实生产配置审查。v335 sidecar 和本页仍未成为正式迁移；独立最小权限消费者、调度/退避、生产规模和索引写放大、真实 Workers/Hyperdrive/Queue、不可变报价与经济 outbox、MySQL/D1 等 C04 门禁仍未闭合。生产恢复路径保持禁用。
