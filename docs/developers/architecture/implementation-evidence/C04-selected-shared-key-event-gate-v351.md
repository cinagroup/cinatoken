# C04.5 选中共享 Key 日志的事件提交门禁（v351，2026-09-25）

状态：**review-only / 默认关闭**。没有正式迁移、远端 SQL、生产角色或部署变更。

## 原有缺口与提案

v339 的延迟约束触发器在同一请求存在预发送 quote attempt 时，要求买方日志事务同时提交 typed economic event。这覆盖已声明的共享 Key 尝试，但旧同步写者仍可写入 `provider_key_id='sharedkey:<id>'` 且没有 quote attempt 的日志。隔离夹具在 v351 安装前复现了该日志提交成功、事件缺失。

[v351 SQL 提案](../../../../packages/core/migrations-proposals/postgres/shared-key-selected-event-gate-v351.sql) 需要迁移者在单个事务中显式设置 `cinatoken.shared_key_selected_event_gate_activation=reviewed-v1`。它只在正式 PG73、v339 quote/attempt/outbox 对象及权限和触发器与审阅形状相符时安装。提案不修改 v339 函数、旧付款表或生产授权。

提案先取得与后续金融授权脚本相同的 advisory transaction lock `746923553`，再锁定相关日志、报价、事件和旧收益表，避免并发迁移以相反顺序进入对象锁。新增触发器只拒绝不合规提交；它没有独立的发送、支付、收益入账或事件生产能力。
预检允许 v340 为受控生产者函数调用而授予 runtime 的经济 schema `USAGE`，但拒绝 schema `CREATE` 及私有事件表的直接读写授权。[v347 买方生产者组合验证](./C04-selected-event-buyer-composition-v351.md)覆盖了这一次序。

新增的延迟 `AFTER INSERT` 约束触发器检查日志最终的 `provider_key_id`。以 `sharedkey:` 开头的日志必须在提交时有该请求的 typed event，且该 selected ID 必须出现在该 event 的不可变 attempt 明细中。v339 的事件验证仍独立检查完整 quote attempt 覆盖；v339 的旧收益写入触发器仍阻止事件与同步付款双付。新的 `BEFORE UPDATE` 触发器使 `provider_key_id` 在插入后不可变，防止先提交普通日志、再改成共享 Key 日志。事件对新日志的外键和不可变事实使提交前可见的事件属于该日志的插入事务。

## 本地验证

[原生夹具](../../../../scripts/db/cutover/postgres-shared-key-selected-event-gate-v351.native.test.mjs) 在自有隔离 PostgreSQL 18.6 上安装正式 PG73 和 v339 前置提案，再验证 v351。命令：

```powershell
$env:GATEWAY_NATIVE_PG_BIN='C:\cinagroup\cinatoken\.wrangler\staging\pg-native-v292-binaries\extracted\pgsql\bin'
node --import tsx --test scripts/db/cutover/postgres-shared-key-selected-event-gate-v351.native.test.mjs
```

[机器报告](./C04-selected-shared-key-event-gate-v351-results.json)：**1/1 测试、14/14 阶段 PASS、cleanup PASS**，保存 SQL、夹具和正式迁移语料 SHA-256。覆盖：

- 无激活标志的安装原子回滚；经济事件表 ACL 或 v339 延迟触发器漂移时拒绝安装。
- 没有 quote/event 的旧共享 Key 买方日志、预算更新和同步收益写入同一事务回滚；普通 provider 日志可提交。
- 已 quote 但最终非共享 Key 的日志仍由 v339 拒绝无事件提交；quote、事件、attempt 明细与选中共享 Key 一致时可提交。
- 选中 ID 与事件 attempt 不一致时回滚；提交后的 `provider_key_id` 不可改；v339 双付保护继续拒绝旧收益。
- 普通 runtime 即使获得测试用日志 INSERT 权限，直接 SQL 仍无法越过门禁、禁用触发器或写私有事件；测试临时授权已撤销。

[真实买方 critical writer 组合](./C04-selected-event-buyer-composition-v351.md)另在 v346/v347 角色栈上验证 `recordUsage` 的选中共享 Key 日志与 v2 事件同事务提交，以及省去事件时买方事务整体回滚；原生 **21/21 阶段、cleanup PASS**。该组合发现并修正了本提案预检对 v340 函数调用所需 schema `USAGE` 的过严拒绝，当前预检只拒绝普通 runtime 的 schema `CREATE` 和私有事件表直接读写。

## 范围限制

若在仍由旧同步写者服务共享 Key 流量时单独安装此门禁，旧买方日志会在提交时被拒绝；正式切换必须先排空在途请求，并与可信事件生产者、消费者和恢复流程同一锁窗协调。

门禁只观察最终 `provider_key_id`。较早发送共享 Key、最终回退到其他 Key 的请求仍依赖 v339 quote claim 和发送前 pool gate。selected ID 出现在事件明细中，不等于证明它是最后一次 route outcome；真实买方组合只证明事件与日志同事务提交。原门禁夹具的成功事件由受信迁移者直接写入；组合夹具虽验证本地 buyer LOGIN 与 `recordUsage`，仍未验证真实 Worker/Hyperdrive 凭据、生产迁移次序、历史日志回填、Linux CI、D1/MySQL 对等协议、消费者或提现。C04.5 和 C04.1–8/G 仍开放。
