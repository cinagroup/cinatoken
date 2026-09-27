# C02.B2.2 — Peer V2 封闭部署与首次真实平台请求

日期：2026-09-09；Checklist v1.118。封闭部署 PASS；实际推理请求收到 HTTP 409，窗口 **INCONCLUSIVE_REJECTED_409**，整体 **STAGING_PARTIAL / ATTENTION_REQUIRED**。不构成完整容量、原生 host 持有期或物理实例驱逐证明。

## 新部署的实证

v218 的终态回执已核实没有云端写入，原目录和日志保留。新的固定 v219 执行器复用已发布 CLI 原语，先核验 1,753 条准备记录、重跑 24 项 CLI 专项测试，再以 `--verify-local` 核验 2,546 条含构建输入的记录。此前 1,833 项联合回归和类型检查证据保留，源文件摘要未变；本轮没有声称重跑全部 1,833 项。

经批准在可联网环境完成一次封闭部署：

- Worker：`cinatoken-proxy-staging`。
- 实际版本：`388a37c6-40e8-4a69-b09a-e60e5e83c8c6`，100%。
- 实际 executable SHA-256：`87c09d97c6297e016781b94e5f49e90ef6d8ef21fb8352e413983858567e9765`，匹配冻结 v214 Peer V2 bundle。
- 网关 settings 摘要未变；只上传候选代码。部署前后完整前检及独立隔离复查通过，生产 settings 未变。
- 四个 staging Worker 的 workers.dev/preview 关闭、无自定义域名/cron；schema 295 对象、56 表计数在部署阶段仍为干净基线；双 Access 拒绝策略和无遗留 token/tail 已检查。
- 最新读取到的 Workers/D1 已出账项目 ContractedCost 均为 0；这不是最终增量账单核验，也不重置 US$2 累计授权。

详见[封闭部署回执](../../../../.wrangler/staging/sse-capacity-peer-v219-deploy/result.json)。CLI 参数按当前 [Cloudflare Wrangler 文档](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy)及本机 4.127.1 核对；使用冻结 bundle、禁用自动创建资源、不修改兼容日期或生产配置。

## 一次真实请求的结果与边界

后续 `--run` 使用新部署回执及同一原始 session 重新完成前检，建立本轮专属 Access/tail，六项 none/invalid/valid 认证检查全部通过，规范 seed 原子写入 ACK。随后：

1. watch-v2 返回 HTTP 200，初始池样本 requests/reservedBytes 为 0；peer 为 `52dedcf4-a8a3-42d0-af32-bf7a110bb980:1`。
2. 仅发送一次 `/v1/images/generations`，返回 **HTTP 409**，generation ID 为 null；没有完成图片、上游 DONE、held 或 native warning 验证。
3. 原进程立即停止窗口并进入 finalizer。没有恢复 RPC，没有重发推理，没有合成成功、费用、退款或完成时间。
4. 双 Access/入口关闭、本轮 token 删除、tail 删除及 key 撤销均已确认，最终 Worker/生产隔离复读通过。
5. finalizer 缺少真实主响应体结束与 native proof，保留 `primary-finish` / `native-proof` 错误，拒绝把“资源已关闭”当作完整 fixture 清理或容量验收成功。

当前证据只捕获了 409 状态，**没有读取/持久化拒绝正文**，因此不能断言准确 reason。源码中的 `peer_not_active_here` / `request_aborted` 均可在进入业务 handler 前返回 409；这与拒绝前的表现相容，但缺少正文时只能作为候选解释，不能伪称已证明异实例调度。

见[实际运行回执](../../../../.wrangler/staging/sse-capacity-peer-v219-run/result.json)及[原始操作日志](../../../../.wrangler/staging/sse-capacity-peer-v219-run/journal.jsonl)。成功结算规则仍为有效 completed 图片及真实上游 DONE 均已验证后不可逆；本次根本没有达到该点。

## 只读复查与保留数据

两次独立只读检查均 PASS：

- [拒绝后检查](../../../../.wrangler/staging/peer-v219-rejection-inspection/result.json)：账务六表全局为空；测试 user 的 spent/reserved 都为 0；精确 key 已 revoked；Worker 版本/settings、关闭入口及生产 settings 匹配；token/tail 不存在。此检查的 description 查询只覆盖两类探针，不声称它单独证明全部三个探针。
- [精确 fixture 检查](../../../../.wrangler/staging/peer-v219-fixture-inspection/result.json)：按三个精确 probe key 复读，全部字节匹配 canonical armed 行；schema 仍为 295 对象，56 表计数恰为干净基线加规范 28 条 seed 与 3 条 probe。28 条 seed 按所有已指定字段核对，只有运行时生成的 `verified_at` 不用重建值比对，而是完整保留实际行并校验同一合法 ISO 时间。

共 **31 条本轮专属测试记录暂时隔离保留**，没有删除；没有账务记录待伪造为已结算。数据最后检查时间为 `2026-09-09T02:29:43.319Z`。原请求的完成时刻没有补造，新只读检查的单调时钟不能代替原请求样本。

保留的记录为 user/workspace/key 各 1、providers/models/model_routes/model_endpoints/model_endpoint_routes 各 5、system_config probes 3。测试 key 已撤销，供应商仅为合成私有 fixture；不是真实模型凭据。该状态不是干净 baseline，不能直接重跑依赖干净基线的旧执行器。

## 调用与费用口径

本轮可观测管理 API 尝试 **235** 次：部署 104、运行 110、只读检查 19+2；Wrangler 内部管理调用另由部署日志保留，不计入这 235 次。D1 管理返回 meta 汇总 rows_read **2,910**、rows_written **117**，后者是平台统计而非 117 条 fixture，实际保留 fixture 为 31 条；Worker 自身查询不包含在管理统计中。

公开 HTTP 新增 **8** 次（认证 6、watch 1、推理 1），首轮累计 **390**；恢复 RPC **0**。真实模型/KMS 累计 **0/0**，生产写入 **0**。累计 **US$2** 上限不重置；最终增量账单尚未核验。

## 下一步及整体门禁

优先补齐有界、无秘密的非成功响应正文/实际结束记录，使 peer 拒绝可以与未知传输明确区分；为本次隔离 fixture 建立并验证独立的拒绝后清理条件，包括关闭证明、原始 409 记录、真实等待、空账务与未变 armed 行、精确全行/计数守卫及原子删除。不得把 primarySends 改成 0 来套用未发送清理路径，也不得伪造 native PASS。

清理及证据缺口处理后，才评估如何完成同池因果观察；不能通过盲重试推理、改成跨池样本或放宽成功定义取得表面通过。C02.B2.2 的物理容量/跨消费者、unknown/幂等、C02.G、C01 剩余决策、Node 22/远程 CI 及 C03–C20 仍未完成。
