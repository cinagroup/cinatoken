# C04 普通预算派发后恢复候选（v354，2026-09-25）

状态：**本地 review-only、默认关闭**。未连接路由、现有协调器或维护调度器；未执行远端 SQL、正式迁移或部署。

## 候选边界

[SQL 提案](../../../../packages/core/migrations-proposals/postgres/ordinary-budget-recovery-login-v354.sql) 要求预置独立的 cinatoken_gateway_budget_recovery 直接 LOGIN，并且只能由直接 migrator 在事务内显式设置 ordinary_budget_recovery_v354_activation=reviewed-v1 后安装。该角色无继承、无成员关系、无资金表或列级写权限，也不能调用 v350 准入函数；runtime、admission 与 buyer LOGIN 均不能调用 v354 恢复函数。v348 已撤销普通 runtime 的用户预算写权限；v354 对表级和列级权限漂移做前后核验，不重新授予 runtime 预算写权限。

两个 SECURITY DEFINER 函数仅在 SESSION_USER 为恢复 LOGIN 且隔离级别为 READ COMMITTED 时执行：

- forfeit_user_budget_dispatched_v354 只将已派发预约转为 expired，在同一事务把完整 reserved_micros 记入 settled_micros、释放 hold，并在当前预算 epoch 增加 budget_spent。未派发返回 0；已 expired 或 settled 的显式重放返回 1，避免重复扣款。
- expire_user_budget_leases_v354 的单次上限为 1–100 条。已到期的 reserved→released，只释放 hold；dispatched→expired，按完整 ceiling 扣款后释放 hold。旧 epoch 的预约仍终结并记录已派发 ceiling，但不修改新 epoch 的账户计数。

两函数的调用时间必须处于数据库 clock_timestamp() 之前 5 分钟至之后 30 秒。扫描还要求每条 expires_at<=p_now **且** expires_at<=server_now，所以客户端略超前的时钟不能提前归还额度。账户锁采用 FOR UPDATE SKIP LOCKED：如行存在但被锁，显式核销返回 55P03 并回滚，扫描跳过该行；账户确实不存在才走旧账户终结分支。这避免了与 v350 先锁账户的 replay 路径形成锁等待环，忙碌时额度保持占用。

[独立恢复 owner](../../../../packages/proxy/src/services/postgres-ordinary-budget-recovery.ts) 是显式创建的 max:1 直连客户端。它检查普通 runtime 和恢复客户端的实际 CURRENT_USER/SESSION_USER，每次函数调用各自使用事务，只有 COMMIT 回执确认后才报告成功；未知回执直接报错，无自动重试。关闭等待在途事务与连接关闭回执。它只暴露 forfeitDispatched、expireBefore，不代替 v351 准入 owner。

## 本地验证

[原生 PG18.6 夹具](../../../../scripts/db/cutover/postgres-ordinary-budget-recovery-v354.native.test.mjs) 安装正式 PG73、v348/v350 和 v354 候选。[机器报告](C04-ordinary-budget-recovery-v354-results.json) 为 **PASS、cleanup PASS、8/8 阶段**：默认关闭及授权漂移回滚、真实 LOGIN/直接 DML 拒绝、派发后不明全额核销、模拟 COMMIT 回执丢失后的显式幂等重放、两条上限扫描、计数漂移原子回滚、旧 epoch 和账户锁并发跳过。v354 SQL SHA-256：2046bac92fd9d099ed577b26d9b1c56def0ede79b65f8cbe242ae03067d423aa；owner：3cca21e75bc0fe0423e6c1742c046c802873bb9a540c7d5fa884942ba8273cd6；夹具：3a6754fe2fd1e8d5a3a101bfb79e9c15ca3fdff3eec0edcca3da0cc6c7e62c0b。

- node --import tsx --test packages/proxy/src/services/postgres-ordinary-budget-recovery.test.ts：4/4 PASS，覆盖未知 COMMIT 不自动重放、扫描上限和关闭等待、角色不符及清理失败。
- GATEWAY_NATIVE_PG_BIN=<本地 PG18.6 bin> node --import tsx --test scripts/db/cutover/postgres-ordinary-budget-recovery-v354.native.test.mjs：PASS，cleanup PASS。
- npm run typecheck -w @octafuse/proxy：PASS。

## 接入仍被阻断

1. v351 普通准入 owner 的 expireBefore 仍返回 0、forfeitDispatched 仍明确失败；现有 ordinary-budget-lifecycle.ts 和 request-budget-admission.ts 尚未组合这两个独立 owner。恢复 LOGIN 有全局扫描和任何已派发 request 的核销能力，必须先设计身份绑定、凭据隔离及维护调度边界，才能接入请求路径。
2. 已恢复的共享 Key 报价请求若日后得到准确 usage，现有 v2 economic event 要求预约结算与 event 在同一事务；先前恢复的 expired 行不能直接重写为实际扣款。late actual reconciliation 需要独立调整事件/账本协议。当前函数保守记完整 ceiling，并未证明完整经济闭环。
3. `1–100` 限制转换行数，不证明大积压时的扫描／排序 I/O 或维护事务时限；原生夹具只覆盖小数据集。buyer settlement LOGIN 仍有受信的直接用户预算写权限；Guardrail 的派发后恢复、D1/MySQL、Worker/Hyperdrive、Linux CI、生产凭据与正式迁移均未闭合。模拟丢失回执证明幂等状态与应用无自动重放，未制造真实网络断线。
