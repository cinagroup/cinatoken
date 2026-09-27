# C02 — SSE 快照接受边界的可复用故障探针

2026-09-08；Checklist v1.92。状态：LOCAL_PASS。新增专项 26/26、与既有 801 项合并的 827/827、staging 类型检查均通过；失败/取消/跳过均零。不是新的 Workers 云端验收。C02.G 保持开放。

## 实现与边界

新增独立 staging 模块 [images-sse-snapshot-fault.ts](../../../../packages/proxy/scripts/staging/images-sse-snapshot-fault.ts)，将此前测试内部拦截升级为可供后续隔离入口组合的 D1 facade。未修改生产 runtime、默认 streaming、账务政策、schema、依赖或任何已发布 Worker。尚未新增 HTTP 探针入口，不可仅凭 header 文法就把模块接到生产。

匹配当前真实 repository 的完整规范化 SQL，而非宽泛的 INSERT/batch 正则。仅拦截十二参数、合成租户完整身份、generations 操作、合法 attempt/claim/digest 和有界 payload 的单条快照 `.run()`；捕获 request ID 与摘要后，才可能拦截对应五字段完整身份的快照/job `.first()`。原有快照 INSERT 与 enqueue trigger 在同一次原生 SQLite 事务执行，不拆开触发器、不构造成功返回值、不重试 INSERT 或推理。

一次性 `system_config` 记录要求精确 key、description 和旧 value 的 CAS。所有身份/模式在创建 facade 时复制；重复使用、竞争认领、未 armed、归属变更均拒绝实验继续。观测记录只包含探针身份、请求 ID、摘要及阶段，不记录 payload、图片或凭据。普通 batch 解包后完整交给原数据库，外来 statement、目标 INSERT 改走 batch/all/first/raw，以及未实现的 session 路径显式拒绝。

| 固定 profile | 真实拦截点 | 核验结果 |
| --- | --- | --- |
| before-fail | 原生 INSERT 之前 | 无快照/job/账务，保留 dispatched 预算；不重新推理 |
| after-ack-loss | 原生 INSERT 已提交、返回确认之前 | 真实读回确认快照/job；一次成功结算 |
| snapshot-read-fail | INSERT 后，完整身份的快照读回 | SSE 不确定错误；独立消费者读取已有快照后恢复一次 |
| job-read-fail | INSERT 后，完整身份的 job 确认 | 同上；不假造 enqueue 缺失、不改 trigger |
| before-hold | INSERT 之前 | 等待释放时不交付成功 DONE；取消不撤销已验证上游成功事实 |
| after-hold | INSERT 提交后、确认返回前 | 快照/job 已原子存在；取消或确认延迟不导致重复费用 |

hold 固定为最多 80 次读回轮询、每次等待 250 ms，即累计等待 20 秒，另加 D1 查询延迟；不是严格 20 秒墙钟 SLA。只接受精确 `release-requested` 状态，不允许请求指定时长、任意 SQL、native abort 或自选故障代码。未释放时留下 release-timeout，不把普通抛错称为平台终止。

## 测试与真实计时

新增 26 项 [测试](../../../../packages/proxy/scripts/staging/images-sse-snapshot-fault.test.mjs)，使用实际共同 Worker handler、生产路由/driver、真实本地 SQLite 的 68 份正式迁移及三份恢复草案，独立消费者使用未包装的原始数据库。禁止外网 fetch。覆盖六种 profile、INSERT 前后 cancel/abort、独立恢复与重复扫描、完整金额/预算/图片数/尝试数、观察归属变化、不可变输入、跨租户不消费探针、竞争认领、非 run/batch 绕行及 batch 回滚。

两项计时用例没有缩短或 mock 15 秒交付确认计时器：

- before-hold：约 15 秒收到 completed → `gateway.image_settlement_unconfirmed` → DONE；继续等到探针约 20 秒超时后，确认没有快照、没有账务，预算仍保留。专项整个用例约 20.662 秒。
- after-hold：约 15 秒收到同样的不确定错误；生产方仍等待 INSERT 确认时，由独立消费者先完成真实账务，再释放生产方，复核只有一个回执/日志和一次费用。专项整个用例约 15.375 秒。

这里 DONE 是 SSE 结束标记：错误事件中的 `outcome_unknown:true`、`retry_safe:false` 和原 request ID 明确阻止把未知结算当作可安全重试的成功。已验证上游 completed + 真正 DONE 的成功事实并未因交付等待超时而变成退款依据。

Node AbortSignal 在已完成上游结算后不等于客户端 reader.cancel：两种动作分别测试，不能把 Node 中 signal-only 后仍可读取 DONE 的结果当作真实网络断连证据。上一轮 [v1.91 两条真实 Workers 取消对照](./C02-images-sse-completed-window.md)仍是最近云端证据。

初次开发运行因测试合成 secret 少于 32 字符而失败；修正后发现预期错误码漏写 `gateway.` 前缀。只修正夹具和断言，没有为了通过测试改动运行时行为。失败输出保留在任务工具记录；最终可重复专项、合并回归及类型检查见[机器证据](./C02-images-sse-snapshot-probe-results.json)。

新增 CI 仅配置 Node 22/24 的无凭据本地合同测试；本机为 Node 24.14.1，Node 22 和远程 CI 未实跑。Workers best-practices 技能促使本轮分别核对流、持久化和后台任务所有权，并保留本地与真实平台的证据边界。已读取当日 Workers 类型包 5.20260908.1 的 D1 API；参见 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。

## 费用、上线前置条件和剩余门禁

本轮无 Cloudflare 管理/推理、真实模型或 KMS 调用，无云端创建、部署、迁移和删除。首轮公开 HTTP 累计仍为 292（v1.91 历史已核验值），模型/KMS 累计 0；首轮 US$2 不重置，最终增量账单仍未核验。本轮没有重新读取云端状态。

下一步先补专用隔离 gateway 入口及清理合同，再进行云端接受故障矩阵。特别是 before-fail / before-hold 超时会留下只有 intent、无 snapshot/job 的未知结果，不能调用仅允许 committed job 的现有 SSE 清理器，也不能伪造零费用或自动退款；必须保存观察，精确限制合成测试身份、撤销 key、关闭 Access 并经过安全窗口后才清理测试 fixture。该测试清理不能扩展为真实客户未知结算处理策略。

随后继续实际 INSERT 确认故障、15 秒 Workers 交付确认、账务提交中取消、原生平台终止与独立消费者恢复/去重。当前没有证明 host termination、isolate eviction、真实 D1 服务故障或完整物理容量；C02.G、完整 SSE 恢复以及 C03–C20 不因本轮通过而关闭。
