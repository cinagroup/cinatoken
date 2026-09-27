# C02.A — 请求级 dispatch 次数止损

日期：2026-09-05。状态：**本地子集 LOCAL_PASS；C02 整包 DOING，C02.G 未通过**。

历史说明：本文及对应快照保留 C02.A 当时的验证结果。后续已推进 [C02.B1 文本 deadline](./C02-text-deadline.md)，当前源码、测试计数与唯一下一步以该证据和主 Checklist 为准，不将下文“尚未实现”的历史描述当作当前代码扫描结果。

执行 Owner / 本地复核：Codex（当前任务）；独立安全、运维与生产验收 Reviewer 待指定。

## 1. 前置合同与本轮边界

依据 [V2.1](../cloudflare-ai-gateway-multi-egress-v2.md) 已有“总上游 dispatch 不超过 3 次”的要求，本轮固定以下本地执行合同，支持 C01.3/C01.10 的次数止损子集。不据此认定 C01 整包通过，也不批准尚未选定的业务价格、账务权威、deadline 数值、部署拓扑或 AWS 权限。

| 合同 | 本轮规则 |
| --- | --- |
| 生命周期 | 每个入站文本请求创建一个预算对象，外层模型回退、全局候选调度及 Key 展开共享同一对象；不是进程全局计数 |
| 硬上限 | 默认 3 个发送许可；内部调用可收紧至 1–3，不能扩大上限；客户端不能设置此内部对象 |
| 计数点 | 已委托 pre-fetch 边界的 driver 在本地准备及财务准入后、出站前同步领取许可；未完成该边界审计的旧 driver 在入口保守领取 |
| 并发 | 等待异步准入后重新同步检查并领取；并发分支不能同时花掉最后一个许可 |
| 不退款 | 已领取许可不退还，失败或 unknown 不恢复额度；预算计数与资金预留/扣费是不同概念 |
| 终止 | 耗尽时返回 HTTP 502 / `gateway.dispatch_limit_exceeded`；`failoverForbidden` 必须同时终止内层和外层模型循环 |
| 成功/未知 | 第三次成功仍正常返回；已接受流及其 usage promise 保留；未知发送结果不能触发下一模型重放 |
| 发布 | 仅本地实现/合成数据验证；没有生产切流授权，C01/C02 整包及后续门禁仍有效 |

这不是耐久单次消费凭证，不提供跨进程、重启、客户端重试或重复 request ID 的 exactly-once。`permitsConsumed` 明确表示保守发送许可，不冒充已覆盖所有辅助 HTTP、SDK 内层调用和网络重定向的物理发包计数。

## 2. 实现与发现

- [request-dispatch-budget.ts](../../../../packages/proxy/src/services/request-dispatch-budget.ts)：独立于有界 trace 数组的请求级预算、不可变快照、同步检查/领取。
- [failover-dispatch.ts](../../../../packages/proxy/src/services/failover-dispatch.ts)：在候选循环和 pre-fetch 边界执行限制；外层模型已花完额度时，在共享池展开、凭据读取及再次财务准入之前拒绝。单次候选展开本身仍可能全池读取，未宣称解决 C07。
- [proxy.ts](../../../../packages/proxy/src/services/proxy.ts)：已有 pre-fetch 委托能力的入口即使未传财务 options，也开启该边界；其余旧 driver 保守在入口计数。
- [全局模型调度](../../../../packages/proxy/src/services/model-fallback-global-dispatch.ts)与 [Chat](../../../../packages/proxy/src/routes/v1/chat.ts)、[Messages](../../../../packages/proxy/src/routes/v1/messages.ts)、[Responses](../../../../packages/proxy/src/routes/v1/responses.ts)：传递同一预算；旧 Completions 复用 Chat handler。
- [错误码](../../../../packages/proxy/src/services/gateway-error-codes.ts)及[公开错误映射](../../../../packages/proxy/src/services/openrouter-error-protocol.ts)：增加次数耗尽响应；不暴露 credential 或原始上游错误正文。

路由级 RED 测试另外发现：内层已标记 `failoverForbidden`，外层模型循环在赋值终态结果后却未 `break`，因此网络结果未知仍会继续发送。本轮修复三处外层循环；四个公开文本入口均有回归断言。现有 unknown 的公开错误规范化仍为 `upstream.server_error`，本轮保留该兼容行为，不谎称另一个错误码已接通。

停止原因日志采用固定 `dispatch_limit_exceeded` 和数值计数。拒绝的下一候选不伪造为已发送的 trace；`admissionDeniedPreDispatch` 仅指当前 attempt，不能解释成整个请求从未发送。全部停止原因的统一观测仍属于 C02.7 未完成内容。

## 3. 验证证据

环境：Windows / Node.js 24.14.1；本地已安装 Workers types 5.20260829.1。仓库 `.nvmrc` 为 Node 22，本轮未在 Node 22、Workers、真实数据库或云上执行这些测试。最新 types 查询因本地 npm 镜像访问 EACCES 未成功，按技能允许的回退使用已安装类型，未宣称最新版已验证。

基线 HEAD：`7eb59008f7d8e156e81fd18a57658fdef2553264`，包含既有未提交工作。对应 [受测文件快照](./C02-dispatch-budget-snapshot.json)；本轮未修改既有 Admin、Core、数据库切换指南或 AWS 选型文件。

| 检查 | 实际结果 |
| --- | --- |
| 初始 20 候选 RED | 旧实现执行 20 次，期望 3，断言失败；不是靠 trace 截断伪造成功 |
| 四个入口的外层 unknown RED | 8 项中 4 通过、4 失败；未知结果实际发送 3 次、期望 1 次 |
| 同一路由测试修复后 | 8/8 通过：503 最多 3 次，unknown 仅 1 次；每请求仅写一份终态 usage 日志 |
| `npm.cmd run typecheck -w @octafuse/proxy` | 退出码 0；覆盖业务源码 |
| `npm.cmd run typecheck:dispatch-safety -w @octafuse/proxy` | 退出码 0；源码及两个新增测试文件一起按真实类型检查，未用双重类型断言掩盖 D1 fixture 缺项 |
| `npm.cmd run test:unit -w @octafuse/proxy` | 整个 npm 生命周期退出码 0；前置专项测试完成，主 suite 684 tests / 134 suites，684 通过、0 失败 |
| `npm.cmd run test:dispatch-safety -w @octafuse/proxy` | 退出码 0；11 个测试文件、144 tests / 17 suites，144 通过、0 失败；在最终 fixture 类型修正后执行 |
| Workflow YAML / 测试路径 | 本地 YAML 解析、事件/权限及引用路径断言通过；不等于 GitHub Actions 已运行 |

主 suite 在最终仅涉及 fixture 类型修正之前执行；修改后的测试已由专项 suite 重新覆盖。不同命令有重叠测试，不能把 684 与 144 简单相加宣传成独立覆盖数量。

主要测试：[预算单元/调度集成](../../../../packages/proxy/src/services/request-dispatch-budget.test.ts)、[真实路由链](../../../../packages/proxy/src/routes/v1/request-dispatch-limit.test.ts)、[failover 合同](../../../../packages/proxy/src/services/failover-dispatch.test.ts)、[全局模型合同](../../../../packages/proxy/src/services/model-fallback-global-dispatch.test.ts)。覆盖大型候选池、Key 顺序不绕过上限、跨模型额度复用、并发最后一个许可、财务拒绝不消耗发送额度、本地准备失败不冒充发送，以及最后一次成功流与用量收集不受影响。

路由测试运行真实认证、规划、路由循环、dispatcher 和文本 driver；但凭据/模型均为合成行，`fetch` 被拦截，D1 仅是接受有限 SQL 的测试替身。它验证控制流与日志调用次数，不证明真实资金原子性、数据库事务或 AWS 权限。

## 4. CI 与停止/回退

新增 [专项 CI](../../../../.github/workflows/proxy-dispatch-safety.yml)：相关 PR、main/develop push 或手动触发，使用 `.nvmrc`、`npm ci`、源码/新增测试类型检查及专项 suite；`contents: read`，15 分钟上限，不需要云凭据，不部署。新增 [测试脚本](../../../../packages/proxy/package.json)及[类型检查入口](../../../../packages/proxy/tsconfig.dispatch-safety.json)。

CI 文件仅已在本地编写和静态验证；没有远端执行或分支保护配置证据。C00 记录的其他 CI 缺口没有因此全部消失。

次数限制是源码安全默认值，本轮未新增可绕过上限的环境开关。若后续实测发现回归，暂停受影响路由或收紧候选，保留已接纳响应/结算，不以回退无界尝试作为恢复方案。未创建云资源、配置真实密钥、执行生产迁移、付费推理或资金操作；外部费用与资源清理不涉及。

Workers best practices 技能约束了请求计数的局部生命周期、promise 处理与真实类型核验；没有因技能示例而引入跨请求明文缓存或失败后盲目重发。

## 5. 未完成项与唯一下一步

**下一步：C02.B — 统一 deadline 与取消传播的本地合同/实现/回归。** 先复核既有 timeout、TTFT、idle 和 usage 收集，固定请求级绝对 deadline 的覆盖面及终态处理；数值作为待验收运行参数，不推断生产 SLO 或上线批准。

同时保留后续 C02 阻断项：

1. 跨 billing/provider-account/故障域的独立切换上限与稳定 credential version / operation 身份尚未实现。
2. 所有模态的实际发送点、OAuth 等辅助出站、自动重定向及 SDK/平台内层重试尚未逐一纳入同一预算；非文本入口未获得本轮真实路由级等价验收。
3. 统一 absolute deadline 尚未覆盖选路、读取/解密、退避、错误体清理与流生命周期；发送许可数量有界不等于等待时间有界。
4. `allow_fallbacks=false`、provider 约束、取消/429/断流和所有模态成功后的不重放仍需按 C02.G 的完整矩阵复验；已有专项通过不替代矩阵闭环。
5. 未消除全池读取/解密、进程内共享健康、持久授权和恢复缺口；不得据此扩容为大规模共享 Token 池或开放商用。

C02.1–C02.7/C02.G 保持未勾选，避免将复合条目的一部分实现冒充整条验收。C01 最新已改选 [Google Cloud KMS](./C01-google-cloud-kms-selection.md)，project/location/保护级别/身份/承载、账务与商业发布决策仍另行推进。上文和 JSON 快照中的 AWS 未验证项是 C02.A 当时的历史事实，不是当前选型，也不表示 Google 已验证。
