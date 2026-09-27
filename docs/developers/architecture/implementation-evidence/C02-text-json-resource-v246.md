# C02 v246：四类文本 JSON／错误响应资源完成

日期：2026-09-16；Checklist v1.145；LOCAL_PASS，未部署。

## 实现

OpenAI Chat、Responses、Anthropic Messages 与 Gemini 在收到非 SSE 响应头后接入已有 `ownUpstreamResponse`。成功 JSON 的有界读取、格式／大小拒绝、非 2xx 正文及取消后的迟到响应都返回独立资源完成任务；外层 dispatch 的原始尝试任务继续覆盖等待响应头的时间。HTTP／usage 可以及时结束，真实取消 ACK 尚未确认时不释放逻辑容量；拒绝 ACK 保持 unconfirmed。

SSE 分支先交给原 pump，不重复包裹其 reader。原 JSON 上限、协议分类、公开模型名、usage、错误归一化、重定向与 fallback 预算不变；Images 的成功结算点和费用算法不变。公开普通／全局路由已有资源登记，本轮无需改路由产品代码。具体语义见 [资源合同](../../reference/text-json-resource-policy.md)。

## 验证

| 范围 | 最终结果 | 证明范围 |
| --- | --- | --- |
| 新驱动测试 | 79/79 | 四协议声明／实际超限、读取中取消、迟到成功／非 2xx、下游取消、ACK 成功／拒绝、JSON EOF／空正文／无效协议 |
| 新公开入口测试 | 81/81 | Chat、legacy completions、Responses、Messages 的两别名及 Gemini 共九入口；普通／全局路由，大小拒绝、已知拒绝 fallback、客户端／deadline 迟到响应、成功 usage 与逻辑容量 |
| 专项连同既有公开生命周期测试 | 658/658 | 79 新驱动 + 81 新公开 + 498 既有公开测试 |
| 完整 dispatch 回归及补充 wire／URL 测试 | 3,714/3,714 | 新增 160 项，0 失败、0 取消；包括既有四文本 SSE 资源／取消回归 |
| dispatch / staging 类型检查 | 均通过 | 未升级依赖、兼容日期或运行时 |

驱动测试先在原实现上执行，79 项均因缺少资源 owner 失败；相同测试文件摘要在最终版本仍一致，最终全部通过。这是 79 个测试场景，不是 79 个独立产品缺陷。公开测试未执行同源码修改前对照，不混入此比较。

公开测试初次聚焦运行 63/81 通过：18 项错误地预期超大上游错误正文保留 400，而既有归一化为 502。其后首次完整运行 3,698/3,714：16 项夹具复用了 Response，且配置多模型却假设只有一次发送。已改为每次 fetch 创建独立正文，按原有已知拒绝 fallback 预算断言调用和取消次数；没有为通过测试修改产品重试策略。两份中间测试源码、第一轮完整失败日志及回执均保留。首次聚焦输出仅见工具记录，不冒充独立日志。

验证器 `.wrangler/staging/verify-text-json-resource-v246.mjs` 在执行前后校验七个当前源／测试／包文件，并核验 v245 的 2,360 条历史摘要；历史文件按路径及旧摘要迁到修改前归档，旧 manifest 不重写。发布器汇总 [机器证据](./C02-text-json-resource-v246-results.json)，总计 2,395 条摘要记录。

按 Workers 最佳实践技能重新取得 [官方最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) 与官方 npm 最新类型 5.20260915.1，检查 ReadableStream／reader cancel、releaseLock 定义。类型仅下载到独立检查目录，项目依赖未变。

## 尚未完成

1. 四个文本出站上传仍是完整 `JSON.stringify`，下一项接入独立上传 owner 和分页编码。此响应 owner 不证明上传已释放。
2. 公开 SQL sink 只捕获记账意图；成功用量和一次 batch 不等于真实 D1 原子性／资金验收。测试用 100 字节逻辑预留不是生产内存参数。
3. 数据库自身时限、初始化路径、所有消费者的全工作集、Workers 原生 wire／取消与原实例容量仍待验收。生产容量未开启，C02.G、C01 和后续依赖不放行。
4. 没有重跑 v243 失败的本机 workerd 启动，也没有新部署。下一次云验须重新冻结候选，旧 CLI 对当前源码漂移应继续拒绝。
5. 本轮 staging 调用／部署 0、生产写入 0、真实模型/KMS 0/0。首轮累计 US$2 上限不重置；最后云观察仍 v232，本轮未重验远端关闭状态或最终账单。
