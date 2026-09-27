# C02 v249：PostgreSQL 初始化失败清理与禁止隐式重试

日期：2026-09-16；Checklist v1.148；LOCAL_PASS，未部署。不是数据库原生时限或 Hyperdrive 验收。

## 本轮实现

PostgreSQL 客户端尚未交给调用方时，session / Drizzle、仓储模块加载／构造、Workers 仓储装饰三个阶段的失败由各自 owner 等待关闭。`end({ timeout: 1 })` 确认后才产生可识别的清理回执；拒绝保持未确认，挂起仍保持所有权，不以 timeout race 丢弃。普通 resolver 错误、形似对象不能冒充此回执。工厂在返回 client 之前抛错仍无可关闭对象，不在已确认范围。

Workers 存储包装层不再因连接断开自动初始化第二次。Node 仍共享初始化及成功池；清理未确认的 PostgreSQL 失败保留为进程隔离状态，后续请求不会反复建连，需要受控重启。已确认关闭的失败仅允许后续新调用再次初始化，没有原请求内的自动重试；其他普通错误保留原来的失败重置行为。Node 也改为先校验加密配置，后取得共享存储。

公开入口的准备资源任务只在收到真实 initializer 的关闭确认后释放可选逻辑容量，不把取消响应作为完成，不关闭已经交接的客户端，也不重复调用 unused disposer。错误回执不保留原始消息／DSN／SQL／cause，并保留安全的连接不可用分类；错误对象 getter 抛错也不能跳过关闭。

Images 的“有效 completed 图片 + 真实上游 DONE”不可逆成功点不变，仍先持久化再交付成功结束，后续取消不撤销费用。未改金额算法、结算状态或已接受推理禁止重放规则。[初始化合同与后续顺序](../../reference/postgres-initialization-policy.md)

## 验证结果

| 范围 | 结果 | 证明范围 |
| --- | --- | --- |
| 初始化 guard / 安全分类 | 28/28 新增 | 三阶段、同步／异步失败、关闭 resolve / reject / throw、成功交接、形似错误、连接分类和异常 getter |
| Node 共享初始化 | 5/5 新增 | 并发合并、成功复用、确认失败的新调用、未确认隔离、普通错误／同步抛错 |
| 公开入口失败清理 | 80/80 新增 | 20 入口 × 客户端／deadline × 关闭确认／拒绝；清理前容量保留，确认后释放 |
| 真实 postgres.js 本机协议链 | 7/7 新增 | database / context / worker 三入口的 SQL 拒绝／连接断开，以及成功 client 的消费者所有权 |
| Workers 工厂本机协议链 | 3/3 新增 | 装饰失败关闭、无效配置零连接、公开取消后迟到初始化失败与容量释放 |
| 专项 + 既有存储测试 | 214/214 | 123 新增 + 88 v248 + 3 既有 Postgres 测试 |
| 完整 dispatch 与补充 wire / URL 回归 | 4,176/4,176 | 0 失败、0 取消；相比 v248 新增 123 |
| core `test:unit` 主脚本 | 407/407 | 与上表部分重叠，不相加；本轮未执行其全部 npm 前后钩子测试链 |
| dispatch / staging 类型检查 | 均通过 | 未升级依赖、运行时或 compatibility flags |

协议夹具仅监听 `127.0.0.1` 动态端口，采用合成凭据和固定握手／SET 应答。真实 postgres.js 建连和 socket 关闭被观察，但没有 PostgreSQL 引擎执行 SQL，没有 Hyperdrive、TLS／认证或服务器提交效果验证。Workers 工厂在 Node 上运行，不能称为原生 Workers 通过。协议格式核对 [PostgreSQL 官方文档](https://www.postgresql.org/docs/current/protocol-message-formats.html)。

相同最终 7 项协议测试／夹具对不可变 v248 core bundle 与新构建对照：旧构建 3 PASS / 4 FAIL，三种 SQL 初始化拒绝没有关闭 socket，Workers 连接断开后建连两次；新构建 7/7。其余 116 新增测试没有旧构建同源码对照，不扩大该结论。

初次专项 205/205 通过；提取可复用 wire 夹具并补三个工厂链后，中间专项 208/208、dispatch 4,170/4,170、core 主集 401/401 和类型检查均通过。但 esbuild 检出新增 `pretest:unit` 与原钩子重名；该中间 PASS 只表示当时测试退出码，不作为最终接受。随后移除重复键，在保留全部旧钩子链的同时前置 core build，并补安全连接错误分类的六项测试，全量重跑得到最终结果。中间包文件、构建警告、bundle、测试和回执均保留。

验证器每次先构建 Node 实际解析的 core dist，再冻结源码／bundle／metafile／207 条构建输入及包元数据，执行前后检查摘要。focused 阶段的 core package 由保留的中间包移除新增重复行重建，并核对与当时回执 SHA-256 完全一致；明确记录此恢复方式。继承 v248 的 2,691 条历史摘要，旧 manifest 不改写；新[机器证据](./C02-postgres-initialization-v249-results.json)共 2,967 条摘要记录。

## 技能影响与未完成项

按 Workers 最佳实践技能落实请求资源 owner，核对当前 [官方规则](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)、最新类型 5.20260915.1 的 Hyperdrive 契约；没有安装或升级依赖。按 PostgreSQL 技能区分连接关闭、池化会话设置及原生查询超时，没有执行其示例中的全局数据库配置操作。Postgres.js 官方确认 `end` 需要等待，并且 timeout 是关闭阶段的秒数，不是 statement timeout。[官方清理合同](https://github.com/porsager/postgres#teardown--cleanup)

1. Hyperdrive schema / 设置作用域仍是下一项：当前 `schema.pg.ts` 的 `pgTable` 未限定 schema，raw SQL（包括用户预算仓储）也使用裸表名。仅改 ORM 或单次 SET 都不足以覆盖；此轮只纠正 `max: 1` 能维持 search_path 的错误注释，不声称已经修复。官方事务池归还连接会 RESET。[Hyperdrive 池化语义](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/#pooling-mode)
2. 连接／排队／statement／lock 时限、已经使用的客户端在全部账务及后台工作后的关闭、工厂返回 client 之前的失败、驱动／代理内部重试仍待验收。关闭包装层的第二次初始化不等于禁用了所有内部重试。
3. audio / Realtime 与其他消费者、完整工作集和原实例容量、Workers host-expiry、Node 22 与远程 CI 未验证；C02.G、C01 与后续依赖继续不放行。
4. 未重跑 v243 Windows workerd 启动失败；未构建或部署新 Workers 候选。下次云验须重新冻结，v232 最后部署不含这些后续本地改动，旧 CLI 对漂移仍应拒绝。
5. 本轮 staging 调用／部署 0、生产写入 0、真实模型/KMS 0/0。首轮累计 US$2 上限不重置；最后云观察仍 v232，关闭状态及最终账单没有重验。
