# C03 v331：旧请求防重放登记与兼容切换

2026-09-24；**本地子集通过，生产关闭，C03 DOING**。承接 [v330 旧库升级与保留期只读审查](./C03-postgres-old-upgrade-retention-v330.md)。全部数据库操作只在夹具自行创建并清理的回环 PostgreSQL 18.6 上执行；73 条正式迁移未增加，没有远端 SQL、部署、云端模型或 KMS 调用。

## 设计与实测边界

- 正式 0069 intent 没有原始请求摘要、请求级总尝试预算或原始请求期限。原生反例可合法存在 `attempt_index=4`、同一 request ID 跨 operation、历史 `outcome_unknown` 后还有 prepared attempt；原 parent 提案会原子拒绝。新增[只读分页盘点](../../../../scripts/db/cutover/build-request-legacy-parent-census.mjs)只记录这些障碍，不伪造可信 parent。
- 新的 review-only [永久请求 ID 登记](../../../../packages/core/migrations-proposals/postgres/request-dispatch-replay-reservations.sql)在旧 intent 与普通日志 INSERT 的同一事务登记 ID。七类来源的[有界可续跑回填](../../../../scripts/db/cutover/build-postgres-replay-reservation-backfill.mjs)每批最多 500 个 ID；[parent gate](../../../../packages/core/migrations-proposals/postgres/request-dispatch-replay-parent-gate.sql)在短锁和最终逐源反查后安装。旧日志晚于游标或切换后到达仍登记；已登记但无合法 receipt 的新 parent 日志 ID 不能被旧写者抢占。运行时授权重跑会撤销普通 runtime 对登记表及五个函数的权限。[财务直连授权生成器](../../../../scripts/db/cutover/build-financial-consumer-direct-login-grant.ts)只在显式 `replayReservationPhase: 'parent-gated'` 时接受完整 replay 结构，精确核验新增触发器与函数；默认阶段继续拒绝。
- [legacy-aware parent 激活](../../../../scripts/db/cutover/build-request-legacy-parent-default-acl-activation.mjs)固定原 parent 提案源码摘要，要求旧活跃 intent 进入终态、旧列级 writer 授权撤销，并把 parent 与 replay gate 放在同一事务安装。旧 intent 和未知 claim 原样保留；旧 ID 永远不能变成新可信 parent，新 ID 才接受新的摘要、期限和预算。缺登记、锁超时或默认 ACL 漂移均回滚。该方案没有对旧请求做可信字段回填或删除旧结构。
- [只读保留期分类](../../../../scripts/db/cutover/build-postgres-replay-retention-candidates.mjs)继续给所有样本 `delete_allowed=false`。永久 ID 登记不等于已批准的保留期限；历史行、事实、日志或登记表均未进行清理。
- 默认关闭的 [Queue 处置候选](../../../../packages/proxy/src/runtime/postgres-recovery-queue-disposition.ts)等待 owner 原 Promise 结束，阻止 owner 提前 ACK，随后对所有结果显式请求重试。当前 V1 wake 没有持久消息级回执，`run_drained` 也不授权 ACK；候选未接 Worker handler。声明的 DLQ 参数仅本地形状校验，未核对真实 Cloudflare 配置。

## 本地验证

| 证据 | 结果 | 实际覆盖 |
| --- | --- | --- |
| [旧 intent 盘点原生报告](./C03-postgres-native-legacy-parent-census-v331-report.json) | PG18.6，1/1、4 阶段、cleanup PASS | 73 正式迁移、0069 缺失的三个原始字段、合法旧行反例、原 parent 原子拒绝和只读游标续跑。 |
| [防重放登记原生报告](./C03-postgres-native-replay-reservations-v331-report.json) | PG18.6，1/1、19 阶段、cleanup PASS | 真实旧列级 writer、1201 字节日志 ID、七源批量与最终反查、低排序晚到 ID、2 秒锁失败回滚、授权重跑、并发同 ID、断线回滚、receipt→log→job 同事务；无 receipt 或 user/operation 不符的日志被拒。财务 receipt 子例用 migrator，未代表独立消费者身份。 |
| [旧 parent 激活原生报告](./C03-postgres-native-legacy-parent-activation-v331-report.json) | PG18.6，1/1、10 阶段、cleanup PASS | 真实 runtime 默认 ACL、扩展期旧写者、活跃旧行终态门槛、缺 ID 登记回滚、同事务 parent+gate、旧 ID 阻断与新 ID 准入；旧日志写者切换后继续登记。 |
| [财务直连授权原生报告](./C03-postgres-native-financial-replay-grant-v331-report.json) | PG18.6，1/1、14 阶段、cleanup PASS | 73 正式迁移、旧日志 guard、parent、replay base/gate 之后，默认 grant 拒绝；显式 `parent-gated` grant 对 SCRAM LOGIN 生效。禁用 replay trigger、函数正文漂移或额外触发器均原子拒绝。 |
| [填充旧库读者报告](./C03-postgres-native-old-reader-v331-report.json) | PG18.6，1/1、10 阶段、cleanup PASS | 512 条旧日志摘要不变；实际请求日志仓储迁移前读到 513、0073 后 515、guard 后 516 条。读者是当前未改动的仓储查询形态，不是历史部署二进制。 |
| [Images HTTP 与资金链报告](./C03-postgres-native-http-fetch-boundary-v331-report.json) | PG18.6，1/1、4 阶段、cleanup PASS | 同一合成 Hono Images 请求经过 replay base/gate、旧日志 guard、真实 `parent-gated` 财务直连授权、不同 runtime/dispatch/fact/financial 密码 LOGIN，登记 1 个 ID、一次受控 fetch、receipt/log/attempt/audit 各 1、支出 `0.040000`；fetch 等待前/中两次观察均为已提交 claim 1、资金事实 0、生产者未结束事务 0。只覆盖这一条路由，不证明所有网络路径或真实 Hyperdrive。 |

legacy 三项单测 **3/3**、财务授权与角色目录 **10/10**、Queue owner 与处置候选 **24/24**、Proxy 类型检查通过。新增原生和单测已登记 [Linux CI 工作流](../../../../.github/workflows/proxy-dispatch-safety.yml)；YAML 本地解析通过，Linux job 尚未运行。机器摘要与源码/报告 SHA 见 [结果 JSON](./C03-postgres-replay-legacy-parent-v331-results.json)。

C03.7 仍缺代表性旧库的批量成本、最终全表反查锁窗、生产维护和 contract/保留政策；C03.G 仍缺全部历史 handler 与真实 Workers/Hyperdrive/Queue、跨 isolate/物理关闭及 DBL-04/05/06/08。C03.4／C03.5／C03.7／C03.G、C01.G／C02.G 均不勾选。生产保持关闭，首轮 staging US$2 上限不重置。
