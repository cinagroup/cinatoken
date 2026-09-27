# HTTP 容量准入与工作所有权合同（本地、显式启用）

2026-09-06，C02.B2.2 的基础合同。实现入口为 [ProxyAppOptions.httpCapacity](../../../packages/proxy/src/app.ts)，默认不传；当前 Workers / Node 生产工厂均未启用。这里没有可直接复制到生产的容量推荐数值。Images 属性名 256 UTF-16 单元、规范化 raw_usage 64 KiB 限额仍按 [User API](../api/user.md#json-属性名与上游-usage-审计上限) 执行，与此开关独立。

## 1. 准入单位与范围

2026-09-08 增补：`createWorkerApp` / `createWorkerHandler` 已接通显式 `httpCapacity` 参数，生产调用处仍不传入。耐久 Images SSE 的快照前/后及财务 ACK 持有期见 [v1.104 本地证据](./implementation-evidence/C02-images-sse-capacity-ownership.md)。这不增加默认容量，不覆盖 scheduled / Queue，也不证明原生平台取消会运行 finally。

[容量池](../../../packages/proxy/src/services/request-capacity.ts) 同时约束 `maxRequests` 与 `maxReservedBytes`。创建池时捕获正安全整数配置；请求同步申请，无等待队列，达到任一上限即拒绝，不存在先检查、跨 await 再增加计数的窗口。字节数是**逻辑工作集预留**，不是实时堆测量、实际已分配字节数或费用预算。

启用 [HTTP 中间件](../../../packages/proxy/src/middleware/request-capacity.ts) 时，必须传入共享池和 `reservedBytesPerRequest`。所有 HTTP 方法、已知/未知路径、别名、健康检查、目录查询、OPTIONS 都收取同一固定的最坏情况预留，不从 Content-Length、model、租户、请求头或路由推导更小额度。配置大于整池或非法时，在创建应用时拒绝。一个运行实例中的多个 HTTP 应用必须显式共用同一池；不能每次请求创建一个池，也不能把进程/isolate 内计数声称为跨实例全局配额。

准入位于上传包装/读取、存储初始化、鉴权、Guardrail、选路和财务变更之前。拒绝不读取正文、不排队、不调用后续应用链；返回 503、`gateway.capacity_unavailable`、固定脱敏消息与 `Cache-Control: no-store`。沿用 Chat / Anthropic 错误外观，并显式提供 CORS 错误头；不猜测恢复时刻，故不添加 Retry-After。

**当前配置是 HTTP-only。** 任何 Upgrade 请求头（包括空值）或 Node Realtime 调度 binding 均在应用链前返回同一 503，不允许通过协议头绕过池。普通 SSE 仍是 HTTP 流，受同一占用合同约束。这不是对 WebSocket 的容量支持；生产默认未启用，既有 Realtime 行为不因本增量改变。

## 2. 一次预留、多个独立持有者

每个请求仅收取一次 `requests=1` 和一次 `reservedBytesPerRequest`，持有者增加不会重复收取。全部持有者释放后才归还整个预留，不在流/usage 可用时提前下调为未经验证的小额度。

| 持有者 | 获得所有权 | 归还条件 |
| --- | --- | --- |
| 入口处理 | 同步准入成功 | 整个中间件/路由处理链完成，包含已有入口生命周期登记的准备写入；客户端 abort 不等于完成 |
| 响应正文 | 处理链返回后、入口持有者释放前 | 观察到 EOF、读取错误，或取消清理 Promise 终态；HTTP 返回 headers 不等于完成 |
| 后台记账及其他受管任务 | `scheduleBackgroundWork` 同步登记时 | 传入的任务 Promise 成功或失败终态；不是 usage 数据到达，也不是客户端读完 |
| 取消清理 | 发起正文取消时、正文持有者仍有效 | 生产者的 cancel Promise 成功或失败终态；不以“已发出取消”替代终态 |

[响应适配器](../../../packages/proxy/src/services/capacity-response-body.ts) 不 clone/tee、不预读、不拼接完整正文，使用零预取水位按需转发原 chunk。客户端取消/abort 立即停止交付；异步取消清理通过现有受管后台通道观察，额度保留至其终态。HEAD 因 Hono 会丢弃 GET 正文，显式取消该正文，避免永远等不到消费者 EOF。无正文响应无需正文持有者；注册的后台任务仍独立保留。

[后台调度](../../../packages/proxy/src/runtime/schedule-background-work.ts) 保留原有 Workers `waitUntil` / Node 受管 Promise 集合语义，增加同一 lease 的持有。重复释放幂等；仍有持有者时可以交接后续清理，全部归还后禁止复活旧 lease。调用者仍需在受管工作链内同步登记；已脱离全部所有权的定时器/任务不能凭旧 Context 重新启动工作。现有调用接受已启动的 Promise，非法晚登记会观察其 rejection 并抛错，**无法撤销已经发生的副作用**。

容量池本身只保存数字，不登记请求、凭据、正文或 Promise。Node 原有后台 Promise 集合没有因此变成跨运行实例的池。

## 3. 不可据此推断的保证

- EOF 是应用读取器终态，不是网络发送确认；release 也不是垃圾回收、物理内存下降或数据库提交证明。
- 生产者若提前结束 Promise 却保留其他资源，该资源不会被本计数器自动发现；数据库驱动、SDK 内部缓冲、悬空任务必须另行核对。拒绝的 cancel Promise 同样不是物理资源清理成功证明。
- 永不结束的清理或记账会继续占用额度，可能使实例持续拒绝新请求。这是保守不归还，不是恢复方案；不能增加 TTL 自动释放来掩盖未结束的工作。
- Workers 的后台执行有平台期限，Promise 可能被平台取消；本地计数器不保证 finally 必定执行，也不是持久化账本或可靠队列。参见 [官方 waitUntil 生命周期](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)。不能据此放宽真实记账/恢复门禁。
- 当前工厂未配置此策略；启用测试只证明入口集成和逻辑所有权，不证明每种模态的实际最坏工作集已被覆盖。

## 4. 启用前有限顺序

1. **补齐消费者清单和关闭条件。** 同实例 HTTP/SSE、multipart 内嵌 JSON、默认参数、其他模态、后台任务，以及单独的 Admin、Realtime host/session、Cron、Queue，明确哪些共享物理预算、哪些独立部署。未接入消费者不能仅靠启用 HTTP 开关宣告安全。
2. **测量选定运行时的完整工作集。** 覆盖 50 MiB 入口、20 MiB 单文件、32 MiB 普通上游、Unicode/替换膨胀、合法短键累计、慢读/不读、并发上传与后台写入、错误响应与拒绝洪峰；包括运行时基线、网络/数据库缓冲、GC 余量。现有字段限额和历史 Node 局部测量不能代替此步骤。
3. **冻结运行配置。** 在 C01.9/C01.10 确认首发运行时、协议/模态、服务目标与余量；由证据推导池预算与固定预留。无法安全支持的入口明确拒绝或另行授权分流，不悄悄降低已承诺的请求容量，也不自动引入第二云服务。
4. **接入 host 生命周期与故障恢复，再开启。** 补 Node 传输缓冲/优雅停机、真实 Workers 取消期限、数据库提交确认/恢复和未结束任务策略；重跑共享池跨消费者并发、拒绝无出站/无账务、停机/异常清理验收。启用、部署、真实 KMS/DB 或云资源操作另行确认。

基础 [实现与验证证据](./implementation-evidence/C02-http-capacity-ownership.md) 保留。接续新增 [消费者 / 关闭条件矩阵](./runtime-capacity-consumers.md) 和 [6 组完整 Images Node 工作集测量](./implementation-evidence/C02-runtime-capacity-validation.md)；这些是合成 DB 确认边界下的本地样本，不是生产权重、Node 22 / Workers 或整个实例验收。C02 仍为 DOING，C02.G 未通过。

正式验收方向后续确定为 **Workers 首发优先、Node 备选**，见 [最新决定 / 原生启动诊断](./implementation-evidence/C02-workers-first-runtime.md)。本机运行库修复需另行授权；不能将备用 Node 测试升级为 Workers 容量验收。

随后用户确认采用与生产资源隔离的 **独立 staging**，首轮累计新增费用上限为 US$2。现已完成独立 Worker/D1 初始化及 [8 项受保护 HTTP 基础冒烟](./implementation-evidence/C02-staging-access-smoke.md)，Access 权限阻塞已解除；测试后入口关闭、临时令牌删除。容量与恢复门禁仍未通过，继续按 [staging 有限顺序](../../operators/deployment/cloudflare-staging.md#3-云端有限顺序) 推进，不再将本机修复作为云端验收的必经门禁。这里没有启用容量池或降低上述完整工作集要求。

2026-09-07：[21 项真实 Workers Images 入站阶段检查通过](./implementation-evidence/C02-staging-image-ingress.md)，验证 50 MiB 总包 / 20 MiB 单文件及控制字段限额，仍未接入容量池或模拟上游。合法入站以 model_not_found 作为解析到模型查找的标记，不是成功推理、并发、同实例内存/恢复或后台所有权证明；US$2 累计上限不重置，测试后入口与临时凭据/数据均已回收。

同日后续：[11 项私有 Images 链路检查通过](./implementation-evidence/C02-staging-image-chain.md)，完整网关接入私有 service binding，普通生成 / 编辑、32 MiB 响应及替换膨胀成功，7 条零价用量日志实际落入 D1。50 MiB padding 入站后只转发 61 字节，20 MiB 文件实收到上游；这不是最大输入 / 输出组合验收。容量池仍未接入，D1 落库不是后台延迟持有 / 提交确认丢失恢复证明；慢读、取消、并发、同 isolate 内存和混合消费者门禁保持。生产配置未变，首轮累计 US$2 不重置，全部尝试已关闭入口并清理本次凭据 / 数据。

同日再接续：[10 项真实 Workers 大包转发 / 交付检查通过](./implementation-evidence/C02-staging-image-large.md)。实际转发的 50 MiB 参考图 JSON 与完整三文件 multipart 已通过上游完整字节 / SHA-256 校验，并与 32 MiB / 近 96 MiB 输出组合；客户端暂停读取完整交付，读取 1 MiB 后取消仍记录上游成功。后者是在上游处理完成后的交付取消，不是取消传播、后台 lease、付费退款或平台内存门禁。六条零价日志不替代持久化恢复；生产容量池仍关闭，慢上传 / 在途取消、确认丢失、完整图像工作集、并发与混合消费者继续待验收。首轮累计 US$2 不重置，本批收尾均通过。

前一批接续：[真实 Workers 在途取消 / 修复子集最终 9/9 通过](./implementation-evidence/C02-staging-image-cancellation.md)。上游 D1 握手确认头部前 / 正文中取消实际到达，四条用量与四条尝试事实完整；保留两次失败并补入口提前 waitUntil、已出站取消事实。小 JSON 慢上传 / 未完成上传取消及后续成功对照已有样本，仍不是最大工作集、反压或重启恢复证明。私有上游新增唯一 staging D1 观察绑定，Gateway / 生产容量池仍未启用。下一项为后台延迟 / 提交确认丢失 / 平台期限恢复，以及剩余大包、edits / SSE 取消、超时、并发和完整实例容量。首轮累计已记录 89 次 HTTP、模型/KMS 0、US$2 不重置；三轮均完整收尾，生产设置指纹不变。

前一批云端接续：[真实 D1 提交边界观察 9/9 符合预期，恢复门禁未通过](./implementation-evidence/C02-staging-image-storage.md)。5 次客户端成功只有 4 条日志 / 尝试事实，提交前失败未在窗口内恢复；提交后丢确认的记录仍持久化。两种暂停均由响应完成后的外部 CAS 释放，只证明该样本的后台持有，不是容量 lease 或物理内存证明。下一步先做 [持久化恢复合同](./image-usage-recovery-boundary.md) 和本地验证，再衔接最小耐久依赖；不以重复推理、延长 waitUntil 或 TTL 自动释放掩盖缺口。42 项 staging 测试和专项类型检查通过；首轮累计 98 次 HTTP、模型/KMS 0、US$2 不重置。入口关闭、测试数据清理、生产设置不变，C02.G 与容量池状态不变。

本地接续：[耐久出站意图基础 19/19 通过](./implementation-evidence/C02-dispatch-intent-local.md)，包含三项子进程退出；42 项 staging 回归和两项定向类型检查通过。SQL 草案不进入自动迁移，没有路由或容量池接入，也未持久化完整结算输入。下一步补不可变输入与原子回执，再接独立恢复执行；意图过期分类不释放预算/容量，不重试推理。完整 Core 类型检查 32 条诊断仍在，不以定向通过替代。本轮无云端操作，C02.G 和首轮 US$2 状态保持。

本地接续（v1.50）：[有界结算输入 / 原子回执](./implementation-evidence/C02-usage-settlement-local.md) 新增 37 项测试，含八项子进程退出；意图 19、预算 33、Images staging 42 项回归及定向类型检查通过。单份 JSON ≤256 KiB 仅约束序列化载荷，不证明完整 Worker 工作集或消费者并发容量。已有单事件重放入口，没有调度扫描/领取/退避和路由接入；下一步补这些边界并纳入容量矩阵，之后云端验收。正式迁移仍 68 份，C02.G 未过、生产容量关闭、US$2 不重置。

本地接续（v1.51）：[有界独立恢复执行器](./implementation-evidence/C02-usage-recovery-consumer-local.md) 新增 32 项测试（六项子进程退出）。先获取显式容量再扫描有界引用，全部已启动 D1 Promise 结束后归还；单个消费者异常也等待其他在途任务。运行窗口只停止新准入，数据库租约只约束写入所有权，均不是硬取消或物理内存回收。尚无实测生产预留、部署入口或跨消费者工作集证据，生产容量池保持关闭。下一步可信生产者/普通 Images 交付持久化断点、受保护触发入口，再回 staging 验收；US$2 不重置。

本地接续（v1.52）：[Images 生产者 / 交付前持久化](./implementation-evidence/C02-image-recovery-producer-local.md) 已显式接入普通路由但默认关闭；确认快照及恢复任务后才允许成功交付，后台快路径只接收有界引用。新增 44 项测试，尚无路由进程终止/真实 Workers 恢复与新工作集证据；SSE、非空预算组合、受保护触发消费者和跨事件容量继续验收。新增定价/快照复制、摘要、D1 预检及持有中的图片响应均须计入预算，256 KiB 载荷限额不是内存上界。生产/云端未启用，SQL 保留 proposals，US$2 不重置。

本地接续（v1.53）：[真实 Images 路由进程退出与组合](./implementation-evidence/C02-image-recovery-restart-local.md) 新增 44 项测试，其中 24 项由新进程独立扫描恢复；无快照不生成用量，不能重发推理。修复原型删除 origin 连带清空 BYOK 财务标记的问题，保留完整 USD/BYOK 计费快照并冻结凭据引用。新的 origin/元数据持有也纳入后续工作集；本地进程退出不证明 Workers 终止或网络交付语义。受保护触发入口尚未实现，恢复路径/容量池均未启用，C02.G 未过，US$2 不重置。

本地接续（v1.54）：[私有恢复 RPC / 独立 host](./implementation-evidence/C02-image-recovery-trigger-local.md) 新增 60 项测试；单次有界入口提前登记 waitUntil，实例级 busy 拒绝不排队，完整 D1 Promise 结束才归还数值池，不同实例通过 D1 fencing 协调。独立 Worker 配置仅 staging D1，HTTP 拒绝、开关禁用、容量值 0；测试的 1,024/2,048 字节不是工作集估计。受保护控制调用方、真实 RPC 授权/调用方终止、数据库身份/SQL 定义重验及实验容量配置是下一步；离线打包不替代 Workers 物理容量/恢复验收。无部署、生产池仍关闭，C02.G 未过，首轮 US$2 不重置。

本地接续（v1.55）：[恢复控制入口](./implementation-evidence/C02-image-recovery-control-local.md) 新增 60 项控制/Images 与 27 项配置测试。控制实例只有标量 busy gate；登记 waitUntil 后无参调用私有恢复 RPC，取消/禁用不能提前释放在途 RPC；不建立等待队列或自动重试。它不是跨实例限流器，也没有解决 RPC 反序列化/平台传输的物理容量。控制包 4,836 字节只证明离线代码大小，不是运行时内存。双配置禁用、无新云调用；专用 Access 策略、SQL 定义真实性、显式实验容量和真实 Workers 验收继续未完成，首轮累计 US$2 不重置。

本地接续（v1.56）：[schema/source artifact 核验](./implementation-evidence/C02-image-recovery-schema-local.md) 新增 67 项测试；独立消费者在取得容量之后读取 24 个对象的实际定义，25 行/每条 SQL 4,096 字节限额在查询端执行，实际匹配文本合计 10,072 字节。哈希、文本表示和传输开销必须纳入后续实验工作集，不能拿该文本长度替代实例内存；取消/运行窗口到期不提前释放在途读取。生产者三处重验增加有界工作，没有启用实测容量值。仅本地定义一致性通过，不证明全库数据/回填、远端 schema 或并发 DDL 安全；双配置关闭，首轮累计 US$2 不重置。

最新本地接续（Checklist v1.84）：[Images SSE 结果不明与重试安全合同](./implementation-evidence/C02-images-sse-outcome-contract.md)。已补齐 Images SSE 流内错误的 retry_safe=false、按场景的 outcome_unknown 及可信网关 request_id；不透传供应商重试元数据，修复 deadline 重复追加 error/DONE，不改变原有金额/预算算法，正常完成保持原状。新增 50 项专项，完整版本化 staging 本地链 754/754、另行 driver/生命周期回归 508/508 与两项类型检查通过。源码未部署；SSE 耐久恢复、真实交付与整实例物理容量未验收。最近远端功能验证仍为 v1.77，累计公开 HTTP 263，模型/KMS 0，首轮累计新增 US$2 上限不重置，最终云账单未核验。下一项为冻结 staging 候选并核对隔离/预算，再进行真实 SSE wire、取消/超时和 D1 结算验收。C02.B2.2 / C02.G 保持开放。
