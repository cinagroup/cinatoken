# C02 — SSE 原生任务取消与持久化日志复核

2026-09-08；Checklist v1.100。状态：**STAGING_PARTIAL**。原实时 tail 矩阵失败，未改写为通过；通过独立持久化日志复核了一个 before-INSERT 请求的原生后台任务取消，并完成受守卫的合成夹具清理。after-INSERT、独立恢复与去重本轮未运行，C02.G 不关闭。

## 已执行与结果

只发布一次 v1.98 冻结 staging 候选，未修改生产结算算法、生产配置或数据库 schema。云端网关版本 `4dec9913-db84-4856-8418-3cfee42d8b82`，入口文件 SHA-256 `29ff91ef634ee797fdf2ec71217d3d1efa7ddcbed84dc31f12474b1cddc7bc97`；下载的实际部署内容与冻结字节一致。其他三个 staging Worker 版本及生产配置指纹未变。

| 检查 | 结果及边界 |
| --- | --- |
| 两个临时入口的无凭证、错误凭证、有效凭证 | 六次检查通过；有效控制请求缺少命令头，返回预期 400，未执行恢复 |
| before-INSERT SSE | 收到有效 completed 图片；上游探针确认 completed 和实际 DONE；成功快照停在 held-before-insert，尚无快照、恢复任务、回执或日志 |
| 客户端原生断连 | 待决 HTTP 读取抛出 AbortError；D1 记录原始 Request.signal 已取消，保留取消时的完整 held 值 |
| 原实时 tail 实验 | 仅收到一个 4,564 字节消息，未保留下可通过校验的事件；停止第二个请求；原始实验 FAIL |
| 同请求持久化日志复核 | 原生调用 outcome=canceled，与平台取消警告、响应 200 记录共享请求 ID；版本、请求路径及三个精确探针头匹配；警告比 D1 原生取消晚 30.004 秒 |
| after-INSERT、独立恢复与去重 | NOT_RUN，不从旧实验或本次清理推导通过 |

关联的 Cloudflare 请求 ID 为 `0f3dbeade7c90526e71c0f7d3bb71a9c`；生成请求 ID 为 `gen-ca20398e-b017-4aac-9879-6f0684558080`。成功点仍为用户确认的“有效 completed 图片 + 实际上游 DONE”；后续取消不能撤销这一成功事实。但**成功事实尚未持久化时，现有 intent-only 记录不足以恢复完整账单**，客户 unknown/幂等政策仍是明确缺口。

## 故障诊断与证据边界

原实时校验器只接受 outcome=ok，而本次持久化原生调用为 canceled，存在已证实的兼容性缺口。实时消息被拒绝后，其内容未保留，后续 close 回调又覆盖了首个错误，因此不能确定它首先失败于哪条断言。没有把已丢失的实时消息重建成“原始 tail”，也没有重发推理。

新增的是独立的持久化日志证据合同，不是放宽原冻结校验器：仅接受固定 staging、单个已发生的合成请求、精确查询时间窗和完整有界结果；调用记录、平台警告、响应事实必须共享请求 ID 与部署版本。另核对原始取消、未改写的 held 值、平台时钟上的响应先于取消及警告延迟。它证明请求级 waitUntil 任务取消，**不证明整个 isolate 被回收**。

首次补救操作在联网前被错误的“平台响应时间 ≤ 本机收到头时间 + 2 秒”断言拒绝，未发生云调用或清理。改为同一平台时钟内的响应/取消先后比较，保留本机取消与原生取消的原有有界关联，重跑 43 项后执行清理；没有通过修改真实时间戳适配测试。

Cloudflare Workers 最佳实践技能促使保留流与日志字节上限、使用原始 Request.signal 和原生平台日志，并独立回收 Access/tail。官方说明明确后台任务有断连后的持有时限；持久化日志可通过临时只读查询检查：[waitUntil 生命周期](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)、[Telemetry 查询 API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/)。

## 本地验证与清理

新增 18 项持久化证据测试，覆盖两个模式的完整 SQLite 清理，以及缺失警告、错误 outcome/版本/请求/探针/路径、非 200、时间顺序、重复事件、截断查询、错误范围和 held 变化等拒绝条件；重新运行现有清理合同的 25 项，合计 **43/43 PASS**，两次记录均通过。测试日志为明确标注的合成数据，不作为云端证据。

既有 1,111 项回归与类型检查仅复核冻结文件指纹，本轮没有重跑整套；Node 22 和远程 CI 尚未验证。

原操作器按设计拒绝仅凭 held 标记删除数据，但成功关闭双入口、恢复 deny-all、删除临时 service token 和原生 tail。后续独立补救使用关联后的持久化证据，等待原固定 350 秒安全窗，先保存完整六组账务、所有者和原始探针，再以同一原子 batch 的精确守卫删除**本次合成夹具**。无退款、无补造零用量或回执、无重发推理。

补救完成后，56 张表计数恢复预检基线，295 项 schema 指纹不变；四个 staging Worker 的 workers.dev、preview、custom domain、cron 均关闭或为空，两个 Access 应用恢复关闭状态，临时 token/tail 不存在，生产配置指纹未变。删除的是可按保存夹具重建的合成数据，原始观察证据保留在操作报告中；不是客户自动退款或未知账单恢复。

## 数量、费用与下一项

本轮新增测试 HTTP 7 次，首轮累计 **340**；管理 API 计数 261（不含 Wrangler 内部调用），一次 staging 发布。管理 D1 元数据累计读 2,361 行、写 156 行，不含 Worker binding 内部查询。另有两次只读 telemetry 查询，合计扫描 3,710,759 行、117,217,640 字节；不能与 D1 行数混算或当作免费证明。

真实模型/KMS 累计仍为 0；首轮累计 **US$2 上限不重置**。预检取得 182 条延迟账户用量记录，选定 Workers/D1 条目报告成本为零，但不是最终增量账单；操作预算预留不是已发生费用。

下一项先修复实时采集器的 canceled 兼容与脱敏首错保留，并补回归；随后重新核验隔离及预算，使用新的合成请求完成 after-INSERT 原生取消、独立恢复与去重，不重放本次未知推理。客户 intent-only/unknown/幂等、完整 SSE 生命周期、其他消费者与物理容量仍开放，C03–C20 不提前开始验收或标记完成。机器结果见 [v1.100 证据](C02-images-sse-host-expiry-staging-results.json)。
