# C04 v400 — personal 鉴权到私有 holder 的安全选路接缝

这是 review-only 的默认平台平坦文本 Chat 组件。公开 handler 尚未调用；正式迁移、远端数据库和生产开关不变。

- [源码](../../../../packages/proxy/src/services/complete-chat-credential-free-dispatch-v400.ts)
- [定向测试](../../../../packages/proxy/src/services/complete-chat-credential-free-dispatch-v400.test.ts)

## 实际执行顺序

`createCredentialFreeCompleteChatDispatchV400` 默认调用真实专用客户端：v395 personal auth → v360 完整报价 → v396 已提交投影 → v398 安全尝试准备 → 验证并构造 v363 六字段 envelope → v361 无金额准入 → 私有 holder。先验证 envelope，准入提交确认后才执行 handoff。

Gateway 不构造含凭据的 `RouteResult`，也不读取 Provider URL、私有模型名称、ciphertext 或 KEK。路由选择来自已确认的投影；完整候选先通过容量、默认端点、策略、熔断和 sticky 检查。一次性接缝从首个有可用尝试的模型选择一个目标；首次 handoff 后不会在模型内或跨模型自动重试。私有 holder 仍须自己读取 committed quote/route，再取得 grant/custody/send-start 才可物理发送。

工厂在任何异步操作前捕获最终正文快照、bearer、角色连接、runtime client 的 driver/raw/drizzle 引用、Guardrail intents、session 与端口；鉴权返回的 key/user/workspace/epoch 构造后续身份，调用者不提供权威身份。每个客户端只有所需连接参数。报价、投影、准备结果与准入返回绑定同一个 request/body/quote/model 顺序；admission 后仍复核 quote/projection/admission 的有效期与取消。

holder 接收的只有 requestId、quoteId、attemptNonce、candidateIndex、routeTargetId、finalBodyUtf8。完整 JSON 或 SSE 流的提交后释放仍由实际 v394 holder 协议管理；Gateway 仅保留 Content-Type 与 no-store 响应头。handoff 期间取消或 private response 不可用时取消未交付正文，并且不再次 handoff。权限客户端的未知 COMMIT/close 结果原样中止，不释放新发送。

## 当前验证范围

定向 **11/11** 通过：调用实际 v398 准备算法验证配置选择 z 而非清单顺序 a、六字段 envelope、一次性执行、JSON/SSE 头清理、鉴权/pending 阻断、quote/project/admit 回执不明、身份/金额漂移、全熔断不准入、admission 后取消/投影过期、调用者异步修改（含 runtime client driver/raw）不生效和 handoff 中取消正文。包含 v395/v396/v398 与既有策略回归的[联合单测报告](C04-credential-free-gateway-seam-v400-unit-report.json)为 **75/75 PASS**，29 个源 pins 无漂移；Proxy 类型检查通过。

这些定向场景的数据库端口使用测试替身，不能单独作为 PostgreSQL 事务或共装证据。另行执行的生成工具 **21/21 PASS** 已记录在同一联合单测报告中，其计数不包含在 75 项回归里。

[v400 同库原生报告](C04-complete-text-auth-routing-recovery-coinstall-v400-report.json)最终 **137/137 阶段、cleanup PASS**，实际执行 v395/v360/v396/v398/v361 客户端及 v394 Worker；受信任测试装饰器仅发布 routing attestation 并收集实际返回值。Gateway 输入和 handoff 不构造含凭据旧计划。原有响应／并发场景共 13 次本机 POST，新增选路、准备、sticky、鉴权与恢复检查不增加 POST。真实 source/capacity/default/all-candidate/membership 拒绝、双事务 `55P03` 后 writer COMMIT、sticky CAS／有效期／ACK 丢失、完整响应观察／no-fetch 双顺序及恢复、合法周期重置后旧报价失效、零持仓 unresolved grant 阻止重置、实际 auth COMMIT 回执丢失后的独立确认均通过。

14 项真实安装负例全部拒绝并恢复基线。其中 public 的 migrator-owned SECURITY DEFINER 包装函数实际可被 auth/projector 调用并读取非零 credential 行计数，而两个角色直接读取私有列均报 `42501`。测试先恢复临时 public CREATE ACL，再确认安装器因额外函数／外部权限报 `P0001`；包装函数、inactive Provider 夹具和所有临时权限随后完整清理。

原生测试发现冻结 v362 的 fresh LOGIN 无限预算分支访问未赋值 `ordinary record` 会报 `55000`。[v400 installer](C04-complete-text-auth-routing-recovery-coinstall-v400.md)仅将这一处声明改为限定 schema 的 `%ROWTYPE`，既有财务、有效期、epoch 与围栏条件不变；真实 fresh per-call LOGIN 的零持仓 grant 与 pending auth 在修复后通过。旧 v362 与 v395–v399 文件保持原样。

独立核对 118 个来源摘要（117 个文件 pin 条目，对应 115 个不同文件，另加 PG73 corpus）、327 个 core 源文件以及安装后／全部场景结束后的完整 catalog。最终为 142 函数／93 表／135 trigger；132 个既有函数完整契约不变，grant 只有上述正文声明变化，122 个既有 trigger、角色和默认 ACL 保留。报告 SHA256 为 `a2c5946e2858428733fc35da0bb58f3a8fb1fe479c6c7f3770fd6c830db12a8e`。

CI 已登记，Linux CI 尚未运行。生产 public handler、Cloudflare/Hyperdrive、完整 ingress/provider controls、dispatch/fallback、跨周期续租／结算和 sent/unknown 财务终态仍需相应证明。公开接线的下一步边界记录在 [v401 范围说明](C04-exclusive-credential-free-ingress-scope-v401.md)，仅为审查范围，没有接线或验收。C04.1–8/G 仍不勾选。
