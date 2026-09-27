# 文本流资源完成与容量持有

适用范围：Chat Completions、Responses、Anthropic Messages、Gemini SSE 的本地实现。此合同不替代真实 Workers 生命周期、原实例容量或堆内存验收；生产容量准入仍默认关闭。

## 三种不同的完成

| 信号 | 含义 | 不代表 |
| --- | --- | --- |
| `usagePromise` | 已能确定用量、取消或流失败事实 | 上游取消已经确认、账务已持久化 |
| 路由记账任务完成 | 当前记账代码已返回 | reader/pump 已清理 |
| `resourceCompletion` | 当前登记的资源工作得到 `confirmed` / `unconfirmed` 结果 | 整个 Worker 的物理内存释放或其他协议的全部资源完成 |

路由在 dispatch 启动前同步登记独立资源任务并保留容量 owner。调度器汇总所有已启动尝试，包括 deadline 返回后才得到响应的尝试；失败候选的清理不得被后续成功覆盖。登记失败时不开始 dispatch。正常返回且未提供资源通道的驱动，仅表示没有额外报告的资源工作，不是对尚未接入模块的清理保证。

四类文本 SSE 的取消是一次性操作。取消 ACK 未到时，用量可先完成；泵单独等待 ACK。拒绝或意外泵错误报告 `unconfirmed`，不能吞掉错误后把它算作已释放。正常 Chat / Responses / Messages 协议终点仍可及时交付结束事件并释放 reader lock，但独立资源完成信号继续等待取消 ACK。Gemini 自然 EOF 无需发起多余取消。

## 容量与运行时

- 只有 `confirmed` 才释放这个资源 owner 的逻辑容量；等待中保持占用。
- `unconfirmed` 保留数字预留，记录固定的结构化告警，不保留错误文本、凭据或请求负载。没有 TTL、超时自动放行或后台推理重试。
- 这是保守的可用性取舍：无法证明清理的请求可能耗尽同一逻辑池。不得在尚未完成全消费者／原实例验收前开启生产容量。
- Workers 使用请求的 `ctx.waitUntil`，保持原方法 receiver；登记成功不意味着平台可无限延长生命周期。官方上限仍适用，未观察到完成不变成成功。
- Node 使用独立受管资源任务集合和 `drainNodeResourceWork()`；原有 `drainNodeBackgroundWork()` 只排空记账，不能被不可信 ACK 阻塞。尚未接入 Node 自动停机编排，也未验收 Node 22。
- 原 owner 不允许在容量已归还后重新 retain。汇总器仅在请求内保存计数和结果，无跨请求的 Worker 资源注册表。

## 未完成边界

TTS、其他协议、上传、JSON／错误正文的独立清理，以及数据库初始化／写入自身时限仍需逐一核对。这里的 `confirmed` 只覆盖已登记工作，不能据此宣布 C02.G 或完整容量门禁通过。下一次原生 Workers 验收必须使用新的冻结构建；禁止通过重复推理、RPC 或上传来寻找相同实例。

Images 成功结算点不变：网关验证有效 completed 图片和真实上游 `[DONE]` 后，先持久化不可逆成功事实，再交付成功 DONE；之后客户端取消不撤销费用。

实现遵循 [Workers 官方最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)的生命周期登记要求；本地合成 `waitUntil` 和逻辑容量测试不是云端验收。
