# Chat / Responses / Anthropic SSE 取消规则

2026-09-09 本地实现更新，尚未部署或完成 Workers 原生验收。

- 客户端取消或请求 deadline 会停止上游读取，并让等待下游读取的写入退出；仅取消响应读体、没有请求 signal 时，也通过 writer.closed 发现取消，不依赖下一条上游事件。
- 已开始的 reader.cancel 只执行一次；usage／取消事实及时完成，不依赖上游的清理 ACK。客户端放弃交付时，pump 单独等待清理 Promise，期间保持 reader 锁，终结后才释放。该本地 Promise 尚未作为独立容量持有者接入 Workers waitUntil，不能据此宣告平台容量安全。
- 取消不是正常 EOF。取消之后不再解析 framer 中尚未收完整的事件，保留此前已解析的 usage；deadline 与客户端取消使用不同分类。
- Chat `[DONE]`、Anthropic `message_stop`、Responses typed terminal / `[DONE]` 的既有协议规则不变。正常终态不能因为上游迟迟不确认 cancel 而拖住成功响应或权威 usage；该清理 Promise 的拒绝仍被观察，但不作为物理容量释放证据，不重发推理。

本次不修改财务算法，不把缺失 usage 当成零成本，不把上游接受情况未知当成可退款或可重放。清理成功或拒绝均不自动证明供应商停止生成或物理资源已释放。Images 已确认的“有效 completed 图片 + 真实上游 DONE，先持久化事实再交付成功 DONE”的规则独立保持。

[39 项专项证据与完整回归](../architecture/implementation-evidence/C02-text-sse-cancellation-v235.md)。Gemini 见其独立的 [取消规则](./gemini-cancellation-policy.md)。
