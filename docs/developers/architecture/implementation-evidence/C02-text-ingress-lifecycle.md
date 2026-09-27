# C02.B2.1 — 文本入口生命周期与有界上传

日期：2026-09-05。状态：**本轮已列本地子集 LOCAL_PASS；C02.B2 / C02 整包 DOING，C02.2 / C02.G 未通过。**

Owner / 本地自检：Codex（当前任务）；独立 Reviewer 和真实环境验收责任人待指定。

## 1. 接续与授权

接续 [C02.B1](./C02-text-deadline.md) 的入口缺口。上一轮仅重复核对 KMS 选型，归类为 no progress；本轮重新检查工作树后推进实现。用户已选择的 [Google Cloud KMS](./C01-google-cloud-kms-selection.md) 不变，不重复询问厂商，不借持续目标获得云部署或资金操作授权。

本轮只修改本地 Proxy 源码、测试和实施记录；没有访问云账号、创建资源、调用真实 KMS/供应商、迁移数据库、充值或部署。开始时工作树已有 66 个修改/未跟踪文件，既有 Admin/Core 等无关工作保留。

## 2. 实际实现

| 边界 | 本轮行为与证据 |
| --- | --- |
| 计时起点 | 在首个应用 middleware 为四种文本 POST 创建请求局部 budget/deadline，先于运行时检查、正文处理、存储和认证；`/v1` 与 `/api/v1` 及尾斜杠一致。不是 TCP/TLS 接入起点，也未改动原计费报价时间字段 |
| 单一剩余时间 | 三个 handler 复用入口 budget，旧 Completions 复用 Chat；认证花费 120 秒后，出站只剩原 300 秒上限中的 180 秒。普通与全局模型回退均实测不续期 |
| 上传 | 文本入口替换旧 body-limit 包装器，按需求拉取并累计实际字节；保留 50 MiB 现有上限，不因 Content-Length 较小而略过实际大小检查。声明已超限则在存储前拒绝 |
| 取消与释放 | 挂起上传在总 deadline 或客户端取消时终止；提前 401/413、已取消请求、源错误和正常 EOF 均释放 reader。取消确认永久不返回也不阻塞清理；EOF 不销毁仍需用于准备阶段的 deadline |
| 准备读取 | 预设解析、模型规划及哈希计算使用已核对为非资金操作的有界等待，迟到结果不返回 handler、不触发新准入/发送。模型规划的内部读取/解密尚不保证全停，见第 5 节 |
| 存储与认证 | 存储初始化保留 client/pool 生命周期责任，只做前后截止检查。认证旧 Key 查找可能惰性迁移，随后还可能持久重置预算，均不通过 race 丢弃；查找完成后已超时则不启动预算重置，不进入推理 |
| Guardrail 与准入 | 对含审计写入的请求 Guardrail 在前后检查，对预算准入在开始前检查；保留已有持久准入/释放/结算的等待责任。不将整个 Hono 链当作可取消的只读 Promise |
| 公共错误 | 上传超限 413、入口超时 504、客户端取消 499，使用固定错误码和对应 Chat/Responses/Messages 结构；不泄漏客户端取消理由，也不把上传超时误归为 JSON 格式错误 |
| 响应交接 | 入口 middleware 返回时清理自己的 timer/上传资源；dispatcher 保持独立的同一绝对截止时间和原客户端 signal。已接受 SSE 返回后再取消，仍终止上游并保留一条用量记录 |

这里“有界上传”不意味着整请求已有严格墙钟上界，也不证明 50 MiB JSON 在 Workers 并发下内存安全。应用最终仍需物化和解析合法 JSON，解析的 CPU/内存以及平台缓冲另行验收。

## 3. 关键来源与代码

- [应用接入](../../../../packages/proxy/src/app.ts)、[入口生命周期](../../../../packages/proxy/src/middleware/text-request-lifecycle.ts)、[正文流保护](../../../../packages/proxy/src/services/bounded-request-body.ts)。
- [认证 middleware](../../../../packages/proxy/src/middleware/auth.ts)、[认证服务](../../../../packages/proxy/src/services/api-key-auth.ts)及三个现有 [Chat](../../../../packages/proxy/src/routes/v1/chat.ts) / [Responses](../../../../packages/proxy/src/routes/v1/responses.ts) / [Messages](../../../../packages/proxy/src/routes/v1/messages.ts) handler。
- 只读检查确认 D1/Postgres/MySQL 的 `getApiKeyWithUserByKey` 兼有旧凭据回填，`persistLazyBudgetResetIfNeeded` 兼有预算 CAS/审计；因此未把名称含 get/auth 的函数假定为纯读取。未修改 Core 的这些持久协议。
- [正文测试](../../../../packages/proxy/src/services/bounded-request-body.test.ts)、[真实 Hono 链测试](../../../../packages/proxy/src/routes/v1/request-dispatch-limit.test.ts)纳入主 script、已有 dispatch-safety CI script 和专项类型检查。未创建新的线上 CI 运行。

类型检查初次发现 Hono Context 的可变 `set` 导致子环境不可赋值，以及 `app.request` 的 Response/Promise 联合返回；改为只依赖只读 Context 字段、显式 `Promise.resolve`，未用 any、双重断言或忽略类型错误绕过。运行测试前读过的 npm body-limit 实现对有 Content-Length 的请求跳过实际计数；本轮替换只作用于上述文本入口，其余模态的 body-limit 行为未改变。

## 4. 最终验证

环境：Windows / Node **24.14.1**；项目 `.nvmrc` 为 **22**，本轮未在 Node 22 上执行。Workers types 使用已安装的 **5.20260829.1**；最新 npm 查询因网络 EACCES 失败，按技能允许的本地类型回退，未修改依赖或 Workers 配置。HEAD 为 `7eb59008f7d8e156e81fd18a57658fdef2553264`，受测文件和依赖摘要见 [本轮快照](./C02-text-ingress-snapshot.json)。

| 命令 / 范围 | 结果 |
| --- | --- |
| `npm.cmd run typecheck -w @octafuse/proxy` | 退出 0 |
| `npm.cmd run typecheck:dispatch-safety -w @octafuse/proxy` | 退出 0；新正文测试与既有四个专项测试文件均纳入 |
| 两个本轮相关测试文件 | **63 tests / 0 suites，63 通过，0 失败/取消/跳过**；包括 6 个正文原语测试与 57 个真实 Hono 链测试 |
| `npm.cmd test -w @octafuse/proxy` | 完整 npm 生命周期退出 0；所有前置组完成；最终主套件 **771 tests / 134 suites，771 通过，0 失败/取消/跳过** |
| `npm.cmd run test:dispatch-safety -w @octafuse/proxy` | **231 tests / 17 suites，231 通过，0 失败/取消/跳过**，退出 0 |
| `git diff --check` | 退出 0 |

771、231、63 包含重叠，不能相加。大套件输出只读过滤保留汇总，显式传回 npm 原退出码；注入故障的预期日志不等于测试失败。所有 upstream fetch 被合成实现拦截，SQL 使用有限接受器和免费价格。认证迁移测试模拟一个由原调用者等待的 Promise；它证明不丢失等待责任、迟到后不启动预算重置，**不证明真实迁移事务、资金恢复或数据库取消已通过**。

## 5. 尚未完成与唯一下一步

继续 **C02.B2.2 — 准备阶段底层取消与分阶段时限**，不能因本轮本地通过进入 C03 或勾选整个 C02：

1. 存储初始化、认证迁移/预算重置、Guardrail 审计/限流以及持久准入/释放/结算仍可能超出 deadline。先拆清只读、写入和资源回收责任，再加入存储级时限/可恢复协议；不能用 `Promise.race` 冒充数据库取消、回滚或关闭共享连接池。
2. 将取消/检查传入模型规划的每个内部读取、候选循环、凭据展开/解密和 Vertex/OAuth 等辅助 IO。当前外层不再等，不代表内部不会继续其他读取；真实 SQL 已开始时能否取消也需按驱动验证。全池枚举/解密的替换仍属于 C07–C09。
3. 定义并实现 headers、首有效 token、idle 与总时间的独立语义/阈值及计量。不能以未收到首 token 推断请求未被供应商接受，也不能让心跳/无有效 token 字节无限续期。当前未新增这些阶段定时器。
4. 扩充 Node 22、Workers runtime、真实数据库、并发上传内存和背压验收；首个 middleware 之前的运行时/网络生命周期、其他模态和 SDK/平台重试计数仍未完整覆盖。

C01 的 GCP project/location、SOFTWARE/HSM、承载/IAM、预算、财务和发布参数仍待冻结。上述缺口不阻塞继续安全的本地实现，但阻止生产验收。回退采用暂停受影响入口或兼容修复；不恢复无界重试、漏计实际正文、丢弃资金预留或明文凭据。

本轮使用 Cloudflare Workers 最佳实践技能，促使实现采用请求局部状态、按需流读取、清理计时器/reader 与保留异步写入责任；查阅 [Workers 官方实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)和 [Request signal 合同](https://developers.cloudflare.com/workers/runtime-apis/request/)，结合本地 Hono/Workers 类型验证。公开文档与本地测试均不替代真实平台验收。
