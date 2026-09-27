# C02：OpenAI 兼容 ASR multipart 上传资源所有权（v242）

日期：2026-09-10。结论：**LOCAL_PASS，未部署**。仅推进 OpenAI 兼容转录上传；不是全部 ASR、Workers 传输或容量验收。C02.G、C01 及其下游依赖保持未通过。

## 实现

此前 OpenAI 兼容 ASR 把整段音频复制成 Uint8Array 后再装入 Blob，上传自身没有资源完成任务。本轮新增请求局部 multipart 生产者：二进制页面至多 64 KiB，文本分块编码，按需 pull，结束时清除生产者的内容引用和 abort 监听。字段顺序、重复字段、CRLF、文件名／MIME 处理和响应格式选择保留。

驱动在认证与准入前登记上传资源任务，在所有退出路径停止上传；该任务与上一轮的响应清理共同汇总。消费者 EOF／主动取消可以确认；强制停止已经持有或读取了内容的消费者为 `unconfirmed`，不能用 HTTP 响应成功、响应清理 ACK 或 reader 解锁替代完成证明。

实现借用请求持有的音频字节，每次交付复制独立页面，不再为出站表示额外构造完整音频 Blob。调用方在尝试完成前不得修改这些字节；实现不会修改原文件，也不声称清除了调用方、入口解析或计费解析保留的引用。大标量字段的 CRLF 规范化仍可能创建整段字符串；完整工作集上限未通过。

仅更新一个既有测试以从真实 multipart wire 解析 provider.options，不再假设 fetch 的 body 一定是 FormData。未修改金额算法、账务状态、不确定请求重放规则或 Images completed＋真实上游 `[DONE]` 不可逆成功点。详见 [上传合同](../../reference/asr-upload-resource-policy.md)。

## 验证

首组同源码 14 项修复前为 **0 PASS / 14 FAIL**，接线后 **14/14 PASS**；原文件、原始日志和摘要均保留。该组断言新流式 body 及独立资源分类，不将 14 个失败解释成 14 个不同产品缺陷。随后增加 27 项边界与传输检查，最终新增 **41/41 PASS**：

- 14 项：明确 200／503 × 完整读取、主动取消、未读取、锁定未读、部分读取、部分解锁、结束边界后未读 EOF。
- 4 项：客户端取消／deadline × 迟到响应取消 ACK 成功／失败；资源任务仍归原请求所有，数字容量不提前释放，单次发送，错误细节脱敏。
- 2 项：准入前／准入等待中取消不发送 HTTP；持久化准入不被 race 遗弃。
- 1 项：原生 Node 本机 HTTP 完整上传，字段／音频字节保留，精确长度一致，单次请求。
- 20 项：分块边界与原生 FormData 每字节对照、Unicode 与 CRLF、消费者取消、源中止、预中止、头注入防护、交付页面隔离、编码错误脱敏、非标量拒绝。

最终完整回归 **3,351/3,351**（v241 的 3,310 项加本轮 41 项），无失败、取消或跳过；dispatch 和 staging 两项类型检查通过，验证进程终态退出 0。新测试纳入 `test:dispatch-safety` 与 `test:unit`。完整命令和日志摘要见 `.wrangler/staging/asr-upload-v242-final-verification.json`。

本机测试没有使用真实模型、KMS 或实际账务服务。逻辑容量检查使用合成 ExecutionContext 和请求池，不是原生实例内存释放证明，也不是公开 ASR 上传端到端专项验收；既有公开路由回归本轮已重跑。

## Workers 与剩余要求

按 workers-best-practices 技能重新检索 [官方最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)及最新官方类型 `5.20260910.1`，检查已有同版本的 RequestInit、UnderlyingSource 和 controller 定义；未安装依赖或更改运行时配置。技能促使本轮采用按需分块和明确的请求局部资源所有权，同时明确区分本机证据与原生验收。

[Workers Request 文档](https://developers.cloudflare.com/workers/runtime-apis/request/)指出，普通 ReadableStream 的手工 Content-Length 会被运行时忽略，通常改用分块传输。当前本机定长断言**不是** Workers 定长上传证明；下一次部署前必须验证目标上游分块兼容性，或完成需要定长时的原生定长流方案及完整所有权。不能因 411／不确定传输自动重试推理。

尚未完成：DashScope 同步／异步／原生 JSON 出站上传、其余 JSON 消费者、入口与数据库自身时限、Node 自动停机、全工作集及 Workers 原实例容量。没有运行 Node 22、远程 CI、新原生 Workers 或历史 staging 全套。下一步先处理上述上传与传输兼容性，再推进剩余消费者和数据库时限，新云端验收须重新冻结候选。

## 证据与费用

继承并核验 v241 的 **2,259 条**摘要。受影响历史源码按路径＋SHA 重定位到 `.wrangler/staging/asr-upload-v242-before-source/`；旧 manifest 不重写。完整摘要与结果见 [机器证据](./C02-asr-upload-v242-results.json)。

本轮 staging 管理／公开调用、部署、生产写入、真实模型和 KMS 均 **0**。首轮累计公开 HTTP 422、模型/KMS 0/0、US$2 上限不重置；US$1.20 历史／延迟预留与 US$0.80 未分配仍是操作预算，不是已核验账单。最后云端观察仍为 v232（2026-09-09T06:45:06.937Z），本轮未刷新云端状态、实际费用或旧候选；已部署 bundle 不包含本轮源码。
