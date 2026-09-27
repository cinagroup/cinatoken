# C02.B2.2 — waitUntil 平台取消后的补账与去重

2026-09-07；Checklist v1.73。**普通小型 Images 的四场景子集通过，完整 C02.G 未通过。** 本轮将 [v1.72 冻结候选](./C02-staging-host-expiry-preparation.md) 发布到独立 staging，验证成功响应结束后，平台取消未完成后台任务时的耐久状态及独立恢复。未修改生产源码或启用生产容量。

[机器可核验记录](./C02-staging-host-expiry-recovery-results.json) 包含 103 个源码摘要、60 个操作产物摘要、5 个证据依赖摘要，以及部署、首次失败和最终成功的独立记录。首次失败没有被覆盖，历史测试向量不充当本轮云端证据。

## 验收结果与边界

最终四个请求均返回 HTTP 200，携带 X-Generation-Id，客户端完整读取 1,082 字节至 EOF，响应摘要一致。没有主动 ctx.abort、探针 release、重发推理或修改数据库时间。

| 操作 / 真实暂停位置 | 平台取消后的耐久状态 | 独立恢复后的状态 |
| --- | --- | --- |
| generations / batch 提交前 | leased，revision 1，attempts 1，last_error=null | committed，revision 3，attempts 2，回执 lease revision 2 |
| edits / batch 提交前 | leased，revision 1，attempts 1，last_error=null | committed，revision 3，attempts 2，回执 lease revision 2 |
| generations / batch 提交后 | committed，revision 2，attempts 1，回执 lease revision 1 | 原记录不变，没有重复扣费 |
| edits / batch 提交后 | committed，revision 2，attempts 1，回执 lease revision 1 | 原记录不变，没有重复扣费 |

每个原生 tail 事件均匹配精确请求、POST 路径和本轮 Gateway 版本：outcome=ok、responseStatus=200、exceptions 为空，并有一条 warn 级别的 waitUntil 平台取消警告。**请求 outcome=ok 不表示后台工作成功完成。** 警告出现后，精确拥有的探针仍停在 awaiting-host-expiry-before-commit / awaiting-host-expiry-after-commit，未进入 45 秒 host-expiry-not-observed 兜底。

这是平台取消警告、完整响应 EOF、耐久探针和账务状态的联合证据，不是“等待足够时间”或普通异常的推断。Cloudflare 的 [waitUntil 生命周期说明](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil) 区分响应后的后台执行窗口与整个请求期限；本轮不以客户端与平台不同时间源证明精确 30 秒墙钟边界，也不推断整个 isolate 被销毁。

## 首次失败与精确兼容修正

首次尝试执行了 4 个鉴权拒绝检查和 1 个 generations 请求；后者实际返回 HTTP 200 / 完整 EOF，并出现原生取消警告。但初版观察器只接受文档中的句子，未接受平台附加的官方文档 URL，因而以 exact platform waitUntil cancellation warning required 失败。没有继续其他 Images 或发送恢复 RPC。

读取 [Cloudflare workerd 的 IncomingRequest::drain 源码](https://raw.githubusercontent.com/cloudflare/workerd/main/src/workerd/io/io-context.c%2B%2B) 后，确认平台警告确实附加该官方链接。新增操作侧适配器只接受两种精确形式：原句，以及原句加该精确官方链接；其他链接、额外文本、措辞变化、错误版本和主动终止仍拒绝。原始事件不修改，原失败报告不改成通过。

首次样本在清理前仍为 leased revision 1、attempts 1、last_error=null，合成预留 100,000 micros、已花费 0。等待安全窗口后精确清理；**该样本没有完成补账验收**。第二次使用全新合成租户与请求，不重发首次已接受的请求，不重新部署，也不修改运行时代码。

## 恢复与重复调用

第二次的两个未提交任务采用固定 5 秒实验租约并自然到期。独立消费者 RPC 扫描、认领和提交各 2 项，其他计数为 0，capacityLimited / admissionStopped 为 false；控制调用正常 finished，retry_safe=false。提交后的两笔已有回执，不再认领。

四个快照分别为 7,700、7,762、7,704、7,762 字节，恢复前后保持一致。每请求仅一条日志、回执、attempt 和 usage_charge 审计。重复 RPC 的全部计数为 0，前后 12 组账务投影完全一致，包含账户、API key、意图、快照、任务、预留、回执、日志、attempt、审计和两组统计。

第二次合成账户恢复前 spent=200,000 / reserved=200,000 micros，恢复后 spent=400,000 / reserved=0。这是测试数据库的 US$0.40 合成结算，**不是实际云账单或真实付款**。没有调用推理补账，没有按 TTL 自动退款。

## 发布、测试与隔离收尾

本轮只部署一次 cinatoken-proxy-staging，入口为 images-host-expiry-gateway.ts，新版本为 4b089cf8-2ceb-4025-ad75-31c4081341b0，流量 100%。实际上传 3,715.04 KiB / gzip 669.60 KiB，启动 50 ms；上传体积及启动时间不是内存容量验收。9 项绑定和完整设置摘要不变；消费者、控制端及私有上游的既有版本不变。

新增 7 项操作侧测试：五模型样本/精确清理与账务校验向量、tail 有界提取、事件严格验证和真实警告格式兼容。首次本地 5 项测试中 3 项因合成 SHA-256 格式无效而失败，修正为合法的 64 位十六进制测试摘要后通过，未放宽校验。完整 staging 回归先 513/513、兼容修正后 **515/515**，无失败、跳过或取消；定向 staging 类型检查退出 0。这不是整个仓库所有测试的总数。

Workers 最佳实践与 Wrangler 技能要求显式区分本地证据、平台证据及生产验收，因此只关闭本次平台取消子集，保留完整容量门禁；操作过程核对当前 Workers 类型 5.20260907.1 和已安装 Wrangler 4.127.1，没有升级依赖。

部署阶段 2 项收尾检查通过，两次实验各 10 项收尾检查通过：

- 四个 Worker 的 workers.dev / previews 均关闭；各服务 custom domains 和 schedules 查询均为空。这不等于枚举整个 zone 的所有 routes。
- 两个 Access 应用恢复 deny-all，service_auth_401_redirect=false；临时服务身份禁用后删除，临时 tail 删除，测试 API key 撤销。
- 最后一次 Images 完成、RPC 完成和 host 持有观察三者的最晚时间之后等待 60 秒，再确认无活跃租约并精确清理本轮租户/探针；没有只因 5 秒租约到期就清理在途执行。
- 消费者控制行不存在，56 张表计数恢复基线，295 个 schema 对象摘要不变，其他 Access 应用不变。
- 三个生产 Worker 的只读设置指纹不变；未读取生产 D1 数据或执行生产写入。

## 累计费用与请求记录

| 阶段 | 测试 HTTP | 脚本管理请求 | REST SQL 语句 | 读取行 / 写入行 |
| --- | ---: | ---: | ---: | ---: |
| 一次部署及复核 | 0 | 62 | 6 | 1,982 / 0 |
| 首次观察失败及清理 | 5 | 101 | 124 | 2,144 / 158 |
| 第二次成功及清理 | 10 | 126 | 235 | 2,767 / 193 |
| 本轮合计 | 15 | 289 | 365 | 6,893 / 351 |

REST SQL 共 61 次调用；管理请求不包含 Wrangler 内部调用，SQL 指标不包含 Worker 内部 D1 操作。成功尝试的 10 次 HTTP 为 4 次鉴权拒绝、4 次 Images 和 2 次恢复 RPC。

首轮累计测试 HTTP 从 202 增至 **217**。真实模型调用 0、KMS 调用 0、生产写入 0。首轮累计新增 **US$2** 上限不重置；最终增量账单尚未核验，不能由合成结算或 HTTP 次数宣称实际费用为零或已精确核实未超额。权限补齐仍不等于真实 Google Cloud KMS key / IAM 已验证。

## 下一实施顺序与未关闭门禁

1. 验证最大 256 KiB 快照及其恢复工作集；本次仅约 7.7 KiB。
2. 继续剩余故障组合，保留其他 scope、未知结果、SSE、outbox 与 client unknown / 幂等政策边界。
3. 完成跨消费者的完整物理容量、实际运行配置及生产 SLO 验收；64 MiB、单消费者、每批 5 项仍仅为实验分配，不是生产容量结论。

整个 isolate 回收、全部 host 失败交错、端到端 exactly-once 推理、自动退款和请求幂等政策均未证明。C01.9 / C01.10、Node 22 / host 备选路径、Audio / Admin / Realtime 原有未验收项继续保留。C02.B2.2 与 C02.G 保持开放，C03–C20 不提前启动；继续遵守 [独立 staging 有限顺序](../../../operators/deployment/cloudflare-staging.md#3-云端有限顺序)。
