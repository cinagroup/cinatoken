# 请求准备与未使用存储客户端的资源归属

适用版本：C02 v248（2026-09-16，本地实现；未作 Workers / 数据库原生验收）。

## 三种完成不能混用

1. 调用方停止等待：客户端取消或绝对 deadline 到达，允许只读准备返回 499 / 504。
2. 已登记工作终止：实际 read / crypto Promise 已 resolve 或 reject，且异步迟到结果清理已完成。
3. 业务事实持久化：准入、迁移、审计、成功结算等写入收到其自身确认。

第 1 项不代表第 2 或第 3 项。资源完成通道不参与 usage 的成功／失败判定，也不撤销 Images 的“有效 completed 图片 + 真实上游 DONE”成功事实。业务写入仍由原 owner 等待、收尾，不因请求取消而遗弃或重试。

## 准备读取

`createRequestDeadline` 可在调用读取前同步登记完成回执。取消只停止调用方等待；回执继续观察实际操作和异步 `onLateResult`。读取自身失败说明此已登记操作终止；迟到结果清理失败则是 `unconfirmed`。取消前尚未启动的操作不得执行；登记失败也不得启动操作。

入口为文本、Gemini、embeddings / rerank、Images 的现有 allowlist；每请求汇总为一个 host 资源任务。并发／嵌套读取必须全部终止，不能以外层已取消或其中一项完成替代其他项。调度器自建的 deadline 也登记准备工作；响应交接后停止新增此类登记，JSON / SSE 后续读取由既有 driver owner 负责，避免向已封闭的组登记新工作。

资源任务通过 `ctx.waitUntil` 或 Node 的独立任务集合继续被观察。可选逻辑容量只在全部已登记任务确认后释放；迟到工作一直不结束则一直保留，清理失败不设置自动释放 TTL。这不是物理堆、服务端 SQL 取消或平台持续存活的证明；Workers 生命周期到期仍是独立验收项。生产容量参数未启用。

## 存储初始化与交接

只有 runtime 明确提供 `disposeUnusedStorage`，初始化才可在取消时先结束调用方等待。初始化实际 Promise 及迟到结果仍由资源任务持有；覆盖“结果已 resolve、调用方 await continuation 尚未接收”的取消窗口。一旦成功交给鉴权／选路／记账，不能用 unused-client 清理路径关闭它。

| Runtime / 情况 | 未交接结果的处理 |
| --- | --- |
| Workers D1 | 无需关闭客户端；等待初始化终止 |
| Workers PostgreSQL | 等待 `raw.end({ timeout: 1 })` 返回；拒绝保持未确认 |
| Node 进程共享池 | 不按单请求关闭池；只等待共享初始化结果终止 |
| 自定义 resolver 未提供 disposer | 保留原来的 await，不擅自丢弃初始化 |
| 初始化失败 | 尚不能证明内部部分创建的客户端已关闭，保守保持未确认 |

Workers 的加密配置先校验、后创建存储客户端。Postgres.js 的 `end` timeout 是关闭期间的强制终止策略，不是每条查询的超时配置；本轮测试只观察调用与确认，不证明真实 socket 已关闭。[Postgres.js 官方说明](https://github.com/porsager/postgres#connection)

## 下一步的有限顺序与验收

1. 先明确 PostgreSQL 初始化失败、部分创建客户端及内部连接重试的所有权；补失败清理与测试。已经交接的客户端要覆盖账务和后台读取终点后再关闭，不能在 HTTP headers 返回时关闭。
2. 解决 Hyperdrive 下的 schema 与设置作用域，再设置数据库原生时限。当前 `max: 1`、独立 `SET search_path` 不能证明后续查询保留该会话设置；源代码的此项注释不能当作验收依据。官方规定 Hyperdrive 采用事务池，归还时 RESET；应选择限定 schema 或每查询／事务设置，避免为维持设置而把整个推理请求包成长事务。[Hyperdrive 池化语义](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/#pooling-mode)
3. 分别定义连接、排队、statement、lock 和 idle-in-transaction 时限；验证迟到结果、超时错误及提交确认丢失。不能只用连接 timeout 代表 SQL 时限，也不能对不确定写入自动重试。[PostgreSQL 客户端连接默认设置](https://www.postgresql.org/docs/current/runtime-config-client.html)
4. D1 当前绑定无 `AbortSignal` 参数；官方 SQL 执行上限 30 秒（batch 为整批），不是端到端等待或客户端取消确认。保留原操作观察和写入所有权，不伪造取消 API。[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)、[绑定 API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
5. 补 audio、Realtime 及其他非此 allowlist 路径；核查未登记的后台任务、完整工作集与 Workers 原实例容量。重新冻结当前构建后，才进行独立 staging 原生验收。

此轮没有创建数据库、改变角色／连接配置、修改线上 schema 或超时设置。以上原生效果仍未验证；C02.G、C01 与后续依赖不放行。
