# C02 v336：告警 Webhook 的内层重定向重发

2026-09-24；**本地 Webhook 子集通过，C02.5／C02.6／C02.G 继续开放**。[机器摘要](./C02-webhook-redirect-v336-results.json)记录负对照、源码 SHA 与剩余出口。

`fireGatewayErrorWebhooks()` 从 `system_config` 读取企业微信／飞书地址，分别调用同一个 `postJsonWithTimeout()`。该函数用原生 `fetch` 发 POST，却没有设置重定向模式；外层没有候选循环。真实 Node 回环负对照让原地址在**完整收取请求正文之后**返回 307／308、指向另一回环服务。四个场景（两种 Webhook × 两种状态）均观察到原地址和 `Location` **各收到一次相同长度的 POST**，共两次有副作用发送；目标返回模拟成功后，原调用还错误地完成成功。新增断言修复前 **0/4**；回环只使用合成告警和本机端口。

`postJsonWithTimeout()` 现显式设置 `redirect: 'manual'`。相同四个场景修复后只有原地址 **1 次 POST**，目标 **0 次**，调用以 HTTP 307／308 失败返回。原有调用方只捕获并记录 Webhook 错误，不对该次结果不明的发送换地址或自动重试。新回环 **4/4 PASS**，Proxy TypeScript 检查、定点 diff 检查及测试脚本登记检查通过；测试已加入 `test:dispatch-safety` 与 `test:unit`。没有 Linux CI 运行结果，既有 Vitest 告警格式测试本轮未计入通过数。

盘点 Core 源码时，GCP service-account token exchange POST 已设置 `redirect: 'manual'`。工具引擎还发现 **10 个**供应商 POST 使用默认重定向；其分发器选择单一供应商，没有内部换候选循环。同轮[工具出口独立证据](./C02-tool-provider-redirect-v336.md)已逐驱动复现 307／308 跨 host 再发送并修复。`web-fetch/safe-redirect-fetch.ts` 显式手动处理重定向，但当前生产驱动未调用它。Core／工具引擎的真实 Workers／Cloudflare、中间代理及供应商内部重试尚未全层验收。

Webhook 告警本身没有持久幂等键或到达确认；本地不重发不证明接收方只处理一次。C02.5／C02.6／C02.G 与生产放行继续开放。本轮无远端供应商调用、云资源写入或部署。
