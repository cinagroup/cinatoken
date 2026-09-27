# C04 v401 — 默认关闭的无凭据 Chat 入口

2026-09-27。本地 successor 在实际 `createProxyApp` / Hono 中增加服务器配置的终结分支，覆盖 `POST /v1/chat/completions` 与 `POST /api/v1/chat/completions`（含尾斜杠）。出厂 Node / Workers 配置未提供 composition 或 activation；生产切换和 C04 验收继续开放。

## 接线与支持范围

[app.ts](../../../../packages/proxy/src/app.ts) 在已有 HTTP capacity、text lifecycle、上传限制和 request storage 之后、旧认证与路由之前注册 [v401 ingress](../../../../packages/proxy/src/services/credential-free-chat-ingress-v401.ts)。只有精确开关 `CREDENTIAL_FREE_CHAT_INGRESS_V401_ENABLED=reviewed-v1` 才进入新分支；缺失服务器连接、私有 holder binding、错误 LOGIN / database name、D1 或混合旧 owner / producer 均终结为安全错误。

服务器捕获连接、端口和 holder 函数；请求不能提供身份回执、价格、数据库角色或 holder。实际 v395 客户端完成 COMMIT 与连接关闭后的一份 immutable receipt 留在请求私有 closure 中，供 preset / Guardrail 和 v400 内部 auth port 使用。后续实际 v360 capability / quote 仍检查禁用 Key、身份和 epochs，不能凭旧 receipt 绕过 freshness。

[v401 preparation](../../../../packages/proxy/src/services/credential-free-chat-preparation-v401.ts) 有界复制原始 bytes / headers，执行实际 preset、request Guardrail、模型解析与 snapshot。默认平台平坦文本支持 JSON / SSE；最多 8 个模型、1024 条 messages、1 MiB 正文。metadata、provider controls、tools、BYOK / 多模态及未知字段早拒绝；preset / Guardrail 后再检查最终 profile，非空 output filters 在 quote / admission 前返回 403。

执行链为实际 `395 auth → preset / request Guardrail → snapshot → 360 quote → 396 projection → 398 preparation → 验证并构造 363 六字段 envelope → 361 admission → 私有 holder`。新分支的成功、拒绝、取消和回执丢失均不进入旧 auth/reset、凭据 plan、预算 owner、fallback、permit 或 usage writer。v400 与历史 SQL 保持冻结。

## 连接与响应生命周期

准备期使用既有 deadline 和 owned mutation drain。私有请求在等待响应头时接收准备超时及原始客户端取消；收到头后由独立 stream owner 持有，准备 timer dispose 不再终止交付，客户端取消继续有效。只有 EOF 或已确认的 cancel / LOGIN cleanup 才释放容量；无法确认时继续持有 numeric reservation。

继承的 sticky resolver 会把实际读取错误转换为 `storage_error`。v401 在调用实际 v398 preparer 时包装其 quote-bound sticky get，先保存原始错误，读取结束后重新抛出；未知 COMMIT / close 不得被当作普通 miss 后继续 admission / handoff。没有原始异常但返回 `storage_error` 也拒绝。此修复仅在 v401 composition，未改写冻结 v398 / v400。

## 验证

[联合单元机器报告](C04-exclusive-credential-free-chat-ingress-v401-unit-report.json) 为 **102/102 PASS**：实际 Hono 47、准备模块 12、冻结 v400 11、旧入口 32，39 文件 pins、core 327 / proxy 454 corpus 均稳定。入口 sticky 四例使用实际 v398 客户端与 preparer，包括 miss / hit、COMMIT 丢失与 close 未确认；SQL factories 是受控替身，该报告单独不证明 PostgreSQL 权限或生产服务绑定。

[本机 PG18.6 原生报告](C04-postgres-exclusive-credential-free-chat-ingress-v401-report.json) 为 **143/143 PASS、cleanup PASS**。完整保留 v400 的 137 个阶段和 14 项实际安装负例，新增 6 阶段：实际 Hono canonical JSON / api alias SSE 各一次 loopback POST；真实 preset / input redaction、原始与最终 body hash、六字段 handoff、普通与三份 Guardrail holds、一个 grant / start / usage fact / durable observation；metadata 两种 header 早拒绝、实际 output policy 拒绝，以及 due period 因已发送未结算义务保持 pending。拒绝场景的财务 / quote / admission / grant / start / observation snapshots 未变，旧 repository traps 为零。

独立核对 **146 来源摘要（145 文件 pin 条目、142 不同文件加 PG73）**、core327 与 unit39 pins / proxy454 corpus。最终 installed / end catalog 完全相同，也与冻结 v400 相同：**142 functions / 93 relations / 135 triggers**，角色与默认 ACL 不变。既有 13 次 POST 加新 2 次，共 15 次。报告 SHA256 `7c9b1cc21ac686ac2c971c11cd43603bb941cb62f5fc2d7f1213c9d55c8fec47`；catalog SHA256 `4647045c0e80b382594cb2b051de4e4dbf03b0ba25a8f146c5cd623be3148554`。

原生 [helper](../../../../scripts/db/cutover/exercise-credential-free-chat-ingress-v401.ts)、[fixture](../../../../scripts/db/cutover/postgres-exclusive-credential-free-chat-ingress-v401.native.test.mjs) 和 [tsconfig](../../../../scripts/db/cutover/postgres-exclusive-credential-free-chat-ingress-v401.tsconfig.json) 使用实际 storage / repositories / role clients / v394 holder，仅 trusted projector decorator 发布实际路由 attestation 后调用 actual projector。公开请求是 Hono in-process `Request/Response`，Provider 一侧是 owned loopback HTTP；没有部署或 Cloudflare service binding。新增 Hono 正例不进入 sticky get，实际 sticky SQL 属于继承阶段；v401 ACK loss latch 的传播由上述 actual-client unit doubles 证明。

Proxy 类型检查、入口测试 scoped TypeScript 0 diagnostics，以及现有 Node esbuild 配置验证通过（3,584,898 bytes、零 workspace externals）。[CI](../../../../.github/workflows/proxy-dispatch-safety.yml) 已登记单元和原生入口，修复 staging 与 52 个精确机器报告文件的测试写权限；源码目录权限未扩大。YAML / shell 语法、106 fixture 与 4 tsconfig 路径核对通过，Linux CI 尚未运行。

[首轮原生失败记录](C04-postgres-exclusive-credential-free-chat-ingress-v401-failed-first-run-report.json) 保留 57 个已通过阶段和 cleanup PASS；继承 sticky helper 的投影剩余时间上限断言失败，新 v401 Hono helper 尚未执行。失败记录没有该瞬间的客户端 / 数据库时钟对照，原因不能据此确定；一次重跑使用相同冻结源码，断言未放宽，完整通过。这不能证明计时场景永远稳定。

## 仍开放

自动响应后 sticky bind / touch、完整 provider controls / fallback、output Guardrail owner、跨周期续租 / 结算、Cloudflare / Hyperdrive 和正式部署接线均未完成。完整响应与 sent observation 留下 unknown grant 和 dispatched holds；它们不证明 Provider 免费、下游完整收到或财务终态，sent / unknown billing 与事件交付仍需独立证据。

C04.1–8 / G 保持未勾选。正式 PG73 / D1 68 / MySQL64 和首轮 staging US$2 上限不变；仅本地测试，没有远端 SQL、部署或付费 Provider 调用。历史范围参见 [v401 实施前审查](C04-exclusive-credential-free-ingress-scope-v401.md)，完整前置栈参见 [v400 共装](C04-complete-text-auth-routing-recovery-coinstall-v400.md)。
