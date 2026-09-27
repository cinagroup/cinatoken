# C04 v333：历史收益补算与已入账流水防删

2026-09-24；**本地子集通过，C04 仍未验收**。本轮未对真实用户补扣、卖家入账或部署。PostgreSQL 夹具仅操作自行创建并清理的 PG18.6 回环集群；正式迁移仍为 73 条。

旧的管理员 `/admin/earnings/rederive?apply=1` 会对历史共享 Key 日志重新读取**当前** Key 的价格、owner 与当前佣金率并写入收益。现改为对这类候选返回 `409 historical_earning_evidence_required` 和有界请求日志 ID，保持零账务写入；dry-run 仍只读。第一页无候选但日志总数超过已扫描行数时，`apply=1` 返回 `409 historical_earning_scan_incomplete` 和 `scanComplete:false`，不能把未扫描的后续页报告为完成。原始报价/owner 快照尚不存在，因此此路径不能自动补算。[路由测试](../../../../packages/admin/lib/routes/admin/earnings.test.ts) **3/3 PASS**，Admin 类型检查通过。

原生负对照证明另一个独立缺口：现有 `shared_key_earnings.shared_key_id` 与 `seller_user_id` 的 `ON DELETE CASCADE` 能在删除共享 Key 时抹掉收益行，但已入账的 `user_earnings.balance_micros=40000` 和 journal 仍保留。负对照在事务内观察后立即回滚。[review-only PostgreSQL 防护提案](../../../../packages/core/migrations-proposals/postgres/shared-key-earnings-history-guard.sql)在既有信用触发器上加窄表锁与 `UPDATE`/`DELETE`/`TRUNCATE` 拒绝触发器，不清除历史行。[原生报告](./C04-postgres-native-earning-history-v333-report.json)为 **1/1、5 阶段、cleanup PASS**：无激活标志拒绝、持锁时约 2 秒 `55P03` 原子回滚，重试后共享 Key/卖家级联与直接改删均拒绝；重复 request-log ID 不二次入账，无收益的 Key 仍能删除。

这个提案尚非正式迁移；D1/MySQL 的同类级联仍未防护。已存在的收益行未具不可变报价/佣金/owner 证据，也未补齐 typed 经济 outbox、消费者、账务调整和 C04.7 可重建汇总。旧同步结算仍可能使用变化后的价格；`addSharedKeyUsage` 在 ledger 成功后的失败也可能令汇总长期落后。本轮仅阻止两个已确认的风险入口，不勾选 C04.1–8/G。新增原生夹具与路由测试已登记 [CI](../../../../.github/workflows/proxy-dispatch-safety.yml)，Linux job 尚未运行。
