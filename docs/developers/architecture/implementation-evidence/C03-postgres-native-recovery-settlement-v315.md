# C03 v315：专用恢复角色的原生资金结算

2026-09-24；**本机原生子集 PASS，生产禁用，C03 DOING**。承接 [v314 双向旧日志切换](./C03-postgres-native-role-guard-v314.md)。验证只使用隔离回环 PostgreSQL 18.6、合成身份和工作区私有运行库；没有远端 SQL、云调用、部署或系统安装。测试后私有 PostgreSQL 进程和自建运行目录均为零。

## 本轮变更

手动切换与恢复角色预检现在都核对 0068 的旧日志 Workspace trigger 函数合同：迁移者所有、`plpgsql`、`SECURITY INVOKER`、`VOLATILE`、trigger 返回值，以及 `pg_catalog, cinatoken_gateway, pg_temp` 的精确 `search_path`。0053 函数体读取未限定 schema 的 `api_keys`；固定路径使调用者的临时同名表不能替换真实 Key 查询。PGlite 的漂移负例会拒绝切换和角色 grant，原生普通/恢复角色的临时表遮蔽写入都得到 SQLSTATE `23503`。

生成的专用角色 SQL 删除了五个只作 trigger 入口的直接 `EXECUTE` grant。原生测试核对这些权限不存在，并在再次显式 `REVOKE` 后完成第二、第三笔结算。必要的函数、表及列权限仍按固定目录授予；角色继续 `NOLOGIN`、`runtimeCompatible:false`。

## 可复跑证据

将 `GATEWAY_NATIVE_PG_BIN` 指向本地 PostgreSQL 17+ `bin` 目录，再执行：

```powershell
node --import tsx --test --test-concurrency=1 scripts/db/cutover/postgres-recovery-settlement.native.test.mjs
node --import tsx --test --test-concurrency=1 scripts/db/cutover/postgres-recovery-role-policy.native.test.mjs
```

两项各 **1/1 PASS**、各自 `cleanup: PASS`。[资金机器报告](./C03-postgres-native-recovery-settlement-v315-report.json)和[角色/guard 机器报告](./C03-postgres-native-role-guard-v315-report.json)记录断言及受测源码 SHA-256；[本轮机器摘要](./C03-postgres-native-recovery-settlement-v315-results.json)记录边界。v314 报告保留为当时源码的历史证据。

| 原生 PG18.6 检查 | 结果 |
| --- | --- |
| 73 条正式迁移、普通 grant、可选双向 guard、生成角色 SQL | PASS；测试内显式安装，生产仍关闭 |
| `SET ROLE` 后恢复任务 `ensure`、`claim` 与无预留结算 | PASS；单笔回执、日志、审计及 committed job，用户余额由 1.000000 到 1.250000 |
| 五项 trigger 入口均无直接 `EXECUTE` 后再结算 | PASS；第二笔回执、日志及 committed job |
| 用户预留与 user、api_key、workspace 三种 Guardrail 窗口 | PASS；第三笔后余额 1.750000，用户预留清零，三项预留均结算 250000 micros，窗口预留清零 |
| 恢复角色直接更改 Key/日志、插入事实 | 拒绝；所需日志、回执和任务 INSERT 可用 |
| 普通与恢复角色临时 `api_keys` 遮蔽 | 两条跨 Workspace 日志均拒绝，SQLSTATE `23503` |
| 独立角色/guard 原生回归 | PASS；迁移/切换持锁回滚、普通日志、双向同 ID 争用 |

这只证明**已有有效事实后的恢复消费者**三条本地资金路径。fixture 由迁移者创建 claimed dispatch intent 和不可变结算事实；生产事实生产者身份及其 `FOR SHARE` Key 锁权限尚未落地。后续生产者修复须防止 `SECURITY DEFINER` trigger 被附着到调用者控制的临时表，不能只切换函数安全模式。真实 origin 容量、代表性旧库切换持锁与普通日志延迟、完整故障/期限矩阵、Workers/Hyperdrive、Queue ACK/retry/DLQ、DBL-04/05/06、C03.G 与 C01.G/C02.G 仍开放。首轮 staging US$2 累计上限不重置。
