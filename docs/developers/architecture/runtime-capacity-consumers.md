# C02.B2.2 运行实例消费者与启用门禁

最新接续（2026-09-08，v1.106）：[容量观测候选已部署到关闭入口的独立 staging](./implementation-evidence/C02-images-sse-capacity-deployment.md)，实际代码摘要已核验；生产入口仍未启用。以下较早“未部署”描述保留其历史范围，新候选的原生同池持有期和完整物理容量尚未验收。

2026-09-06 基线，2026-09-08 增补；本地源码 / 配置模板核对，不代表线上部署状态。HTTP 基础实现见 [容量合同](./request-capacity-contract.md)，早期实测见 [证据](./implementation-evidence/C02-runtime-capacity-validation.md)。v1.104 已在 Workers 工厂接通显式 `httpCapacity` 选项并完成[耐久 SSE 本地持有期验证](./implementation-evidence/C02-images-sse-capacity-ownership.md)；生产入口仍未传入策略，未设置默认额度或部署，新组合的原生及物理容量验收待完成。

用户后续已确认 **Workers 首发优先、Node 备选**，并要求使用与生产资源隔离的独立 staging；现已在累计 US$2 授权下完成独立 Worker/D1 初始化及 [8 项受保护 HTTP 基础冒烟](./implementation-evidence/C02-staging-access-smoke.md)。Access 权限阻塞已解除；收尾入口关闭、临时令牌删除，容量验收仍待完成。按 [staging 有限顺序](../../operators/deployment/cloudflare-staging.md#3-云端有限顺序) 推进；Windows 本机修复不再是唯一前置。下表中的 Node host 缺口仍保留为备用路线要求，其余数据库 / 模态 / 服务目标参数仍未全部冻结。

2026-09-07 增补：[真实 Workers Images 入站阶段 21 项检查通过](./implementation-evidence/C02-staging-image-ingress.md)，覆盖 50 MiB 请求 / 20 MiB 单文件与控制字段边界。测试后入口关闭、合成用户/Workspace/Key 清理。没有上游响应、成功推理、后台结算、并发或同 isolate 内存/恢复证据；大包后的单个小请求不证明同实例恢复，C02.G 仍未通过。

## 1. 消费者和物理范围

后续同日增补：[11 项真实 Workers 私有 Images 链路检查通过](./implementation-evidence/C02-staging-image-chain.md)。已验证串行合成成功、32 MiB 上游与近三倍输出膨胀、20 MiB 文件出站及真实 D1 零价日志；未注入容量池，未测得 isolate 内存上界，也未验证后台延迟 / 取消 / 恢复。当前 staging 增加独立私有模拟 Worker，专用入口与生产入口复用共同 handler；不假定 service binding 把所有传输工作集物理隔离。50 MiB JSON padding 被丢弃，仍需实际转发大字段及最大输入 / 输出组合。

| 消费者 | 现有入口 / 物理范围 | HTTP 池覆盖情况 | 开启前必须满足的条件 |
| --- | --- | --- | --- |
| Proxy HTTP，包括 SSE、Images、音频、向量、文本、目录 / 管理 API、别名、未知路径 | [app.ts](../../../packages/proxy/src/app.ts)；一个 Node 进程或 Worker isolate 内可以有多个请求 | 显式注入时同一固定预留；[Workers](../../../packages/proxy/src/runtime/workers.ts) 工厂现支持显式策略，生产调用处未传入；[Node](../../../packages/proxy/src/runtime/node.ts) 生产入口仍未启用 | 不能用 Images 样本替代其他模态、原生 JSON、SSE 单事件、multipart 内嵌 JSON、默认参数与所有错误路径的工作集；HTTP-only Profile 必须明确能力范围 |
| 请求内受管后台工作 | [schedule-background-work.ts](../../../packages/proxy/src/runtime/schedule-background-work.ts)；与发起请求同实例，可能晚于响应结束 | 同 lease 独立持有；响应 EOF 不释放未结束的记账 | 核对每个生产者实际 Promise 终态、驱动缓冲与提交确认；平台取消后的持久化恢复另验。直接启动但未 await / 未登记的任务不自动受管 |
| Proxy Realtime host / WebSocket session | [Node Upgrade](../../../packages/proxy/src/runtime/node-realtime-upgrade.ts)、[Node 桥接](../../../packages/proxy/src/runtime/node-realtime.ts) 及公开 Realtime 路由；Node 与 HTTP 同进程 | HTTP-only 策略拒绝 Upgrade / Node Realtime binding；不是 WebSocket 容量支持。生产默认仍保留原功能 | 必须将 Upgrade 前暂存、帧缓冲、会话、会话后记账纳入相同物理预算，或由明确发行配置关闭；不能只关闭应用路由却留下 host 缓冲 |
| Provider attempt Cron 清理 | [Worker scheduled](../../../packages/proxy/src/index.ts) → [retention](../../../packages/proxy/src/runtime/provider-attempt-retention-worker.ts)，与 Proxy 是同一个 Worker 脚本，不应假定平台一定分配独立预算 | 直接 context.waitUntil，不经过 HTTP 池 | 行数上限不是字节 / 连接内存上限。须共享预算或明确隔离 / 暂停调度；Postgres finally 中 end 的 Promise 与错误吞掉也不是远端释放确认 |
| Batch Queue / DLQ | 同一 [Worker queue 入口](../../../packages/proxy/src/index.ts) → [batch-queue.ts](../../../packages/proxy/src/runtime/batch-queue.ts) | 不经过 HTTP 池；一批中顺序处理也不约束同实例跨事件占用 | `BATCH_API_ENABLED=false` **不是消费端停机开关**。只有未配置 consumer 等明确部署条件才能作为不纳入的证据；需核对 R2 流、校验写入、重试以及数据库连接持有期 |
| Admin UI / Admin API / User API / Playground | 独立 [Admin Worker](../../../packages/admin/worker.ts) / Next Node 进程；[Admin](../../../packages/admin/lib/admin-app.ts) 和 [User](../../../packages/admin/lib/user-app.ts) Hono 各有 2 MiB 入口上限 | 不共享 Proxy 内存池。Realtime Playground 在 Worker 外层直接分流，不经过这两个 Hono 上限 | 2 MiB 不是整个 Next / OpenNext、响应、下载、实时桥接的容量证明。独立进程 / Worker 分别定额；同机容器仍需总宿主机预算，服务调用产生两端工作集 |

Cloudflare 官方说明内存上限按 isolate 而非单请求计算，同一 isolate 可以处理多个并发请求；HTTP `waitUntil` 在响应结束 / 客户端断开后最多延长 30 秒，未结束任务可能被取消。[平台限额](https://developers.cloudflare.com/workers/platform/limits/#memory)、[waitUntil](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)。本地 lease 不能证明所有 finally 在平台终止后仍会执行，也不能代替可靠账务恢复。

## 2. 配置证据与不能推断的状态

- 受版本管理的 [Proxy 模板](../../../packages/proxy/wrangler.base.jsonc) 含每小时 retention Cron、Batch R2 与两个 queue consumer 定义。每个 consumer 的 max_concurrency 是平台调度设置，不是整个 isolate 的 HTTP+Cron+Queue 字节预算。
- [配置生成器](../../../scripts/deploy/gen-wrangler.mjs) 仅在 `BATCH_INFRA_ENABLED=true` 时保留 Batch bindings；否则删除 `r2_buckets` 和 `queues`，并固定公开 `BATCH_API_ENABLED=false`。本地已生成文件未配置 consumer；这不是远端已经关闭的证据。本轮未生成 / 部署配置，也未访问真实消息。
- [Admin 模板](../../../packages/admin/wrangler.base.jsonc) 指向独立 `cinatoken-admin`，对 Proxy 使用 service binding；CHAIN_JOBS 是 producer，不可把它误称为这里的 consumer。
- [Compose 示例](../../../docker/examples/gateway.compose.yml) 将 Proxy 和 Admin 分成两个服务 / 进程，但没有给出内存资源上限；不能按两个独立进程就忽略宿主机总量。[Proxy Dockerfile](../../../Dockerfile.proxy) 仍以 Node 22 Alpine 为基线，本机 Node 24 Windows 样本不等价。
- `startNodeServer` 没有接入 SIGTERM / SIGINT 停止准入、连接排空和后台 drain 的优雅停机流程。测量 fixture 自己的关闭流程只保证测试收尾，不代表生产 host 已修复。

## 3. 有限接续顺序（保持 C02.B2.2）

1. **运行配置冻结**：C01.9 / C01.10 确认首发运行时、HTTP / Realtime、模态、是否启用 Cron / Queue、请求与响应大小合同、延迟 / 可用性目标、同机服务和安全余量。本清单列出真实候选消费者，但没有代用户选择禁用能力或新增部署。
2. **同配置完成测量矩阵**：当前 6 组完整 Images Node 样本已具备；补合法短键累计、SSE、慢上传 / 慢读取、错误与持续拒绝负载、非空 Guardrail / 默认参数、混合模态、真实驱动 / host 缓冲；给出重复测量和波动，不以单次最大值作为硬上界。Node 22 / Workers 各自验收。
3. **所有权与恢复闭环**：跨消费者共池或明确隔离，补 Node host 停机、Workers 取消期限、数据库提交确认丢失 / 重启恢复；不以 TTL 强行归还未结束任务，不以重复推理补账。
4. **由证据计算预算再接入**：逻辑字节预留必须包含运行时基线、不同工作集并存、GC 与传输 / DB 余量；如果现有 50 / 20 / 32 MiB 合同不能安全支持，应明确报告并请求范围决定，不静默降额。生产启用、部署或真实服务验证须另有授权。

目前完成消费者源码清单、有限的 Images 本地测量、真实 Workers 入站和私有合成成功链路子集；尚未覆盖全部工作负载、同实例完整容量及恢复，没有宣布整个实例安全。

2026-09-07 接续：[真实 Workers 大包 / 交付子集 10/10 通过](./implementation-evidence/C02-staging-image-large.md)。50 MiB 参考图 JSON 和完整 50 MiB multipart 真正到达私有上游，配合大响应输出完成独立散列核对；客户端暂停读取和头部到达后取消已有样本，六条零价日志到达 D1。仍未测同 isolate 峰值、并发混合消费者或后台确认丢失恢复，也未验证上游在途取消。容量池未启用；下一项仍为 C02.B2.2 的慢上传 / 在途取消与后台恢复。

前一批接续：[在途取消 / 后台记账子集最终 9/9 通过](./implementation-evidence/C02-staging-image-cancellation.md)。入口提前注册 waitUntil，普通 Images 生成 / 编辑补已 dispatch 取消的尝试事实；真实 Workers 小 JSON 的头部前 / 正文中取消得到私有上游终态确认，四条用量与四条尝试记录到达 D1。两次失败过程保留；取消后的成功对照不等于进程重启恢复。私有上游现有唯一 PROBE_DB 指向 staging D1，仅做有界、按所有权匹配的观察写入；不把 service binding 当作物理内存隔离。容量池仍未启用。下一项保持 C02.B2.2：后台延迟 / 确认丢失 / 平台期限恢复，余下大包、edits / SSE 在途取消和超时，然后完整工作集 / 混合并发。

前一批云端接续：[D1 提交边界观察 9/9，恢复未通过](./implementation-evidence/C02-staging-image-storage.md)。客户端 5 次成功、实际 4 条日志，提交前失败缺少耐久重试输入；提交后 ACK 丢失仍有真实记录。后台暂停在客户端 EOF 后由外部 CAS 释放，不构成容量 lease、同 isolate 内存或重启证明。下一项仍 C02.B2.2，按 [恢复合同草案](./image-usage-recovery-boundary.md) 固定本地状态/幂等回查与独立消费者约束；后续恢复消费者也须纳入容量矩阵。现有临时探针行不是生产意图账本，不能拿来补账；生产容量池继续关闭，全部模态 / 混合消费者与平台终止恢复门禁保持。

本地接续：[request/attempt 耐久意图与 CAS 基础](./implementation-evidence/C02-dispatch-intent-local.md) 已有 19 项测试和三项子进程退出样本。只有本地仓储/SQL 草案，没有运行中的恢复消费者、路由接入或新资源，因此不在矩阵中冒记一个已验收的后台服务。下一步不可变结算输入/原子回执与独立恢复执行仍要核算工作集；过期分类不是物理容量归还，也不是财务终态。Cloudflare 平台期限/重启与混合消费者门禁不变。

本地接续（v1.50）：[不可变结算输入 / 原子回执](./implementation-evidence/C02-usage-settlement-local.md) 已覆盖单事件恢复、提交丢确认、重复消费和子进程重启。尚无独立运行的消费者，不能据此新增已验收服务行；下一步需为扫描/领取/重试和单事件解析、摘要、账务 batch、回查分别核算持有期与并发。256 KiB 是每份 JSON 的上限，不是内存 lease 大小；规范化对象、UTF-8 编码、SQL 参数与运行时额外副本仍要测量。原请求结果在持久化前丢失仍是 unknown，不能通过重新推理补事实。

本地接续（v1.51）：[有界恢复执行器](./implementation-evidence/C02-usage-recovery-consumer-local.md) 已实现独立单批扫描、领取/退避及容量持有，但无 Worker/Cron/Queue 入口或远端配置，不是已部署服务。显式预留须覆盖扫描引用、单事件解析/摘要、SQL 参数和回查；测试 1,024 字节只验证数字计数，不是工作集估计。同 isolate 启用时须共用实例总池或证明隔离，不能给 HTTP 和恢复各自重复分配全额预算。租约/准入窗口到期不释放仍在等待 D1 的资源；32 项本地测试不替代 Workers 容量验收。下一步可信生产者/普通 Images 交付持久化断点与受保护触发入口。

本地接续（v1.52）：[Images 生产者 / 交付前持久化](./implementation-evidence/C02-image-recovery-producer-local.md) 已显式接入普通路由但默认关闭；确认快照及恢复任务后才允许成功交付，后台快路径只接收有界引用。新增 44 项测试，尚无路由进程终止/真实 Workers 恢复与新工作集证据；SSE、非空预算组合、受保护触发消费者和跨事件容量继续验收。新增定价/快照复制、摘要、D1 预检及持有中的图片响应均须计入预算，256 KiB 载荷限额不是内存上界。生产/云端未启用，SQL 保留 proposals，US$2 不重置。

本地接续（v1.53）：[真实 Images 路由进程退出与组合](./implementation-evidence/C02-image-recovery-restart-local.md) 新增 44 项测试，其中 24 项由新进程独立扫描恢复；无快照不生成用量，不能重发推理。修复原型删除 origin 连带清空 BYOK 财务标记的问题，保留完整 USD/BYOK 计费快照并冻结凭据引用。新的 origin/元数据持有也纳入后续工作集；本地进程退出不证明 Workers 终止或网络交付语义。受保护触发入口尚未实现，恢复路径/容量池均未启用，C02.G 未过，US$2 不重置。

本地接续（v1.54）：[私有恢复 RPC / 独立 host](./implementation-evidence/C02-image-recovery-trigger-local.md) 新增 60 项测试；单次有界入口提前登记 waitUntil，实例级 busy 拒绝不排队，完整 D1 Promise 结束才归还数值池，不同实例通过 D1 fencing 协调。独立 Worker 配置仅 staging D1，HTTP 拒绝、开关禁用、容量值 0；测试的 1,024/2,048 字节不是工作集估计。受保护控制调用方、真实 RPC 授权/调用方终止、数据库身份/SQL 定义重验及实验容量配置是下一步；离线打包不替代 Workers 物理容量/恢复验收。无部署、生产池仍关闭，C02.G 未过，首轮 US$2 不重置。

本地接续（v1.55）：[恢复控制入口](./implementation-evidence/C02-image-recovery-control-local.md) 新增 60 项控制/Images 与 27 项配置测试。控制实例只有标量 busy gate；登记 waitUntil 后无参调用私有恢复 RPC，取消/禁用不能提前释放在途 RPC；不建立等待队列或自动重试。它不是跨实例限流器，也没有解决 RPC 反序列化/平台传输的物理容量。控制包 4,836 字节只证明离线代码大小，不是运行时内存。双配置禁用、无新云调用；专用 Access 策略、SQL 定义真实性、显式实验容量和真实 Workers 验收继续未完成，首轮累计 US$2 不重置。

本地接续（v1.56）：[schema/source artifact 核验](./implementation-evidence/C02-image-recovery-schema-local.md) 新增 67 项测试；独立消费者在取得容量之后读取 24 个对象的实际定义，25 行/每条 SQL 4,096 字节限额在查询端执行，实际匹配文本合计 10,072 字节。哈希、文本表示和传输开销必须纳入后续实验工作集，不能拿该文本长度替代实例内存；取消/运行窗口到期不提前释放在途读取。生产者三处重验增加有界工作，没有启用实测容量值。仅本地定义一致性通过，不证明全库数据/回填、远端 schema 或并发 DDL 安全；双配置关闭，首轮累计 US$2 不重置。

最新本地接续（Checklist v1.84）：[Images SSE 结果不明与重试安全合同](./implementation-evidence/C02-images-sse-outcome-contract.md)。已补齐 Images SSE 流内错误的 retry_safe=false、按场景的 outcome_unknown 及可信网关 request_id；不透传供应商重试元数据，修复 deadline 重复追加 error/DONE，不改变原有金额/预算算法，正常完成保持原状。新增 50 项专项，完整版本化 staging 本地链 754/754、另行 driver/生命周期回归 508/508 与两项类型检查通过。源码未部署；SSE 耐久恢复、真实交付与整实例物理容量未验收。最近远端功能验证仍为 v1.77，累计公开 HTTP 263，模型/KMS 0，首轮累计新增 US$2 上限不重置，最终云账单未核验。下一项为冻结 staging 候选并核对隔离/预算，再进行真实 SSE wire、取消/超时和 D1 结算验收。C02.B2.2 / C02.G 保持开放。
