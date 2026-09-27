# C02.B2.2 — 成功响应未交付的 staging 入口准备

2026-09-07；Checklist v1.70。**新增固定、有界、显式选择的 staging 响应拦截入口，完成本地验证与离线候选。尚未部署，不能标为线上 client-unknown 验收通过。** 上一轮真实平台结果仍是 [v1.69 部分响应断线](./C02-staging-partial-delivery.md)。C02.G、其他 host 中断与完整物理容量保持开放。

[机器可核验结果](./C02-staging-undelivered-preparation-results.json) 锁定 98 个源码文件、新候选配置/绑定类型/打包输出，以及本轮完整回归产物。原有 93 个源码与 v1.69 的 23 个操作产物均未改变；新增 5 个文件，不修改现有生产/默认 staging 入口、财务算法或 SQL 草案。

## 为什么需要独立入口

原生终止探针位于真实记账 batch 前后，既有网关可能已经将 HTTP 200 响应返回给 Workers 平台。仅暂停客户端读取不能证明服务端没有交付成功响应头；v1.69 已诚实限制为“客户端未读取完整响应”。

新入口在服务端持有原有成功 Response，不返回它，便于下一轮区分：

- 真实用量已经耐久保存，但客户端未得到成功结果。
- 是否已经提交原有记账 batch。
- 客户端可能得到平台错误响应，也可能只有传输错误；不能把前者称作“没有任何 HTTP 响应头”。

这只是受控故障实验，不是新的生产响应策略、退款条件或自动重试规则。

## 固定机制与安全边界

1. 仍由 createImagesFencingGateway 组成真实公开路由、鉴权、预算、private Images transport、耐久快照、账务和原生终止探针。生产者 5 秒租约是既有实验配置，不是生产推荐值。
2. 只匹配 POST /v1/images/generations 或 edits，且解析为 before-abort / after-abort 的既有有限探针合同。鉴权、精确租户 armed 行、D1 类型和 native abort 能力检查仍由原网关执行；响应拦截不授予这些能力。
3. 在分发前同步注册额外 waitUntil，保持原生 context 接收者。没有全局可变请求数据、客户端可选超时、增加上游请求、重建财务事实或读取完整响应。
4. 原网关非 200 响应保持同一对象及状态；普通请求、错误探针、其他模式或路径不经过此额外拦截。scheduled/queue 处理器沿用原工厂。
5. 对匹配场景的 HTTP 200，成功 Response 永不返回。固定额外等待 10 秒，预期真实 ctx.abort 在这期间终止上下文；没有重写或模拟 native abort。
6. 若原生终止未发生，10 秒后注册原响应体取消工作，并返回 503 / C02_STAGING_DELIVERY_GATE_EXPIRED，Cache-Control:no-store。它不带成功响应的生成 ID 或上游 ID，**该标记必须判定实验失败**，不是原生终止证据。取消 Promise 由独立 host hold 跟踪，不通过排空响应来释放。
7. 门禁是成功 Response 就绪后的固定额外持有窗口，不替代原有请求 deadline，也不保证操作系统的精确墙钟调度时间。

新增配置构造函数只更换 main，其他字段与已核验的 fencing staging 配置完全一致。workers.dev=false、preview_urls=false、routes=[]、无新增 crons；仍只绑定独立 staging D1 和私有模拟上游。没有恢复 RPC binding、真实模型或 KMS 能力扩张。

## 验证与失败记录

新增 **15/15**：

- 9 项单元/配置测试：生成/编辑 × 提交前/后四组合均不能泄漏成功响应；10 秒前不返回、到期只返回失败标记；不读成功响应体；普通和错误响应保持；原拒绝传播；两个并发请求不互相释放；配置仅改 main 并拒绝复用生产名称。
- 6 项真实路由＋SQLite 集成：两种操作分别覆盖 normal、before-abort、after-abort；真实小请求上游调用恰好一次，意图与快照各一份。正常控制分别提交一次。
- 集成测试刻意使用会返回的 abort shim，验证它不能冒充平台终止：原生能力调用被记录，但拦截入口到期只能返回 503。提交前 shim 错误进入 pending / execution_error；提交后真实账务已提交。**这些 Node 状态不是真实原生 leased 终止证据。** 下一轮线上必须另查 native exception 和耐久状态。
- 首次集成 6 项失败、单元 9 项通过：测试夹具的合成 secret 少于现有要求的 32 字符，真实路由在准入阶段返回 500，未到达 abort。补足合成材料长度后通过，未放宽生产 secret 校验。另一次单用例诊断失败记录保留。
- 完整既有 staging 链 465，加 v1.69 的 5 项、新增 15 项，**485/485**；无失败、跳过或取消。定向 staging 类型检查退出 0。新文件由本轮显式回归命令追加，未修改 package.json。
- Wrangler 4.127.1 类型生成与 --check 通过，当前 Workers 类型 5.20260907.1 已核对。只做 deploy --dry-run；离线输出 3,804,238 字节（3715.08 KiB / gzip 669.62 KiB），不是实际上传或平台内存测量。
- 首次 dry-run 的相对 outdir 被按配置目录解析；使用绝对 outdir 重新生成固定候选目录。版本查询曾出现默认日志目录写权限提示，后续将日志写入工作区。没有安装依赖或更改 Windows 系统权限。

按照 Workers 最佳实践和 Wrangler 技能，保留流式 Response 所有权、提前持有、固定有界实验和生成绑定类型。参考 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) 与 [Wrangler 命令](https://developers.cloudflare.com/workers/wrangler/commands/)；没有把 Node 模拟器结果扩大为 Workers 终止证明。

## 线上与费用状态

本轮 **0 次 staging 公开 HTTP、0 次模型/KMS 调用、0 次云端配置/数据写入、0 次部署**。没有新建令牌或测试租户，无需云端清理。仅查询官方 npm 版本和官方文档。

线上最后已核验状态引用 v1.69，而非本轮重新读取：四个 Worker 入口关闭，Access deny-all，测试身份/样本已清理；Gateway 仍为 2f3d3d28-08aa-4a5f-a84d-5f3e5001a4a1，消费者为 e386f210-43a8-4b03-b91e-f179cadf8354。本地新增文件不代表这些部署已改变。

首轮累计公开测试 HTTP 仍为 190；累计新增 US$2 上限不重置，最终增量账单仍未核验。合成账本金额不是实际账单。

## 下一项明确验收顺序

1. 重新核对源码/离线产物摘要、实际 staging 版本/绑定、Access、全 schema/表计数及生产只读设置指纹；保持入口关闭，确认无其他在途实验。
2. 只将此候选发布到既有独立 staging Gateway，不改消费者、schema、生产或其他应用。部署成功后重新核对精确版本和绑定。
3. 通过临时 Access 服务身份，发送生成/编辑 × before-abort/after-abort 四个小合成请求，各只发送一次。成功 200 或本工具的 gate-expired 503 都不能算通过；平台错误与传输错误分别记录，不谎称两者都没有响应头。
4. 以每请求精确探针和 tail native exception 关联真实 request ID，不依赖未交付的 X-Generation-Id。核对接受快照、原生终止、自然到期租约和提交前后账务，拒绝以 returning shim / ordinary caught error 替代。
5. 独立恢复提交前缺失账务，再重复恢复，核验日志/回执/费用审计各一次、快照不变、12 组投影不变；不重发 Images，不按 TTL 退款。
6. 完整撤销临时访问并清理精确样本，复核所有基线，再登记这一个平台子集结果。其后继续其他 host 中断、故障组合、最大快照与跨消费者完整容量；C01.6/C05 的幂等/退款政策仍需既定决策门禁。

即使后续实验成功，也只证明“未交付成功结果”的受控上下文终止恢复，不自动证明整实例回收、所有断网时序、客户端没有收到任何 HTTP 头或端到端 exactly-once 推理。
