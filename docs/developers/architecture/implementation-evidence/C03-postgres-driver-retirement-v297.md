# C03：postgres.js 断连事务退役候选（v297）

日期：2026-09-21。状态：**LOCAL_CANDIDATE_PASS / INSTALLED_DRIVER_FAIL / ACTIVATION_BLOCKED**。

本轮只实现、验证本地隔离候选；没有替换现用依赖、修改锁文件、启用恢复执行器或部署。C03 DOING、C01.G / C02.G / C03.G 及 US$2 累计限制不变。它落实 ADR-0002 的旧执行者隔离方向，不决定 unknown 收费，也不承诺网络 exactly-once。

## 结果与反例

- 未改驱动的 v296 三项 wire 回归继续 **2 PASS / 1 FAIL**：onclose 已拒绝外层 begin，回调之后抛错，驱动内部 rollback 在 `nextWrite` 访问空 socket。最终测试文件仍实际失败，未 skip / todo，也未关闭共享池掩盖失败。
- 新的负对照只跑“旧回调正常返回 + 同一池重连 + 新事务保持打开”。未改驱动 **0 PASS / 1 FAIL**：连接 2 在 `select newer` 与 `select new_barrier` 之间收到旧事务的额外 `commit`。这是本地协议轨迹证据，不仅是崩溃问题；夹具不执行 SQL，不能推断真实资金已受损。
- 候选 ESM / CJS 各 **12/12**，再各独立重复三轮，共 72 次重复用例通过。构建器验证源摘要、拒绝未知或重复补丁，并对三种产物做两次字节级一致性检查。
- 既有 owner + PGlite recovery runner **35/35**，专项 TypeScript 检查通过。v296 的 208 项其他 PG 回归本轮未重跑，不冒充新证据；原 8 个源/测试/配置摘要中 7 个未变，仅 wire 夹具为显式候选和连接轨迹扩展。

## 修复范围

[`postgres-transaction-retirement.mjs`](../../../../scripts/db/diag/postgres-transaction-retirement.mjs) 限定 postgres.js 3.4.9、esbuild 0.27.3，逐项校验 ESM/CJS/CF 的 index 与 connection 原始 SHA-256。只在内存中转换 index，再生成独立 bundle；不写 `node_modules`，不设置解析别名，不运行 npm hooks。其余 bundle 输入摘要也随测试输出记录；不是对整个依赖树的供应链认证。

每次 `begin` 的闭包拥有独立 `transactionClosed`：

1. 先安装 close 观察者，再进入用户回调。
2. close 时永久标记该事务退役，拒绝它自己的待派发队列，再拒绝外层 begin。
3. 该事务及嵌套 scope 的 SQL handler 在执行/排队前拒绝退役 scope 的所有查询，包括驱动内部 COMMIT / ROLLBACK / SAVEPOINT / PREPARE。

标记不附着在可重连的 connection 对象上；新事务有自己的闭包，旧回调不能借新连接继续。未改 `connection.js` 的 `socket.write`，也未加入“忽略空 socket 后继续”等吞错逻辑。常规提交、回滚、savepoint 和根连接复用另有正对照。

这不阻止仍在运行的用户回调持有内存或执行其他副作用。owner 仍分别等待外层、回调、SQL，且断连后的资源状态保持 unconfirmed；不把“未误发 SQL”当作服务端停止、物理释放或资金结果的证明。没有自动重发推理。

## 验证矩阵

| 层级 | 本轮覆盖 | 不代表 |
| --- | --- | --- |
| 构建 | 同一补丁用于 ESM / CJS / CF；源摘要拒绝；双构建一致 | 已替换生产包或全部依赖已固定 |
| Node 真实驱动、loopback 协议 | 原三项；正常失败回滚；旧回调 return/throw/late query/savepoint/prepare；active+sent+queued 断连拒绝；正常嵌套；暂停嵌套失败后不得 rollback 新连接 | SQL 语义、TLS、身份验证、真实 pooler、多数据库连接竞争 |
| PGlite | 既有恢复注册、lease、同事实账务与独立资源保留 35 项 | 原生 PostgreSQL/WAL 或 Workers 验收 |
| Workers | CF 源同补丁与 bundle 编译，保留 `cloudflare:sockets` | workerd 执行、Hyperdrive 或线上内存/生命周期通过 |

队列用例等待协议端确实看到 active 与 sent 两条 SELECT 后才断开；第三条必须尚未发到 peer，三个 Promise 都须拒绝。重连用例记录连接编号与完整有界 SQL 序列，并用新事务的后续查询检查没有迟到收尾。

## 运行记录与复现

详见[机器摘要](./C03-postgres-driver-retirement-v297-results.json)。首轮构建成功，但子进程继承 `NODE_TEST_CONTEXT`，Node 拒绝递归启动测试；**0 个 wire 用例执行**，外层 0/3。删除仅子进程的该环境变量并显式指定 TAP reporter 后，11 项版本双分支通过；加强队列观测并增加暂停嵌套用例后，最终双分支各 12 项通过。该初始错误未删除或计作通过。

本地运行（不连接远端，不部署）：

```powershell
node --test --test-reporter=tap scripts/db/diag/postgres-transaction-retirement.test.mjs
```

命令在 `.wrangler/staging/postgres-retirement-v297-*` 下生成仅供测试的本地 bundle；目录名中的 staging **不表示访问 Cloudflare staging**。本轮 6 个可再生构建目录保留，不修改或删除用户/云端数据。

未修补基线（预期仍 exit 1，真实缺陷未在现用依赖中修复）：

```powershell
$env:GATEWAY_POSTGRES_RECOVERY_DRIVER = ''
node --import tsx --test --test-reporter=tap packages/core/src/storage/recovery/postgres-recovery-operation-owner.wire.test.mjs
```

## 上游依据与技能影响

截至本轮读取，[PR #1168](https://github.com/porsager/postgres/pull/1168) 尚未合并，提出空 socket 防护；其讨论也提示 reserve/reuse 后续问题。本轮选择在事务作用域拒绝迟到 SQL，而不是据此声称单行防护已解决所有生命周期问题。官方仓库 [master package.json](https://raw.githubusercontent.com/porsager/postgres/master/package.json) 当时仍为 3.4.9；这是观察时点，不是未来版本保证。

[Issue #1189](https://github.com/porsager/postgres/issues/1189) 报告 BEGIN reservation hook 在 pipeline/backpressure 边界可能不执行，[Issue #1195](https://github.com/porsager/postgres/issues/1195) 报告 reserve 重连问题；本轮未复现这两项，不将它们误标为已修复，也不把改用 reserve 视为安全替代。

使用 PostgreSQL 最佳实践技能保持短事务/连接归属边界；使用 Workers 最佳实践技能对 CF 分支做一致性检查并区分构建与运行验收。参考 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) 与 [TCP sockets 生命周期](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)。Firecrawl CLI 本轮不可调用，依技能 fallback 用官方网页读取；未重新安装。

## 下一有限步骤与保留门禁

1. 先在同一 loopback 入口复现并约束 BEGIN 的 reservation / pipeline / backpressure 边界；确保所需 narrow API 没有绕过事务归属。当前候选仅处理**已进入 scope 后的 onclose 退役**，不是通用驱动修复。正常完成后逃逸的 tx handle、手工 COMMIT/ROLLBACK、reserve/COPY/cursor 等未作完整支持承诺。
2. 再确定受版本控制的依赖采用/构建接线方式，验证 ESM/CJS/CF 实际解析入口，不凭手工修改 node_modules 放行。当前生产 factory、包导出和默认驱动完全未切换。
3. 原生 PostgreSQL 的锁等待/多连接/COMMIT ACK 故障测试，仍先满足 v292 的系统运行库更新授权及复验条件；未授权不安装、不重启、不重试 initdb、不自动换远端。
4. Workers/Hyperdrive、完整执行时限、可信资源释放、无损日志、最小权限、迁移/保留兼容及 C03 总门禁仍开放。云端 BYOK 原阻塞和维护窗口不变。

本轮云管理、远端 SQL、部署、模型、KMS、系统安装/重启均 0；US$2 不重置。完整目标继续进行，不因候选局部通过而关闭。
