# C02.B2.2 — Images 恢复机制接入完整 Worker 入口

2026-09-07；Checklist v1.62。**本地完整 Worker 组装链通过，尚未部署这份恢复生产者入口。** 前轮真实消费者的 [晚期审计故障回滚与恢复](./C02-staging-recovery-audit-fault.md) 证据保持独立；不能把两组测试拼接成已完成的云端端到端证明。C02.G 仍未通过。

## 变更与默认边界

[Worker app 工厂](../../../../packages/proxy/src/runtime/workers.ts) 与 [共同 handler](../../../../packages/proxy/src/runtime/worker-handler.ts) 现在显式接受既有 `imageUsageRecovery` 选项。不从 bindings、HTTP header 或正文读取启用开关；生产 `src/index.ts` 仍调用无参工厂，不启用恢复或容量池。选项由 app 在组装时复制，后续调用方修改不会改变已组装实例。

提取 [staging 共用入口工厂](../../../../packages/proxy/scripts/staging/images-gateway-handler.ts)，保留完整存储、加密仓库、维护、鉴权、scheduled/queue 和提前 `waitUntil` 合同。普通 staging 入口仍不传恢复选项；新增 [恢复专用入口](../../../../packages/proxy/scripts/staging/images-recovery-gateway.ts) 明确使用 30 秒结算租约。没有新增消费者 RPC、公共控制路由、Cron、生产资源绑定或任意 SQL 接口。

私有传输仍只允许固定 origin/path、POST 和 manual redirect，并额外拒绝 URL 用户信息与 fragment；不替换全局 fetch、不复制正文流、不回退到公网。故障 facade 仅在当前请求包装 D1，仍要求严格有限 header 与精确租户/armed 行；未修改其事务或返回边界算法。

[配置准备工具](../../../../scripts/deploy/prepare-proxy-staging-images.mjs) 新增显式 `imagesRecoveryStagingConfig`，复用原隔离校验，只改变恢复入口 main。原 CLI 与默认输出保持 legacy staging，不会自动选择恢复版本或发布。实验配置在 `.wrangler/staging/images-recovery-v162/wrangler.jsonc`，含已核验 staging D1 UUID，公网/预览关闭；后续部署前仍须重验云端状态与绑定。

## 本地证据

[新增 28 项完整入口测试](../../../../packages/proxy/scripts/staging/images-recovery-worker.test.mjs) 使用 Node 24.14.1、真实 SQLite SQL 和 D1 adapter、真实 Worker handler/storage/repositories/Images 路由，以及禁止外网的私有模拟上游；**不是 workerd 或 Cloudflare 平台测试**。

- Worker 与 staging 两层组合：generations / edits、合成费用 0 / 0.10，出站前意图认领、持久化快照、独立后台 hold、一次日志/回执/统计与正确预算结算。
- staging 实际 header / 一次性 D1 facade：generations / edits 的提交前失败与提交后 ACK 丢失。前者保留预留并进入退避，消费者在数据库时间推进后补账；后者识别已完成，不重复扣费。改变当前价格配置后仍使用耐久财务快照；上游发送次数始终为 1。
- 仅正式 schema 的默认入口正常工作，请求/绑定伪造恢复开关不起效；显式启用但 schema 仅 0/1/2 份时，上游发送为 0。
- 组装选项复制、维护模式、无效加密材料、错误鉴权、无效探针 header 与固定传输边界。

新增 1 项配置测试核对 legacy 默认不变、仅 main 差异和拒绝外加能力；定向 TypeScript 检查退出码 0。完整 staging 回归 **35 + 8 + 158 + 39 + 65 + 88 + 24 = 417** 全部通过，最后 24 项实际退出码 0、无取消或跳过。完整 Core 类型检查未重跑，历史 32 条诊断保持。完整结果和 78 个文件的 SHA-256 见 [JSON 证据](./C02-images-recovery-worker-composition-results.json)。

Wrangler 4.127.1 离线 `deploy --dry-run --experimental-provision=false` 通过：3,800,382 字节 JS，gzip 668.88 KiB，791 个输入；打包图没有恢复消费者或控制 Worker 入口。重新生成的恢复入口绑定字段与现有 Wrangler 生成的 `ImagesStagingEnv` 完全相同，因此复用该绑定接口，不手写新 Env；专用生成输出留在忽略目录。staging TypeScript 同时检查两个入口。依据 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) 保留显式绑定、请求级状态、流身份与后台任务持有；没有用 waitUntil 代替耐久任务。

操作准备曾因本地脚本相对路径错误失败，随后修正并重跑打包/类型生成成功；最初版本查询的默认日志目录写入被沙箱拒绝，后续日志改到工作区。两者均未发布、未创建云资源，不是运行时故障证据。

## 权限、费用与剩余验收

本轮 4 次只读管理 API 均 HTTP 200：gateway / recovery-control 的 workers.dev 与 previews 均关闭，gateway Access 为 deny-all，D1 UUID `6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1` 的名称为 `cinatoken-staging`。未再次试写权限，前轮已实测的 Access 写权限记录保持；不将元数据读取成功说成所有操作均获准。

本轮部署、云配置/数据库写入、公网测试、模型/KMS、生产操作均为 0；首轮公网测试累计仍为 135，**累计 US$2 不重置**，最终增量账单仍未核验。合成 0.10 美元不是真实云费用。本轮没有读取生产配置/业务数据，因此不另行宣称重新核验了生产指纹。

下一步在受保护的独立 staging 部署并验证这份恢复生产者，连接现有私有上游与独立恢复消费者，核验真实快照、故障、对账与无重发推理，然后恢复封闭入口并清理精确样本。沿用原 Access/令牌收尾顺序，不重放三份已应用的 ALTER 草案。平台终止、确认丢失、并发 fencing、完整物理工作集、SSE、Node 22 和其他模态仍待验收。回退只能关闭新准入并切回已核验入口；已经受理的耐久任务须由消费者/对账收尾，不能删除或重推理。
