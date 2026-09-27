# C03 旧请求处理器兼容性补充（v332）

本地 [PG18.6 原生报告](./C03-postgres-native-legacy-handler-compat-v332-report.json) 为 **1/1、5 阶段 PASS，cleanup PASS**。夹具只启动新建、独占、127.0.0.1 PostgreSQL 集群，执行 73 条正式迁移和 review-only 的重放登记、旧库 parent gate 提案。没有远端 SQL、部署、云调用或保留期删除。

v331 旧读者夹具仅调用 `getRequestLogsByKeyId()`，旧写入为简化 SQL。本轮直接使用 `insertRequestUsageAndChargeTxPg(client, params)` 原有双参数普通写入路径，以及 `createPostgresRequestLogsRepository()` 的三个实际旧读者：owner 限定的 Generation 查询、后台请求列表、时间范围统计。请求日志仓储源码与 Git HEAD `7eb59008f7d8e156e81fd18a57658fdef2553264` 相同；写入器为当前源码，双参数入口保持原有调用方式，不代表旧部署二进制。

| 阶段 | 原生观察 |
| --- | --- |
| 切换前 | runtime 独立 LOGIN 通过真实普通事务写入一个零费用请求；owner Generation 读到该行，错误 user/workspace 均返回空；后台列表 1 行、统计 11 tokens。 |
| 扩展与切换 | 重放触发器安装后，有界 `legacy_log` 回填扫描/登记各 1 行；同一事务激活旧库 parent gate，旧 ID 保留来源为 `legacy_log`。 |
| 切换后 | 相同双参数普通写入成功，新的日志 ID 自动产生 `legacy_log` tombstone；旧 Generation 投影逐字段不变，两个请求均可读；后台列表 2 行、统计 22 tokens。 |
| 冲突回滚 | 为新 ID 先建可信 parent，再由普通写入器尝试同 ID。服务端返回 `P0001`，日志和每日统计仍分别为 2 行，可信 parent 保留。 |

此结果缩小了旧处理器兼容性的证据缺口，但 **C03.G 仍不勾选**：未运行所有历史 handler 或部署产物、收费及预算预留的旧路径、真实 Worker/Hyperdrive/Queue，也未建立代表性旧库的锁窗与生产回滚方案。现有生产禁用边界不变。
