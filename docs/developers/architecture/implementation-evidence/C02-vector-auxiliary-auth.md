# C02.B2.2 — Embeddings / Rerank 辅助认证与取消

日期：2026-09-05。状态：**已列 Node 子集 LOCAL_PASS；C02 仍为 DOING。** Owner / 本地自检：Codex（当前任务）；独立 Reviewer 待指定。

接续[请求级认证预算](./C02-auxiliary-auth-budget.md)，不覆盖历史证据。Google Cloud KMS / project `cinatoken` 的决定不变，本轮不涉及 KMS 实现或云操作。

## 1. 实现与边界

- `proxyEmbeddings` / `proxyRerank` 将同一个 dispatch budget 的 `auxiliaryAuth` 传到 driver/Core：推理许可最多 3 次、认证 exchange 最多 3 次，两个计数独立。换 provider、共享/BYOK Key 不重置；普通 Key/有效缓存不消耗新认证许可。
- 两个 proxy 复用现有绝对调度 deadline 所有者：默认 300 秒、内部可收紧不可延长，关联 ID 和 Chat 风格错误保持一致；客户端取消为 499，调度到期为 504。**起点是 proxy 调度，不是向量请求到达**，上传、鉴权、guardrail 和路由准备尚未纳入这一 owner。
- driver 将取消信号传至 OAuth 和已接受 JSON 响应的有界读取。停止后不会进行下一次资金准入或模型 fetch；迟到 OAuth 响应会被取消。正文取消不等待可能永不完成的取消确认；Embeddings 非 JSON 正文原有的等待也已移除。
- 修正两个 route 的账务确定性判断：`failoverForbidden` 只表示禁止重试，不代表上游已接受/可能收费。上游 2xx、显式 `upstreamOutcomeUnknown` 和正文超限事实仍用于保守结算，不能因局部认证停止抹掉实际发送未知。

关键文件：[Embeddings driver](../../../../packages/proxy/src/services/egress/openai-embeddings-driver.ts)、[Rerank driver](../../../../packages/proxy/src/services/egress/openai-rerank-driver.ts)、[proxy](../../../../packages/proxy/src/services/proxy.ts)、[Embeddings route](../../../../packages/proxy/src/routes/v1/embeddings.ts)、[Rerank route](../../../../packages/proxy/src/routes/v1/rerank.ts)。未修改 Core、共享 dispatcher、依赖、Wrangler/CI 配置或 Admin。

采用 Workers 最佳实践技能后，复用显式请求所有者，不增加全局未完成 I/O，并将取消清理传至响应体；没有以只结束调用方等待替代资源清理。[Cloudflare 官方规则](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)已刷新。npm 最新类型查询被 EACCES 拒绝，按技能回退安装版本 **5.20260829.1**；已检查 AbortSignal 类型及本地 Wrangler schema/config。

## 2. 新增测试与账务反例

新增 **56 项**，其中 [Vertex egress](../../../../packages/proxy/src/services/egress/vertex-service-account.test.ts) **32**、[真实 API 调用链](../../../../packages/proxy/src/routes/v1/request-dispatch-limit.test.ts) **24**。测试继续由现有 Proxy 主套件、dispatch-safety 和专项类型检查收集，无新收集入口，也未删除/跳过既有测试。

| 场景 | 核验事实 |
| --- | --- |
| 32 个认证候选、内部 proxy 连续调用 | 同一 owner 只允许 3 次真实合成 OAuth fetch；推理与准入均 0；公共向量 API 仍不支持外层模型数组回退 |
| 主私有 → 共享 → 平台 → 后备私有 | 运行真实凭据展开，换身份不会换认证预算，耗尽后不继续准入 |
| 有效缓存 / 普通 Key | 已耗尽认证预算仍可用免认证候选；推理次数仍独立计入 |
| OAuth 中客户端取消 / 调度到期 / OAuth 超时 | 信号到达 HTTP；推理 0、准入 0、不制造未知推理；迟到正文取消 |
| 已接受正文挂起 / 非 JSON 且 cancel 不确认 | 有界结束、实际取消、释放读取锁；只发一次，不重放；已发送事实保持 unknown |
| `/v1`、`/api/v1` × 2 接口 × 6 种终态 | 真实 Hono/auth/planner/dispatcher/driver/admission/usage 链；模拟有限预算与 SQL 捕获，所有终态各写一次日志 |

API 的六种终态分别是：发送前认证超限、发送前认证取消、明确 503 后认证超限、明确 503 后认证取消、无效 2xx、模型传输未知。前两种不预留；中间两种恰好一次预留/dispatch，最终生成 `settled / 0` 的预算转换；后两种生成 `expired / 正数预留上限`。测试检查 SQL 参数与错误收集，不把 SQL 返回成功的模拟器当作真实事务/并发/持久性证明。

首次定向运行的模拟 SQL 白名单误写为 `user_budget_audit_logs`，真实生成表为 `user_audit_logs`，因此测试失败；修正 fixture 表名后全量重跑通过，未放宽账务状态/金额断言。

## 3. 最终验证

环境：Windows / Node **24.14.1**；项目要求的 Node 22 尚未验证。

| 命令 | 最终结果 |
| --- | --- |
| `npm.cmd run typecheck -w @octafuse/proxy` | 退出 0 |
| `npm.cmd run typecheck:dispatch-safety -w @octafuse/proxy` | 退出 0 |
| `tsx --test packages/proxy/src/services/egress/vertex-service-account.test.ts packages/proxy/src/routes/v1/request-dispatch-limit.test.ts` | 177 tests / 1 suite，全部通过，退出 0 |
| `npm.cmd test -w @octafuse/proxy` | 完整 pretest / main 生命周期退出 0；最终主套件 908 tests / 134 suites，全部通过 |
| `npm.cmd run test:dispatch-safety -w @octafuse/proxy` | 414 tests / 23 suites，全部通过，退出 0 |
| `git diff --check` | 退出 0 |

各套件均 0 失败/取消/跳过，计数重叠，不相加。Core 源码未变，专项包含既有 Core OAuth/认证预算测试；未重跑 Core 完整主套件。此前 workerd 完整 OAuth fixture 和最小空 Worker 均在断言前原生启动失败，本轮没有无条件重试或触发远端 CI。

HEAD：`7eb59008f7d8e156e81fd18a57658fdef2553264`。[受测快照](./C02-vector-auxiliary-auth-snapshot.json)记录 7 个本轮源码文件与 17 个相关源码/配置的 SHA-256，并对开始时 104 个 dirty/untracked 文件复核：99 个不变、5 个预期改动、0 个意外改变；另有 4 个此前干净的向量源码文件变脏，并新增本报告/快照。历史 C01/C02 证据和其他用户改动保持不变；不以 HEAD 替代脏工作树证据。

## 4. 剩余工作与停止条件

现有 17 个应用 OAuth 调用点已接入 6 个，另 **11** 个未接入：Images 2、Audio speech 2、OpenAI audio 1、DashScope ASR 3、DashScope realtime 1、Node realtime 1、Admin Playground 1。数字不含 Core 定义和测试 fixture；未接入调用的默认快照不能当作真实认证次数。

下一项仍为 **C02.B2.2**，首先接 Images generations/edits，再音频/Realtime/管理预览；后续补向量入口全过程、数据库/解密、headers/有效 TTFT/idle。Top-K、SQL 物理取消与持久写入恢复、真实 Workers/DB/Node 22、生产 SLO/配额仍未验收；C02.G 不勾选，C03–C20 不声明完成。

停止条件：认证预算重置/超发、取消后发送、认证失败触发费用未知或资金准入、已发送未知被改为已知零、任何凭据泄漏。回退应关闭对应路由或收紧候选，不恢复无界认证/正文等待，不删除在途结算事实。

外部动作：不涉及。HTTP、RSA、账号、仓储与 SQL 全是本地合成测试；没有访问真实 OAuth/模型端点、读写 KMS 密钥、修改 GCP、数据库迁移、部署、真实资金操作或新费用。本轮无数据删除。
