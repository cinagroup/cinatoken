# C02 v367：共享下载重定向器的方法门禁与出口复核

2026-09-25；**本机 Node 回环通过，C02.5／C02.6／C02.G 仍开放**。[机器摘要](./C02-safe-redirect-method-fence-v367-results.json)记录源码 SHA 与测试命令。无供应商请求、远端 SQL 或部署。

## 发现与修复

[`fetchWithSafeRedirects()`](../../../../packages/tool-engines/src/web-fetch/safe-redirect-fetch.ts) 是导出的通用 helper。它使用 `redirect: 'manual'` 并逐跳检查目的地，却把调用者的整个 `RequestInit` 带到下一跳。若调用者传入 POST 和正文，307／308 会在第一次发送可能已被接收后，再由 helper 自身把相同 POST 发往 `Location`。这条显式内层重发未包含在 v336 十个供应商 POST 的覆盖范围；当前生产调用者 [DashScope 异步 ASR](../../../../packages/proxy/src/services/egress/dashscope-audio-driver.ts) 只把它用于下载结果文档，默认 GET。

新增 [真实本机 socket 回环](../../../../packages/tool-engines/src/web-fetch/safe-redirect-post-wire.test.mjs)：以两个本机 HTTP 服务模拟原站和跨域目标，同时把 helper 看到的固定公网测试域名映射到回环端口。修复前，HTTP 307、308 两个负对照各让原站完整接收一次 `paid-request` POST，跳转目标又完整接收相同 POST；目标断言 **2/4 失败**，GET 下载的两个对照通过。负对照输出未另存原始日志。

helper 现在在任何网络调用前只接受**无正文 GET／HEAD**，拒绝 POST 等可产生副作用的方法及 GET／HEAD 携带正文；对 `maxRedirects` 的 NaN、无穷、负数和非整数同样提前拒绝，避免无效上限使重定向次数不受约束。合法 GET 仍逐跳检查目标并可下载跳转结果。DashScope 的异步 ASR 夹具改为提交 POST、轮询 GET、结果 GET 收到 302、再向另一个公网测试域名 GET 下载，确认真实调用链保持可用。

## 当前出口盘点

| 出口 | 当前显式重定向控制 | 既有证据／本轮范围 |
| --- | --- | --- |
| 四个文本协议；默认未接线的私有 holder | 原生 `fetch` 的 `redirect: 'error'` | [v336 文本](./C02-text-realtime-hidden-retry-v336.md)；holder [源码](../../../../packages/proxy/src/services/private-complete-text-holder-v365.ts) |
| Images generations／edits、OpenAI／DashScope 音频、Embeddings／Rerank | `redirect: 'manual'` | [v333 Images](./C02-images-hidden-retry-v333.md)、[v334 音频／向量](./C02-audio-vector-hidden-retry-v334.md)、[v335 TTS](./C02-speech-hidden-retry-v335.md) |
| DashScope Realtime Upgrade | Node `ws` 设 `followRedirects: false`；Worker `fetch` 设 `redirect: 'manual'` | [v336 Realtime](./C02-text-realtime-hidden-retry-v336.md) |
| 企业微信／飞书 Webhook；十个工具供应商 POST | 原生 `fetch` 的 `redirect: 'manual'` | [v336 Webhook](./C02-webhook-redirect-v336.md)、[v336 工具](./C02-tool-provider-redirect-v336.md) |
| DashScope 异步 ASR 结果文档 | `fetchWithSafeRedirects()` 显式有限跳转，现仅无正文 GET／HEAD | 本轮方法门禁与 GET 回环；[真实调用处](../../../../packages/proxy/src/services/egress/dashscope-audio-driver.ts) |

此盘点核对了 `packages/proxy/src/services/egress`、Webhook、私有 holder 与 `packages/tool-engines/src` 的物理出口源码；它不是网络栈或供应商的端到端发送审计。ASR 轮询 GET 与结果下载 GET 是已接受作业后的读取，不会再次提交付费任务，但仍各是实际 HTTP 请求。

## 验证与剩余门禁

- Tool Engines `test:unit` 已登记新回环和原有 URL guard，**44/44 PASS**；单独两文件 **10/10 PASS**。
- DashScope ASR 驱动测试 **33/33 PASS**，其中提交／轮询／302 下载的调用链通过。
- Tool Engines 与 Proxy `typecheck`、定点 `git diff --check` 均通过。Linux CI 未运行。

这些证据只证明本机 Node 的 helper 与当前调用链。真实 Workers／Cloudflare 传输、中间代理和供应商自身是否重试，无法由这里的单次 `fetch` 或 socket 计数推出；完整的成功／unknown 后禁止重放、全部协议的持久预算与财务结算也未验收。因此 **C02.5／C02.6／C02.G 不勾选**。
