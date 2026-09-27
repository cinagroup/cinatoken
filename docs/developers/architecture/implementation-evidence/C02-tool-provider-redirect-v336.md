# C02 v336：十个工具供应商 POST 的内层重定向

2026-09-24；**本地 Tool Engines 子集通过，C02.5／C02.6／C02.G 继续开放**。[机器摘要](./C02-tool-provider-redirect-v336-results.json)固定十个 driver、真实回环和源码 SHA。

Proxy 的四条工具路由分别调用 `searchWebByProvider()`、`fetchUrlByProvider()`、`deepSearchByProvider()` 或 AI Detection driver；各分发器选择一个配置的供应商，不在内部换候选。实际供应商出口为十个 POST：Web Search 的 Bocha／CleverSee／Tavily／Tencent WSA，Web Fetch 的 Firecrawl／Tavily／Jina，Web Deep Search 的 Firecrawl／Jina，以及 Tencent TMS 检测。它们均允许注入 `fetchImpl`，默认使用原生 `fetch`；原先没有指定重定向模式。

新增真实 Node HTTP 回环使用 `fetchImpl` 仅将固定的 `https:` 供应商 URL 映射到本地原地址，底层仍调用原生 `fetch`。原地址完整接收 POST 后返回 307／308，`Location` 指向另一 loopback origin。十个 driver × 两个状态共 **20 个场景**，修复前每个均观察到原地址和跨 host 目标**各一次同长度 POST**，虽然注入的 `fetchImpl` 只被调用一次；新回归 **0/20**。这证实发送放大来自 HTTP 客户端的自动跳转，而不是分发器显式循环。

十个 driver 现均指定 `redirect: 'manual'`。相同回环修复后每个只有原地址 **1 次 POST**、目标 **0 次**，原有供应商错误类型将 307／308 保留为 `upstreamOutcome='unknown'`；**20/20 PASS**。Tool Engines `test:unit`（含现有 bounded response）**34/34 PASS**，Tool Engines 与 Proxy TypeScript 检查、定点 diff 检查通过。新测试已登记 Tool Engines `test:unit`；`proxy-dispatch-safety.yml` 增加 Tool Engines 类型检查和单测步骤，本地 YAML 解析通过，Linux CI 尚未运行。

这里没有活动的纯 GET 工具供应商出口：`web-fetch/safe-redirect-fetch.ts` 虽提供手动重定向函数，但当前十个生产驱动都不调用它。Core 的 GCP token exchange 是 POST，已显式 `redirect: 'manual'`；DashScope 异步音频结果查询是另一条 GET 路径。手动重定向只关闭可见的浏览器/HTTP 客户端跳转，不能证明真实 Workers／Cloudflare、中间代理或供应商内部不会重试，也不证明供应商已接收、计费或退款结果。工具预算／账务全链、所有失败／断流和 C02.G 仍未验收。本轮无远端供应商调用、云资源写入或部署。
