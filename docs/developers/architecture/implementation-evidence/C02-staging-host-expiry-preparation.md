# C02.B2.2 — waitUntil 平台期限取消的候选准备

2026-09-07；Checklist v1.72。**固定超窗探针、20 项新测试、类型检查及离线候选已完成；尚未部署，不能标为真实平台期限取消通过。** 上一轮云端结果仍为 [v1.71 成功响应未交付后的原生终止恢复](./C02-staging-undelivered-recovery.md)。C02.G 与完整物理容量保持开放。

[机器可核验记录](./C02-staging-host-expiry-preparation-results.json) 锁定本轮 103 个源码、操作产物和前序证据。新增 5 个文件，修改 2 个仅供 staging 的共享工厂/探针文件；96 个原基线源码未变。未改生产运行时代码、财务规则、SQL 草案、依赖或生产配置。

## 为什么这项不能由 ctx.abort 代替

之前已证实主动原生终止后可补账与去重，但平台自行耗尽后台持有期限是另一个执行路径。当前 [Cloudflare 生命周期说明](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil) 规定：HTTP 响应结束或客户端断开后，waitUntil 后台工作可再执行至多 30 秒，同一请求的多个 waitUntil 共用窗口；它不是整个 HTTP 请求的墙钟时限。平台取消未结束工作时会记录专门警告。

因此，下一轮必须将成功响应 EOF、耐久暂停标记、平台取消警告和财务状态组合核验。只等足时间、没有日志、HTTP 200、普通异常、Node mock 或 ctx.abort 都不能单独证明此门禁。

## 固定实验合同

1. 新入口 images-host-expiry-gateway.ts 使用真实共同 Worker handler、鉴权、预算、私有 Images transport、耐久快照和记账 batch。生产者租约固定 5 秒，仅为实验参数，不是生产建议。
2. 服务端显式选择 storageFaultProfile=wait-until-expiry；没有 HTTP/环境变量可设置等待时长。带探针的请求仅允许 POST generations / edits，且 mode 为 before-release 或 after-release。其他探针模式/路径拒绝；无探针请求继续原链路。
3. 精确匹配请求日志 INSERT 的 user/key/workspace，以及本轮拥有的 armed 探针行后，先以原 CAS 认领。未 armed、描述/所有权改变或跨租户都不能开启暂停。
4. 提交前写入 awaiting-host-expiry-before-commit；提交后必须先真实完成原 batch，再写入 awaiting-host-expiry-after-commit。每个请求只注入一次，绝不伪造数据库返回结果。
5. 在该耐久标记之后，只等待一个固定 45,000 ms 的定时器，不轮询 D1、不接收 release、不调用 ctx.abort、不修改原生 context。保持原有成功响应交付及后台 waitUntil 所有权。
6. 如果定时器仍能执行，CAS 写入 host-expiry-not-observed 并抛出 C02_D1_FAULT_HOST_EXPIRY_NOT_OBSERVED；**这必须算实验失败**。提交前兜底不补提交原 batch，提交后不再提交；所有权已改变则保留 CAS 错误而不覆盖他人状态。
7. 45 秒是标记后的固定兜底调度，不保证操作系统精确墙钟上限。平台的后台窗口从响应结束/断开计算，线上必须读取成功响应至 EOF，不能因未结束响应而无限延长调用。

旧的默认 profile、20/40 次有界轮询、before-fence、普通错误与主动 native abort 路径保持原合同。变更未启用到生产、默认 staging 入口或当前云端版本。

## 本地验证

新增 **20/20**：

- 12 项数据库 facade 测试：提交前/后分别验证精确 armed、一开始未 armed、跨租户、描述不同、暂停期间 release、暂停期间所有权变更；44,999 ms 不完成，45,000 ms 才进入失败兜底；不调用 native abort；已用 facade 不重复注入，新 facade 不能重新认领旧标记。
- 2 项配置/入口测试：仅服务端固定 profile 可用；不兼容租约、任意 profile/时长、主动 abort/fence/fail 模式与其他路径拒绝；候选配置仅改变 main，继续强制 staging 隔离和关闭入口。
- 6 项真实路由＋SQLite：generations / edits 各覆盖普通、提交前暂停、提交后暂停。成功 JSON 已完整读取时，真实后台持有任务仍未结束；每请求只推理一次，接受意图/快照各一份，提交前 leased revision 1、提交后 committed revision 2；费用与预留对应真实提交状态。
- Mock 定时器走到 45 秒后，明确得到 host-expiry-not-observed。提交前因此进入普通 caught-error 的 pending / execution_error，提交后保持 committed，快照摘要/记录时间不变。**这些终态不是平台取消留下的 leased 证据。**

完整 staging 回归 **508/508**（既有 488 + 新增 20），无失败、跳过或取消；定向 staging 类型检查退出 0。没有修改 package.json，新测试在本轮明确追加。原有普通探针、主动终止、fencing 和成功响应拦截测试均随整链重跑。

采用 Workers 最佳实践与 Wrangler 技能，核对当前类型 5.20260907.1 和安装的 Wrangler 4.127.1；生成候选绑定类型、types --check 通过，9 项绑定字段与既有生成的 staging 类型完全相同。离线 deploy --dry-run 通过，输出 3,804,198 字节（3715.04 KiB / gzip 669.60 KiB），不是实际上传或平台内存测量。Wrangler 提示有新版本，本轮未升级。

## 云端、费用与已锁定候选

候选配置位于 .wrangler/staging/images-host-expiry-v172/wrangler.jsonc；仍指向 cinatoken-proxy-staging、独立 cinatoken-staging D1 和私有 Images 上游，workers.dev/previews 关闭，routes 为空，没有恢复 RPC 或真实模型/KMS 能力扩张。

本轮 **0 次云端测试 HTTP、0 次模型/KMS 调用、0 次部署、0 次云端配置/数据写入**。未新建测试身份或样本。最后云端已核验状态来自 v1.71，而不是本轮重新读取：Gateway 10155c73-f327-4711-bb40-db4c2b49b6db、消费者 e386f210-43a8-4b03-b91e-f179cadf8354，入口关闭、Access deny-all、样本已清理。

首轮累计公开测试 HTTP 仍为 **202**，累计新增 **US$2** 上限不重置；最终增量账单未核验。此轮离线准备不代表新权限已通过真实 KMS 调用验证。

## 下一项明确顺序

1. 基于本轮新源码摘要检查实际工作树与候选，重新读取云端版本/设置/Access/入口、完整 schema/56 表计数和生产只读指纹。旧 v1.71 源码清单的两个 staging 摘要已成为历史，不能跳过差异校验或直接重跑旧发布脚本。
2. 仅发布本候选到既有隔离 Gateway；确认绑定/完整设置和关闭入口状态，其他三个 Worker 不重新部署。
3. 建立限定 tail 与临时服务身份，验证无凭据及错误令牌拒绝，再分别发送四个小请求，各一次，完整读取成功响应并记录 EOF 时间。不主动 abort、不 release、不修改数据库时间。
4. 在有界观察期内，要求平台的 waitUntil 取消警告与准确请求探针、操作、部署版本匹配；耐久标记仍停在 awaiting-host-expiry-*，且提交前 leased / last_error=null，提交后已 committed。探针不得主动输出该平台警告；普通错误或兜底均不能通过。若真实平台警告形式有差异，保留结果并核验来源，不能降级成“等够时间即成功”。
5. 待未提交租约自然到期，由独立消费者只补两笔提交前账务；重复 RPC 对比全部 12 组投影、快照与每请求日志/回执/attempt/审计各一次，不再发送 Images。
6. 关闭入口、撤销临时身份，确认无在途执行后精确清理并复核全部基线。登记这一个平台期限子集后，继续其他故障组合、最大快照及跨消费者完整物理容量。

整实例回收、全模态/消费者、端到端 exactly-once、请求幂等/退款政策和生产 SLO 均未由本轮完成。无快照不重建用量，不按 TTL 自动退款，生产容量保持未启用，C02.G 保持开放。
