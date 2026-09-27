# C03 v332：回填索引、旧路径兼容、Images edits 与服务器时限

2026-09-24；**本地子集通过，生产关闭，C03 DOING**。承接 [v331 防重放与兼容切换](./C03-postgres-replay-legacy-parent-v331.md)。所有原生测试只使用自行创建并清理的回环 PostgreSQL 18.6；正式迁移仍为 73 条，replay/parent SQL 仍是 review-only，没有远端 SQL、部署或云调用。

## 本轮进展

| 证据 | 结果 | 覆盖 |
| --- | --- | --- |
| [回填与锁窗报告](./C03-postgres-native-replay-scale-lock-v332-report.json) | PG18.6，1/1、10 阶段、cleanup PASS | 25,000 条合成旧日志、500 条一页、51 页；中断回滚后从已提交游标续跑。expand 与七表 gate 在旧写者持锁时约 2 秒失败并完整回滚，重试完成。 |
| [旧 handler 兼容报告](./C03-postgres-native-legacy-handler-compat-v332-report.json) | PG18.6，1/1、5 阶段、cleanup PASS | 实际普通两参数日志写入及当前未改动的请求日志仓储在 parent 切换前后读写；归属 Generation、后台列表、统计与新 parent ID 碰撞的整笔回滚。[范围说明](./C03-postgres-legacy-handler-compat-v332.md)。 |
| [Images edits HTTP→资金报告](./C03-postgres-native-http-edits-financial-v332-report.json) | PG18.6，1/1、4 阶段、cleanup PASS | 实际 Hono multipart edits、哈希 API Key、独立 runtime/dispatch/fact/financial 密码 LOGIN、上传字节、一次受控 fetch、一次 fact/outbox/job 和 `0.040000` 结算。上游等待前/中均观测到 claim 已提交、资金事实为 0、生产者未结束事务为 0。 |
| [服务器总时限报告](./C03-postgres-native-server-deadline-v332-report.json) | PG18.6，1/1、3 阶段、cleanup PASS | 新 LOGIN 的 500ms `transaction_timeout` 终止自动提交与显式事务；服务器日志记录两次终止，原后端消失且未提交插入回滚。[范围说明](./C03-postgres-server-deadline-v332.md)。 |

改动后的回填生成器另复跑 [replay 登记](./C03-postgres-native-replay-reservations-v332-report.json)与[旧 parent 激活](./C03-postgres-native-legacy-parent-activation-v332-report.json)两份原生夹具，分别 **1/1、19 阶段**与 **1/1、10 阶段**，cleanup 均 PASS。连同上表，本轮原生测试共 **6/6**。

回填生成器现在沿源列主键的排序规则做游标比较、排序和最大值；只有允许同一请求多个 attempt 的 intent 来源保留 `DISTINCT`。本地旧 SQL 在 25,000 行中点得到 Seq Scan/Sort，单次 `EXPLAIN ANALYZE` 为 8.362 ms、610 个 shared hit blocks；更新后的 500 行页得到 Index Only Scan，0.150 ms、19 个 shared hit blocks。完整 51 页实测合计 702.863 ms，p95 页 18.470 ms。此计时只描述合成回环环境，不能推断生产锁窗或容量。新 [回填生成器](../../../../scripts/db/cutover/build-postgres-replay-reservation-backfill.mjs)的 SHA 由 v332 报告固定，取代 v331 的生成器快照；最终七源反查仍是防游标竞态的切换门禁。[压测细节](./C03-postgres-replay-scale-lock-v332.md)。

新增四份原生夹具已登记 [Linux CI 工作流](../../../../.github/workflows/proxy-dispatch-safety.yml)，本机 YAML 解析通过；Linux job 尚未运行。[机器摘要](./C03-postgres-replay-cutover-compat-v332-results.json)固定本轮报告和源码摘要。

## 仍需验收

25,000 行是小型合成样本，尚无代表性生产数据分布、数据量、索引/约束锁窗或维护回滚演练。没有批准的保留期、归档完整性与 contract 迁移；旧 handler 只覆盖当前兼容源代码，不包括历史部署二进制或全部路由。总时限夹具不覆盖恢复 runner 内部控制语句、真实网络不明分支，也没有物理 socket 关闭回执。实际 Workers/Hyperdrive/Queue、跨 isolate 排他和 ACK/DLQ 仍未验证。C03.4／C03.5／C03.7／C03.G、DBL-04/05/06/08、C01.G／C02.G 均保持开放；生产禁用，首轮 staging US$2 上限不重置。
