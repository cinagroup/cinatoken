# C04 v401 — exclusive credential-free Chat ingress 的下一步范围

这是实施前只读审查的历史范围。后续默认关闭的本地实现见 [v401 ingress](C04-exclusive-credential-free-chat-ingress-v401.md)；下文描述审查时的源码状态与要求，不是当前实现或验收声明。出厂公开 Chat 配置仍走旧认证、预算和带凭据路由。

v400 组件是后续接入的候选输入。完整同库前置条件以 [v400 native 报告](C04-complete-text-auth-routing-recovery-coinstall-v400-report.json) 的最终 `status`、`cleanup`、逐项真实场景和 source/catalog pins 为准；运行中的阶段、单元测试及 catalog-only 结果不能代替完整通过。即使 v400 完整通过，也不能据此勾选 v401 或公开入口切换。

## 最小本地实现边界

第一步是默认关闭、由服务器配置的精确 Chat 分支，并在真实 Hono 入口证明互斥。仅覆盖 `POST /v1/chat/completions` 与 `POST /api/v1/chat/completions`，斜杠处理与实际 router 一致。其他方法、管理接口、旧 Completions 和其他协议不纳入此次范围。

| 位置 | 当前行为 | successor 必须建立的边界 |
| --- | --- | --- |
| [app.ts](../../../../packages/proxy/src/app.ts):79、221–241、398、434 | 配置既有 role bindings；HTTP capacity 与 text lifecycle 在 storage/auth 之前；两个 Chat alias 共用 router | 新增独立默认关闭的服务器 composition；捕获配置和端口，验证精确路径、PostgreSQL、reviewed activation、必要角色连接与私有 holder binding。保留已有 capacity、上传限额和 lifecycle 顺序 |
| [chat.ts](../../../../packages/proxy/src/routes/v1/chat.ts):155 与 [auth.ts](../../../../packages/proxy/src/middleware/auth.ts):149 | `requireApiKey` 调旧 `authenticateApiKey` | 在调用旧认证前选择新认证分支；启用分支用 actual v395 acknowledged receipt 建立 context。不能等到 handler 内才选择 |
| [chat.ts](../../../../packages/proxy/src/routes/v1/chat.ts):159–227 | handler 先构造 shared-key quote capture、producer 与旧 usage closure | 新分支在这段初始化之前进入自己的 preparation/composition，不能先执行旧初始化再跳转 |
| [chat.ts](../../../../packages/proxy/src/routes/v1/chat.ts):253–372 | session controls → preset → request Guardrail → 最终模型解析/sticky context | 复用有边界的 preparation 操作，使用同一已认证主体，捕获原始 body hash 与最终正文；Guardrail 失败立即返回安全错误 |
| [chat.ts](../../../../packages/proxy/src/routes/v1/chat.ts):378 | `buildModelFallbackPlan` 开始加载完整旧路由 | 新 preparation 完成后构造 `createFinalChatQuoteSnapshot`，调用 successor seam 并终结请求；不得落入该 plan 或旧 response/settlement 尾部 |

旧认证本身包含写操作：[api-key-auth.ts](../../../../packages/proxy/src/services/api-key-auth.ts):44 在认证结果转换时调用 `persistLazyBudgetResetIfNeeded`，后者在 [user-service.ts](../../../../packages/core/src/services/user-service.ts):157、214 执行旧周期 CAS/audit；旧 key lookup 也可能迁移 legacy 明文 key。因此仅在 `buildModelFallbackPlan` 前增加开关不能建立 exclusive auth/period ownership。

建议本地修改范围仅为 `app.ts` 的显式 composition、Chat 的认证选择/context、独立 ingress preparation 模块与入口测试。旧 auth/reset 服务无需改写；关闭分支继续调用现有代码。启用后缺少配置、类型不匹配或新 authority 失败均返回错误，不回退到旧路径。

## 先检查配置与支持的 profile

- 在调用认证写操作前检查 feature/profile 配置：仅 personal Gateway Bearer；禁止管理凭据、其他客户端凭据约定以及启用旧 shared-key producer、aggregate budget proof 或 PostgreSQL Chat budget owner 的混合 composition。角色连接必须由服务器提供并满足各 actual 客户端的 LOGIN contract；请求不能指定角色、连接、holder、价格或身份。
- 有界读取并捕获原始请求 bytes/hash；该捕获不得依赖旧 `POSTGRES_CHAT_BUDGET_OWNER_ENABLED`。已知不支持的 ingress controls 早拒绝；preset/Guardrail 后再次检查最终 profile，所有拒绝均在 quote enrollment/admission 之前。
- 初始 profile 为默认平台平坦文本 Chat、JSON/SSE、受 v360 支持的模型列表。最终 body 限于 `model/models/messages/max_tokens/max_completion_tokens/stream/temperature/top_p/presence_penalty/frequency_penalty/seed/stop/user`；messages 的 role/content、模型个数及其他 bounds 继续由 [actual v360 SQL](../../../../packages/core/migrations-proposals/postgres/authenticated-complete-text-quote-v360.sql):234 起独立检查。
- tools、结构化/多模态 content、response_format、audio、logprobs、service-tier、provider preference/sort/partition、其他协议适配和 private BYOK/shared-key 选择不在这一步 profile 内。不能为兼容这些输入调用旧 credential router。受支持的 gateway controls 必须先解析、移除，再创建最终 snapshot。
- 若需要 preset，先以 v395 receipt 的 workspace/user 解析，再检查转换结果。source attestation、endpoint capacity/default eligibility、策略与 sticky namespace 必须来自 actual projection/preparer authority，不能由调用者补证。

这些 Worker 预检查只用于尽早拒绝。actual capability、quote、projection、grant/custody/start 和 SQL fences 仍须各自验证 authority，不能以 Worker 判定替代。

## Guardrail 的两个独立阻断点

request Guardrail 可复用：[request-guardrails.ts](../../../../packages/proxy/src/services/request-guardrails.ts):249–287 执行 policy preflight、审计和 key/workspace budget intent 读取，不在此处 reserve budget。传递 preparation deadline；审计等写操作须被持有并等待确认，不能与取消做不受控的 race。返回的 intents 只交给 actual v361 admission 一次。

**阻断错误的诊断也不能规划旧路由。** [chat.ts](../../../../packages/proxy/src/routes/v1/chat.ts):324 在 Guardrail 拒绝且 metadata 开启时仍调用 `buildModelFallbackPlan`。其底层 [model-router.ts](../../../../packages/proxy/src/services/model-router.ts):324 读取 Provider rows，并构造含 `providerEndpoints/providerApiKey` 的 `RouteResult`。新 ingress 必须绕过整个诊断分支。最小 profile 可以早拒绝 router metadata；若保留错误 metadata，只能输出公开的请求/Guardrail 信息，不能为诊断读取旧 plan。

**output Guardrail 尚未由 v400 seam 实现。** 旧 [chat.ts](../../../../packages/proxy/src/routes/v1/chat.ts):917 起才过滤、审计并处理响应。v400 直接返回私有 holder response stream。初始 successor 必须在 quote/admission/handoff 前拒绝非空 `outputFilters`，直到另有经过证明的 response owner；不能静默略过，也不能进入旧响应尾部补做。

最终正文使用 [chat-final-quote-input.ts](../../../../packages/proxy/src/services/chat-final-quote-input.ts):109 的 `createFinalChatQuoteSnapshot`。其后不得再改写 bytes、模型顺序或 session namespace。不要调用 :148 的 `createFinalChatQuoteInput`，该接口要求先取得旧 `ResolvedPlan`。

## 两次认证的身份与 epoch 漂移

v395 context 必须在 preset/Guardrail 前建立，而冻结 [v400 seam](../../../../packages/proxy/src/services/complete-chat-credential-free-dispatch-v400.ts):79 又会认证一次。直接串联时存在明确的组合风险：前一次主体/epoch 决定 preset 与 Guardrail，后一次主体/epoch 决定 quote。当前 [ApiKeyContext](../../../../packages/proxy/src/middleware/auth.ts):17 也不携带 `keyLimitEpoch`。

successor 必须选择并证明一种组合：

1. **再次 actual 认证并比较。** 在报价前，将第二份已确认 v395 receipt 与 preparation receipt 比较 `keyId/userId/workspaceId/budgetEpoch/keyLimitEpoch`。任一漂移都中止；不能把第二份身份静默套在第一份策略/body 上。policy source 漂移仍由实际后续 SQL 验证。
2. **服务器持有一份已确认 receipt。** 新的内部 composition 在私有 closure 中捕获实际 v395 客户端完成 COMMIT 与 LOGIN close 后返回的不可变 receipt，用它进行 preparation；通过服务器内部的 auth port 或新的 typed successor seam 传递同一 receipt。请求不能提交 receipt/context，裸 SQL 返回也不能跳过客户端确认协议。不得改写冻结 v400 来扩大它的验证声明。

第二种只避免重复认证，不提供持续 freshness。两种方案都必须运行 actual v360 capability/quote：[postgres-complete-chat-quote-v360.ts](../../../../packages/proxy/src/services/postgres-complete-chat-quote-v360.ts):125–136、228–238 将 capability 回执与 key/user/workspace/budget/key-limit epoch 比较，并绑定原始 hash、最终正文及 request。旧 receipt 已过期、key 被禁用或 epoch 改变时必须失败。不能采用缓存 receipt 作为免检查的 admission 许可。

Bearer 仅留在服务器内部；context/日志/响应不能暴露它。新 context 应显式携带 key-limit epoch，不伪造旧 `apiKeyHash` 作为 C04 路由 authority。

## 互斥、取消与财务约束

新分支一次性执行 actual `395 auth → 360 quote → 396 projection → 398 preparation → 验证并构造 v363 六字段 envelope → 361 admission → 私有 holder`。v400 当前组件捕获端口/配置、复核 expiry 并限制一次 handoff，可作为 successor 的审查输入；它的单元测试不证明公开入口和 SQL 共装。

启用分支不得执行以下旧 owners，即便新分支发生拒绝、取消或 ACK loss：

- [chat.ts](../../../../packages/proxy/src/routes/v1/chat.ts):494 的 `openPostgresChatBudgetRequestOwner`、:524 的 authenticated budget proof、:553 的 route-aware budget admission。
- :596–622 的旧 `beforeUpstreamDispatch`/permit，:645 的 `dispatchGlobalModelFallback`、:780 的 `proxyChatCompletions` 及任何旧自动 fallback。
- :969–1118 的旧 usage/cost settlement、`recordQuotedUsage`/`recordUsage`、shared-key economic producer 和 :1123 的旧 budget-owner completion。

保留 [text-request-lifecycle.ts](../../../../packages/proxy/src/middleware/text-request-lifecycle.ts):98–128 的 preparation deadline、owned mutation drain 和 resource completion。跨 await 检查取消与 quote/projection/admission expiry；不得 race 未登记的角色写操作。未知 COMMIT/close 必须中止新发送，并持有尚未确认清理的资源。准备 deadline 的 dispose 与已交付 response stream 的取消不能混为一体；private holder 的响应/续租工作也须有明确 owner。

完整响应或 sent observation 仍是 unknown/hold，不推出下游已收到、Provider 免费或财务终态；不在 Gateway 补做旧账务写入。此接线不能取消 no-fetch/terminal/recovery fences，也不能降低 Provider billing 或 C01/C02 的独立验收要求。

## 聚焦的入口测试

测试边界是实际 `createProxyApp`/Hono request 的两个 Chat alias，包住认证选择、preset/Guardrail、最终 body 和响应返回。先用受控端口证明流程互斥，再以修复并冻结后的真实 v400 同库栈补 actual authority/财务证据。mock 入口测试不能代替 native SQL 场景。

| 场景 | 必须观测的结果 |
| --- | --- |
| 启用后成功的 JSON/SSE | 两个 alias 都只调用新准入一次、holder fetch 一次，且 envelope 恰为六字段；旧 reset/owner/plan/permit/dispatch/usage writer 的 traps 全部零调用 |
| 关闭 feature | 当前 legacy 入口测试继续通过；旧 auth/预算/路由行为不变，非 Chat route 与旧 Completions 不受影响 |
| 错误 activation、缺失 binding、D1、混合旧 owner/producer、unsupported credential/profile | 明确拒绝；零 quote enrollment/admission/holder，零 legacy fallback；最终 body 经 preset/Guardrail 变为 unsupported 也同样拒绝 |
| Guardrail 阻断并带 metadata request | 早拒绝 metadata 或安全阻断返回；`buildModelFallbackPlan`/Provider credential read trap 零调用 |
| 非空 outputFilters | quote/admission/handoff 前拒绝，不进入旧 response tail |
| 两次认证 key/user/workspace 或任一 epoch 漂移 | 第二次 actual receipt 后、报价前失败；receipt 方案则验证 actual capability/quote 拒绝禁用或旧 epoch，不能用缓存放行 |
| body/session/config 调用者跨 await 修改 | 原始 hash、最终 bytes/model order、identity、role connections 与 affinity namespace 保持捕获值，holder 只见最终绑定正文 |
| pending/unauthorized、过期、准备或 admission 后取消、COMMIT/close ACK loss、holder 不可用 | 零旧 reset/owner/plan/permit/dispatch；失败后不再 handoff。重复 run/错误处理不能形成第二次准入或发送 |

对旧认证 lookup、`persistLazyBudgetResetIfNeeded`/旧 budget CAS、Provider repository/plan、旧 owner factory、permit/dispatch 与账务 writer 设置明确的 fail-on-call spies。Guardrail audit 和 preset/key/workspace 的允许读取应单独观测，避免把必要 preparation 错误禁掉。

## 实施前置条件与仍未完成的验收

本地可立即实施：精确默认关闭 composition、early auth selector、successor receipt/context、独立 preparation 与上述入口互斥测试。它们不要求部署或改写冻结 SQL。

进入实际角色接线前仍需：v400 native 报告最终完整 PASS、cleanup PASS、执行来源与最终 catalog 独立核验；真实入口加同库 SQL/holder 的组合测试；role bindings、source attestation 与 reviewed activation 的部署配置审查。output Guardrail 的独立实现、跨周期续租/结算、所有 provider controls/fallback、Cloudflare/Hyperdrive、sent/unknown 财务终态和 Provider billing 验收都不由本范围替代。

参考输入：[v395 auth/period](C04-personal-key-auth-period-v395.md)、[v398 credential-free preparation/sticky](C04-credential-free-route-attempts-sticky-v398.md)、[v400 seam 组件](C04-credential-free-gateway-seam-v400.md)、[v400 coinstall 范围](C04-complete-text-auth-routing-recovery-coinstall-v400.md)。本说明仅确定下一道本地 gate；没有 v401 acceptance、公开 cutover 或上线批准声明。
