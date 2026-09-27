# C02 — 操作器单调时钟、预校验与安全收尾

2026-09-08；Checklist v1.102。状态：**LOCAL_PASS**，不是 staging 整轮通过；C02.G 仍未通过。本轮没有部署、云端管理请求、模型或 KMS 调用。已部署 Worker 和生产结算算法均未修改。

## 修正范围

上一轮 v1.101 的原生取消与独立恢复证据保留，原整轮结果仍为 FAIL_CLOCK_ORDER。不能通过重排 UTC 时间、补造单调时间或重跑已提交的恢复，将旧实验改为成功。

新增操作器模块使用 `process.hrtime.bigint()` 记录同一进程的相对时间；每个进程实例生成独立 clockId。UTC wallAt 仅作原始审计标签，可前跳或回跳，不能决定顺序或等待结束。不同 clockId、缺失记录、回退的单调源、不安全整数及非法 UTC 标签都拒绝。[Node 高精度计时文档](https://nodejs.org/api/process.html#processhrtimebigint)。

- 请求顺序验证：started ≤ headers ≤ cancel ≤ finished；开始至取消最多 90 秒，取消至客户端结束最多 10 秒。
- tail 收件时间使用同进程单调记录，要求取消后 29–90 秒；原有 native invocation → 原始 Request.signal 取消 → 原生警告的同平台时间验证、部署身份、精确 held 字节及客户端 200 证明仍保留。11 字段原生 tail 投影不增删、不将 canceled/null response 改为 ok/200。
- 清理期限保留保守窗口：started/headers 各加 350 秒、客户端结束加 30 秒、最后 recovery RPC 结束加 30 秒，取最大值；毫秒取整另加 1 毫秒余量。每次睡眠不超过 20 秒并重新检查单调时钟，支持取消，不自动重试外部操作。
- 新 V3 清理模块调用新版双入口收尾，保留完整六组财务行、原始探针、所有者及逐字段原子事务保护；新增同 clockId 的清理期限、当前样本和收件时间检查。先持久化完整事实，再原子删除合成夹具。校验失败时不删除财务行、不退款、不重放推理。

这些窗口是操作器验收约束，不是生产 API 的新时限。遵循 Workers 最佳实践技能，仍区分请求级 waitUntil 任务取消与整个 isolate 回收，不以本地 SQLite 测试或单调记录证明平台驱逐。Cloudflare 文档规定 HTTP 响应结束或客户端断开后，waitUntil 最多延续 30 秒；独立恢复仍是必要路径。[Cloudflare context 生命周期](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)。

## 开放入口前的计划合同

`staging-sse-operator-plan.mjs` 提供无外部副作用的完整计划结构校验，并仅在校验成功后进入操作回调。固定 staging account/D1/gateway/controller、规范 tokenName、部署 UUID、runId/keyHash/expiry 格式、两种互异模式及四个唯一 probe 均须匹配；拒绝预先伪造 generation ID、额外字段和非规范临时令牌名。计划深拷贝并递归冻结，避免异步调用期间被调用方修改。

预算合同要求沿用累计记录与 US$2、capReset=false、最多 32 次新增 HTTP / 2 次 recovery RPC。**这是结构与授权基线校验，不是实时费用、有效期新鲜度或资源隔离证明**。未来在线操作仍必须在同一受控流程内执行新的只读 billing / binding / Access / schema / deployment 核查；不能单凭这个纯函数开放入口。

新版双 Access 收尾先同步保存规范所有权（只读取 runId/tokenName/tokenId，不读取请求正文），即使该校验失败，也会尝试关闭两个固定 staging workers.dev/preview 入口。只有两个入口均已确认关闭，才报告所有权错误；非法 journal 不触发 token 或 policy 写入。合法 journal 沿用先停用 token、关 redirect、恢复双 deny-all、最后删除精确归属 token 的顺序。API 省略默认 false 被接受；不扩大未知 token 的删除范围。关闭 API 失败仍可能留下入口未确认，模块明确报错，不能宣称已隔离。

## 本地验收

新增 **150 项**，完整回归 **1,400/1,400**，失败、取消、跳过均为 0：

| 子集 | 数量 | 证据边界 |
| --- | ---: | --- |
| 单调时钟、取消等待、跨进程拒绝、UTC 跳变 | 35 | Node 操作器本地合同 |
| 计划结构/预算/作用域/冻结、非法输入零操作回调 | 29 | 纯函数与回调替身，无 Cloudflare API |
| 双入口安全收尾、8 个写入前/后故障及检查点故障 | 52 | 本地 Cloudflare API 状态替身；含原有 44 项在新版重跑 |
| V3 原子清理及缺失/错误证据、过早清理、pending job、持久化失败 | 34 | 实际 SQLite 与网关逻辑，native tail 和时钟样本为明确标注的合成夹具 |

V3 的成功本地夹具同时验证恢复后唯一财务事实、清理后的基线与其他所有者行不变、重复清理无新效果；负例验证财务行不被删除。本轮没有修改冻结 v1.101 及以前的代码/报告/hash 依赖。新增 Node 22/24 CI 工作流但未执行远程 CI；本机只有 Node 24.14.1 实测，Node 22 未验证。

## 线上边界与下一步

本轮**尚未把新版模块接入新的真实网络操作入口，也未执行新的 native matrix**。不得继续运行冻结 v201 脚本期待自动获得修复。下一步先编制并本地验证新的在线编排：启动时生成规范 tokenName；第一处 cloud 写入前调用计划合同；在真实 fetch/header/abort/finish/tail message 回调处捕获不可补造的时钟样本；轮询、RPC 与清理均使用同一 clockId。跨进程恢复必须走独立保守对账，不能复用上个进程的相对时间。

完成该接入后，再进行新的只读 staging 预检和有限的新请求实验；不重放 v1.101 推理或已提交恢复。此后继续客户 intent-only/unknown/幂等政策、完整 SSE 生命周期和跨消费者物理容量验收，C02.G、C03–C20 保持开放。

最后一次云端观察仍为 v1.101 finalization（2026-09-08T10:40:36.126Z）：双 Access deny-all、四个 Worker 入口关闭、临时 token/tail 不存在、合成数据已清理，56 表 / 295 schema 项恢复基线。**本轮没有重新核验云端状态**。继承累计 HTTP 356、真实模型/KMS 0、首轮 US$2 不重置；本轮新增相关调用 0。最终增量账单仍未核验，不能据此声称最终账单为零。

机器报告见 [v1.102 结果清单](./C02-images-sse-monotonic-operator-results.json)；历史失败与补救见 [v1.101](./C02-images-sse-host-expiry-tail-v2-staging.md)。
