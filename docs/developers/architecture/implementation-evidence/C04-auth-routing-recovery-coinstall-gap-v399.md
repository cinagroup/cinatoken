# C04 v399 — auth、routing、recovery 同库安装缺口

这是冻结源码的缺口分析，不是 v399 验收结果，也没有新增 SQL。v395/v396/v397/v398 的提案与既有报告保持冻结；正式迁移仍为 PG73 / D1 68 / MySQL64。

## 已有证据与范围

| 已验证部分 | 证据 | 范围 |
| --- | --- | --- |
| v395 personal auth / period | [报告](C04-personal-key-auth-period-v395-report.json)：20 stages PASS、cleanup PASS | v388 分支的独立 auth fixture；未安装 v389/v396/v397/v398 |
| v397 response / no-fetch recovery | [报告](C04-complete-text-response-no-fetch-coinstall-v397-report.json)：54 stages PASS、cleanup PASS | frozen v392 先装，再安装 no-fetch / buyer split / v388 / v389；未包含 v395/v396/v398 |
| v396 → v398 routing / sticky | [报告](C04-complete-text-routing-projection-v396-report.json)：106 stages PASS、cleanup PASS | 无 v370 no-fetch / v388 / v389 / v397 的 routing 分支；包含 v392 |

最终 v396→v398 catalog 已独立核对：v398 的 **40 个 authority functions、30 张依赖表、40 个完整 user triggers、12 个 proof principals** 与实际 catalog 一致。四处 try-lock / NOWAIT 正文 pin 均匹配，v398 SQL SHA256 为 `f4a34bad4aee4343b3bce308abd4946c866d577727dd245a157049d7bdb1297d`。这不证明完整安装栈已在同一数据库共存。

## 冻结提案的确切拒绝点

| 安装次序 | 执行即拒绝的位置 | 实际差异 |
| --- | --- | --- |
| v389 → v395 | [v395 SQL](../../../../packages/core/migrations-proposals/postgres/personal-key-auth-period-v395.sql) `$preflight$` 的 exact trigger/function digests | v389 在 `complete_text_attempt_grants_v362` 新增 `complete_text_grant_enqueue_recovery_v389`；超出 v395 的 37-trigger 分支，并引入新的 referenced trigger function |
| v396 → v395 | 同一 v395 exact catalog 检查 | `complete_text_routing_v396_grant` 也落在 v395 的 14 张依赖表内，改变 trigger digest 和 referenced-function inventory |
| v370 no-fetch / v388 / v389 / v397 → v396 | [v396 SQL](../../../../packages/core/migrations-proposals/postgres/complete-text-routing-projection-v396.sql) `$preflight$`：`routing projection v396 immutable triggers differ` | grant/custody/start 三表的全部非 internal triggers 必须合计恰好 **3**，且只能是原始 immutable triggers。v370 no-fetch 已在 custody/start 新增两条 fences；后续 terminal、recovery、close fences 继续扩大集合 |
| v388 → v398 | [v398 SQL](../../../../packages/core/migrations-proposals/postgres/complete-text-sticky-routing-v398.sql) 的 function dependency loop | v398 要求 `reject_complete_text_enrolled_hold_mutation_v366()` 的旧正文 `fbb71177d61d3e668bea3b662a5769f5`；[v388 SQL](../../../../packages/core/migrations-proposals/postgres/complete-text-no-fetch-platform-close-v388.sql) 将其替换为 `6e5666a4e25b0645537c0742cd44b52e`。v389/v397 认可的是后者 |
| v397 → v398 | 同一 v398 exact table trigger 检查 | v398 要求 observations 表恰好两条 immutable/no-truncate triggers；v397 新增 `response_observation_no_fetch_fence_v397`，使其变为三条 |
| v396 → v397 | [v397 SQL](../../../../packages/core/migrations-proposals/postgres/complete-text-response-no-fetch-coinstall-v397.sql) 的完整 manifest count | v397 在 20 张表上要求原分支的 **57** 条 triggers。v396 的 grant/custody/start 三条 routing fences 都在这 20 张表内，超出该 manifest |

[v389 recovery SQL](../../../../packages/core/migrations-proposals/postgres/complete-text-no-fetch-recovery-v389.sql) 明确创建上述 grant enqueue trigger；[v392 observation SQL](../../../../packages/core/migrations-proposals/postgres/complete-text-response-observation-v392.sql) 明确要求原 eight-trigger baseline。v380 新增 admission 的 preexisting-log fence、buyer split 收紧财务列 ACL，也会与 v398 的原分支 table/column ACL 和 trigger sets 不一致。因此只修改 enrolled-hold 的一个 digest 不足以完成同库安装。

## 当前可行子栈与顺序约束

- 已有同库原生证据：`v392 → v396 → v398`，以及 v397 报告中固定的 `v392 → v370 no-fetch → v368/v371/v372/v380/v386 → v388 → v389 → v397`。
- v395 必须在 v388 之后、v389 和 v397 之前。源码相容的候选插入点是 `… → v388 → v395 → v389 → v397`。v395 的 14-table trigger inventory 与 v397 baseline 在重叠表上逐名比较，移除 v389 enqueue 后无差异；这个插入顺序尚未做联合原生验证。
- v395 要求 v388，但 frozen v396 无法装在 v370 no-fetch / v388 分支之后；先装 v396，又会使 frozen v395 拒绝。因此当前冻结源码不存在仅靠重排顺序完成完整安装栈同库安装的路径。
- v392 也有独立的 exact eight-trigger baseline；它必须先于 no-fetch/terminal 与 routing fences 安装。现有 v397 native 已验证反向首装拒绝及整事务回滚。

## 下一 bridge 必须核验的 inventory

### 保留完整历史 authority

[v395 SQL](../../../../packages/core/migrations-proposals/postgres/personal-key-auth-period-v395.sql) pin **14 tables / 37 triggers / 28 functions**。14 表为：`api_keys`、`users`、`workspaces`、`user_audit_logs`、`user_budget_reservations`、`guardrail_budget_reservations`、`guardrail_budget_windows`、`complete_text_quotes_v360`、`complete_text_attempt_grants_v362`、`complete_text_platform_terminals_v388`、`complete_text_platform_outbox_v388`、`api_key_request_logs`、`complete_text_hold_renewals_v367`、`complete_text_result_facts_v366`。下一 bridge 需要最终合并后的完整集合，并纳入 `authenticate_personal_gateway_key_v395`、`reset_due_period_v395`、`next_period_v395`。

[v397 SQL](../../../../packages/core/migrations-proposals/postgres/complete-text-response-no-fetch-coinstall-v397.sql) baseline pin **54 functions / 57 triggers / 20 tables**，安装后再新增三条对称 fences。下一 bridge 应保留它的 holder/observer/resolver/closer/recovery worker 权限边界、financial ACL、no-fetch 与 observation 不重叠条件。

[v398 SQL](../../../../packages/core/migrations-proposals/postgres/complete-text-sticky-routing-v398.sql) 的 **40/30/40/12** 分支需要与最终 terminal/recovery catalog 合并，而不能沿用旧集合。八张 policy source 表是 models、model_surfaces、system_config、model_routes、providers、route_pools、model_endpoints、model_endpoint_routes；另需 route_source_generations、routing epoch/facts/projections/members 的完整 ACL、列 ACL、无 RLS/FORCE RLS/rules 以及完整 trigger sets。

### 关键合并 trigger sets

| 表 | 最终集合应包含 |
| --- | --- |
| grants | `complete_text_attempt_grants_v362_no_mutation`、`complete_text_grants_v386_close_fence`、`platform_terminal_grant_v388`、`complete_text_grant_enqueue_recovery_v389`、`complete_text_routing_v396_grant` |
| custody | 原始 immutable、`complete_text_send_custody_v370_no_fetch_fence`、`complete_text_custody_v386_close_fence`、`complete_text_routing_v396_custody` |
| starts | 原始 immutable、`complete_text_send_starts_v370_no_fetch_fence`、`complete_text_starts_v386_close_fence`、`complete_text_routing_v396_start` |
| observations | immutable、no-truncate、`response_observation_no_fetch_fence_v397` |
| no-fetch resolutions | 原始 immutable/no-truncate、`no_fetch_response_fence_v397` |
| platform terminals | v388 row/complete/truncate guards、`platform_terminal_response_fence_v397` |

其余依赖表仍需完整列举；不能只计上述命名 triggers。每个 referenced function 都需正文、owner、language、security、volatility、config 和精确 EXECUTE ACL，包括 grantor/grant option。新的 auth/sticky/writer 角色不得获得彼此的 wrapper 或原表权限。

### 后续证明门禁

下一实现应选择一个明确的 combined branch，以新 successor installer 和 final catalog 证明该分支；保留全部历史 SQL 原文和拒绝行为，不通过删除 fences、改旧 count 或关闭 triggers 绕过安装。至少需要真实同库 native 验证：

- auth 到期有 live/zero-hold grant 时继续 pending；真实 no-fetch terminal 后才可 reset；旧 epoch 的 admitted quote 不能继续 grant。
- 每个候选的 default/capacity 资格、source/routing epoch 漂移及 lock-busy 都在 grant/custody/start 前拒绝。
- observation 与 no-fetch/terminal 的对称并发排斥、recovery enqueue 和 job 租约不新增 send/financial authority。
- sticky 同 quote/candidate 的 holder/observation 证明、过期 mutation / 新 quote 读取、CAS、真实 COMMIT ACK loss 和无重复 POST。
- 额外 EXECUTE/列授权、新增或禁用 trigger、RLS/rules、失败 COMMIT 都拒绝或回滚，并在最终 source pins 与 cleanup 证据中体现。

这份分析不宣称跨周期不中断、完整 public Chat cutover、supplier billing/settlement 或 Worker 入口已经完成。
