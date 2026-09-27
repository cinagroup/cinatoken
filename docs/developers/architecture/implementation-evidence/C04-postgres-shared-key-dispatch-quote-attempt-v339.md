# C04 v339：Shared Key 发送前报价引用桥接

2026-09-24；**review-only，默认关闭，未启用资金结算**。[机器摘要](./C04-postgres-shared-key-dispatch-quote-attempt-v339-results.json)固定源码和[原生报告](./C04-postgres-shared-key-dispatch-quote-attempt-v339-report.json)的 SHA。C04.1、C04.2 及 C04.G 仍不勾选。

## 已建立的边界

[`shared-key-dispatch-quote-attempts.sql`](../../../../packages/core/migrations-proposals/postgres/shared-key-dispatch-quote-attempts.sql) 依赖 v338 不可变报价表。专用直连 LOGIN 只得到私有 schema 的 `USAGE` 和一个 `SECURITY DEFINER` claim 函数的 `EXECUTE`，没有报价或 attempt 表读取/写入权。函数在 `READ COMMITTED` 中先锁 request ID，拒绝已存在的 request log，再以 `FOR SHARE` 锁 active Key、读取当前激活 transition 和版本，并在同一事务写入 `attempt_id`、`request_log_id`、`attempt_index`、Key、route target、owner 和两个报价 ID。COMMIT 回应不明时调用方停止发送；改价/撤销后也不通过 claim 重放旧引用。该行只证明**发送前捕获**，不证明上游收到字节或产生费用。

SQL 安装前核对 v338 报价关键函数的源码摘要、触发器启用状态、绑定、owner 和基本属性，并拒绝第三角色已有的私有 schema／表／函数 ACL。安装后再核对新表和函数的精确授权；恶意默认授权或给专用 LOGIN 的可转授权都会使整笔安装回滚。专用 LOGIN 不能经普通 runtime 或 migrator 继承。request advisory lock 与同轮 [经济 outbox 提案](./C04-postgres-economic-outbox-v339.md)的日志入口约定相同；后者在日志 INSERT 前拿锁并于 COMMIT 枚举 attempt，防止晚到 claim 脱离经济事件集合。

[`shared-key-quote-attempt.ts`](../../../../packages/proxy/src/services/shared-key-quote-attempt.ts) 通过独立 PostgreSQL 连接调用函数并校验 direct LOGIN、返回身份和 COMMIT ACK；每个请求 scope 生成递增序号和 UUID。[Failover](../../../../packages/proxy/src/services/failover-dispatch.ts) 在文本驱动真正的 `beforeFetch` 内调用捕获，[Chat/Completions](../../../../packages/proxy/src/routes/v1/chat.ts) 把同一个 `generationId` 交给捕获和 `recordUsage`，跨普通/`partition=none` 模型循环复用。报价捕获先于预算 admission；若预算拒绝，已提交的引用仍只是 pre-send，绝不能当作已发送收益事实。

运行配置不提供 `SHARED_KEY_QUOTE_ATTEMPTS_ENABLED` 或专用 `QUOTE_ATTEMPT_HYPERDRIVE`。即使人为设成精确的 `reviewed-v1`，若未在 `createProxyApp` 注入具备“买家日志 + 每 attempt typed 经济事件同事务提交”责任的经济生产者，Chat/Completions 在读取请求体和上游发送前返回 503。当前未实现该生产者，未修改旧 `recordUsage` → `settleSharedKeyEarning` 默认路径。

## 本地验证

- 独立 PG18.6 在全部 73 条正式迁移及 v338 报价提案之后运行，**1/1、13 阶段、cleanup PASS**。禁用 append-only 触发器、替换为 no-op、授予第三角色读取旧报价、恶意默认授权或专用 LOGIN 可转授权都阻止安装；专用角色仅可执行 claim；重复 ID 精确幂等，身份/序号冲突拒绝；撤销被已持有的 Key 锁阻塞，之后新 claim 失败、历史引用保留；日志已存在时拒绝晚 claim；引用不能改删。
- 定向 Node **6/6**、Proxy TypeScript 检查通过。测试覆盖默认关闭/错误配置、缺经济生产者的 503、双 Key 发送前逐次引用、claim/ACK 错误零发送、预算拒绝后零发送但有 pre-send 引用，以及 `partition=none` 对同一 capture 的透传。
- 没有远端 SQL、部署或云服务调用；Linux CI 未运行。

## 尚缺

当前只有 Chat 与旧 Completions 的引用桥接；其余文本、向量、图像、音频和 Realtime 入口尚未接入。注入经济生产者目前只是明确的组合边界，没有可部署实现；还要持久化每跳发送/结果不明/用量事实、typed outbox、消费者和幂等入账。最终成功 route 的 request-level usage 不能代表此前可计费的失败 attempt。v338 报价表也没有接入真实买家价与权益版本来源。正式迁移、受控角色创建/授予、运行时 Hyperdrive、历史孤儿引用清理及 D1/MySQL 对等协议仍未完成。
