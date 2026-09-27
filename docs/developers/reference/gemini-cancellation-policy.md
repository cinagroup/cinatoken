# Gemini 请求取消规则

适用 `generateContent` 与 `streamGenerateContent`；本地实现更新于 2026-09-09，尚未部署或完成 Workers 验收。

- 请求取消信号传入真实上游 fetch 和普通 JSON 有界读取器。请求已发送后的取消不证明供应商未接受，不自动退还发送许可或切换候选重放。
- SSE 客户端取消、下游读体取消或 deadline 停止读取上游，不再额外 drain 25 秒。即使上游无数据、下游不读取，取消也应解除正在等待的读写。
- usage 只保留取消前已经解析的数据。客户端取消标记与 deadline 错误分开；缺失最终 usage 不代表零成本，也不保证供应商停止计费。
- usage／取消事实不等待不可信的上游取消 ACK；公开路由可及时记录取消和 unknown 成本，不把缺失 usage 当作零成本。pump 独立持有已放弃的 reader，直到取消清理 Promise 终结再释放 reader 锁。清理拒绝被观察，但这不证明远端资源或 Workers 原实例容量已释放。
- 中止下游使用标准 TransformStream 的 `terminate()`：关闭 readable 并解除阻塞 write，不向下游或关闭诊断透传私有取消原因。正常 EOF 后的 usage 不因迟到的客户端取消而变更。

上面的事实／清理分离规则取代 v234 的“usage 等待清理”表述；旧源码、测试和证据保留。当前清理 Promise 尚未作为独立资源完成任务接入全部容量控制与 Workers `waitUntil`。

## 入口 deadline 与错误状态（v237）

- Gemini 公开单段 POST `/v1beta/models/:modelAction` 从进入统一中间件时起算 300,000 ms 的绝对执行时限；上传、准备阶段与出站共享原始时间和发送预算，选路或重试不能重新起算。无效／编码后的 action 参数也先受相同入口约束，再由路由校验。GET、catalog、其他前缀或额外子路径不被这个新增匹配器覆盖。
- 取消／超时停止有界上传与可取消的准备读取；已开始的存储初始化、旧密钥查询潜在迁移、审计和预算写入继续由原请求等待收尾，之后不得继续推理。这不是对 SQL／初始化强制中断的保证；此类收尾可能超出 300 秒，需要数据库自身时限和资源完成合同补足。
- 上游已发送但结果未知时禁止自动重放；deadline 错误保留 `gateway.request_deadline_exceeded`，不能再被当作普通上游 5xx。只有可信内部 dispatch metadata 能保留网关错误，不能信任上游伪造的头部。
- 已有部分 usage 后发生流错误，也记为 error 而非 success；deadline 与客户端取消分开。错误日志只用固定流错误摘要／deadline 摘要，不透传任意上游异常内容。unknown 成本继续使用现有预算上限保留规则，不因为超时或缺失 usage 推定免费。

`GEMINI_POST_DISCONNECT_DRAIN_MS` 仅为兼容旧导出保留并标记 deprecated，不再控制运行时 drain。旧测试对这个常量的范围断言不能代替取消行为验证。

本规则不改变 Images 的成功结算点：网关已验证有效 completed 图片及真实上游 `[DONE]` 后，先持久化结算事实，再交付成功 DONE；其后客户端取消不撤销费用。Gemini 文本 usage 不借用该图片专属条件。

最新验证见 [C02 Gemini 入口与错误状态](../architecture/implementation-evidence/C02-gemini-ingress-v237.md)；[v236 结算与清理分离](../architecture/implementation-evidence/C02-gemini-settlement-v236.md)和 [v234 历史取消证据](../architecture/implementation-evidence/C02-gemini-cancellation-v234.md)不被重写。
