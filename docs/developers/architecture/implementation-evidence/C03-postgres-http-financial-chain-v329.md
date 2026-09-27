# C03 v329：Images HTTP→PostgreSQL→资金结算本地链路

2026-09-24；**本地子集通过，生产关闭，C03 DOING**。承接 [v328 Worker 生产者与资金 consumer 组合](./C03-postgres-worker-consumer-composition-v328.md)。正式 PostgreSQL 迁移仍为 73 条；本轮只在自建回环 PostgreSQL 18.6 安装 review-only 提案，没有连接远端数据库、部署或调用云端模型/KMS。

## 实现

资金 consumer 在预检及每次 SQL/事务的实际会话内，要求 `session_user=current_user=cinatoken_gateway_financial_recovery_consumer`。同时读取 `pg_settings`，要求 `transaction_timeout`、`statement_timeout`、`lock_timeout`、`idle_in_transaction_session_timeout` 的来源均为 `database user`，数值分别在 **1–30,000 / 1–15,000 / 1–5,000 / 1–10,000 ms**。会话后续覆盖默认值即拒绝继续工作；这个检查不能独立证明最初使用的凭据，原始连接与凭据保管另须验收。[默认关闭的直连 LOGIN 授权生成器](../../../../scripts/db/cutover/build-financial-consumer-direct-login-grant.ts)只返回 DBA 与 migrator 两个待审 SQL 事务，不执行 SQL；输入须显式选择固定角色、数据库、连接上限和外部生成的 SCRAM verifier。预检/后检包括角色属性、数据库默认时限、必要函数源码及触发器形状、全 gateway schema 的有效权限。verifier 结构校验不证明密码熵，连接上限也必须另与实例全量 origin 容量核对。

真实 Images 路径的隔离测试揭露并修复三处兼容问题：PostgreSQL Guardrails 查询不能在 `ORDER BY CASE` 内读取同层 SELECT 别名；`postgres.js` 在当前 `fetch_types:false` 连接上把裸 JS 字符串数组绑定为普通文本，四个 Endpoint/route policy 批量读取改用单个 JSON 标量与 PostgreSQL `jsonb_array_elements_text`；fact/job 授权预检现在接受**精确匹配**的先装旧日志 guard 触发器，额外/漂移触发器仍拒绝。触发器计数先赋给 PL/pgSQL 变量，避免 `IF` 条件内 `CASE` 被错误解析。改动均由隔离 PG18.6 复验。

## 原生结果

| 证据 | 结果 | 覆盖 |
| --- | --- | --- |
| [完整 HTTP 链报告](./C03-postgres-native-image-http-financial-v329-report.json) | 1/1、4 阶段、cleanup PASS | 实际 Hono Images generations HTTP 请求、哈希 API Key、真实 PostgreSQL 路由读取、独立 runtime/dispatch/fact/financial SCRAM LOGIN 会话。受控本地 provider fetch 恰好一次、HTTP 200。资金前 parent/claim/fact/outbox/pending job 各 1，旧日志 0、支出 0；consumer 后 receipt/log/attempt/audit 各 1，job `committed`、支出 `0.040000`，`queueAckSafe:false`。四个批量读取均由真实 PG 执行。 |
| [资金直连授权报告](./C03-postgres-native-financial-direct-grant-v329-report.json) | 1/1、10 阶段、cleanup PASS | 生成的 DBA/migrator SQL 在隔离库里安装专用 SCRAM LOGIN 与精确授权；函数源码/属性、额外 trigger、PUBLIC 列权限漂移拒绝；会话超时被覆盖时 consumer 在扫描/容量前拒绝，服务器 200 ms 事务超时实际中断长事务。该夹具只执行空扫描。 |
| [fact/job guard 授权报告](./C03-postgres-native-fact-job-guard-grant-v329-report.json)、[直连报告](./C03-postgres-native-fact-job-guard-direct-login-v329-report.json) | 2/2、17+5 阶段、cleanup 均 PASS | guard 先于 fact/job grant；函数改为 invoker、禁用固定 trigger、增加 trigger 均原子拒绝；随后 NOLOGIN 与独立密码 LOGIN 的最小列权限继续可用。 |
| [资金 consumer 再验报告](./C03-postgres-native-financial-consumer-login-v329-report.json) | 1/1、5 阶段、cleanup PASS | 在当前 consumer 源码摘要下复验独立密码 LOGIN、跨角色拒绝和一笔 `1.250000` 的持久结算。该夹具仍使用自己的测试授权，和新生成器的安装测试是两组独立证据。 |

本地组合测试 **25/25**、新授权生成器单测 **3/3**、Core Guardrails/Endpoint 定向测试 **10/10**；完整 Images staging 回归命令退出码 0，Proxy 类型检查、dispatch safety 窄类型检查、Core 变更文件定向类型检查与 dispatch-intent 窄类型检查通过。Worker owner 的 workerd 条件 bundle 静态检查 **1/1**；本机 workerd 在模块执行前发生 Windows `0xc0000005`，不能计入运行时通过。新 workerd 夹具、授权单测和四组原生夹具已登记 [Linux CI 工作流](../../../../.github/workflows/proxy-dispatch-safety.yml)，尚无 CI 运行结果。Core 全量 `tsconfig.json` 检查仍被既存测试文件的 `vitest` 类型缺失及其他测试类型错误挡住；本轮改动所用的窄检查通过。原始报告与源码摘要见[机器结果](./C03-postgres-http-financial-chain-v329-results.json)。

本地直连 URL 仅模拟三个 Hyperdrive binding，受控 provider 不代表外部 provider 或真实凭据。没有真实 Worker/Hyperdrive origin 容量及关闭收据、Queue ACK/重投/跨 isolate 排他、代表性旧库回填/保留期或生产授权审核；`queueAckSafe` 继续为 false。C03.4、C03.5、C03.7、C03.G 与 C01.G/C02.G 均不勾选，DBL-04/05/06/08 未闭合。首轮 staging US$2 上限不重置；本轮远端 SQL、云管理、部署、模型和 KMS 调用均为 0。
