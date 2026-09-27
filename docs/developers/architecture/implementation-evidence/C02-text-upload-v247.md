# C02 v247：四类文本 JSON 分页上传与独立资源完成

日期：2026-09-16；Checklist v1.146；LOCAL_PASS，未部署。

## 实现

OpenAI Chat、Responses、Anthropic Messages 和 Gemini 接入已有 `withOwnedJsonUpload`。先冻结 JSON 投影，再进行 provider 认证／OAuth 和派发准入；用至多 64 KiB 的按需页面替代完整出站序列化字符串。保留参数合并、模型映射、Chat include_usage、认证、重定向拒绝、JSON／SSE 响应分类与既有 fallback 规则。

上传 owner 与响应 owner 汇总为独立资源任务。上传 EOF、未开始上传的停止或本地取消清理确认可以完成上传 owner；已开始／锁定的上传被迫停止、已读末页但未读 EOF 保持 unconfirmed。成功响应和成功 usage 不会覆盖这些状态，也不会被它们撤销。响应清理 ACK 尚未到达时，汇总任务仍继续等待。

Images 的“有效 completed 图片 + 真实上游 DONE”不可逆成功点、先持久化事实再交付成功结束的规则和费用算法均不变。此轮没有修改 Images 产品代码。具体边界见 [文本上传合同](../../reference/text-upload-resource-policy.md)。

## 验证

| 范围 | 结果 | 证明范围 |
| --- | --- | --- |
| 新驱动测试 | 104/104 | 四协议 JSON／SSE × 六种上传状态；准备与准入失败；双向 owner；OAuth 前投影、toJSON 一次；四种本机 HTTP |
| 新公开入口测试 | 72/72 | 九入口 × JSON／SSE × 完整／部分／末页／取消；普通及全局路由；usage 2+3、成功状态、一次 SQL batch、逻辑容量保留／释放 |
| 专项及相关既有测试 | 833/833 | 176 新增 + 579 既有公开入口 + 72 边界／Vertex + 6 全局 fallback |
| 完整 dispatch 及补充 wire／URL 回归 | 3,890/3,890 | 相比 v246 新增 176；0 失败、0 取消 |
| dispatch / staging 类型检查 | 均通过 | 没有升级运行时、依赖或 compatibility flags |

四项 Node 原生 loopback HTTP 验证实际请求字节、UTF-8 Content-Length、无分块编码和各协议路径；本地服务只返回合成响应。这不是 Workers 原生 `expectedLength`、取消 ACK 或物理容量证明。

首次聚焦测试为 175/176：新增 Anthropic 本地服务测试的 base 含 `/v1`，又由既有协议解析器追加 `/v1/messages`。已修正测试 base，没有修改产品 URL 解析。原测试文件保留；该次输出仅在工具记录中，没有独立初次日志。随后 176 个新增场景聚焦全部通过。

第一次完整回归为 3,889/3,890：既有全局 fallback 的 fetch mock 对 `ReadableStream` 执行 `JSON.parse(String(body))`。仅改为读取流中的 JSON，保留原 M2/M1/M2 次序、三次已知拒绝回退及最终模型等断言。失败日志、旧测试、第一版验证器和回执均归档，最终完整重跑通过。此轮没有执行旧实现下的同测试源码对照，不宣称修改前后缺陷数。

验证器执行前后锁定十个当前源码／测试／包文件，并核验 v246 的 2,395 条历史摘要。九个修改前文件按原路径和旧摘要迁入独立归档；旧 manifest 不重写。[机器证据](./C02-text-upload-v247-results.json) 共 2,431 条摘要记录。

按 Workers 最佳实践技能使用按需流式传输和独立资源所有权，重新读取 [官方最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)，核对当天取得的最新官方类型 5.20260915.1 中 `UnderlyingSource.expectedLength`。类型检查文件仅在独立检查目录，未安装或升级依赖。

## 尚未完成与下一项

1. 数据库自身时限和存储初始化仍需明确资源归属；不能简单用 Promise.race 丢弃未完成写入或迟到客户端。
2. 原入站对象、完整容器快照、审计与其他消费者的副本仍可能同时存在。分页编码不是全工作集有界证明；生产容量参数没有开启。
3. 公开 SQL sink 只验证记账意图，不代表真实 D1 原子性／资金验收。100 字节逻辑池是测试参数，不是生产内存测量。
4. Workers 原生上传／取消与原实例容量、Node 22／远程 CI 仍待验收；未重跑 v243 的 workerd 启动失败。C02.G、C01 及后续依赖不放行。
5. 下次线上验收须重新冻结当前候选。v232 最后部署不含后续本地改动；旧 CLI 对源码漂移仍应拒绝。
6. 本轮 staging 调用／部署 0、生产写入 0、真实模型/KMS 0/0。首轮累计 US$2 上限不重置；最后云观察仍 v232，没有重验远端状态或最终账单。
