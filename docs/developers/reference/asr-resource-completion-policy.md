# ASR 响应与下载资源完成合同

本合同覆盖 OpenAI 转录、DashScope Qwen3 / Qwen-Audio / Fun 同步转录、DashScope 异步文件转录和原生多模态透传的已登记响应资源。补充 [TTS 资源合同](./tts-resource-completion-policy.md)，不代表全部音频上传或 Workers 容量已经验收。

## 登记与确认

公开转录入口（`/v1/audio/transcriptions`、`/api/v1/audio/transcriptions`）与原生 DashScope 多模态入口，在 dispatch 前通过现有资源调度器登记任务。每个 buffered ASR 尝试汇总 HTTP 等待、迟到响应、成功／错误正文和结果下载清理；不把 `usagePromise` 当成资源释放证明。

- 读取正常完成后可确认其登记的正文工作；正文超限、取消或读取失败会登记一次取消 ACK。
- ACK 未完成时仍持有资源任务；拒绝或同步异常产生 `unconfirmed`，不能用释放 reader lock 替代。
- 等待 HTTP 头时取消可及时返回 499／504，但迟到响应仍归原请求清理；迟到 transport 拒绝为未确认。
- 已登记资源全部确认才释放该资源 owner 的逻辑容量。失败保留数字预留，不用 TTL 强制放行，记账不等待清理。
- 已观察到非成功提交响应仍按既有已知失败规则处理；清理未确认本身不把账务改成未知扣费。异步提交已接受后的结果未知仍禁止再次提交。

## 异步结果下载

保留一次任务提交、有限轮询和安全 GET 重定向。每一跳继续验证 HTTPS、IP 字面量限制、相对 URL、重定向次数及跨域敏感头剥离；字面量校验不等于 DNS pinning。

结果下载不再通过单个外层 race 遗弃整段重定向执行。各次 fetch 已有取消所有权；重定向正文通过调用方提供的 `cancelResponseBody` 处置钩子登记 ACK，并用同一 deadline 等待。取消／deadline 可中止等待并终止后续跳转，原清理任务独立收尾。正常取消 ACK 拒绝保持历史“可继续安全跳转”的兼容行为，但资源汇总记为未确认。

缺失 Location、被禁止的目标和超出跳数，也必须保留已经启动的重定向正文清理。共享下载工具未传此钩子的其他调用方仍使用原有默认行为，不因这个可选接口自动获得同等生命周期保证。

## 验收边界

该实现遵循 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)的请求级生命周期登记；`ctx.waitUntil` 保留 receiver，平台终止时限仍适用。Node 合成 ExecutionContext、SQL sink 与数字容量测试，不证明真实资金事务或原生内存释放。

尚未完成：ASR multipart / Blob 与大 JSON 出站表示的完整上传所有权、调用方文件引用及全工作集管理、其他 JSON 消费者、入口准备／数据库自身时限、Node 自动停机及 Workers 原实例容量。上游异步服务中的已接受任务也不会因为本地 HTTP 清理而被证明取消；本轮没有新增远程撤销接口或自动重放。

Images 的 completed＋真实上游 `[DONE]` 不可逆成功结算点、金额算法与生产容量开关均不变。下一次云端验收须新冻结构建，不复用旧 bundle 证明当前代码。
