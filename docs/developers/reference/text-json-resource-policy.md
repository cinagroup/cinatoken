# 文本 JSON／错误响应资源完成合同

适用于 OpenAI Chat、Responses、Anthropic Messages 与 Gemini generateContent 的非 SSE 响应；2026-09-16，C02 v246。本合同不改变 Images 的不可逆结算点。

## 生命周期

在收到上游响应头后，非 SSE 分支立即由 `ownUpstreamResponse` 接管正文。成功 JSON 的有界读取、格式拒绝、非 2xx 正文消费和取消后的迟到响应均带回 `resourceCompletion`。外层 dispatch 在真正发送前已登记原始尝试任务，因此等待响应头的阶段也有归属。

- 完整正文 EOF 或无正文响应：资源可确认完成，与业务成功／失败无关。
- 格式错误、大小拒绝、客户端停止：及时完成原有 HTTP／usage 路径；资源任务独立等待真实上游 `cancel()` ACK。
- ACK 拒绝或读取错误导致清理无法确认：返回 `unconfirmed`。启用逻辑容量时保留数字预留，不靠超时自动释放。
- Reader 解锁、最后一个数据块或客户端已收到错误均不是清理成功证据。
- 新增 owner 按需读取，不预取、不 tee、不额外复制整个正文；既有跨模型错误审计中的 clone 不在本次变更内。原 8 MiB JSON 上限、错误正文限制和协议校验继续生效；这些限制不证明整个 isolate 工作集有界。

公开普通／全局路由沿用 `scheduleResourceCompletion` 的 Workers 生命周期登记；Node 后备路径使用已有独立资源任务集合。资源完成通道不得阻塞 usage／财务事实完成。`confirmed` 只说明已登记工作结束，不代表物理内存已经回收。

## 兼容性边界

四个 SSE 分支保留原来的 pump、reader 及取消时序，不再套一层响应 owner。Gemini 保留原来的 MIME／action 分支规则，本次没有额外放宽或收紧其协议校验。

上游状态归一化、用量提取、公开模型名、费用算法、候选路由与重定向策略不变。已知拒绝仍遵循原有模型 fallback 预算；本次不增加重试。未知结局、取消和截止后的请求不自动重新发送。

## 尚未验收

四个文本请求上传仍使用完整 `JSON.stringify`，下一步接入独立上传 owner／分页编码。数据库自身时限、初始化路径、Workers 原生传输与原实例容量、全工作集仍须单独验收。Node 合成上游及 SQL sink 测试不是 Workers 或真实 D1 财务验收；生产容量未开启。
