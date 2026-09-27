# C02.B1 — 文本调度绝对截止时间与取消传播

> 历史阶段记录：后续 [C02.B2.1 入口生命周期](./C02-text-ingress-lifecycle.md)已前移计时起点并补充上传/准备读取保护；当前状态与下一步见新记录。下文保留 B1 当时范围、测试和快照，不用新结果覆盖旧证据。

日期：2026-09-05。状态：**本地子集 LOCAL_PASS；C02.B / C02 整包仍为 DOING，C02.2 / C02.G 未通过。**

Owner / 本地复核：Codex（当前任务）；独立 Reviewer 与生产验收责任人待指定。

## 1. 前置与授权边界

接续 [C02.A 次数止损](./C02-dispatch-budget.md)，在既有未提交工作树内完成文本调度 deadline 草稿、接入和回归。用户最新 [Google Cloud KMS 选型](./C01-google-cloud-kms-selection.md)不变。本轮不创建云资源、接入真实 KMS、部署、迁移数据库、充值或调用付费模型。

此处 `LOCAL_PASS` 仅指下表已实现并测试的本地控制流，不把 mock 或 Node 测试当作真实数据库、Workers、费用或生产 SLO 证据。没有通过 C01 的保护级别、承载、身份或账务发布门禁。

## 2. 实际合同与覆盖面

| 事项 | 当前实现 |
| --- | --- |
| 默认值 | 文本执行使用 `300_000 ms` 本地安全上限，与既有用量安全等待的量级一致；不是经生产容量验收的 SLO。没有客户端可扩大的 timeout/header 或关闭安全限制的环境开关 |
| 绝对起点 | Chat、旧 Completions、Responses、Messages 复用 HTTP handler 创建的 request budget 的不可变 `createdAtMs`；普通外层模型回退和全局 `partition=none` 不续期。内部调用可收紧、不能延长默认上限 |
| 调度等待 | shared/BYOK 展开、sticky 读取、driver 准备及发送等待受同一绝对时间约束；下游请求取消合并到传给 driver/fetch 的信号。底层仓储和辅助认证 IO 并非都支持实际取消，见未完成项 |
| 财务准入 | 截止时间到达不遗弃已开始的持久准入 Promise；等它成功或失败后，由原路由保留释放/结算责任，且 pre-fetch 再检查截止状态，禁止迟到发送。**若准入写入本身永久挂起，返回仍可能超过截止时间；不能声称整请求已有严格墙钟上界** |
| 未发与未知 | 截止前未取得发送许可，标记当前 attempt 未派发；已领取许可且结果未确认，保守记 unknown，终止全部回退。明确收到 503/429 的 attempt 不冒充未派发，也不因错误正文超时自动变成未知消费 |
| 响应读取 | 三种文本协议的非流式 JSON 读取接收取消信号；普通/global 错误正文有字节和等待上界。终止不等待可能永不完成的 reader.cancel 确认，释放 reader；返回的有界错误正文仍由现有路由规范化 |
| 已接受 SSE | 截止时间贯穿响应体，即使下游不读取也能终止并取消上游；body.cancel 也传播到上游信号。正常协议终态保留已收集用量，最后一个发送许可成功不会被次数上限误杀 |
| 观测 | 固定 `deadline_exceeded` / `client_cancelled` 停止原因；HTTP 504 / 499 与既有跨协议错误结构对应；保留可能已发送的 attempt 事实。网关 deadline 写 `stream_error`，不冒充客户端主动取消 |
| Sticky 清理 | 有界等待 CAS 清理；超时后保留其 background mutation/trace owner，不继续发送。该元数据写入不授权或结算资金，不将此模式套用到财务准入 |

计时器与状态均为请求局部，正常 EOF/取消/异常时清理。Node 定时器不独自阻止空闲进程退出。支持传入绝对时间不代表有跨进程、重启或客户端重试的 exactly-once。

## 3. 实现与回归发现

- [截止控制器](../../../../packages/proxy/src/services/request-deadline.ts)、[请求预算起点](../../../../packages/proxy/src/services/request-dispatch-budget.ts)、[文本入口适配](../../../../packages/proxy/src/services/proxy.ts)、[统一 dispatcher](../../../../packages/proxy/src/services/failover-dispatch.ts)及 [global 调度](../../../../packages/proxy/src/services/model-fallback-global-dispatch.ts)。
- [有界 reader](../../../../packages/proxy/src/services/egress/bounded-response-body.ts)、[JSON 公共处理](../../../../packages/proxy/src/services/egress/text-json-response.ts)、[Chat driver](../../../../packages/proxy/src/services/egress/openai-driver.ts)、[Responses driver](../../../../packages/proxy/src/services/egress/openai-responses-driver.ts)、[Messages driver](../../../../packages/proxy/src/services/egress/anthropic-driver.ts)。
- [控制器测试](../../../../packages/proxy/src/services/request-deadline.test.ts)、[调度/driver 故障测试](../../../../packages/proxy/src/services/request-deadline-dispatch.test.ts)、[真实 Hono 路由链测试](../../../../packages/proxy/src/routes/v1/request-dispatch-limit.test.ts)。新测试同时加入主测试与已有专项 CI 调用的 script，且纳入专项 TypeScript 检查。

初次故障注入复现“可能已发送的超时没有 attempt 记录”和“错误正文永久挂起”；该运行在已确认卡住的测试处主动终止。修复后重跑通过，未把被终止的运行记为成功。专项类型检查曾发现 hook context 和仓储 fixture 类型不完整；通过类型缩窄及显式 fixture 结构修复，未添加双重断言或忽略错误。

## 4. 最终验证

环境：Windows、Node.js **24.14.1**、本地 Workers types **5.20260829.1**；`.nvmrc` 仍为 **22**。本轮 npm 最新类型查询因网络 EACCES 失败，使用技能允许的已安装类型回退，未修改依赖或兼容日期。配置保留 `enable_request_signal` 和关闭正文日志。

基线 HEAD：`7eb59008f7d8e156e81fd18a57658fdef2553264`，不是干净工作树；受测修改文件见 [源码/测试快照](./C02-text-deadline-snapshot.json)。既有 C00、C02.A 快照保留，不用新摘要覆盖旧证据。

| 检查 | 最终结果 |
| --- | --- |
| `npm.cmd run typecheck -w @octafuse/proxy` | 退出 0 |
| `npm.cmd run typecheck:dispatch-safety -w @octafuse/proxy` | 退出 0，含业务源码及四个专项测试文件 |
| 两个 deadline 测试文件 | 32 tests，通过 32；fake clock 驱动截止时间，不真实等待 300 秒 |
| 四个 HTTP 入口 | 既有 8 项 + 新增 8 项均通过；新增项覆盖 ordinary/global 两种回退，504、一次发送、协议错误结构及一条终态用量记录 |
| `npm.cmd test -w @octafuse/proxy` | 完整 npm 生命周期退出 0；所有前置专项完成，最终主 suite **724 tests / 134 suites，724 通过，0 失败/取消/跳过** |
| `npm.cmd run test:dispatch-safety -w @octafuse/proxy` | 最终 **184 tests / 17 suites，184 通过，0 失败/取消/跳过**，退出 0 |
| `git diff --check` | 退出 0 |

724 与 184 包含重叠，不能相加为独立覆盖数。完整命令的输出只读过滤用于保留汇总，显式返回 npm 原退出码；没有过滤失败而改变退出状态。没有远端 CI、Node 22、Workers runtime 或三种真实数据库的本轮实测。

全部 provider 行、凭据、模型及上游响应均为合成数据，fetch 被拦截。Hono fixture 使用有限 SQL 接受器及免费报价；它证明控制流/日志次数，不证明真实账务原子性、持久恢复、上游停费或 KMS 权限。

## 5. 未完成项与下一步

**唯一下一实施项仍在 C02.B：C02.B2 — 补齐入站生命周期与分阶段时限。** 按以下次序继续，不进入 C03 或把 B1 当成 B 全部验收：

1. 将预算起点以前的 body-limit middleware、认证/仓储初始化，以及 handler 内 JSON 上传、模型规划/政策读取接入可清理的生命周期；当前只在进入调度时检查已花时间，不能主动中断所有此前等待。
2. 明确首响应 headers、首 token、idle 和总时间各自语义/数值、错误及计量规则；当前只有三种文本协议的总截止控制，不把“还没首 token”当成未接受证据或回退许可。
3. 完成底层仓储、共享/BYOK 全池展开、解密与 Vertex/OAuth 辅助 IO 的取消/局部循环检查；当前外层停止等待不保证这些函数立即停止后续内部读取。大池的 Top-K 和全池解密移除仍属于 C07–C09。
4. 为持久化准入/释放/结算设置真实存储超时和可恢复状态协议；验证迟到提交及故障恢复，不能把 Promise.race 当作数据库取消或事务回滚。deadline 后迟到 actual usage 的耐久调整仍依赖后续账务工作包。
5. 扩充 Workers、Node 22、真实 DB、背压与有字节无有效 token 的矩阵；其余模态、辅助请求、SDK/平台重试与故障域切换上限继续由 C02 原条目覆盖。本轮没有将 300 秒默认强加到已有独立长任务时限的音频/实时/图像入口。

因此 C02.1–C02.7 / C02.G 均保持未勾选。回退策略为暂停受影响入口或收紧已验证路径，保留已接纳请求和账务事实；不退回无界重试、丢弃预留或恢复旧明文池。

Workers 最佳实践技能促使本轮保持请求局部状态、流式背压、取消清理与明确的 Promise owner；按 [官方请求信号合同](https://developers.cloudflare.com/workers/runtime-apis/request/)核对现有兼容开关，并按 [流式处理/后台工作边界](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)区分响应生命周期与后台任务。测试计时采用 [Node 官方 MockTimers](https://nodejs.org/api/test.html)接口；这些文档核验不替代真实运行时验收。
