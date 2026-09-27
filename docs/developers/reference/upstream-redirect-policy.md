# 文本推理上游重定向策略

适用本地实现：OpenAI Chat / Responses、Anthropic Messages、Gemini generateContent / streamGenerateContent 的文本出站驱动。2026-09-09 的实现使用 `redirect: 'error'`；2026-09-27 的真实 Linux workerd 门禁发现该运行时在发送前拒绝此值，因此后继修复改为 `redirect: 'manual'`。本轮完整 Linux 验收与发布结果须单独确认。

上游地址应直接指向最终推理端点。301、302、303、307、308 均不自动跟随，包括同源地址；客户端参数、路由默认参数或 provider 配置不能覆盖这一限制。这样避免隐藏的额外 HTTP 请求、307/308 重发 POST 正文，以及凭据被转发到另一个目的地址。

`manual` 将 3xx 响应交还驱动，驱动不跟随 Location。初次 POST 已经发出，既有 `ambiguousDispatchedStatusMeta` 将这些响应标记为 `upstreamOutcomeUnknown` / `failoverForbidden`；fetch 异常也继续保留 unknown。两条路径均不退回已消费的 dispatch 许可，不自动换模型、凭据或供应商重放。该标记不自动授权扣款、退款或最终 unknown 收费；财务结论必须由既有持久化事实和对账规则决定。

明确的 429 响应仍遵循现有有界候选策略，单请求最多消费 3 个 dispatch 许可；上游提供更多候选不增加该上限。503 已由既有 unknown 规则阻止自动重放，单次发送后终结。这不证明所有 SDK、代理或供应商内部没有重试，也不是分布式 exactly-once 保证。

Cloudflare 文档说明新建 Request 默认自动跟随重定向，`manual` 不自动跟随，并警告跟随模式可能向不同域名转发敏感请求头。文档仍列出 `error`；本次兼容选择依据实际 workerd 错误，并非文档宣布该值不受支持。此处只接收原 3xx，不实现手工重定向或地址白名单例外。[Cloudflare Request](https://developers.cloudflare.com/workers/runtime-apis/request/)

本机真实 HTTP 的修复前后证据和未完成范围见 [C02 v1.132](../architecture/implementation-evidence/C02-text-redirect-v233.md)。
