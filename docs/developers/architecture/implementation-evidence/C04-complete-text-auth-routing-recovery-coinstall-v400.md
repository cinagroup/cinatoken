# C04 v400 — personal auth、routing/sticky、no-fetch recovery 同库 successor

这是 review-only successor installer。它不修改 v395–v399 冻结提案和历史报告，正式迁移仍为 PG73 / D1 68 / MySQL64；未部署、未访问远端数据库、未调用付费 Provider。

## 安装范围与顺序

真实基线顺序为 `v392 → v370 no-fetch → v368/v371/v372/v380/v386 → v388 → v395 → v389 → v397`。这些步骤运行各自冻结的完整提案，包括原 preflight。先创建独立的 `cinatoken_gateway_complete_text_routing_projector` 和 `cinatoken_gateway_complete_text_sticky_router` LOGIN，均无继承、无角色成员关系、无超级用户/建库/建角色/复制/BYPASSRLS 权限。

新 [v400 SQL](../../../../packages/core/migrations-proposals/postgres/complete-text-auth-routing-recovery-coinstall-v400.sql) 由 [生成工具](../../../../scripts/db/cutover/build-complete-text-auth-routing-recovery-coinstall-v400.mjs) 编译。它携带 v396 routing 与 v398 sticky 的冻结 action DDL 原正文，使用新的完整合并 catalog preflight/postflight。安装者是直接 `cinatoken_gateway_migrator` LOGIN；调用方在单个显式事务中设置 `cinatoken.complete_text_auth_routing_recovery_coinstall_v400_activation='reviewed-v1'`，执行整份 SQL 后 COMMIT。默认不激活。安装不可通过跳过旧 preflight、删除已有 trigger 或放宽旧提案来实现。

生成工具先核对五份冻结 SQL 的完整 SHA256，再核对已提交的真实基线 metadata [fixture](../../../../scripts/db/cutover/fixtures/complete-text-auth-routing-recovery-coinstall-baseline-v400.json)。基线原始 snapshot SHA256 为 `24ca20e8883d11688a1469d1b1f40fc0a915c16081084362c14e9fde3fe28f38`；规范化 metadata SHA256 为 `3b2518407d868758acde6ec6dc9f22bf58b3545399fe8ddcb7f815494444e0d6`。该 snapshot 不含 Provider 值、Bearer、密码或业务行数据。

### 原生发现的 unlimited grant 修复

完整原生 run 在真实 unlimited、zero-hold grant 的正向分支发现 PG55000：frozen v362 的最后过期检查引用尚未赋值的 `ordinary RECORD.expires_at`。v400 在 strict preflight 后安装该函数的窄 successor 正文，只把 `ordinary record;` 改为 `ordinary cinatoken_gateway.user_budget_reservations%ROWTYPE;`，使未选择 reservation 时字段具有已知结构和 NULL 值。frozen v362 文件保持原样。

这一修复严格 pin 原文件 SHA256 `c9eb17e019dc1bbeeb7d4269cb1c2ce6b8861fab37e2bfed8ac3a8a97ce2d4f7`、原正文 MD5 `0339e4f95fff26784032d2d73ec09a7a` 和新正文 MD5 `d12fadd87e87c9a74c9060b9ba9f4c6b`。其余参数/default/OUT、owner、ACL、config、financial checks 和 trigger fences 不变。完整 133 个 inherited functions 中 **132 个完全不变，1 个只有该 declaration repair**；v396/v398 action DDL 仍为冻结原正文。

## 完整 authority contract

| Inventory | 基线 | 安装后 | 检查内容 |
| --- | ---: | ---: | --- |
| Functions | 133 | 142 | qualified signature、owner、正文 MD5、language/prokind/retset/parallel/strict/leakproof/security/volatility、完整参数名/default/OUT 与返回定义、完整 SET config、EXEC ACL 的 grantee/grantor/grant option |
| Relations | 89 | 93 | owner/kind/persistence、RLS/FORCE RLS、完整 table ACL、各列类型/空值/identity/generated/default/collation/列 ACL、完整 constraints 和 rules |
| Non-internal triggers | 122 | 135 | 完整逐表集合、函数引用、enabled/type/qual/列/参数/延迟/transition/constraint 属性和完整定义 |
| Schemas | 7 | 7 | owner、完整 ACL/grantor/options |
| Principals | 26 | 26 | LOGIN/INHERIT/特权 flags、连接上限、config、角色成员关系、建库/公共 schema CREATE |
| Migrator default ACL | 3 | 3 | schema/object type/grantee/grantor/options 精确不变 |

metadata capture 也检查所有 migrator-owned functions/relations，包含 managed schemas 之外的对象。新两个 LOGIN 在全部非系统 schemas 上只能拥有预期 wrapper EXECUTE，不能直接读取任何表、列、sequence 或创建 schema 对象。其他 cinatoken principals 的 managed-schema 之外有效 EXECUTE/table/column/sequence authority 也拒绝。sequence 检查使用 `CASE` 按 relkind 分支，避免 planner 在非 sequence 对象上调用 `has_sequence_privilege`。

安装 session 必须为 `session_replication_role=origin`。cinatoken principals 的数据库级角色设置、当前数据库的 all-role 设置必须为空；非 migrator principal 不得拥有 `session_replication_role` 的 SET 权限。managed/migrator-owned relations 上 policy inventory 必须为空。它们在 preflight 和 postflight 同时检查，避免数据库级默认值或 parameter grants 绕过启用为 `O` 的 triggers。

完整基线 catalog 被保留。唯一旧对象权限变化是 verifier 对 models/model_surfaces/system_config 的 SELECT，以及两个新 LOGIN 对 gateway schema 的 USAGE。新表保留 owner-only authority，routing epoch 仅另给 verifier SELECT；两个 wrapper 不给原表或 Provider 读取权限。新增 13 条 triggers 是八条 policy source invalidators、grant/custody/start 三条 routing fences、两条 projection/member immutability fences。

安装后 grants/custody/start 的完整 trigger 数量分别为 **5/4/4**；observation 仍为 **3**。v388 的 enrolled-hold 正文 `6e5666a4e25b0645537c0742cd44b52e`、v395 auth/period helpers、v389 enqueue、v397 对称 no-fetch/observation fences 全部保留。

## 功能边界

v400 把已经审查的 auth、routing/sticky 和 recovery 放进同一安装栈。它保留 v395 的 conservative period policy：任何 live 普通/guardrail hold 或未终态 C04 grant（包括 zero-hold 已 start）都会返回 `period_reset_pending`；不会清金额或跨 epoch 自动续租。旧 quote/admission 在真实 period epoch 变化后必须由 grant authority 拒绝。跨周期不中断续租/settle 的 epoch rollover 仍未实现。

routing 保留 frozen v396 的默认 endpoint/capacity/全 candidate witness 和 source epoch fences；busy source gate 与 source table LOCK NOWAIT 均 fail closed。sticky 保留 frozen v398 的实际 grant、holder fact、linked observation、token CAS 与 pool epoch proof。post-response 的 TTL 豁免只允许 late mutation，其他 epoch/source/proof 检查继续执行。fresh independent quote 的 get 可恢复未知 COMMIT ACK；不能据此新增 Provider POST。upstream complete 不代表 downstream 已收到响应。

生产 auth/routing 没有接线，公共开关仍关闭。本证据只覆盖默认 platform/preparer 范围；本轮不是部署批准。

## 验证结果

[v400 native 报告](C04-complete-text-auth-routing-recovery-coinstall-v400-report.json) 为真实 owned PG18.6 完整 run：**137 stages PASS、cleanup PASS**。报告 SHA256 为 `a2c5946e2858428733fc35da0bb58f3a8fb1fe479c6c7f3770fd6c830db12a8e`；native fixture SHA256 为 `26c35a4f62fdc5c73f0f1a29814308f99fccea19c2823c1a97e983bbd9add607`。此前 33-stage catalog-only run 只用于准备可信基线；完整 run 使用上面的 typed-row 修复，并验证真实 fresh unlimited grant 正向路径。

14 项真实 installer 负例为：默认关闭、额外 proof EXEC/grant option、正文改动、auth 参数 default 改动、额外 grant trigger、Provider 列 ACL、额外 source trigger、RLS/FORCE RLS、rewrite rule、schema function default ACL、migrator table default ACL、holder 的数据库级 `replica` 设置、holder 的 replication parameter SET grant，以及 public 的未审查 migrator-owned definer wrapper。每次拒绝后完整基线 catalog 均恢复相等。数据库级设置负例实际重新登录非 superuser holder 并 `SHOW session_replication_role=replica`，随后 installer 以 P0001 拒绝；RESET/REVOKE 后才进行成功安装。

public wrapper 负例实际用 fresh auth/projector LOGIN：直接 `count(api_key)` 以 42501 拒绝，migrator-owned SECURITY DEFINER wrapper 则可返回 owner 和正数 credential-row count，不返回 credential 值。测试在 installer 前精确恢复 public CREATE ACL，使 P0001 来自 functions/outside authority 检查。随后 DROP wrapper、删除 synthetic inactive Provider，逐项确认 public ACL、Provider 原行、完整 baseline metadata、origin/role settings/parameter SET 权限恢复；没有 successor 残留。

联合功能覆盖真实 `auth → quote → projection → preparer → admission → grant/custody/start → v394 Worker/v392 observation`，包括 expiry/CAS/COMMIT ACK 恢复、grant/custody/start 三处 policy epoch 漂移、source generation ABA、default/capacity/all-candidate SQL fences，以及 try-lock 55P03 contention 后 writer COMMIT、无新增 POST。继承的 v397 observation/no-fetch races 与 v389 真实 runner 在同库继续通过。

auth/period 验证包含 live ordinary hold、projected never-started grant、真实 unresolved unlimited zero-hold grant 的 pending；合法 no-fetch terminal 后 reset；旧已 admit 的 unlimited quote 在 epoch 改变后被 actual grant 拒绝；reset COMMIT ACK 丢失后 fresh LOGIN 恢复一个 epoch/audit，无新 quote/send。v389 runner 重新认领 auth helper 已有 terminal 时 financial state 保持不变、无新增 POST。既有 loopback 矩阵共有 13 次物理 POST，新增 v400 fence/reset/reconciliation 验证增加 **0 次 POST**。

最终 installed/end catalog 完全相等，SHA256 为 `4647045c0e80b382594cb2b051de4e4dbf03b0ba25a8f146c5cd623be3148554`。独立 audit 再次逐项确认 **142 functions / 93 relations / 135 triggers / 7 schemas / 26 principals / 3 default ACL**；132 个 inherited function 完全不变，只有 grant 的指定 declaration body delta；全部 122 条 inherited triggers、principals 和 default ACL 保留。Root 独立核对 118 fingerprints（117 file entries、115 个不同文件，加 PG73 aggregate）；全部 source pins、core 327-file aggregate 和 PG73 稳定。

[生成工具单元验证](../../../../scripts/db/cutover/build-complete-text-auth-routing-recovery-coinstall-v400.test.mjs) **21/21 PASS**，并由 peer/root 独立重跑。包含冻结来源漂移拒绝、132 unchanged + 1 exact declaration repair、完整 additive merge、financial ACL 不变、baseline body/参数 default/OUT/ACL grantor/grant option/extra trigger/RLS/rule/列/default ACL/principal/schema 改动拒绝、独立 final catalog audit。实际 SQL 与纯 render 输出逐字一致；当前 SQL SHA256 为 `41ae69406e2319cd11c3a54e320cded0df321265e9e4aa2f97175ec4be3cfdd9`。

## 证据边界

- 仅支持上述审查顺序；任意重排和重复安装未获支持。v401 当前仅做分析，不构成新 SQL 或验收。
- 实际 v400 service/v394 Worker 在 Node 中使用真实独立角色客户端。准备的 HTTPS fixture 地址仅由注入的 physical fetch 转为 owned HTTP loopback；未使用真实 Cloudflare Binding/Hyperdrive 或远端 pooler。
- physical start COMMIT 到 Provider POST 之间仍可能发生配置漂移。NOWAIT/try-shared 门禁只验证所复现的 source writer 关系循环，不宣称历史协议全局无死锁。
- raw digest 覆盖 HTTP 解码后 fetch-readable bytes；usage observation 信任隔离 holder，未提供 Provider 签名、supplier cost 或 buyer settlement 证明。已发 grant 仍为 unknown，四个 holds 保持 dispatched。
- observation COMMIT 前无 durable response spool；稳定 same-start nonce 和独立 reader 恢复已提交 observation，无第二次 POST。COMMIT proxy 证明 backend CommandComplete(COMMIT) 被抑制后的恢复；未证明远端 pooler/close ACK 行为。
