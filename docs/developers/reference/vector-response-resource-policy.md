# Embeddings / rerank 响应资源完成合同

2026-09-10，v244；本地源码，不是线上发布声明。

## 所有权与结算

两个 OpenAI 兼容向量驱动在收到上游响应后，用 `ownUpstreamResponse` 接管正文。它不预读、不拼接完整正文，也不更改 HTTP 状态及响应头；成功 JSON 仍沿用既有有界读取和 schema 校验。非 2xx 正文也经过该 owner，因此后续 failover／日志读取者触发的取消不会丢失底层确认。

- 实际读到源 EOF（或没有正文）确认资源完成；读到最后一段字节不等于 EOF。
- 取消、超限、错误 Content-Type、读取失败会立即停止交付。底层 `reader.cancel()` Promise 独立观察；释放 reader 锁不是取消成功的证明。
- 取消确认成功才返回 `confirmed`；拒绝返回 `unconfirmed`；一直挂起则一直等待，不用 TTL 推断释放。
- 收到响应头之前的原始 fetch Promise 由现有 failover attempt 持有；迟到响应仍绑定原取消信号并清理正文。没有增加第二次推理或重试。
- `/v1/embeddings`、`/api/v1/embeddings`、`/v1/rerank`、`/api/v1/rerank` 在派发前登记资源完成任务，复用 `scheduleResourceCompletion`。显式注入容量策略时，响应结束与记账完成不会提前释放挂起的资源。
- 资源通道不参与成功判定或费用计算。取消 ACK 的拒绝不撤销已确认成功，也不授权重发推理；未确认时保留逻辑容量预留。

## 范围与未完成项

这是响应源的生命周期合同，不是整个请求内存上界。Embeddings 32 MiB、rerank 16 MiB 的既有响应字节上限未改，解析对象、重建 JSON、借用的传输 chunk 与上传序列化的工作集仍须另行计算。两个驱动目前仍对上传执行完整 `JSON.stringify`，尚未接入分页上传 owner；其他 JSON 消费者不因本次修改自动获得覆盖。

本地测试中的 1,024 字节只是数值池夹具，不是生产容量建议。Workers 原生取消确认、宿主终止、同实例容量及物理工作集未由这些 Node 测试证明；生产容量默认关闭，数据库自身时限、其他消费者和 C02.G 仍待完成。Images 的 completed + 上游 `[DONE]` 不可逆成功点不变。

设计遵循 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)的流式处理与明确异步工作所有权原则；取消 ACK 的独立资源语义是本项目合同，不是 Cloudflare 物理回收保证。
