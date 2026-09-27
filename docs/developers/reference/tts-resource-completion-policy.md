# TTS 响应清理、记账与容量

此合同扩展[文本资源完成策略](./text-resource-completion-policy.md)，适用于 OpenAI Speech（二进制及 SSE）和 DashScope SpeechSynthesizer、Qwen、MiniMax 的响应处理。实现为本地验证状态，不是生产容量或原生 Workers 验收结论。

## 所有权链

公开 `/v1/audio/speech` 和 `/api/v1/audio/speech` 在 dispatch 前登记请求级 `resourceCompletion`，复用请求资源调度器。Failover 汇总每个尝试，TTS 尝试再汇总 HTTP 等待、响应清理和音频流清理。

- `usagePromise` 仍只代表可结算的用量／取消／错误事实；不等待取消 ACK。
- 音频流完成时，reader lock 可按原兼容行为释放，但 `resourceCompletion` 要等取消 ACK。拒绝或同步异常产生 `unconfirmed`，不能作为资源释放确认。
- OpenAI 二进制自然 EOF 不发起多余取消；正常 SSE／DashScope 协议终点可及时结束交付和产生用量，后台独立等待清理。
- 首帧解析失败、DashScope 应用错误、OpenAI 响应类型不符，以及非成功错误正文的超限／取消／读取失败都登记独立清理。
- HTTP 请求被取消或到达 deadline 后，调用方可先返回；已发出的 fetch 等待继续被持有。迟到响应的取消 ACK 也属于同一资源任务。迟到 transport 拒绝报告 `unconfirmed`，不重放请求。
- 资源任务只在 `confirmed` 后释放自己的逻辑容量 owner。待确认或 `unconfirmed` 保留容量，不用 TTL 放行；记账任务保持独立。

## 兼容与限制

没有更改 TTS 定价算法、unknown 预算规则或 Images 不可逆成功点。Qwen 驱动可处理其 WAV 协议，但公开 API 仍只接受 MP3／PCM；不为测试绕过现有路由格式门禁。

共享音频生命周期和有界错误正文读取器新增可选资源登记接口；只有明确接入的调用链获得该保证。其他 ASR／JSON 消费者并未因此自动完成资源验收。

`confirmed` 只覆盖已经登记的响应资源。克隆音频上传源、fetch 对上传 reader 的持有、入口准备／数据库时限、所有其他消费者、Node 自动停机和 Workers 原实例容量仍需要独立实现或验证。不能用停止本地上传源、已释放 lock 或 Promise 归零证明全请求物理内存已释放。

按照 [Workers 官方最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)使用 `ctx.waitUntil`，保持 receiver，不建立跨请求的 Workers 清理注册表；平台生命周期上限仍适用。生产容量开关不启用，下一次云端验收须重新冻结构建，不使用旧 bundle 代表当前源码。
