# C02.B2.2 — 有界观察客户端与同池阶段标记

日期：2026-09-09；Checklist v1.110。整体 **STAGING_PARTIAL**；本轮为本地候选，不提升 C02.G。
Owner / Reviewer：Codex 当前任务实现及本地自检，独立平台/发布签核待定。

## 本轮解决的证据缺口

v1.109 的严格序列号可以排除乱序，但“客户端在某事件后收到样本”仍不能证明该样本在事件后生成：网络可能缓存旧样本。本轮新增 v2 协议，不覆盖 v1.109 冻结源码及证据。

新 Worker 仍只有一个原有逻辑容量池。`GET /__staging/sse-capacity/watch-v2` 使用 `x-c02-capacity-watch: v2`；样本多一个数值 `barrier`。`POST /__staging/sse-capacity/barrier-v2` 携带原 `x-c02-capacity-peer` 身份与 `x-c02-capacity-barrier`，按 `held → post-native → post-recovery` 顺序推进同池数值标记，分别为 1/2/3。仅接受无正文、无 query/fragment/Upgrade 的精确请求；必须匹配当前同池 UUID 与观察代次。

标记同步更新之后生成的样本才携带新 barrier。已缓存样本保持原值，不能由客户端改标签。重复、跳步、跨池、过期或缺失 peer 均拒绝。标记只改诊断数字，不触碰数据库、账务、容量 lease 或上游；其 ACK 不代表观察请求一直存活，也不代表原生取消已经发生。

## 客户端与判定器

- `staging-sse-capacity-peer-protocol.mjs`：严格身份/schema、canonical JSON、UTF-8、连续序列、非递减阶段及终止校验。拒绝重复字段、未知字段、超长行、总量溢出、畸形/空数据、旧版本、混入 barrier ACK、阶段倒退和截断。每帧至多 512 bytes（含换行），部分行至多 511 bytes，整个响应至多 `181 × 512 = 92,672 bytes`，最多 180 样本及 1 个终止条。
- `staging-sse-capacity-peer-client.mjs`：一次 watch GET，最多三个 marker POST，**每次先同步扣共用 HTTP 次数预算、持久化 PENDING，再发请求**；失败/不确定尝试仍消费预算，不重试、不重新连接、不自动推理或调用恢复 RPC。仅发送固定 staging URL、Access 两个请求头及固定诊断头，禁用跳转和缓存。
- 每个网络/读体阶段 5 秒上限，journal 每次 5 秒上限。使用原单调时钟且检查实际剩余时限，不以墙钟或“定时器尚未回调”当作未超时。观察客户端寿命 185 秒，Worker 观察设计寿命 180 秒；它们不保证平台终止时能执行 finally/timer，也绝不作为业务 lease TTL。
- ACK 体最多 512 bytes。客户端同时校验响应身份头、ACK 的实例/代次/阶段，再过滤旧 barrier 样本，只有当前 barrier 的新样本可供该阶段使用。确认丢失即停止，即使服务端可能已经推进标记。
- 响应异常、格式异常、EOF/end、超时、预算或 journal 失败均停止客户端。取消已持有 reader，向网络传播 abort，并处理不合作的迟到响应；不等待无限期的取消承诺。对外错误仅固定分类，不持久化原始错误、凭据或任意响应正文。
- `classifySseCapacityPeerSequence` 校验同一 peer、四阶段顺序、四次尝试、单调时钟、事件前置时点、marker ACK 和新样本，再分类 idle baseline / occupied held / idle after native marker / idle after recovery marker。其最强结论只是 `LOGICAL_SEQUENCE_PASS`，始终 `nativeVerified:false`、`c02GatePassed:false`、`isolateEvictionProven:false`。

## 验证范围

新增 82 项测试：37 项协议测试、26 项客户端测试、17 项 Worker v2/客户端互通测试、2 项真实 SQLite 账务组合测试。包括字节级分片、最大帧数、重复字段、畸形 UTF-8、缓存旧样本排除、同池原子标记、并发重复标记、跨实例停止、无正文消耗拒绝、预算/journal 失败、无响应和无数据超时、不合作的迟到响应、ACK 丢失、总时限和 oracle 篡改拒绝。

两项 SQLite 集成保留 before-hold / after-hold 原有结算行为：独立恢复分别提交 0/1、去重 0；after-hold 成功费用不因取消撤销，观察和标记不释放原请求尚未结束的容量持有者。测试中的 post-native 标签是显式本地模拟，**不是 Workers 原生证据**。

完整回归 **1,711/1,711 通过**，失败/取消/跳过均为 0，staging TypeScript 检查通过。执行前后核对历史 **1,657 条摘要**及 **11 个新增文件摘要**，全部一致。命令、原始输出及摘要见 [v210 本地结果](../../../../.wrangler/staging/sse-capacity-peer-v210-verification-result.json)，汇总见 [v1.110 机器结果](./C02-images-sse-capacity-peer-barriers-results.json)。新增 Node 22/24 CI 仅已定义，未执行远程 CI；本机 Node v24.14.1。v2 的新 main 仅为纯关闭配置候选，尚未打包或发布。

## 发布门禁与下一步

下一项必须将客户端接入**新的**有界操作器：原生 V3 证据判定成功之后才能捕获 `post-native` 的前置单调时点并发 marker；真实 held D1 观察、主请求响应池 ID、取消时点、tail 回执、恢复/去重结果必须来自同一轮实测。不能仅给字段命名 post-native，或只提供布尔值，就通过原生门禁。

新操作器还须整合总 HTTP/管理 API 预算、写前日志、只发一次推理、错误停止、精确清理和已验证的入口关闭顺序，然后进行封闭构建及必要平台验证。marker 被路由到其他实例时停止该实验，不通过重试碰撞实例。watch 是另一个活动 invocation；即使验证通过也不能声称 isolate eviction。

本轮没有部署、Cloudflare 管理 API、公开测试 HTTP、远端 D1 写入、模型/KMS 调用或生产修改。累计 HTTP **382**，真实模型/KMS **0/0**，首轮 **US$2 累计上限不重置**；最终增量账单尚未核实。云端最后观察仍为 [v1.108](./C02-images-sse-access-confirmation.md) 的 `2026-09-08T12:59:42.118Z`，不是今天的新复核；四个入口关闭、双 Access deny-all、临时 token/tail 已删除是该历史观察。当前云端原池容量结论仍 **INCONCLUSIVE_HELD**。

成功点保持“有效 completed + 实际上游 DONE，之后取消不撤销费用”。物理容量、其他消费者、unknown/幂等、C01 剩余决策、C02.G 与 C03–C20 均仍开放。本轮采用 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)约束请求所有的流/计时器、有界处理和原 service binding；无新增全局 Request/Response/Promise 注册表。
