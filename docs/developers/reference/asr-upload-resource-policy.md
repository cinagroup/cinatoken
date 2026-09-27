# OpenAI 兼容 ASR multipart 上传资源合同

本合同补充 [ASR 响应与下载资源完成合同](./asr-resource-completion-policy.md)，仅覆盖 OpenAI 兼容 `/audio/transcriptions` 的出站上传。DashScope 大 JSON 上传、入口解析和调用方文件引用仍是独立待办。

## 上传表示与生命周期

驱动用请求局部、按需读取的 multipart 生产者替代完整音频 Blob。保留字段顺序、重复字段、CRLF 规范化、文件名转义、MIME 规范化和上游 response_format 选择；原生 FormData 只保留标量字段，不承载音频 Blob。

二进制每页至多 64 KiB；文本按至多 8 Ki UTF-16 单元编码，不拆分有效代理对。`highWaterMark: 0` 不主动预读。精确长度计算也分块编码文本；但字段 CRLF 规范化仍可能创建大字符串，不能据此声称整个请求工作集已有硬上限。

生产者借用当前请求的音频字节，交付时复制独立页面；调用方在尝试完成前不得修改音频字节。终结时清空生产者持有的 parts 和游标，移除 abort 监听；不清空或修改调用方文件。入口已经缓存的音频、计费时长解析和其余调用链引用不会因此自动释放。

上传资源任务在认证／准入前纳入尝试汇总，所有返回／抛错路径执行幂等停止。持久化准入仍等待其自身完成，不通过取消 race 遗弃数据库写入。

## 什么可以确认

- 消费者读取到生产者 EOF，或调用消费者 cancel 并完成同步源清理：该上传源可确认。
- 从未 pull 且当前未锁定的源被停止：没有已交付页面，可确认该源。
- reader 仍锁定、部分内容已经交付，或只交付了结束边界但未到 EOF：被迫停止后为 `unconfirmed`。
- 已部分读取后释放 lock、响应正文取消 ACK 成功、稍后才解锁，都不能将 `unconfirmed` 改成已确认。
- 编码失败使用固定安全错误，并记为未确认；不透出 abort 原因或编码器原始异常。

资源结果与推理结果／账务独立。明确成功转录和明确非成功响应保持既有分类；后续资源失败不修改已确认金额，也不授权重放。Images completed 加真实上游 `[DONE]` 的不可逆成功结算点完全不变。

## Workers 验收边界

该实现依据 [Workers 流式处理最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)减少上传表示的额外整文件复制；本轮证据是 Node 合成消费者和一次本机 HTTP 请求，不是原生 Workers 验收。

特别注意：本机 Node HTTP 已验证计算长度与 Content-Length 一致；[Workers Request 文档](https://developers.cloudflare.com/workers/runtime-apis/request/)说明，普通 ReadableStream 的手工 Content-Length 不决定原生 wire 长度，通常使用分块传输。**不能把本机长度断言当作 Workers 的定长上传证明。** 下一次冻结构建前，应确认上游分块兼容性，或为需要定长的路径完成原生定长流及其独立取消／完成所有权设计；禁止因 411 或不确定传输自动重放推理。

`confirmed` 不证明网络对端已接收全部字节、不证明上游任务已取消、不测量 GC 或物理内存。实际 Workers 的 abort、流传输、主机期限与原实例容量必须另验；生产容量开关不因此开启。

后续顺序：其余 ASR JSON 上传及定长传输兼容性 → 剩余 JSON 消费者 → 入口准备与数据库自身时限 → 新冻结候选的原生 Workers 验收。C02.G、C01 及其下游依赖保持未通过。
