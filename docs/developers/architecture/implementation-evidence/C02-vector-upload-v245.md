# C02 v245：向量 JSON 上传分页与资源所有权

日期：2026-09-10；Checklist v1.144；LOCAL_PASS，未部署。

## 已实现

Embeddings／rerank 从整份上传 `JSON.stringify` 改为已有分页编码器。新 `withOwnedJsonUpload` 在认证和准入前创建 JSON 投影快照并登记上传资源任务，随后汇总 v244 响应 owner。回调结束由 finally 停止编码；上传源被锁定／部分读取／末页已读但没有消费 EOF 时保持 unconfirmed，不能被成功响应覆盖。完整 EOF、显式取消及未触碰源分别验证。用量、结果分类、费用算法和 Images 不可逆成功点未改。

模型改写、参数覆盖、rerank 字段筛选仍使用原函数。两个既有 driver 测试改为在模拟 fetch 内读取请求流，再断言同一 JSON 请求内容，不再对 ReadableStream 调用 String。公开入口沿用 v244 的资源登记，不增加配置、云资源、依赖或自动重试。详见 [上传合同](../../reference/vector-upload-resource-policy.md)。

## 本轮证据

| 测试范围 | 结果 | 内容 |
| --- | --- | --- |
| 新上传 driver／组合 helper | 36 项通过 | 两驱动六种消费状态；快照、准入取消／抛错、无效认证头、fetch 拒绝；上传和响应 ACK 独立；JSON 投影失败及 toJSON；两个本机 HTTP 字节／长度用例 |
| 新公开入口 | 16 项通过 | 两操作 × 两别名 × 完整消费／部分读取／末页未 EOF／显式取消；HTTP 成功及一次记账 batch，资源未确认保留逻辑容量 |
| 专项连同既有向量生命周期 | 175/175 | 本轮新增 52 项，既有 123 项 |
| 完整 dispatch 回归及补充 wire／URL 检查 | 3,554/3,554 | 0 失败、0 取消 |
| dispatch / staging 类型检查 | 均通过 | 第一次类型检查发现新测试回调缺少参数类型与 reader 收窄，已修正；未通过修改产品代码规避这些测试类型错误 |

校验器 `.wrangler/staging/verify-vector-upload-v245.mjs` 在运行前后冻结八个源／测试／包文件，生成四份不可覆盖日志及验证 JSON；v244 的 2,336 条历史摘要用归档源继续核验。发布器保留原 manifests，生成 [机器证据](./C02-vector-upload-v245-results.json)。本轮没有执行相同最终测试源码的修改前对照，不宣称 before/after 缺陷数。

Workers 最佳实践及官方 npm 最新类型 5.20260910.1 已重新核对，读取其 `UnderlyingSource.expectedLength` 定义；沿用此前下载文件，不安装依赖。Node HTTP 验证 Content-Length、无 Transfer-Encoding、完整 Unicode／转义正文以及一次 POST；没有执行 Workers 原生上传测试，不将 Node 结果用于替代 workerd 行为。

## 未完成与下一步

1. 容器快照依然全量存在，字符串共享引用；64 KiB 是出站编码页上限，不是整个请求或 isolate 工作集上界。保留原有入站、定价／审计、JSON 重建及所有参数限制。
2. 公开测试使用合成 SQL sink；一次 batch 不等于真实 D1 金额／原子性验收。1,024 字节逻辑预留不是生产容量参数。
3. 下一项：OpenAI Chat、Responses、Anthropic、Gemini 的非流式 JSON／错误响应资源及上传源；随后继续数据库自身时限和初始化路径。四驱动的 SSE 已有独立 owner，不因其存在而假定 JSON 分支也覆盖。
4. Workers 原生定长传输、取消、上游提前返回、原实例容量及全工作集仍待新冻结 staging 候选验收。Node 22、remote CI 未验；v243 原生启动失败本轮未重试。C02.G、C01 和后续依赖保持未通过，生产容量未开启。
5. staging 调用／部署 0、生产写入 0、真实模型/KMS 0/0。首轮累计 US$2 上限不重置；最后云观察仍 v232，本轮没有重新核验远端状态或最终账单。
