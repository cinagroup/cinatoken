# C02.B2.2 — CLI 验证与首次封闭部署前检停止

日期：2026-09-09；Checklist v1.117。整体 STAGING_PARTIAL；新 Peer V2 未上传、推理窗口未执行、C02 门禁未通过。

## 本轮实际结果

已完成 [v1.116 CLI 本地验证包](./C02-images-sse-capacity-peer-cli.md)：新增 24 项入口测试，联合 **1,833/1,833 通过**，失败/取消/跳过为零，staging 类型检查通过。发布包 1,745 条摘要核验，实际 `--verify-local` 连同构建输入核验 2,538 条记录，结果 PASS。另以真实 Wrangler 4.127.1 执行冻结 bundle 的离线子进程 dry-run，退出码 0。Node 22/24 远程 CI 尚未运行。

随后执行了一次 `--deploy-closed`，独占目录 `.wrangler/staging/sse-capacity-peer-v218-deploy` 已保留。该次入口内 dry-run 同样成功；但第一个只读 D1 身份 GET 在收到 HTTP 响应前失败，前检立即停止：

- `cloudMutationAttempted=false`，未执行在线 Wrangler 上传。
- 管理请求尝试 1 次，无 HTTP 状态，D1 SQL 读取/写入均为 0。
- 没有创建 Access token、tail、seed，没有打开入口，没有发送公开 HTTP 或推理/RPC。
- 原始 [终态回执](../../../../.wrangler/staging/sse-capacity-peer-v218-deploy/result.json)和[追加日志](../../../../.wrangler/staging/sse-capacity-peer-v218-deploy/journal.jsonl)均保留，不覆盖，不删目录重试。

随后经工具批准，在沙箱外进行了一次**独立只读**诊断：固定相同 staging D1 身份 GET 返回 HTTP 200、`success=true`，数据库 UUID/名称精确匹配；Cloudflare 响应时间 `Wed, 09 Sep 2026 02:13:20 GMT`。见[诊断结果](../../../../.wrangler/staging/peer-v218-connectivity-result.json)。诊断不含 SQL、不修改资源、不打印 credential。两次请求的对照支持“首次失败由沙箱网络限制导致”，并证实当前 credential 可读 staging D1；它不证明其他管理权限、全套前检或部署一定成功。

## 证据与预算口径

本轮管理 GET 尝试共 **2 次**，其中 1 次收到成功响应。在线部署 **0 次**，公开测试 HTTP 新增 **0**，首轮累计仍 **382**；真实模型/KMS 累计 **0/0**；生产写入、D1 SQL 写入、Access/tail 修改均 **0**。累计 **US$2** 上限不重置。此次只读身份检查没有读取最新账单，最终增量费用仍未核验。

仅 D1 身份获得新的实际观察；四个 staging Worker 版本/入口/绑定、生产 settings、双 Access、schema/counts 和账单**没有重新全部验证**。最后完整云端观察仍为 v1.108（2026-09-08T12:59:42.118Z）；旧容量结论 INCONCLUSIVE_HELD 保留，不能升级成新 Peer V2 成功或物理容量证明。

## 下一步

依据终态回执确认本次没有云端写入后，为后续操作创建新的受审执行编号及新目录；以获准联网的执行环境重新做完整只读前检，随后最多一次封闭候选部署。不能重跑已消费的 v218 CLI 目录，也不能通过删除失败证据来恢复它。新部署完成后仍须实际 module/settings/version 与隔离回执通过，才进入单次 Workers 验收。失败或不确定推理/RPC 的禁止重放规则不变。

完整物理容量、跨消费者、unknown/幂等、C02.G、C01 剩余决策及 C03–C20 仍开放；本轮不是整体目标完成。
