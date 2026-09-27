# 文本 JSON 上传与资源完成合同

适用于 OpenAI Chat（含 legacy completions）、Responses、Anthropic Messages 与 Gemini 的 JSON 请求上传；2026-09-16，C02 v247。覆盖 JSON 和 SSE 两种响应模式，不改变 Images 的不可逆成功结算点。

## 上传准备与传输

四个驱动在 provider 认证／OAuth 和派发准入前，调用已有 `withOwnedJsonUpload` 冻结 JSON 投影。保留路由参数合并、私有模型映射、Chat `include_usage`、JSON 转义及 `toJSON` 行为；序列化失败时不发认证或推理请求。认证／准入期间修改原对象不改变本次上传字节。

出站不再创建整个请求的 `JSON.stringify` 字符串，改为按需生成至多 64 KiB 编码页。预先计算 UTF-8 字节长度；底层 owner 声明 workerd 源级 `expectedLength`，驱动携带 Content-Length，Node 请求使用 `duplex: 'half'`。这不是已经完成 Workers 原生传输验收的声明，不能仅凭手工 HTTP 长度头认定平台会定长发送。

## 上传与响应分别完成

`resourceCompletion` 汇总上传 owner 和既有响应 owner；SSE 保留原 pump，非 SSE 使用已有正文 owner。驱动回调在准备失败、提前取消或取得结果后始终停止残余编码器。

| 上传状态 | 资源完成判定 |
| --- | --- |
| 消费方读到真正 EOF | confirmed |
| 消费方主动取消且本地编码源清理确认 | confirmed；不证明远端收到请求或完成计费 |
| 从未拉取且未锁定，准备阶段即停止 | confirmed |
| 已锁定／已开始消费但被强制停止 | unconfirmed |
| 已读最后一页，但未读到 EOF | unconfirmed |

响应成功不覆盖未完成上传。即使上传已 confirmed，汇总任务仍须等待响应正文 EOF／真实取消 ACK；任一方向无法确认，启用逻辑容量时保留数字预留。Reader 解锁、业务完成、取消信号或超时本身都不是释放依据。

HTTP／usage 和记账不等待资源清理。上传未确认不能把已成功的响应用量撤回为取消，不新增自动重发。既有已知拒绝 fallback、未知结局禁止重放和重定向拒绝策略不变。

## 验证与边界

Node 本地测试覆盖四驱动与九个公开入口的 JSON／SSE、部分消费／末页／取消、OAuth 前快照、准备失败、响应清理 ACK，以及四种协议的真实 loopback HTTP 字节和长度。公开测试使用合成 SQL sink 和数字容量池，不证明真实 D1 原子性或物理内存回收。

容器快照仍完整复制 JSON 结构，原入站解析对象、路由审计和其他消费者也可能持有副本；按页编码不等于全工作集有界。数据库自身时限／初始化、Workers 原生 wire／取消、原实例容量和生产容量参数仍待独立验收。生产容量不开启，C02.G／C01 不因这些本地测试放行。

本合同补齐 [v246 响应合同](./text-json-resource-policy.md) 中当时尚未接入的上传部分；旧证据保留其历史状态，不重写历史验收结论。
