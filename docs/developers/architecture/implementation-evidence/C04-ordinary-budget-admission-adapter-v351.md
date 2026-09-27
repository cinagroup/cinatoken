# C04 普通预算准入应用适配（v351，2026-09-25）

状态：**本地 review-only、默认关闭**。没有 Worker/Node 路由创建该 owner，没有远端 SQL、正式迁移或部署。

## 已实现的候选边界

- [`postgres-ordinary-budget-admission.ts`](../../../../packages/proxy/src/services/postgres-ordinary-budget-admission.ts) 显式接收普通 runtime 客户端和两条不同的 PostgreSQL 连接串，为一个请求打开 `max: 1` 的独立准入客户端。打开前核验普通客户端的 `CURRENT_USER` 与 `SESSION_USER` 都是 `cinatoken_gateway_runtime`；打开及每个函数事务内核验准入客户端两者都是 `cinatoken_gateway_budget_admission`。连接串或客户端对象相同均拒绝。校验依据是数据库实际角色，不把 Hyperdrive URL 中的用户名当成身份凭证。
- 有限预算的 `reserve`、`markDispatched`、派发前 `release` 分别调用 v350 的三个 `SECURITY DEFINER` 函数。每次调用都在单个 PostgreSQL 事务中完成角色核验和函数执行，只有 `begin` 返回并确认 COMMIT 后才向协调器报告成功。COMMIT 结果不明会抛错；准入协调器不会再次派发或自动重试同一请求。请求 owner 的 `close()` 停止新调用，等待已开始的事务结束，再等待连接关闭回执；关闭结果不明会抛明确错误。
- [`request-budget-admission.ts`](../../../../packages/proxy/src/services/request-budget-admission.ts) 接受可选 `ordinaryBudgetRepositories`。显式注入时，免费/付费普通预算 lease 都使用该仓库；未注入时继续使用原有仓库。当前没有路由注入，所以生产路径保持原状。
- v350 准入角色没有派发后核销或租约回收权限。适配器的 `forfeitDispatched` 明确失败，让派发后的额度保持保守占用；`expireBefore` 不执行旧 runtime DML，交由后续独立恢复 owner 清理。它不会给准入 LOGIN 添加直接资金表授权。

## 本地验证

- `node --import tsx --test packages/proxy/src/services/postgres-ordinary-budget-admission.test.ts packages/proxy/src/services/request-budget-admission.test.ts`：**21/21 PASS**。覆盖显式仓库注入、实际角色不符与复用连接拒绝、阻断预算、预约 COMMIT 回执丢失、派发标记 COMMIT 回执丢失、无 claim 时释放、派发后核销拒绝、关闭等待在途事务及关闭回执不明。
- `npm run typecheck -w @octafuse/proxy`：**PASS**。
- `git diff --check -- packages/proxy/src/services/request-budget-admission.ts packages/proxy/src/services/postgres-ordinary-budget-admission.ts packages/proxy/src/services/postgres-ordinary-budget-admission.test.ts`：**PASS**。
- [v350 隔离 PostgreSQL 18.6 函数与权限夹具](./C04-budget-admission-login-v350.md) 已扩展为 v351 应用与真实函数组合验证：正式 PG73、v348 买家拆分、v350 准入 API 下，独立请求 owner 完成 reserve→release 和 reserve→mark，派发后 forfeit 明确失败并保留 950,000 micros 上限。原生 **11/11 阶段、cleanup PASS**；本次隔离报告为 `.wrangler/staging/pg-native-dispatch-tests/report-budget-admission-v350-cefba00a-802d-47f3-ba68-1e3ee189cd16.json`，fixture 已登记本地 CI。该测试使用直接 PostgreSQL 连接，尚未验证 Hyperdrive 事务池或 Worker 绑定。

## 仍阻断真实 Chat 接入

1. v350 SQL 故意拒绝 `guardrail_budget_admission_rejected` 释放原因，该原因由现有 Guardrail 拒绝分支使用；若现在注入 v351 owner，该分支会保留预约并阻断发送，但不会完成预期的拒绝回执和清理。必须先实现 Guardrail 多意图准入、买方证明及其赔偿/回收协议。
2. `forfeitDispatched` 和 `expireBefore` 需要有独立权限且数据库约束的恢复 owner；目前 v351 不执行这两种写入。等待租约过期本身不是恢复证明。
3. Chat/Guardrail 路由尚未创建和 `finally` 关闭这个请求 owner，也没有独立 Hyperdrive binding、凭据隔离和请求身份绑定。v350 函数目前可为任意有效的用户/API key 组合预约，应用必须把认证快照与该调用绑定。
4. 生产角色、正式迁移、真实 Worker/Hyperdrive、Linux CI、D1/MySQL 对等协议及完整 C04.1–8/G 门禁仍需验证。本适配器的存在不表示经济流量可以开启。
