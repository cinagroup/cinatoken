# C03 v316：窄权限事实生产者提案与恢复负例

2026-09-24；**本机原生子集 PASS，生产禁用，C03 DOING**。承接 [v315 专用恢复角色结算](./C03-postgres-native-recovery-settlement-v315.md)。本轮只在提案目录添加两个默认关闭的 SQL 文件；73 条正式 PostgreSQL 迁移没有新增或改写。没有远端 SQL、云资源、部署、真实 origin 或系统运行库安装。

## 生产者权限缺口与提案

0069 的 intent INSERT trigger 以调用者权限读取 `api_keys FOR SHARE`；PostgreSQL 对该行锁要求 Key 表至少一列 UPDATE 权限。0070 的事实 INSERT trigger 也以调用者权限写 outbox。直接把两项权限授给未来事实生产者会扩大其可改写范围。[PostgreSQL 权限说明](https://www.postgresql.org/docs/18/ddl-priv.html)。

[intent guard 提案](../../../../packages/core/migrations-proposals/postgres/dispatch-intent-producer-definer.sql)与[outbox enqueue 提案](../../../../packages/core/migrations-proposals/postgres/settlement-outbox-producer-definer.sql)各自要求迁移者在显式单事务中设置激活断言，核对既有表、trigger、函数所有者/路径和 ACL，等写冲突锁后原位替换函数。新函数均由迁移者拥有、固定 `search_path=pg_catalog, pg_temp`，并在读取 Key 或写 outbox 前核对 `TG_RELID`、trigger 名称及事件；撤销 PUBLIC、普通 runtime 和适用时合成生产者的直接 EXECUTE。`CREATE OR REPLACE FUNCTION` 保留既有函数的所有权与权限，因此替换和 REVOKE 必须同事务完成。[PostgreSQL 函数安全说明](https://www.postgresql.org/docs/18/sql-createfunction.html)。普通 [runtime grant 脚本](../../../../scripts/db/cutover/grant-postgres-runtime.ts)重跑后也再次撤销这两个入口的 EXECUTE。

两个提案没有 CREATE ROLE、LOGIN、origin、队列入口或生产授权。当前 Worker/Node 生产入口没有接 PostgreSQL intent/fact 仓储；显式 Images 恢复入口仍只接受 D1。测试中的 `cinatoken_gateway_fact_producer` 只是隔离库内的合成 NOLOGIN 权限探针。

## 本地验证

| 验证 | 结果 |
| --- | --- |
| intent 提案 PGlite：旧 invoker 权限拒绝、显式激活、窄角色 prepare/claim、范围不匹配、临时 trigger 误用 | **1/1 PASS** |
| outbox 提案 PGlite：无直接 outbox INSERT 的事实写入、事务回滚、不可变约束、临时 trigger 误用 | **1/1 PASS** |
| 原生 PG18.6 生产者提案 | **1/1 PASS**；73 条正式迁移加两个显式提案，运行 grant 重跑后，合成角色完成 intent→fact→outbox，账务仍为 1.000000 |
| 原生 Key 改属竞态 | **两种顺序 PASS**；两次均由 `pg_blocking_pids` 证实等待指定持锁会话；先写 intent 留下历史范围，先改 Key 则旧范围 intent 被拒 |
| 原生权限负例 | Key SELECT/UPDATE、outbox 直接 INSERT 均拒绝；两个 definer 函数的 temp trigger 附着在无 EXECUTE 时拒绝，测试故意误授权后由关系/事件检查拒绝执行 |
| 恢复角色原生资金负例 | **1/1 PASS**；同回执重放不重复扣费、过期 lease 不写账、提交前异常整笔回滚，COMMIT 已确认后应用层结果丢失由回执只读确认一次结果 |
| PostgreSQL 迁移合同、源码/报告摘要与 diff 检查 | **PASS** |

[生产者原生报告](./C03-postgres-fact-producer-proposals-v316-report.json)和[恢复负例原生报告](./C03-postgres-native-financial-negative-v316-report.json)均记录 `cleanup: PASS`；[机器摘要](./C03-postgres-fact-producer-proposals-v316-results.json)固定受测源码 SHA-256。两套本地回环 fixture 结束后，未留自建运行目录或私有 PostgreSQL 进程。

资金负例中的最后一项在数据库 COMMIT **已得到驱动确认后**才注入应用层结果丢失；它不证明财务事务的 TCP COMMIT ACK 丢包路径。先前 v314 dispatch intent 测试另有网络 ACK 丢包证据，但不能代替财务事务测试。

## 保留门禁

合成角色有列级 SQL 权限，但没有生产调用者/租户授权、预算准入、请求级 unknown 门禁、结果来源或正式身份映射；这些仓储目前仍是默认禁用的本地候选。提案尚未进入自动迁移，也未在测试库外执行；代表性旧库持锁/普通流量、真实 origin 容量、Workers/Hyperdrive、Queue ACK/retry/DLQ、DBL-04/05/06、C03.G 和 C01.G/C02.G 未验收。C03.5 仍未勾选，首轮 staging US$2 累计上限不重置。
