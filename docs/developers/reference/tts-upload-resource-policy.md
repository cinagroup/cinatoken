# 语音克隆上传资源合同

此合同补充 [TTS 响应资源合同](./tts-resource-completion-policy.md) 中尚未接入的 OpenAI-compatible stateless voice cloning 上传。仅覆盖此上传生产者及其资源完成登记，不代表 ASR、所有 JSON 请求或原生 Workers 的物理容量已经验收。

## 何时可确认清理

上传流在认证、准入与 fetch 之前登记到当前 TTS 尝试的资源汇总。成功用量／记账仍与资源清理独立，不等待清理确认。

| 观察到的事件 | 资源结果 |
| --- | --- |
| 消费者读取完整 JSON 并触发源 EOF | `confirmed` |
| 消费者主动 cancel，执行同步生产者清理 | `confirmed` |
| 从未读取、未被锁定的源在收尾时停止 | `confirmed` |
| 上传已开始、未到 EOF，被网关强制停止 | `unconfirmed` |
| 未读取但 fetch 仍锁定源，被网关强制停止 | `unconfirmed` |
| Base64 编码或生产者操作失败 | `unconfirmed` |

网关调用 `controller.error()` 只证明停止了自己的源，不能证明 fetch 已处理上传取消。部分上传即使 reader 已释放 lock，也不能因此确认清理。`unconfirmed` 不靠 TTL、晚到解锁或响应清理成功改成 `confirmed`；可选逻辑容量保持数字预留，生产容量开关仍关闭。

## 数据与生命周期

- `highWaterMark: 0`：消费者请求读取才编码，不在认证／准入等待时预取。
- 音频按 24 KiB 输入分块编码，每个完整 Base64 音频块为 32 KiB；这不是整个 JSON prefix／suffix 的统一上限。
- 完成、取消、强制停止或编码失败后，编码器清空自己持有的音频字节引用、prefix、suffix 和游标；不修改调用方的音频内容或请求对象。
- 错误使用固定的安全消息，不记录参考音频、转录文本、凭据或原始编码异常。
- 不新增请求重放、金融结算规则、格式支持或云资源。Images 的 completed＋上游 `[DONE]` 成功结算点不变。

登记沿用公开 Speech → failover → TTS 请求级资源链，遵循 [Workers 生命周期最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)；`waitUntil` 的平台期限仍适用。确认仅代表已登记生产者的终结，不等同于 socket 发送 ACK、底层所有缓冲区释放、调用方引用清空或 GC 完成。

后续仍须完成其余上传／JSON／ASR 消费者、数据库自身时限以及新冻结候选的原生 Workers 验收。不能用 Node 回环上传通过替代 Workers 原实例容量证明。
