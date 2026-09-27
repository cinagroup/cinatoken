# C02 v248：准备读取与迟到存储客户端的资源归属

日期：2026-09-16；Checklist v1.147；LOCAL_PASS，未部署。此子项不等于数据库原生超时、连接关闭或物理容量验收。

## 实现与边界

`createRequestDeadline.wait` 在调用前登记实际操作完成回执；调用方取消后，原 read / crypto 及异步迟到清理继续被观察。操作 resolve / reject 是此操作终止，清理 reject 则保持 `unconfirmed`。入口汇总所有并发与嵌套读取；文本调度器的自建 deadline 同步接入，避免只跟踪外层取消包装。响应交接后不再向已封闭的准备资源组登记 chunk，既有 driver 继续拥有 JSON / SSE 正文。

存储初始化只有在 runtime 声明 unused-result disposer 后才允许提前结束调用方等待。Workers 迟到 PostgreSQL 客户端等待 `end({ timeout: 1 })` 确认；D1 无需关闭；Node 的进程共享池不由单请求关闭。覆盖结果 resolve 与 await 交接之间的取消窗口，正常交接后不调用 unused disposer。Workers 先校验加密配置再创建存储。初始化失败仍保守未确认，部分客户端清理留待下一项。

已启动写入仍由原 owner 等待，不 race、不遗弃、不因超时重放。资源任务与 usage / 结算独立，Images 的“有效 completed 图片 + 真实上游 DONE”不可逆成功点及先持久化再交付成功结束的规则不变。生产容量参数未开启。[完整合同与后续有限顺序](../../reference/preparation-resource-policy.md)

## 验证

| 范围 | 结果 | 证明范围 |
| --- | --- | --- |
| deadline 资源回执 | 16/16 | 取消／deadline，嵌套、同步抛错、登记失败、异步迟到清理 |
| 公开存储初始化 | 88/88 | 20 路径 × 两种停止 × 两种清理结果共 80 项；另含交接窗口、Node 共享／legacy 合同及 Workers disposer |
| 公开规划读取 | 新增 36/36 | 九入口，两种停止、两种实际读取结局；五路并发读必须全部完成，不能先释放 |
| 调度器准备归属 | 新增 23/23 | shared、BYOK key / policy / 并发、sticky；另含 JSON / SSE / 空响应交接后读取 |
| 专项及既有公开入口 | 814/814 | 163 新增 + 651 既有 |
| 完整 dispatch 与补充 wire / URL 回归 | 4,053/4,053 | 0 失败、0 取消；相对 v247 新增 163 |
| dispatch / staging 类型检查 | 均通过 | 未升级依赖、运行时或 compatibility flags |

新增调度器测试以相同测试源码执行前后对照：原实现 3 PASS / 20 FAIL，修改后 23 PASS / 0 FAIL。失败均为原读取尚未终止时资源任务已完成；完整日志、原 dispatcher 和测试摘要均保留。仅此 23 项构成同源码前后对照，不扩大到整轮新增测试。

初始直接运行 110 项为 94 PASS / 16 FAIL：Node 导出仍指向旧 core dist，导致 15 项新 observer 测试失败；另 1 项新增鉴权测试遗漏测试 env。保存旧 bundle 和初始夹具，重新构建 core、修正测试 env 后 110/110。公开并行读取初始测试误设一条读，实际非 Gemini 有五条；32 项预期失败，改为每条独立 gate，并验证最后一条读完成前仍保留容量。以上早期运行只有工具输出，无独立完整日志；不伪造日志，也不计作产品前后缺陷数。

首轮归档验证已有 4,030/4,030 和专项 791/791，但 dispatch 类型检查失败：新 TS 测试使用的 Promise.withResolvers 不在项目 lib 中，且 Hono request 返回值需统一成 Promise。仅修正测试类型表达，无提升 TS lib。随后补调度器资源归属并全量重跑得到上述最终结果；首轮 FAIL 回执和源码保留。

core 包在 Node 下解析到 `dist/index.js`，因此最终验证先重新 bundle，再冻结输出、metafile 和全部直接构建输入的摘要；不是只验证未执行的 TypeScript。验证前后检查当前源码和 206 条构建输入／包元数据记录，继承核验 v247 的 2,431 条历史摘要；按原路径 + 旧摘要迁移被修改的历史文件，旧 manifest 不重写。新[机器证据](./C02-preparation-resources-v248-results.json)共 2,691 条摘要记录。

## 技能与原生数据库缺口

本轮按 Workers 最佳实践技能接入 request-local owner 与 host 生命周期，读取当前[官方规则](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)并核对最新类型 5.20260915.1 的 D1 API，无 AbortSignal。按 PostgreSQL 最佳实践技能核查池化和超时，而非把 client-side 停止等待当作服务端取消。

Hyperdrive 官方文档规定事务池的连接归还时 RESET，`SET` 仅对当前查询／事务有效。当前代码的 `max: 1` + 初始化独立 `SET search_path` 不能证明后续 SQL 使用正确 schema；这是基于源码与文档的待验证风险，本轮没有实际 PostgreSQL 复现，也没有修改该设置。下一步先解决 schema / 设置作用域和失败初始化清理，再做原生 query / lock / connection 时限。[Hyperdrive 官方池化语义](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/#pooling-mode)

D1 的平台 SQL 上限为 30 秒，不能拿来证明端到端等待、取消确认或写入提交结果；绑定 API 没有客户端 AbortSignal。本轮没有真实 D1 / PostgreSQL、Hyperdrive 或 socket 关闭实验；既有本地 SQLite 回归不能替代这些证明。[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)、[绑定 API](https://developers.cloudflare.com/d1/worker-api/d1-database/)

## 保持开放

1. 初始化内部失败／重试与部分客户端清理、已使用客户端在全部记账工作后关闭、数据库原生超时；audio / Realtime 及其他非 allowlist 路径覆盖。
2. SQL / crypto Promise 终止只证明登记工作结束，不是服务端取消、物理内存或连接关闭证明。100 字节逻辑池为测试参数，非生产内存测量。Workers host-expiry、完整工作集及原实例容量未验收。
3. Node 22、远程 CI 未验证；未重试 v243 Windows workerd 启动失败。C02.G、C01 与后续依赖继续不放行。
4. 下次云验需要新冻结候选；v232 最后部署不含后续本地改动，旧 CLI 对源码漂移仍应拒绝。本轮没有构建新的 Workers 部署候选。
5. 本轮 staging 调用／部署 0、生产写入 0、真实模型/KMS 0/0。首轮累计 US$2 上限不重置；最后云观察仍 v232，没有重验远端关闭状态或最终账单。
