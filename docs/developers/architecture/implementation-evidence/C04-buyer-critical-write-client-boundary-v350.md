# C04 买方 critical write 独立客户端边界（v350，2026-09-25）

状态：**review-only / 默认关闭**。未建立 Worker 买方 Hyperdrive binding，未运行远端 SQL 或部署。

## 改动与边界

- `recordUsage` 接受经济 handoff 时必须同时收到独立 PostgreSQL 买方客户端；普通路径不得传入该客户端。价格、用户快照等读操作仍经普通 repositories，最终 `insertRequestUsageAndChargeTx` 则使用买方客户端，把买家日志、预算扣款及 v2 事件留在同一事务。旧同步卖家结算在经济事件提交后不执行。
- `createPostgresSharedKeyEconomicProducer` 现在必须取得专用客户端；`recordUsage` 在任何价格读操作前检查两个原始连接对象不同，且数据库返回的 `CURRENT_USER` 和 `SESSION_USER` 分别是 `cinatoken_gateway_runtime` 与 `cinatoken_gateway_buyer_settlement`。这样直接调用 `recordUsage` 的未来路径也不能把另一个普通 runtime 连接当成买方。客户端生命周期仍由调用方负责，当前应用不构造或注入该适配器。
- 原生夹具先完成旧 v2 兼容段，再在同一个隔离数据库安装 v344 私有扣款回执、v346 买方权限拆分和 v347 买方 LOGIN 生产者；真实 `recordUsage` 桥接段在新角色上运行。普通 runtime 直接改买方资金得到 `42501`。402 Chat 回环由于生产准入身份尚缺，仅在该隔离夹具临时授予旧 runtime 的普通预约列权限，随后撤销并复验 `42501`；这不是部署授权方案。
- 该合并回归在早期合成 v2 兼容事件之后安装 v344；正式切换必须先装回执再放行任何 v2 流量，不能把夹具安装次序当成上线次序。

## 验证

- `node --import tsx --test packages/proxy/src/services/shared-key-economic-usage-handoff.test.ts packages/proxy/src/services/shared-key-quote-attempt.test.ts`：**23/23 PASS**，含无买方客户端、别名连接和错误 LOGIN 的发送前拒绝。
- `npm run typecheck -w @octafuse/proxy`、`git diff --check`：**PASS**。
- 隔离本地 PostgreSQL 18.6：`GATEWAY_NATIVE_PG_BIN=... node --import tsx --test scripts/db/cutover/postgres-shared-key-economic-producer-v2.native.test.mjs`，**1/1 测试、19/19 阶段、cleanup PASS**。[机器报告](./C04-buyer-critical-write-client-boundary-v350-results.json)固定正式 PG73、review-only 提案和当前源码 SHA-256；覆盖买方事务提交、普通 runtime 资金写拒绝、真实 Chat 402 零上游发送与零扣款事件、非共享终局、实际零用量预约及事件失败全回滚。

## 未闭合

买方客户端尚无 Worker／Node 配置、请求作用域 owner 与关闭回执，真实 Hyperdrive 身份未检验；普通预算和 Guardrail 准入、管理／提现、旧写者切换仍需独立角色。原生夹具中的临时预约授权只说明 Chat 回环，不证明该角色设计安全。v344／v347 对非买方 LOGIN 的数据库约束仍是最终事务防线；本地应用身份查询本身不能替代凭据隔离。正式迁移、生产流量、D1／MySQL 对等协议、Linux CI、真实供应商账单和生产锁窗均未验证。C04.1–8／G 继续开放。
