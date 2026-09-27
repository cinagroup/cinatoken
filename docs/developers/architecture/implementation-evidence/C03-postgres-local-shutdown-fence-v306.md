# C03 v306：本地关闭队列、迟到连接与关闭回执隔离候选

2026-09-23；**LOCAL CF-BUNDLE / DIRECT-HOOK PASS，PRODUCTION DISABLED，C03 DOING**。本轮承接 [v305 池级关闭准入门禁](./C03-postgres-end-admission-barrier-v305.md)及其三个独立反例，仅改动版本与源码摘要固定、默认禁用的 postgres.js 3.4.9 实验候选和本地回归。正式依赖、锁文件、共享 dist、生产配置与恢复运行器接线均未切换。本轮没有真实 Workers、Hyperdrive 或原生 PostgreSQL 验收；也不决定 unknown 如何收费、不授权不明推理重发或凭关闭事件释放资金与资源。

## 有限修复与准确语义

[候选构建器](../../../../scripts/db/diag/postgres-owned-cancellation.mjs)在 `pool.end()` **调用时**同步锁存关闭门禁。除 v305 已封闭的池级全局 `queries` 外，本轮在合成协议夹具中覆盖了 `Connection.initial`、事务及显式 `reserve()` 私有队列、已解析但尚未交接的 reserve、首次 `listen()`、启动元数据 `fetch_types` 与重连计时器。关闭后的这些新工作确定拒绝为固定 `CONNECTION_ENDED`，不把 SQL、参数、端点或凭据写入错误自身。事务局部后续 SQL 与 `COMMIT` 不再越过关闭门禁；`reserve()` 的局部等待项在测试窗口内 settle，迟到 handoff 不产生新 lease。旧 Query、排队项和迟到 socket 必须保持原执行归属，不能由新执行者接管或重发。

同步重入也纳入门禁：调试回调、参数序列化器在尚未写出 Query／Bind／Execute 时触发 `end()`，该查询拒绝而不是发送；参数 `Describe` 已发出后、`ParameterDescription` 回来时已关闭，不再派发后续 Bind／Execute。内部 `fetch_types` 的拒绝被观察而不泄漏为未处理 Promise。重复 `end()` 在同步 `socket.end` 异常后仍观察同一失败，不因再次调用伪装成功。

**门禁不是物理字节截止线。** 已由 `Connection.execute()` 接纳且在结束调用前进入写入路径的同一 Query，可以因套接字缓冲／背压而在 `end()` 调用后才把字节写到 socket；本地用例验证它仍由原 Promise 拥有、只派发一次。这不是新准入，也不能证明服务端 SQL 停止、事务未提交或经济结果。相反，上述未接纳的初始、局部、重入及延迟 Bind 工作不能在关闭后被新派发。

CF 分支的原始 `Socket.closed` 与 postgres.js polyfill 合成 `close` 仍分别观察。空闲关闭时 `raw.closed` 拒绝、`raw.close()` 同步抛错，以及原始 socket 在 `end()` 后才到达且关闭拒绝，均形成固定 `CONNECTION_CLOSE_UNCONFIRMED`，不以包装层合成事件冒充关闭回执。`end()` 失败后再 `close()`、以及 `end()` 和 `close()` 并发等待迟到 socket 的用例，均保持该拒绝；初始 Query 另以 `CONNECTION_ENDED` 终结，夹具中无启动／SQL 字节。CF 原始 socket 直接路径使用 **Node 进程本地 `cloudflare:sockets` import hook**，并未建立真实网络连接；其他 CF 测试也是 Node loopback，绝非 workerd／Hyperdrive 原生证据。

`pool.end()` 的 Promise 是此候选的**逻辑关闭/等待合同**，不是每个底层 socket 的物理关闭证明。自定义异步 socket factory 若在 `end()` 后才交还 socket，原初始 Query 会被拒绝，迟到 socket 会收到关闭请求；但 `end()` Promise 仍可能先于该 factory 返回并完成。缺失、拒绝或尚未兑现的底层关闭回执都不能被写成可信资源解除。DBL-06 因此仍开放。

## 本地验证与负对照

[v306 harness](../../../../scripts/db/diag/postgres-owned-cancellation-v306.test.mjs)外层 **26/26 PASS**，其 23 个子套件及输入、产物摘要在 `.wrangler/staging/postgres-owned-cancel-v306-run-uJkDDp/`；[持久机器摘要](./C03-postgres-local-shutdown-fence-v306-results.json)保存必要统计与 SHA-256。ESM、CJS、CF 三入口分别重复构建，产物及 pinned 输入摘要一致；语法检查 3/3，恢复器 TypeScript 检查通过，16 个受保护的依赖、锁文件、共享 dist 与生产配置输入未变。

| 检查 | 结果与证明边界 |
| --- | --- |
| [新增本地关闭夹具](../../../../packages/core/src/storage/recovery/postgres-owned-cancellation-shutdown-local.wire.test.mjs) | ESM、CJS、CF **各 15/15**。覆盖 v305 的 initial／事务／warm reserve 负例、reserve handoff 与空闲释放、socket factory 拒绝、重连 timer、首次 listen、启动元数据、延迟 Bind、同步重入、预接纳缓冲 Query 和重复 end 错误。CF-only `raw.closed` 拒绝 **1/1**。这是有限合成故障矩阵，不是全模式/全时序证明。 |
| [CF 原始 socket 直接夹具](../../../../packages/core/src/storage/recovery/postgres-owned-cancellation-cf-direct-shutdown.wire.test.mjs) | **5/5**：wrapper 仍 opening 时的 raw 关闭、同步 `raw.close()` 失败、失败 end 后 close、迟到 raw 的 `closed` 拒绝、并发 end/close 的两个拒绝。仅 Node 进程本地 import hook，无真实 Cloudflare socket。 |
| 既有 CF 合成关闭／池关闭、可移植活跃 SQL | **6/6、4/4、1/1**；旧 `raw.closed` 与池级队列边界保持。ESM/CJS 可移植活跃 SQL 各 **1/1**，不把关闭门禁当作已派发 SQL 的取消。 |
| ESM/CJS owner 与取消、生命周期、legacy cancel | 两入口各 **37/37、60/60、2/2**；取消后 lane 的 `unconfirmed` 语义未放宽。 |
| owner／supervisor／既有资金 SQL | **66/66**，依赖已有本地 PGlite；不能替代原生 PostgreSQL 多会话/WAL。 |
| 安装驱动与历史证据 | 安装驱动 cancel **2/2**；原空 socket/onclose 负例仍为 **2 PASS / 1 FAIL**（预期失败），没有误称现用驱动已修复。v302 历史 harness **3 PASS / 1 SKIP**，v303–v305 各 **0 PASS / 1 SKIP**；源码漂移后有意跳过旧全量验证，保留历史报告而不重标成本轮通过。 |

运行本地复验：

```powershell
node --test --test-reporter=tap scripts/db/diag/postgres-owned-cancellation-v306.test.mjs
```

脚本需要现有 `.wrangler/staging/pg-schema-v250/package/dist/index.js` PGlite 缓存，或显式设置已有本地 `GATEWAY_PGLITE_MODULE`；不会自动安装、访问远端 SQL 或部署。报告路径为临时构建目录，不应作为长期产物。父级 240 秒、子进程 45 秒及类型检查 25 秒是**测试预算**，不是生产 SQL 执行时限。

## 未闭合门禁及下一有限项

DBL-04 此轮只增加**默认禁用候选的本地关闭围栏证据**；不能据此启用生产。下一项需把同一 Query 的实验 owner 接入运行级固定只读恢复 SQL 与单次观察，并强制 SQL／Query 模式 allowlist、公开类型及明确的默认禁用采用入口；扩展认证/TLS、pooler、cursor/COPY 等未测模式和真实 Workers/Hyperdrive 故障矩阵。`runUsageRecoveryPostgres()`、观察器及正式采用插件仍未调用该实验入口；不接任意用户 SQL、资金 claim、COMMIT 或不受控 `unsafe`。DBL-05 还需覆盖初始化、排队、查询、锁等待和内部事务收尾的服务端执行时限；DBL-06 需同一物理连接／执行代次的可信关闭与安全解除证据。原生 PostgreSQL 多连接/WAL、Workers 运行时、C03.G 与 C01.G/C02.G 均未通过。

v292 的本机 VC++ 运行库阻碍未变，本轮未安装、重启或重试 initdb。云管理、远端 SQL、部署、付费模型、KMS、资源增删及系统运行库更新均 **0**；首轮 staging 累计费用上限 **US$2** 不重置。
