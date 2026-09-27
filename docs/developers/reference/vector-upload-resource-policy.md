# Embeddings / rerank JSON 上传资源合同

2026-09-10，v245；本地实现，未部署。接续 [v244 响应合同](./vector-response-resource-policy.md)，替代其中“向量上传仍完整 JSON.stringify”的历史状态。

## 实现

两个驱动在确定路由请求字段后调用 `withOwnedJsonUpload`：先完成 JSON 值投影快照及 UTF-8 字节计数，再解析上游凭据和执行派发准入，最后将分页 `ReadableStream` 交给 fetch。已有 JSON 投影器兼容可选字段、非有限数字、typed array、toJSON 等内部值；public JSON 和 route defaults 不新增限制。循环引用／bigint／getter 异常在回调开始前失败，不启动本次认证或推理。

容器快照仍是全量的，字符串不可变引用共享；不是完整工作集有界的声明。生成的字节页至多 64 KiB，不再创建整份出站 JSON 字符串。rerank 仍只转发经过既有校验和筛选的字段；模型、默认参数和覆盖规则不变。

上传和响应分别登记资源任务，汇总后交给上一轮接入的公开路由资源调度器。取消 ACK、上传完成状态不参与金额或结果分类：

| 上传状态 | 资源结果 |
| --- | --- |
| 传输消费者读到 EOF | confirmed |
| 消费者显式取消，内部编码源清理成功 | confirmed（不是远端接收确认） |
| 回调结束前未被锁定、从未读取的源 | 停止本地编码后 confirmed |
| 已锁定、部分读取、读完末页但没有 EOF 的源被迫停止 | unconfirmed |

`finally` 停止上传编码；响应方向的 EOF／ACK 不覆盖上传 unconfirmed。任何一个资源任务未确认，逻辑容量不会提前释放。fetch 尚未返回、或已派发后抛错的原始 attempt 仍沿用 failover 既有所有权和结果不明规则；不重新提交推理。

## 运行时和验收边界

沿用已有上传 owner 的 workerd 源级 `expectedLength`；Node 后备使用 `Content-Length` 和 `duplex: 'half'`。本轮本机 HTTP 验证字节与长度，不声称手工 Content-Length 能强制 Workers 定长行为。Workers 原生传输、上游提前返回、客户端取消和整实例容量还需新冻结 staging 候选验收。

本地公开路由的 1,024 字节预留是数值测试夹具，不能作为生产容量参数。新快照、输入对象、定价／审计和响应重建仍占用内存；其他 JSON/error 消费者和数据库自身时限未全部处理。未启用生产容量、未更改 Images completed + 上游 `[DONE]` 成功点，首轮累计 US$2 授权不重置。

按 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)采用流式正文和明确异步所有权；本合同的 confirmed 不是 Cloudflare 物理堆回收保证。
