# C02 v370：Playground Realtime 重定向重放门禁

2026-09-25；本地确定性回归通过。C02.5／C02.6／C02.G 仍开放。没有远端 Provider 请求、SQL 或部署。

## 发现

[`dispatchPlaygroundDashScopeRealtime()`](../../../../packages/admin/lib/services/admin/playground-realtime-service.ts) 通过 Worker `fetch` 直接建立 DashScope WebSocket Upgrade，原调用没有设置 `redirect`。Provider 若返回 307／308，默认跟随策略可能再发一次携带相同 Bearer 的 Upgrade；这个 Admin 调试台路径不经过 Proxy 的请求级 dispatch 预算。Proxy 的 DashScope Realtime 驱动已经显式设置 `redirect: 'manual'`，Admin 的普通文本／音频／图片 POST 也已设置该选项，但此 Upgrade 是漏项。

新增 [dispatch 级回归](../../../../packages/admin/lib/services/admin/playground-realtime-redirect.test.ts) 用本地替身实现默认 307／308 跟随行为，保留同源 Bearer 和请求次数。修复前首个 307 对照返回第二跳的 HTTP 400，测试失败（预期首跳状态 307）；这说明替身实际进入了第二跳。修复后发送侧固定 `redirect: 'manual'`，并把上游 3xx 变成不含 `Location` 的 502，避免把重定向交给浏览器继续处理。307／308 两例均只调用一次带 Bearer 的 `fetch`。

## 复核范围

本轮核对了 Proxy 的四类文本驱动、Images generations／edits、OpenAI／DashScope 音频、向量与 Rerank、DashScope Realtime，Tool Engines 的十个 POST 与共享下载器，以及 Admin Playground 的直接 Provider POST 和 Realtime Upgrade。Proxy／Tool Engines 的这些生产出站调用使用原生 `fetch` 或 Node `ws`，代码未实例化供应商 SDK；既有 v333–v367 本地证据覆盖了主要 POST 的状态分类及重定向，不能推断网络栈、Cloudflare 或 Provider 内部绝不重试。Admin 直接 POST 已有 `redirect: 'manual'`；本轮只修复 Admin Realtime Upgrade。

## 验证与限制

- 修复后 Admin Playground 套件 **49/49 PASS**（新增 2 例）；Admin `typecheck` PASS；定点 `git diff --check` PASS。
- 测试用确定性 `fetch` 替身执行真实 Admin dispatch 代码，未建立真实 Worker WebSocket，也未证明 Cloudflare 或中间代理的物理 Upgrade 次数。
- Admin Playground 不写 Gateway 用量日志，真实 Provider 会话仍可产生费用。此修复只关闭该侧路径的显式浏览器／`fetch` 重定向；成功或 unknown 后的全协议重放、底层 HTTP／SDK／代理发送次数和持久结算仍需验收，所以 C02.5／C02.6／C02.G 不勾选。
