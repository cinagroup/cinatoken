# C03 v333：空日志 ID 游标与切换后主键保护

2026-09-24；**本地子集通过，生产关闭，C03.7 仍开放**。正式迁移仍为 73 条；本轮 SQL 仅更新 review-only 提案，没有远端 SQL、部署或云调用。

正式 0001 的 `api_key_request_logs.id` 是没有非空字符串约束的 `TEXT PRIMARY KEY`。先前回填以 `''` 表示第一页，同时使用 `WHERE id > ''`，会漏掉合法的空 ID。最终七源 gate 会拒绝切换，但操作员不能靠继续翻页修复。现在 `null` 明确表示第一页；`''` 表示从已提交的空 ID 后续跑。CLI 使用 `--start` 或 `--after <id>`，即使旧 ID 本身等于 `--start` 也不会混淆。每页仍独立事务，只有 COMMIT 成功后才能保存返回的 `next_request_id`；`scanned=0` 才结束一个来源，随后由七源 gate 检查漏行与并发。

另一处风险是旧日志 `id` 在切换后被 UPDATE 为新值。INSERT 触发器不会看到这次改写，新的旧日志 ID 没有防重放登记。expand 提案增加精确 `BEFORE UPDATE OF id` 触发器：改写 ID 被拒绝，同值更新和其他列更新可继续。parent gate 与财务授权预检核对该触发器的目标列、事件、时机、函数与启用状态；普通 runtime grant 重跑也会撤销新函数的 EXECUTE。

| 当前证据 | 结果 | 覆盖 |
| --- | --- | --- |
| [回填/锁窗](./C03-postgres-native-replay-scale-lock-v333-report.json) | PG18.6，1/1、11 阶段、cleanup PASS | 25,000 个非空旧日志加一个空 ID；空 ID 在第一页登记，空游标从下一 ID 续跑；25,001 行共 52 页，停机回滚后续跑，expand/gate 锁冲突约 2 秒失败后重试。 |
| [登记/最终 gate](./C03-postgres-native-replay-reservations-v333-report.json) | PG18.6，1/1、21 阶段、cleanup PASS | 禁用 ID guard 时 gate 拒绝；切换后 ID 改写失败、其他列更新成功；七源回填、并发、回滚与保留期只读审查。 |
| [旧 parent 激活](./C03-postgres-native-legacy-parent-activation-v333-report.json) | PG18.6，1/1、10 阶段、cleanup PASS | 旧 intent 保留，新 parent 才可接纳新请求。 |
| [旧读写路径](./C03-postgres-native-legacy-handler-compat-v333-report.json) | PG18.6，1/1、5 阶段、cleanup PASS | 当前普通日志写入与现存读者在切换前后继续工作。 |
| [财务授权](./C03-postgres-native-financial-replay-grant-v333-report.json) | PG18.6，1/1、15 阶段、cleanup PASS | 新 guard 被禁用时授权失败；精确触发器、函数内容与 ACL 核对。 |
| [Images generations](./C03-postgres-native-http-generations-financial-v333-report.json)、[edits](./C03-postgres-native-http-edits-financial-v333-report.json) | PG18.6，各 1/1、4 阶段、cleanup PASS | 本地 HTTP→PG→独立财务 consumer 链经更新后的 guard/grant 复跑。 |

游标/CLI 与授权目录定向测试 **13/13**，相关三个 TypeScript 文件的定向严格检查通过。当前 `scripts/tsconfig.json` 全量检查仍失败，报错位于未触碰的 `catalog-readiness-probe-worker.ts` 与 `scripts/smoke/*` 类型合同；不能把定向检查称为脚本全量通过。上述七份报告及当前源码 SHA-256 见[机器摘要](./C03-postgres-replay-cursor-guard-v333-results.json)。25,001 条是合成回环数据；这不证明生产数据规模、锁窗、保留期/contract、历史部署 handler、真实 Workers/Hyperdrive/Queue 或物理关闭。生产保持禁用。

## v332 证据完整性勘误

首次复跑回填夹具时，它仍指向 `C03-postgres-native-replay-scale-lock-v332-report.json`，因而覆盖了该文件。v332 机器摘要固定的旧报告 SHA-256 为 `7fefe517244f2e49f563f96d411f649f3b710defe332929948813854adf806c8`，当前该路径的 SHA-256 为 `7c62b63643bb3945d806c589ddda61ee665773645943a60a49968cf3e9d7c17e`；本地没有找到旧报告副本，不能再把该 **v332 报告** 称作当前工作树中可按旧 SHA 验证的证据。其余 v332 证据未改。本轮夹具已改为只写 v333 路径；上表和机器摘要中的 v333 报告是当前代码的权威本地结果。
