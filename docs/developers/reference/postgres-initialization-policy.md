# PostgreSQL 初始化失败、清理确认与重试边界

版本：C02 v249；本地实现，尚非 PostgreSQL / Hyperdrive 线上验收。补充并更新 [v248 初始化合同](./preparation-resource-policy.md) 中“初始化失败一律无法确认清理”的保守规则；其他边界不变。

## 未交接客户端的三个责任范围

1. `initPostgresDrizzle`：创建 raw client 后的 session 初始化和 Drizzle 构造。
2. `createPostgresStorageContext`：client 已创建后的仓储模块加载和仓储构造。
3. `resolveWorkerStorageFromBindings`：storage 已创建后的 Workers 仓储装饰。

每层只接管已经拿到、尚未交给调用方的客户端；成功返回即交接，不能再用失败清理关闭它。失败则等待一次 `end({ timeout: 1 })`：完成才记录 `confirmed`，关闭抛错或拒绝则 `unconfirmed`，关闭一直不完成则继续持有，不能靠另一个定时器虚构确认。这个参数控制客户端关闭，不是 query / lock timeout。[Postgres.js 清理合同](https://github.com/porsager/postgres#teardown--cleanup)

失败回执不携带原始驱动消息、DSN、SQL 或 cause，只保留固定的初始化阶段、清理状态及安全的连接错误分类。任意普通 resolver 错误、形似对象不构成确认。工厂在返回可关闭 client 之前抛错仍无此回执，不能推断其内部资源已关闭。

## 调用方与共享池

只读准备因客户端取消／deadline 停止时，HTTP 可以先结束；初始化及清理仍由独立资源任务观察。只有该 initializer 明确确认关闭，才释放可选逻辑容量。清理失败保留数字预留，不调用 unused-result disposer 第二次，也不撤销或改变既有业务结算。

Workers `createWorkerStorageContext` 不再在连接错误后自动重新初始化。这约束的是该包装层，不宣称禁用了所有驱动内部连接选择、准备语句恢复或代理重试。正常 D1 路径不变，默认数据库选择未变。

Node 进程共享初始化仍合并并发调用。成功的池继续共享；明确未确认清理的 PostgreSQL 失败缓存为隔离状态，后续请求返回同一失败，不反复创建新客户端。需要受控重启恢复，不能只清空变量当作资源释放。已确认关闭的失败允许后续新请求重新初始化，但不会在原请求内自动重试。非此类型错误保留原有失败重置行为，不将其声明为清理已确认。单个请求取消不能关闭已发布的共享池。

## 验证范围与下一步

合成协议服务只绑定本机 `127.0.0.1` 动态端口，使用合成凭据、固定握手和 SET 响应，观察真实 postgres.js 的连接次数与 socket 关闭；不执行 SQL。它不是 PostgreSQL 引擎、Hyperdrive、TLS/认证或服务端提交证明。Mock ACK 测试覆盖关闭一直等待、resolve / reject / 同步抛错，公开入口验证对应的逻辑容量。

后续必须按顺序补齐：

1. Hyperdrive 的 schema 和设置作用域：ORM 表声明与 raw SQL 都必须覆盖，不能只改 Drizzle 的表名或仅设置一次 search_path。当前局部连接数 `max: 1` 不意味着池后端连接固定，事务归还会 RESET；本轮仅修正误导性注释，未改变 schema 解析行为。[Hyperdrive 池化语义](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/#pooling-mode)
2. 原生连接、排队、statement、lock、idle-in-transaction 时限及错误分类；不因超时重放不确定业务写入。
3. 已使用客户端的终点必须覆盖准入、审计、usage 结算及后台仓储操作，不以 HTTP headers / EOF 代替所有权结束。
4. audio / Realtime、其他未覆盖消费者、Workers host-expiry 和完整工作集／原实例容量。重新冻结候选后再做隔离 staging 验收。

Images 的“有效 completed 图片 + 真实上游 DONE”不可逆成功点不变，先持久化再交付成功结束，之后取消不撤销费用。C02.G、C01 及后续依赖未放行；本轮无部署或模型／KMS 调用，累计 US$2 上限不重置。
