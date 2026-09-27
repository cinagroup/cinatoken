# C04：平台 no-fetch 事件的持久投递与幂等消费（v402）

本批次接续 [v401 实际 Hono 入口](./C04-exclusive-credential-free-chat-ingress-v401.md)，补 C04.6 中已存在的 [v388 平台 no-fetch outbox](./C04-complete-text-no-fetch-platform-close-v388.md) 的投递协议。新 SQL 为 review-only，必须显式设置 `cinatoken.complete_text_platform_event_delivery_v402_activation=reviewed_v402`；Node／Workers 默认配置未启用。

## 实现

- [SQL 提案](../../../../packages/core/migrations-proposals/postgres/complete-text-platform-event-delivery-v402.sql) 由 [生成器](../../../../scripts/db/cutover/build-complete-text-platform-event-delivery-v402.mjs) 固定继承完整 v400／v401 catalog 后生成。只新增私有 `cinatoken_platform_delivery` schema、jobs／batches／projections／receipts／restores，以及公开窄函数和两个独立 LOGIN。
- [数据库客户端](../../../../scripts/db/cutover/postgres-complete-text-platform-event-delivery-v402.mjs) 核对 URL、真实 `current_user`／`session_user`、Read Committed 和精确 JSON 回执；每次操作等待 COMMIT 与 LOGIN close，未知 close 抛 typed error。
- [投递适配器](../../../../scripts/db/cutover/complete-text-platform-event-delivery-runner-v402.mjs) 持久扫描 → claim → `queue.send(eventId)` → finish。消息正文仅 UUID，broker 不接收报价、凭据或财务载荷。consumer 重读数据库证据，等待实际消费事务及 close 后才 ACK。

### 精确 schema 合同

SQL postflight 和生成器的 JavaScript 核验同时固定新表的 owner、列、ACL、RLS／rules，以及 PostgreSQL 18 的 **57 个约束、8 个索引**。约束包括 catalog 中的 NOT NULL、主键／唯一键、外键与 CHECK；核对定义、validated 和 deferrable 状态。索引核对定义、unique／primary 与 valid／ready／live 状态。

| 新表 | 约束 | 索引 |
| --- | ---: | ---: |
| `jobs_v402` | 13 | 2 |
| `batches_v402` | 8 | 1 |
| `projections_v402` | 19 | 3 |
| `receipts_v402` | 8 | 1 |
| `restores_v402` | 9 | 1 |
| 合计 | 57 | 8 |

新 `delivery_indexes` catalog 字段单独核对后，在比较旧基线摘要前移除；旧 v400 catalog 查询未改。新公开函数显式撤销继承的 runtime EXECUTE，只给对应 publisher／consumer 授权；旧默认 ACL 保留。完整继承目录仍须相等。

约束和索引的精确 deparse 来自 embedded PG18.3 的新 DDL 检查，依赖仅为 12 个 typed baseline stubs。该检查不执行继承的 v388／v400／v401 协议，不证明真实历史行、角色权限或完整共装；这些证据须由下述独立 PG18.6 原生运行提供。

首轮 native 发现语法错误后，生成器单元另用 embedded PG18.3 编译两个完整 installer DO，确认到达未激活门禁的预期 `P0001`；故意插入额外括号时必须返回 `42601`。这项检查不执行成功安装或 postflight 的实际 authority 核验。

### 投递与消费

扫描不使用永久水位：每次寻找尚无 job 的实际已提交 v388 事件，consumer-before-scan 的已消费事件随后登记为 delivered。事件 mutex 协调扫描和消费；due jobs 用 `FOR UPDATE SKIP LOCKED` claim。claim nonce 持久绑定 limit 和原批次，重放不领取新事件或再次增加 attempt。

lease 和 published visibility 均为 30 秒。`published` 只证明 broker 接收，未收到消费回执会再次到期。每次新 claim 计一次 attempt；失败退避依次为 5／15／45／135／405／1215 秒，第 7 次失败或第 7 次未消费 lease 到期后进入 dead letter。自动投递不能恢复死信；迁移者带明确原因最多恢复 3 次，历史追加保存。

消费仅接受实际不可变 `platform_text_no_fetch_closed`／version 1。函数重读 outbox、terminal、quote、grant、永久未发送 resolution、零买家日志、普通及全部 Guardrail 终态和 payload 摘要，同事务写不可变 projection／receipt，并把已有 job 标记 delivered。延迟 companion 约束拒绝缺回执、缺 projection 或 delivered job 无回执。历史账户及窗口余额允许后续请求或周期维护改变，不用当前余额冒充历史关闭时的计数器快照。

source reader 在事务内固定 UTC；grant／quote／resolution 与普通／Guardrail 关闭前快照用实际 ROWTYPE 归一化时间戳，再比较当前 typed 行。零买家日志也先按实际 ROWTYPE 归一化，只保留原 `expected_log` 的部分键进行 containment。原 payload 和存储摘要不重写。读取逻辑保留关闭时选定 fact 的身份／摘要，不因合法后续 `provider_bill` fact 的出现单独否定既有事件；这不确认该账单金额或财务终态。

## 验证

[联合单元报告](C04-complete-text-platform-event-delivery-v402-unit-report.json) 为 **76/76 PASS、0 skipped**：生成器 27、实际客户端 26、runner 23。12 文件 pins、core 327／proxy 454 corpus 在运行前后保持一致。客户端／runner 的 SQL factories 是受控替身，单元报告不独立证明 PostgreSQL 权限。报告 SHA256 为 `341e04f229d9b0f40fd08bd7b467b3a36e4b18b19914e47d92d2f0c7b4e67ccc`。

[本机 PG18.6 原生报告](C04-postgres-complete-text-platform-event-delivery-v402-report.json) 为 **166/166 阶段 PASS、cleanup PASS**：143 个冻结继承阶段、23 个新阶段。共 **17 项实际 installer 负例**，其中旧 14 项、新 3 项为默认关闭、额外 consumer 财务列权限和额外继承 outbox trigger；每次拒绝后目录恢复相等。另有 publisher／consumer 各 7 项、合计 **14 项 raw authority 拒绝**，均返回 `42501`，覆盖原始凭据、金融表／job／receipt 直接访问及不相关函数；这 14 项不计入 installer 负例。

新协议阶段覆盖 actual LOGIN／事务、consumer-before-scan、持久 claim nonce 重放与错误 limit `22023`、持锁 due row 的确定性 `SKIP LOCKED`、并发 publishers／重复 consumers、claim／finish／consumer 的真实 COMMIT ACK 丢失，以及 broker ACK 丢失后延迟消费。consumer runner 在未知 COMMIT 时 ACK 为 0；独立 LOGIN 读到已提交 receipt 后重放，ACK 一次，不重复写 projection。published visibility 到期可重投相同 UUID，七次尝试、有限退避、三次带原因恢复、第四次拒绝，以及最后第七 lease 的真实服务器 30 秒到期均完成。

最终 **6 个实际历史事件 → 6 个 projection／6 个 receipt**，新增 Provider POST 为 **0**，继承共 **15 次 owned loopback POST**。新 helper 前后金融／source snapshots 相等。installed／end 完整 catalog 相等：**153 functions／98 relations／148 triggers／8 schemas／28 principals／3 default ACL**；全部旧 142 functions／93 relations／135 triggers 保留，新表的 57 constraints／8 indexes 逐项核对。最终 catalog SHA256 为 `cda6b958658be78f896ca640081331e5e64eea8e952f70f71a56097d31d9a98d`。

独立机器核对确认 **158 来源摘要（157 文件 pin 条目、153 不同文件，加 PG73 聚合）**、unit 12 pins、core 327／proxy 454 corpus 均稳定；历史来源及正式迁移未改。原生报告 SHA256 为 `a38a28402df1fa666f82cabddda4b2a57d05d0ffd69da4941cf19521522539ab`。最终 SQL SHA256 为 `27fd0ed66d065343223ecf7ca8c151511e76345977c496e49fdceee86012d940`，生成器 SHA256 为 `d33964d367dc0568c3f7b07e9a7160e33481af7ea9e5e357364e11f22df33c5b`；内存 render 与保存 SQL 逐字节相同。

[首轮失败报告](C04-postgres-complete-text-platform-event-delivery-v402-failed-first-run-report.json) 保留 **146 个已通过阶段、cleanup PASS**：成功安装时生成器 postflight 的多余括号触发 `42601`，新 delivery helper 尚未执行。修复生成器／生成 SQL，并增加完整 DO 编译回归后重新运行得到上述完整结果；没有把首次失败改成通过。失败报告 SHA256 为 `6f37eb1365c09106794043d5398fbf4fdee68706452bc8aa414df907da455909`。[初次 75 项单元报告](C04-complete-text-platform-event-delivery-v402-initial-unit-report.json) 仍保留 pending-native 的历史状态，不代替最终 76 项报告。

[scoped tsconfig](../../../../scripts/db/cutover/postgres-complete-text-platform-event-delivery-v402.tsconfig.json) 类型检查通过。[CI](../../../../.github/workflows/proxy-dispatch-safety.yml) 已登记单元与原生运行，并固定安装 PGlite `0.5.8`、显式传入 `GATEWAY_PGLITE_MODULE`；本机完整 DO 编译检查没有 skip。Linux CI 尚未运行。

## 边界

该消费者确认已提交平台终态的投递和 projection，不新增供应商账单，不扣买家款，不给卖家收益。零买家关闭仍为供应商成本 `not_asserted/null`，不是零费用账单。已发送／unknown 请求的普通及 Guardrail 持仓继续保留。

native 使用本机 PG18.6 与进程内 UUID 消息适配器，未运行真实 Cloudflare Queue／Hyperdrive／Cloudflare Worker／Linux CI，未做远端 SQL、部署或付费 Provider 调用。

[新 helper](../../../../scripts/db/cutover/exercise-complete-text-platform-event-delivery-v402.ts) 的有限重试场景使用受限时间探针：仅临时给 **两个新函数** `protect_jobs_v402`／`verify_companions_v402` 加相同的仅迁移者可进入的分支，允许单个新 job 仅改变 `next_attempt_at`／`lease_until`，其他字段保持相等。它在分支有效时执行 `SET CONSTRAINTS cinatoken_platform_delivery.jobs_v402_companion IMMEDIATE`，随后恢复两个原函数再 COMMIT；后续协议调用前比较完整 installed catalog。trigger 始终启用，新探针不改金融历史、source、batch、projection 或 receipt。5–1215 秒退避从真实服务器时间戳断言，再人工推进；第三次恢复后的第 7 个 lease 则等待真实服务器 30 秒到期。前者不能替代真实 1215 秒等待或生产调度验收。

native 使用 **6 个实际旧 source**；其中同一个已消费 source 通过实际 postgres.js factory 的新 LOGIN TimeZone 设置，在 `Asia/Singapore`／`America/New_York` 两个显式会话中重放 consume 并 observe，不写 role GUC。该场景没有逐一对六个 source 运行时区矩阵，也没有单独生成或记录历史 closer 的 TimeZone 矩阵；不能扩写为历史 closer 所有时区的原生覆盖。

继承的 143 阶段仍适用 [v400 证据边界](C04-complete-text-auth-routing-recovery-coinstall-v400.md) 和 [v401 fixture 边界](C04-exclusive-credential-free-chat-ingress-v401.md)：只覆盖指定安装顺序；公开入口是 Hono in-process Request／Response，trusted projector decorator 发布实际 routing attestation；仅注入的 physical fetch 把准备好的 HTTPS fixture 地址转为 owned HTTP loopback。旧阶段还包含 owned-cluster 管理者缩短 deadline、临时 privileged wrapper 及 malformed cross-grant observation 探针，随后恢复／删除。COMMIT proxy 只证明 backend COMMIT 已完成而客户端 ACK 被抑制，未证明远端 pooler／close ACK。physical start COMMIT 到 Provider POST 之间的配置漂移、历史协议全局无死锁和未提交 observation 前的 durable response spool 继续未证明。

正式迁移 PG73／D1 68／MySQL64、staging US$2 上限不变。C04.1–8／G 仍不勾选；供应商来源认证、实际扣费政策、sent／unknown 财务终态、完整收益事件、正式迁移及部署验收继续开放。
