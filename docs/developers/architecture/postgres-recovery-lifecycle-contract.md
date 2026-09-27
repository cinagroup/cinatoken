# PostgreSQL 恢复执行、观察、取消与关闭合同

当前状态（v327）：[Images 生产者直连登录身份](./implementation-evidence/C03-postgres-direct-login-producers-v327.md)在隔离 PG18.6 以独立 SCRAM 密码连接验证 runtime／dispatch／fact 角色、两份显式直连权限生成器、组合 factory 与本地登录预配；四份原生报告各 **1/1**，共 26 阶段且 cleanup PASS。parent 授权额外拒绝 dispatch 对其他 gateway 关系或 definer 的权限；预配拒绝已有 `LOGIN` 角色的 NULL／MD5 校验器，除非显式轮换。factory 在入口预检 runtime，并将每次生产者 SQL 与身份核对放在同一事务；两处都检查 `session_user` 和 `current_user`。双 origin 校验只证明输入快照的算术；生产凭据、真实 Hyperdrive／Node origin 绑定与当前容量、独立资金 consumer、旧库和 Workers／Queue 未验收。正式迁移仍 73 条，授权 review-only，C03.4/C03.5/C03.7/C03.G 与 DBL-04/05/06/08 保持开放，生产禁用。

历史状态（v326）：[Images dispatch／fact 生产者角色分离](./implementation-evidence/C03-postgres-producer-role-split-v326.md)在隔离 PG18.6 证明独立合成角色的 parent claim、fact/outbox/job 精确列授权和实际拒绝：parent grant **2/2（17 阶段）**、fact/job grant **2/2（13 阶段）**、组合 factory **1/1（7 阶段）**，均 cleanup PASS。factory 对每次生产者 SQL 在同一事务核对 `current_user`；普通 runtime 身份仅抽样。角色仍 `NOLOGIN`，生产登录来源、Hyperdrive/origin 容量、独立资金 consumer、旧库和 Workers/Queue 未验收；正式迁移仍 73 条，提案 review-only，C03.4/C03.5/C03.7/C03.G 与 DBL-04/05/06/08 保持开放，生产禁用。

历史状态（v324）：[parent ACL 与 Images 单次 grant 桥接证据](./implementation-evidence/C03-postgres-parent-acl-images-bridge-v324.md)验证普通 runtime 授权脚本重跑后的 parent 表／函数收权，以及已有 runtime 默认 ACL 下显式单事务安装、失败回滚和完整恢复；隔离原生 PG18.6 分别 **1/1（5 阶段）**、**2/2（7 阶段）**，cleanup PASS。Images generations／edits 的单次 grant bridge 把预算票据交到 driver 前回调，只有完成确认标记才允许 fetch；claim 前合成拒绝保留原错误且零恢复／旧财务写入，claim 标记后取消返回不可自动重试的结果不明响应。路由 **436/436**、相关定向 **52/52**。attempt context helper 能绑定可信入口、route 与逻辑出站内容，但尚未接入 claim；driver 先准备载荷、helper 再从可变输入重算，尚无同一不可变快照保证。生产 PG factory、真实生产者身份/权限、结果事实与资金结算、旧库升级/保留期以及 origin/Workers/Hyperdrive/Queue 继续开放。提案仍 review-only，正式迁移 73 条，生产禁用；C03.4/C03.5/C03.7/C03.G 与 DBL-04/05/06/08 不勾选。

历史状态（v323）：[parent／预算／Images 本地组合证据](./implementation-evidence/C03-postgres-parent-budget-images-v323.md)增加显式 opt-in 的 parent 函数 adapter、Images 服务端入口摘要、两阶段预算票据和单次 grant 路由能力。PGlite adapter 1/1、摘要 6/6、预算 15/15、Images 路由 422/422；隔离原生 PG18.6 在 73 条正式迁移和三份 review-only 提案上，把 parent adapter、预算协调器与实际 Images generations driver／假 fetch 组合，1/1、5 阶段、cleanup PASS。已持久 claim 的回执前两账簿仍预留且零 fetch；确认后才标记 dispatched 并一次 fetch；明确拒绝释放，模拟回执丢失保留预留、零 fetch。该原生夹具的预算仓储、digest 和 fetch 为测试替身；入口 digest 与 adapter 尚未接生产 factory，Guardrail 后载荷 context、真实资金/结果事实、生产者身份/权限、旧库与真实 origin/Workers/Hyperdrive/Queue 仍开放。提案保持 review-only、恢复角色 `NOLOGIN`、生产禁用，C03.4/C03.5/C03.7/C03.G 与 DBL-04/05/06/08 不勾选。

历史状态（v322）：[请求级 parent 与 Images grant→fetch 分项证据](./implementation-evidence/C03-postgres-request-parent-grant-fetch-v322.md)将调用者给定的请求摘要、原始期限和总尝试次数冻结在 review-only PostgreSQL parent 中，V1 上限 3 次／300 秒；prepare／claim／classify 按 parent→attempt 锁序，默认 ACL／角色继承、旧 intent 行和直接写权限使激活事务回滚。PGlite 1/1，隔离原生 PG18.6 1/1（15 阶段、双连接提交／回滚）、cleanup PASS。独立原生夹具在 v320 提案上以实际 `proxyImageGenerations`／Images driver 与假 fetch 验证确认 grant 前零 fetch、确认后一次 fetch并保留首个已知 503，拒绝／模拟 ACK 丢失零 fetch，1/1（6 阶段）；它没有安装 parent 或经过完整 HTTP／结算入口。Images generations／edits 对合成恢复对象的 PG claim 不明错误公开 503、`outcome_unknown:true,retry_safe:false`，完整路由 414/414、类型检查通过；没有 PG factory 生产接线。请求摘要可信派生、现有 attempt 优先直接 DML repository 改造、真实 origin/资金/撤权/保留期/旧库、Workers／Hyperdrive／Queue 与 DBL-04/05/06/08 均开放，恢复角色仍 `NOLOGIN`、`runtimeCompatible:false`，生产禁用。

历史状态（v321）：[保守单次派发的本地 failover 候选](./implementation-evidence/C03-postgres-conservative-failover-v321.md)在 Proxy 的 `failoverDispatch` 增加 opt-in `stopAfterFirstGrantedDispatch`；它必须配合驱动委托的 `beforeUpstreamDispatch` 回调，缺少任一条件即在派发前拒绝。回调成功后，已知非 2xx 保留原始 Response、所选 route、usage Promise 和上游请求 ID，设置 `failoverForbidden`，不因保守开关伪造 `upstreamOutcomeUnknown`；授权后抛错停止后续 route，授权前可继续的本地准备失败仍可前进。默认行为不变，本地定向套件 59/59 与 dispatch-safety 类型检查通过。回调在本轮测试中不等于 PostgreSQL 持久 claim；此候选未接生产 Worker/Node、真实生产者身份、结果结算或真实 origin，不能证明每 grant 至多一次 fetch、unknown 分类/事实来源及端到端停止重试。v320 数据库提案仍 review-only、默认关闭且位于正式迁移之外；恢复角色保持 `NOLOGIN`、`runtimeCompatible:false`，C03.5 / C03.G 与 DBL-04/05/06/08 继续开放。

历史状态（v320）：[claim 授权与请求门禁预检修正](./implementation-evidence/C03-postgres-claim-auth-request-gate-hardening-v320.md)修复 v319 的两处证据/预检缺口：此前 `is_default=NULL` 负例没有有效 Workspace 成员，不能证明 NULL 标志本身拒绝 claim；现有 definer 在组织 Workspace 的成员分支前显式拒绝 NULL，新 PGlite 负例即使提供有效成员仍拒绝。请求级唯一索引提案将已绑定 intent trigger 的时机、事件、行级、非延迟、无 WHEN/列列表/参数/transition table 纳入预检；PGlite 与隔离原生 PG18.6 均验证仅 BEFORE INSERT 的漂移整体回滚且索引不留下。两个提案 PGlite 2/2；原生授权生产者 1/1（8 阶段）及请求级组合 1/1（9 阶段），两套清理 PASS。v319 冻结报告只说明当时源码及测试，不能代替 v320 的修正证据。提案仍在正式迁移之外、默认关闭；真实生产者身份、完整请求准入/预算/unknown/结果来源、claim 后撤销、旧库索引持锁与重复 claim 处置、保留期、Workers/Hyperdrive/Queue 和 DBL-04/05/06 均开放，恢复角色仍 `NOLOGIN`、`runtimeCompatible:false`，C03.5 / C03.G 不勾选。

历史状态（v319）：[claim 时租户授权与单请求持久门禁](./implementation-evidence/C03-postgres-claim-auth-request-gate-v319.md)修改现有 intent definer 提案，并增加请求级索引提案；两者均默认关闭、位于正式迁移之外。intent definer 在 claim 事务中按 Key、User、Workspace、Org、成员关系顺序锁定并复核当前授权，等待后再检查 Key 到期和 intent 截止；PGlite 覆盖失效条件及生产者直接读取禁权。`request_id` 的非空 claim 唯一索引保守限制每请求最多一个已提交 claim；隔离原生 PG18.6 先复现旧 schema 两次 attempt 均 claim 的反例，再证明提案对存量重复回滚不清理、首笔 COMMIT 后竞争者拒绝、首笔 ROLLBACK 后竞争者获 grant。原生授权生产者和单请求门禁各 1/1、清理 PASS；未在真实 Worker/Hyperdrive 运行。保守门禁也禁止已知拒绝后的 fallback；已 claim 后撤销与 unknown 策略、删除/保留期、生产者真实身份、请求级准入和结果来源仍开放。提案不在正式迁移，切换默认关闭，恢复角色仍 `NOLOGIN`、`runtimeCompatible:false`，C03 / ST-12 与生产启用门禁开放。

历史状态（v318）：[旧日志流量持锁与恢复登录时限](./implementation-evidence/C03-postgres-native-upgrade-traffic-login-timeouts-v318.md)在隔离本机 PG18.6 中以 512 条合成旧日志、真实 intent/fact 写事务和普通 runtime 日志探针验证两项提案的锁等待、约 2 秒 `55P03` 回滚及成功双提案事务持锁时旧日志读写。原生登录测试显示 `SET ROLE` 不载入 `NOLOGIN` 恢复角色的 15s/30s 目录默认值；夹具会话前后保持 4s/0，独立 LOGIN 夹具的新连接 200ms statement 超时生效。此前 `SET ROLE` 资金演练不证明恢复角色登录时限。合成流量不证明代表性旧库维护窗口；生产者身份/调用者授权/准入/unknown/结果来源、真实 origin、Workers/Hyperdrive/Queue 与 DBL-04/05/06 均未验收。提案不在正式迁移，切换默认关闭，恢复角色仍 `NOLOGIN`、`runtimeCompatible:false`，C03 / ST-12 与生产启用门禁开放。

历史状态（v317）：[生产者预检与财务 COMMIT 响应丢失](./implementation-evidence/C03-postgres-producer-preflight-commit-response-v317.md)为两个默认关闭的 definer 提案补函数体、trigger/FK、角色继承和有效权限漂移拒绝；只打印的单事务 bundle 在 PGlite 证明失败时整体回滚，原生窄生产者复跑通过。独立原生资金测试截留已提交的 PostgreSQL COMMIT 协议响应，由新连接只读确认一次账务；未操纵 TCP ACK 包。生产关闭。

历史状态（v316）：[窄权限事实生产者提案与恢复负例](./implementation-evidence/C03-postgres-fact-producer-proposals-v316.md)在隔离回环 PG18.6 验证合成 NOLOGIN 生产者 intent→fact→outbox、两种 Key 改属锁顺序和恢复资金负例；当时只注入 COMMIT 已确认后的应用层结果丢失，尚无 v317 提案预检加固或协议响应丢失证据。

历史状态（v315）：[专用角色原生资金结算](./implementation-evidence/C03-postgres-native-recovery-settlement-v315.md)在隔离本机回环 PG18.6 以 `SET ROLE` 验证三笔资金路径，并复跑迁移、权限和双向 guard；0068 Workspace 函数路径进入切换与授权预检，五项 trigger 入口的多余直接 EXECUTE grant 已移除。测试迁移者负责准备事实，当时生产事实来源未验证。

历史状态（v314）：[原生 PostgreSQL 恢复角色与旧日志双向切换](./implementation-evidence/C03-postgres-native-role-guard-v314.md)取得隔离本机回环 PG18.6 的迁移、权限和双向并发子集证据；当时完整资金 writer 尚未在专用角色下运行。切换正文与只打印 SQL 的事务打包器保持默认关闭。

历史状态（v313）：[正式迁移与结算日志权限收敛](./implementation-evidence/C03-postgres-formal-recovery-migrations-acl-v313.md)当时只有本地 PGlite 证据；旧日志 INSERT guard、原生 PostgreSQL 权限/并发/持锁时长及真实服务端期限尚未验收。专用恢复角色草案保持 `runtimeCompatible:false`，C03 / ST-12 与生产启用门禁继续开放。

历史状态（v312）：普通恢复 SQL 的本地末次派发候选及恢复身份/连接预算离线预检、生产禁用；C03 / ST-12 仍未通过。承接 [ADR-0002](./decisions/ADR-0002-request-execution-settlement-states.md)、[v300 驱动候选](./implementation-evidence/C03-postgres-transaction-lifecycle-v300.md)、[v302 可拥有取消传输](./implementation-evidence/C03-postgres-owned-cancellation-v302.md)、[v303 实验 owner 接线](./implementation-evidence/C03-postgres-owned-cancellation-owner-v303.md)、[v304 CF 底层关闭门禁](./implementation-evidence/C03-postgres-cf-raw-close-gate-v304.md)、[v305 池关闭准入门禁](./implementation-evidence/C03-postgres-end-admission-barrier-v305.md)、[v306 局部队列关停门禁](./implementation-evidence/C03-postgres-local-shutdown-fence-v306.md)、[v307 固定恢复扫描接线](./implementation-evidence/C03-postgres-controlled-recovery-scan-v307.md)、[v308 显式采用构建门禁](./implementation-evidence/C03-postgres-explicit-candidate-adoption-v308.md)、[v309 类型与 Queue owner 候选](./implementation-evidence/C03-postgres-observation-queue-owner-v309.md)、[v310 前置准入截止](./implementation-evidence/C03-postgres-preinit-deadline-v310.md)、[v311 固定扫描末次派发](./implementation-evidence/C03-postgres-owned-scan-deadline-v311.md)及[v312 普通 SQL/角色预算预检](./implementation-evidence/C03-postgres-statement-deadline-role-preflight-v312.md)。本合同不新增 unknown 收费政策，不授权推理重发或生产启用。

## 一、必须分开的证据

| 层次 | 真实含义 | 能否据此释放恢复容量 |
| --- | --- | --- |
| 停止准入 | 不再注册/认领下一项恢复任务 | 不能；当前 SQL、回调及内部事务收尾仍归原执行者拥有 |
| 有限观察结束 | 观察者的等待预算已耗尽，返回冻结快照 | 不能；`completion` 仍是同一份已开始工作的完成 Promise |
| statement / transaction / callback 计数 | 本地驱动调用、事务外层、回调仍未结束 | 不能推断已发到服务器；还可能在池/驱动队列中 |
| 取消传输完成 | 新取消连接已结束 | 不能证明原查询停止，更不能证明事务或本地回调完成 |
| 原主连接 close 事件 | 驱动观察到被退役主连接的 close 回调 | 不能跨运行时推断物理释放，更不能推断 SQL 是否提交 |
| 辅助/原主连接 `raw.closed` | 指定 Cloudflare TCP socket 的原生关闭 Promise 已完成；两条连接分别观察 | 成功完成只约束该 socket；拒绝或缺失不作关闭回执，均不能证明 SQL/账务结果 |
| 物理连接关闭 | 指定连接确已关闭 | 单独不足以证明服务端 SQL 未提交，或所有本地回调均结束 |
| 同事实资金回执 | 原始结算事实的经济结果已确认 | 可报告 committed，不覆盖独立的资源不明状态 |
| 所有本地操作成功结束且 lane drain 确认 | 当前窄适配器的非流式工作完成 | 可返还该逻辑 hold；不是实际内存/跨实例容量的验收 |
| 任一驱动拒绝、关闭/取消结果不明 | 资源证据不足 | 暂保留 hold；不得通过 TTL、观察截止、后来读回或重试伪造确认 |

PostgreSQL 官方协议说明取消没有直接成功响应，主连接仍须等待查询结果；取消可能无效，断开连接也不必然阻止正在执行的非 SELECT 提交。因此取消包送达、取消连接关闭和经济结果必须分开。[协议依据](https://www.postgresql.org/docs/current/protocol-flow.html#PROTOCOL-FLOW-CANCELING-REQUESTS)

## 二、v301 可用的本地接口

`createPostgresRecoveryRun()` **只创建一次执行**，立即返回冻结的句柄：

- `completion`：完整执行、已开始消费者、SQL、独立事务回调及 lane drain；可能一直 pending。拒绝会被观察，但调用者仍拿到同一拒绝；不得另起一轮替代等待。
- `stopAdmission(reason)`：锁存停止原因；已经结算成功的结果不撤销。已确认认领但未开始结算，仍可按同一有效 lease 记录 interrupted；这是原合同的控制写，不是新认领或推理重发。
- `snapshot()`：冻结的固定尺寸计数和状态；无 SQL、参数、身份、令牌或原始异常文本。`heldLanes` 是尚未确认释放的 hold，`uncertainLanes` 是已知有驱动不明的 lane；运行中 `resources` 为 pending，不能读取初始 confirmed 值冒充释放。
- `claimObservation()`：内部单次观察拥有权，重复注册观察器（包括前一次已截止）拒绝；不累积无界计时器或重新开始预算。
- `cancelActiveScan()`：仅显式 `ownedScans: true` 的默认禁用候选可取消**当前**受控恢复扫描，未活动时返回 `null`；重复请求属于同一 Query/同一取消尝试。观察截止、abort 与 run budget 不自动调用它，取消结果也不代替完整 `completion` 或资源关闭证明。

已有 `runUsageRecoveryPostgres()` 仍等待完整 completion，且拒绝 `ownedScans: true`：实验 opt-in 必须使用可保留、可观察的单次 `createPostgresRecoveryRun()` 句柄。未把旧接口改成超时提前返回。返回结果与句柄内部状态分离，调用者修改结果对象不会修改后续快照。

`supervisePostgresRecoveryRun()` 附着于已经持有的执行句柄，不开始数据库工作。显式 profile 中两个预算均为 1–60,000 ms 的原型输入范围，不是生产推荐值或测得的内存/运行时预算：

1. `observationBudgetMs` 从附着时刻开始；到期停止新恢复任务。
2. `cleanupObservationMs` 是停止后的额外观察期，不调用 cancel/destroy，也不授权释放。总截止锚定于初始绝对时间，不因延迟 timer 重置；提前取消则使用较早的停止时间。
3. `observation` 以 completed / completion_rejected / observation_expired / clock_invalid 之一返回当时快照。completed 只说明本地 completion 成功返回，仍须检查 resources，不能理解为“全部记账成功或资源均释放”。
4. 观察截止后快照不变；后来的经济/资源结果通过原 `completion` 和新的 `snapshot()` 读取。
5. 成功/失败/截止时清除计时器和 abort 监听；迟到 timer 无效。无效/回退/抛错时钟停止准入并报告 clock_invalid，但不释放工作。无效 profile / 初始时钟会在附着前拒绝，原句柄仍归调用者负责。

单线程调度停顿或 Worker isolate 被终止时，不能保证观察 Promise 按墙钟准时返回。调用者必须为完整 completion 提供可验证的运行时寿命；v309 只有**未接任何 Worker handler 的 Queue owner 候选**，没有实际接入 fetch/Queue/Workflow，也没有把仅等待 observation 的模式作为生产用法。[Workers 调用寿命依据](https://developers.cloudflare.com/workers/platform/limits/)

## 三、v302–v307 传输、应用 owner 与 CF 关闭门禁实验边界

只有单独构建的、版本及三模块源码摘要限定的 postgres.js 3.4.9 候选提供实验接口；现有采用插件仍选择 v300，正式依赖与应用恢复器未采用 v302。

`unsafe(sql, parameters, { owned_cancel: true })` 在派发前声明该查询需要独占。普通查询默认不变。`query.cancelOwned()` 返回缓存、冻结的句柄；显式 opt-in 查询的 `cancel()` 返回同一个 `handle.result`，非 opt-in 的公共 cancel 仍保留原返回行为。

- `result`：取消传输结果。`transport_closed` 仅表示取消连接报告无错误 close；不是主查询取消成功。失败拒绝为固定 `CANCEL_TRANSPORT_FAILED`，拒绝立即被观察；不暴露 PID、取消 secret、SQL、端点或原始异常。
- `transportClosed`：独立记录 `close_observed` 或 `not_started`；结果失败时它可以继续 pending。`not_started` 只表示驱动未取得取消 socket，不证明自定义 factory 内部没有资源。
- `transportRawClosed`：单独观察辅助取消连接的原生 `raw.closed`；`raw_closed`、`raw_close_rejected`、`not_observable` 或 `not_started`，不以 CF polyfill 合成 close 冒充底层关闭。辅助 socket 的合成 close 路径会尝试请求 `raw.close()`；创建前失败且确无 socket 时，两项辅助关闭观察均标记 `not_started`，owner 不等待不存在的 socket。
- `primaryCloseObserved`：独立记录原主连接 `close_observed` 或 `not_started`；可在主 SQL 和辅助取消连接完成后继续 pending。它是驱动事件，不是跨 Workers 运行时的物理关闭回执。
- `primaryRawClosed`：单独观察原主 Cloudflare socket 的 `raw.closed`，与 `primaryCloseObserved` 分开；缺失或拒绝仍隔离退役池槽。
- `snapshot()`：固定尺寸的结果/辅助 close/辅助 raw close/原主 close/原主 raw close 状态。完成后旧快照不变；不得将其用作应用 hold 的释放凭据。
- 尚未派发的 lazy、池排队、连接准备及事务本地队列查询，可本地拒绝 57014 并移除同一队列项。主查询已结束时返回 `already_settled`，不会取消后来查询。
- 活跃取消绑定查询对象、当时 socket、BackendKeyData 的 PID/secret 及连接端点。辅助连接建立后和实际写包前再次核对目标；迟到时返回 `target_finished`、请求关闭辅助连接，不发送旧取消包。
- 在已验证的 Node loopback 路径，一旦接受活跃取消，主会话不再接后续 SQL，继续读取当前查询结果；ReadyForQuery 后请求销毁原连接。即使主查询成功或取消传输失败，也不能在旧会话上继续 SQL。v304 的 CF 编译候选在 Node 模拟中仅于原主 `raw.closed` 成功完成且连接未 end/terminate 后才允许旧池槽逻辑重连；拒绝或缺失时隔离。此结论仍不能外推为真实 Workers/Hyperdrive 验收。

本原型只验证单端点、非流式查询的合成协议边界。cursor/describe/forEach/readable 等模式及显式 reserve 句柄拒绝 opt-in；多主机取消拒绝。低层实验 `ownedStatement(sql, params)` 仍能接受调用方 SQL，**只供内部协议诊断，不能作为通用受控 SQL API**。v307 的高层运行器另以封闭 catalog 只生成 `unregistered`／`due` 两种固定恢复 SELECT（各含 all／tenant 变体），绑定参数且不向调用方暴露 Query 模式；这不等于底层所有 SQL/Query 模式已获 allowlist 验收。不支持任意用户 SQL、COPY、派发后修改 Query 模式/选项、不受控 socket factory、认证/TLS 或 pooler/Hyperdrive 的通用兼容承诺。单端点自定义 factory 的合成注入不等于这些能力通过验收。

Node loopback 的 close 观察不迁移为 Workers 物理关闭证明：安装包的 CF polyfill 会在 error 路径合成 close，destroy 也没有向调用者交还原始 close Promise。v304 默认禁用候选把合成 close 与辅助/原主 `raw.closed` 分开，并在原主底层关闭成功前阻止池槽重连；end/terminate 后迟到的底层关闭亦不得重连。在 Node 的 CF 编译产物故障注入中，合成 close、底层关闭待定/拒绝以及 end 后迟到均有本地证据；这**不是**真实 Workers/Hyperdrive 或 TLS/pooler 验收。v304 的 `pool.end()` 后池级排队 Query 虽不再派发但可能一直 pending；v305 默认禁用候选在关闭的首次异步让出前锁存 `ending`，确定拒绝池级全局 `queries` 中的 Query 与等待中的 `reserve()`，并拒绝关闭后新的 lazy Query / `reserve()`，错误固定为不含连接信息的 `CONNECTION_ENDED`。`onopen()` / `onclose()` 不得在关闭期间重开池槽或派发旧**池级**等待项；重复 `end()` 不恢复池级准入。已派发的主 SQL 仍属原执行者，并不因等待队列拒绝而获得完成/取消/经济结果证明；主 `raw.closed` rejected 或缺失时也不推断物理释放。该 liveness 修复**仅涵盖池级全局等待队列**。独立 Node loopback 反例已观察到：阻塞 socket factory 后调用 `end()`，`Connection.initial` 的 SQL 在解除阻塞后、`end()` Promise 完成前仍派发成功；事务局部队列也可在调用 `end()` 后继续派发。已取得的 warm `reserve()` 私有队列则有 Query 在 `end()` Promise 完成后仍 pending（100 ms 有界观察，不宣称数学上永不终结）。重连计时器等其余局部状态仍未完整验证；不得概括为所有已排队 Query 均能终结或优雅关闭已完成。v304–v305 内部 operation owner 保留同一个 Query，并分别登记主 SQL、取消结果、辅助 close/底层 close 与原主 close/底层 close；`drain()` 等待已登记项，取消后 lane 保持 `unconfirmed`，不凭任一关闭事件释放容量。`runUsageRecoveryPostgres()`、观察器和正式采用插件**尚未调用该入口**，生产关闭。DBL-04 仅有本地候选证据，DBL-06 未闭合。

上述 initial、事务和 reserve 反例是 **v305 阶段的已记录负对照**，不再代表 v306 候选的当前行为。v306 在 `pool.end()` 的同步关停边界拒绝尚未写出的 `Connection.initial`、事务/保留句柄私有队列和之后的首次 `listen()`；阻止已排定重连重新开放连接，也在 Describe 后的参数阶段、同步调试回调或序列化器重入关停时，拒绝未写出的后续 SQL。拒绝错误固定且不携带连接地址/SQL 参数。已经进入驱动并被缓冲的同一条 Query 仍可在 `end()` 调用后才物理写出；它属于原执行者，不是新准入或重发，也不能由此推断服务端结果。v306 的 CF 编译候选还在 Node 合成直连中覆盖 wrapper 尚在 opening、迟到 raw、`raw.closed` 拒绝、同步 `raw.close()` 抛错及并发 `end()`/`close()` 的关闭观察；同一连接的多个等待者不得互相覆盖，重复关闭不得把已知失败改报成功。完整本地矩阵见[v306 证据](./implementation-evidence/C03-postgres-local-shutdown-fence-v306.md)。

这仍是**逻辑关停**：异步 socket factory 未返回时，`pool.end()` 可以先完成，迟到 socket 只会被请求关闭，不等于获得物理关闭回执；wrapper 的 close 与原生 `raw.closed` 也不是同一种证据。真实 Workers/Hyperdrive、原生 PostgreSQL、服务端 SQL 终结、账务结果、DBL-06 可信资源解除均未因此验收。v304–v306 内部 owner 未接 `runUsageRecoveryPostgres()`、观察器或正式采用插件，生产保持关闭。

v307 在**另一个显式且默认禁用的运行级入口**接入两种固定只读恢复扫描：仓储先验证 all／tenant 范围与 1–50 的数量上限，再从四个冻结的 SQL/参数组合中选择；仅扫描回调使用 `{ owned_cancel: true }`。已通过的非空 mock 路径显示注册 `INSERT`、注册读回和未认领的 claim 行锁仍走普通 SQL；该 mock 在锁处返回 `not_claimed`，**未**验证 v307 opt-in 下真实 claim 成功、COMMIT、fail 或资金事务。`ownedScans: true` 同时要求 v302 `ownedCancellation` 与 v307 `ownedRecoveryScanFence` 能力标记，并拒绝旧的仅等待 `runUsageRecoveryPostgres()` 包装入口；owner 的直接 `ownedRecoveryScan()` 也核对 v307 标记，低层 `ownedStatement()` 的旧 v302 标记仍仅用于诊断。SHA-pinned v306 ESM/CJS/CF 产物缺少新标记，分别在容量、SQL 和 socket 创建之前被拒绝 **3/3**。普通默认路径不要求候选标识、不自动取消。观察器仍只附着同一执行句柄一次，截止只停止新工作，不启动取消包或替代完成等待。

`cancelActiveScan()` 是手动请求，空闲返回 `null`；主执行帧写入前的取消在合成协议中不发送该查询的 Query／Execute 帧或取消包，活跃取消保留同一 Query、主结果及五项取消/关闭观察。取消失败但主读成功、同步 `unsafe` 抛错、取得 hold 后 owner 构造失败，均保留不明扫描 hold；其他已确认的消费者 hold 可独立释放。`cancelOwned()` 同步抛错或交还畸形句柄时只尝试一次，后续请求得到同一固定 `CANCEL_TRANSPORT_FAILED`，原始错误文本不进入快照；此时**没有可用的五项收据句柄**，不能宣称辅助连接已关闭。Query 尚未构造或没有 `cancelOwned` 时，即时取消只得固定 `Owned cancellation driver required`，也不解除 hold。

同步取消重入若发生在参数查询的构造/描述阶段，Parse／Describe **可能已写出**，因此不能概括为零协议字节、零 SQL 文本或服务器完全未见请求；定向本地负例只证明后续 Bind／Execute 没有越过该门禁。门禁补齐前，旧 v306 产物在新重入用例中的 **0/2** 失败是当时的负对照观察；它不表示现今旧产物仍可通过运行级能力检查并复跑同一用例。最终 `.wrangler/staging/postgres-owned-cancel-v307-run-oUZ722/results.json` 本地 harness **39/39**、36 个子套件、32 个源码 SHA、16 个受保护输入；ESM/CJS/CF 每入口固定扫描 wire **4/4**、重入 **2/2**、独立负例 **2/2**，catalog **5/5**、mock **21/21**、既有 owner／观察／资金 SQL **66/66**。CF 产物仍仅在 Node loopback／进程本地 hook 下运行，非 workerd／Hyperdrive；正式依赖、采用插件、公开类型及生产恢复路径未启用。详见[v307 证据](./implementation-evidence/C03-postgres-controlled-recovery-scan-v307.md)。

v308 只在本地评估插件增加**显式** v307 修订：禁用时为空、普通启用仍取 v300；v307 三份产物及实际加载字节核对冻结 SHA、双能力标记和构建元数据。scratch core 实际工厂的两类固定扫描 wire **4/4**，新采用 harness **6/6**、旧 v300 采用回归 **9/9**，16 个受保护输入未变。esbuild/Wrangler alias 是**整个 bundle** 的驱动替换，并非仅扫描，不能由此宣布低层任意 SQL 已受控；未接正式 build/公开类型/Workers 恢复入口。离线 Wrangler dry-run 不是 workerd；本机同一已诊断的 workerd 二进制在最小业务模块之前崩溃，不计运行时验收。见[v308 证据](./implementation-evidence/C03-postgres-explicit-candidate-adoption-v308.md)。

v309 使**普通 owner 的运行时返回对象**不再含 `ownedStatement(query, params)`；四种固定扫描仍可通过私有闭包执行，任意 SQL 只留内部诊断工厂。整个 owner 的 `client.raw` 仍可执行内部 SQL，不能对外公开。新 package 子路径仅有 TypeScript `types` 条件：公开观察视图只有同一 `completion` 与只读快照，运行时导入被拒，不能从此取得扫描取消、stop、释放、连接或 SQL 权限。观察器的准入控制另为内部参数。这是类型边界，不是生产执行 API。队列候选默认关闭，未接 Worker 入口；若将来接线，Queue handler 的**主返回 Promise**须等待同一 `completion`，不能仅使用 `waitUntil` 或观察期作长期拥有者。候选在完成后才请求退役独立 client，仍固定 `physicalClose: not_observed`；本地 busy gate 只限同 isolate。由于真实 Queue handler 正常返回会隐式 ACK，而候选对 `busy`/`outcome_unknown` 正常返回，**严禁直接绑定消费者**；先取得持久排他、ACK/retry/DLQ、DBL-05/06 和实际运行时证据。见[v309 证据](./implementation-evidence/C03-postgres-observation-queue-owner-v309.md)及[Cloudflare Queue ACK 语义](https://developers.cloudflare.com/queues/configuration/batching-retries/)。

v310 给该默认禁用候选增加**在打开 client 前创建**的单调绝对准入截止：同一不可续期对象传给初始化与恢复 runner；初始化耗尽则不启动恢复，runner 入口已耗尽时在 SQL/hold 前停。时钟倒退/异常粘性失败，剩余不足 1 ms 不被写作 PostgreSQL 的 `0`（关闭超时）；恢复已启动时到期仍等待原 completion。它**不**覆盖异步 socket factory、认证/TLS、驱动池/initial/事务私有队列的最终派发，不终止服务器 SQL、锁等待或内部 COMMIT/ROLLBACK。DBL-05 的固定服务端后备上限至少需 PostgreSQL 17+ 的 `transaction_timeout`；PG16 quickstart 不具该参数，不能替代为每条 `statement_timeout`。[PostgreSQL 维护者说明](https://www.postgresql.org/message-id/2164653.1758313260@sss.pgh.pa.us)确认事务内 `SET LOCAL transaction_timeout` **不能重新设定本事务的截止**。专用角色与独立 Hyperdrive 尚未决定/配置，既有 origin 连接配额曾耗尽，不能直接新增。详见[v310 证据与路径矩阵](./implementation-evidence/C03-postgres-preinit-deadline-v310.md)。

v311 将这份**同一对象**传入每条 recovery lane 的本地 owner：普通 lazy `unsafe()` 消费、新 `begin()` 和固定扫描构造先检查，过期/坏时钟拒绝新的驱动调用。只有显式、默认禁用的固定 `unregistered`／`due` 扫描还要求新候选能力标记，并在驱动构帧后及 Describe 后 Bind／Execute 前检查；小帧在检查后同栈写出。旧 v307 缺标记时在 hold/SQL/socket 前拒绝。原 Query 的完成与取消/关闭收据仍独立拥有；已发 Parse／Describe 不能写作零协议字节，任何拒绝也不能推断服务器/物理连接已终结。普通注册、claim/fail 和资金 SQL 只有本地 owner 调用边界检查，异步队列最终派发和内部 COMMIT/ROLLBACK 仍缺；没有服务器超时实施。详见[v311 本地证据](./implementation-evidence/C03-postgres-owned-scan-deadline-v311.md)。

v312 在默认禁用候选中将同一截止交给普通恢复 SQL 的驱动末次派发检查，仍不给普通 SQL 取消权限。ESM/CJS/CF 各有 10/10 普通 wire 测试、13/13 固定扫描回归、6/6 无截止回归；post-Describe 已发 Parse/Describe 而未发 Bind/Execute，有客户端帧断言。过期拒绝退役连接可能牵连同连接的其他管线查询，已派发 SQL、内部 BEGIN/COMMIT/ROLLBACK 和服务器锁等待不受此检查终止。离线 origin 预算验证器只计算显式同实例快照；NOLOGIN 角色草案 `runtimeCompatible:false`，正式恢复迁移缺失，资金 writer 在 `api_keys` 与不可变日志上的 `FOR UPDATE` 需要尚不能授予的 UPDATE 权限。服务器端四项 timeout 仅是拟议的新登录默认值，没有执行、原生权限或 Hyperdrive 验收。详见[v312 本地证据](./implementation-evidence/C03-postgres-statement-deadline-role-preflight-v312.md)。

## 四、有限故障矩阵与当前进度

| 合同项 | 本地证据 | 剩余门禁 |
| --- | --- | --- |
| DBL-01 一次执行、停止新准入 | 扫描迟到不注册/认领，claim ACK 迟到只中断同 lease | Workers 运行时寿命/实际队列入口 |
| DBL-02 观察截止不释放 | 真实 timer、人工时钟延迟/回退/异常、重复观察拒绝、结果防篡改 | 不能替代远端执行时限 |
| DBL-03 本地各层拥有权 | 外层已拒绝时 callback/SQL 仍计数；COMMIT ACK 等待与 callback 完成分开 | 驱动内部控制语句、认证/TLS、COPY/cursor/reserve 全面覆盖 |
| DBL-04 取消传输与主查询分开 | v302–v306 的传输/owner/关闭队列本地子集保留；v307 运行级两种固定只读扫描与单次观察有 Node 候选证据：harness 39/39、旧 v306 三入口门禁 3/3、每入口固定 wire 4/4、重入 2/2、独立负例 2/2，mock 21/21。v308 默认禁用显式采用构建 6/6、scratch core 固定扫描 wire 4/4；v309 普通 owner 不返回任意 SQL、公开观察仅类型-only，Queue owner 候选 8/8；旧 v300 采用 9/9 | 诊断工厂及内部 raw 仍不能公开；全 bundle alias 不等于正式采用。Queue 候选尚无持久 ACK/retry/跨 isolate 排他，不能直接部署；完整 Query 模式、认证/TLS/pooler、实际运行时寿命、异步 socket factory 物理关闭、原生 PostgreSQL 与真实 Workers/Hyperdrive 均未验收；不是完整 DBL-04 或受支持生产接口 |
| DBL-05 服务端执行时限 | **全路径仍未验收**；v310–v312 本地截止候选、v313 正式迁移/资金修复；v314 本机 PG18.6 角色 timeout 目录值及迁移锁超时回滚；v315 三笔本地资金路径；v316 过期 lease 拒绝及提交前回滚；v317 财务 COMMIT 协议响应丢失；v318 证实 `SET ROLE` 不载入角色登录默认值，独立夹具 LOGIN 的 200ms statement 超时确由服务器执行 | 恢复角色仍 NOLOGIN，既有 SET ROLE 资金测试没有该角色登录时限；需确认同实例 origin 预算后，以实际新登录身份验证总时限、内部 BEGIN/COMMIT/ROLLBACK、自动提交、其他网络不明分支及共享管线隔离。`SET LOCAL transaction_timeout` 不能收紧已开始事务，观察截止也不证明 SQL 终结 |
| DBL-06 可信资源解除 | 成功 drain 只释放一次；驱动失败或 release 抛错继续保留 | 同一物理连接/执行代次的清理证据与安全解除流程；不能永久占满后宣称完成 |
| DBL-07 经济结果独立 | 观察截止后成功与 ACK 丢失均保持一次原金额扣费；v316 专用角色重放、过期 lease、提交前回滚和应用层结果丢失；v317 原生协议代理在 COMMIT 后截留 `CommandComplete`/`ReadyForQuery`、独立后端确认、客户端断链并由恢复角色读回，只留一次账务 | 未操纵 TCP ACK 数据包；真实网络中间件、原生完整并发/WAL、既有未决授权/收费政策仍开放。协议响应丢失不代表所有网络故障 |
| DBL-08 原生/Workers/Hyperdrive | v314 隔离回环 PG18.6：73 条正式迁移、dispatch 12/12、角色/双 guard 1/1；v315 三笔专用角色资金路径；v316 合成生产者与恢复负例；v317 预检加固后生产者与资金协议响应丢失各 1/1；v318 合成旧日志并发提案和登录时限各 1/1；v319 原生授权生产者正常路径和单请求 claim 竞争各 1/1；v320 PGlite 两项负例 2/2、原生生产者和请求级组合各 1/1；v322 parent 提案 PGlite 1/1、原生双连接 1/1（15 阶段），独立 `proxyImageGenerations`／Images driver 假 fetch 夹具原生 1/1（6 阶段），两套 owned 集群清理 PASS | 本机合成旧日志和空库请求不等于代表性旧库/完整请求流量；v322 grant→fetch 夹具没有安装 parent，也无生产入口、真实 origin 或结算。默认关闭的提案不等于真实 Workers/Hyperdrive、同实例 origin 或生产身份验收；旧库回填/持锁、真实 Queue 与故障矩阵/发布门禁仍开放 |

## 五、下一有限实现顺序

1. 继续 DBL-04：保留 v305/v306 旧候选负对照及 v307 固定 scan/重入回归；v309 已将普通 owner 的任意 SQL 探针隔离、仅公开只读观察类型，并加默认关闭的 Queue 生命周期候选。先补真实 Queue 的持久 ACK/retry/DLQ 与跨 isolate 排他，再考虑 handler 接线；`busy`／`outcome_unknown` 正常返回会隐式 ACK，现候选**不能部署**。扩展受控模式、认证/TLS/pooler、取消失败而主查询成功及资源迟到结束的故障矩阵。先在可运行的隔离 workerd/合成协议环境核验，真实 Hyperdrive 再按独立 staging 前置验收。v308 全 bundle alias 不授权任意 SQL 或对 claim/COMMIT/fail 自动取消；历史 v308 harness 源码 pin 因 v309 package 出口变化不能算本轮复跑通过。保持生产关闭；不得借用 legacy cancel、`pool.end()`、观察截止或 CF 合成 close 冒充物理清理凭据。
2. 再落实 DBL-05：v310–v312 已覆盖部分本地准入与末次派发，v313 将恢复关系和窄 Key 锁函数纳入正式迁移；v314–v317 在本机 PG18.6 子集验证专用角色资金路径、窄生产者、权限/结构漂移拒绝与财务 COMMIT 协议响应丢失。v318 新增合成旧日志读写与提案持锁证据，并暴露 `SET ROLE` 不加载恢复角色登录时限。v319 的 claim 时授权只在提案触发器内，单请求非空 claim 唯一索引只在 review-only DDL 内；v320 显式拒绝有有效成员时的 NULL 默认 Workspace 标志，并强化索引提案的 trigger 形状预检。v321 只让本地 Proxy 在受委托的回调成功后保守停止 failover 并保留已知失败响应，不提供持久 grant 或真实请求接线。下一步在真实请求入口冻结生产者凭据、预算/guardrail 准入与 claim 次序、跨 attempt 的 unknown 和结果来源，验证一次 grant 至多一次 fetch、原响应结算，并明确 claim 提交后撤销政策。保守索引禁止已知拒绝后的 fallback，且删除 claimed 行会重开 ID；制定保留期/契约并在代表性旧库和完整普通流量下量测迁移与提案锁、日志延迟/死锁及已有重复 claim 处置，再考虑正式迁移。两个 definer 修复和单请求索引仍在正式迁移之外，单事务 definer bundle 只渲染不执行，切换与恢复角色保持 NOLOGIN、`runtimeCompatible:false`，不为 `FOR UPDATE` 放宽不可变日志 UPDATE；补齐专用角色其余故障分支。取得同实例全部 Hyperdrive/直接连接的实时容量事实后，以实际新登录身份验证服务器 timeout、内部事务控制、其他真实网络不明结果及共享管线隔离；`SET LOCAL transaction_timeout` 不会改变本事务已确定的总时限。
3. 取得 DBL-06 的本地与服务端终结证据后，才能接可信解除和调度。最后完成 DBL-08 及其余 C03.G；观察接口本身不是完整恢复服务。

候选默认禁用，正式驱动仍有原空 socket 负例。未授权自动重发推理、未知收费、关闭共享池、迁移或新增云资源。首轮 staging 累计 US$2 不重置。
