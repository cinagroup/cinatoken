# C02.B2.2 — 成功响应未交付后的原生终止与账务恢复

2026-09-07；Checklist v1.71。**真实 staging 的 4 个普通 Images 请求均未交付原有成功 Response，客户端得到平台 HTTP 500；原生终止后的补账与去重通过。** 这是受控小请求子集的 STAGING_PASS，不是“客户端没有收到任何 HTTP 响应头”，C02.G 与完整物理容量仍未通过。

[脱敏 JSON 证据](./C02-staging-undelivered-recovery-results.json) 包含部署、逐请求财务观测、原生事件、恢复前后与重复恢复的全部 12 组投影、清理及基线复核；锁定 98 个源文件、37 个操作产物和 3 项前序证据依赖。沿用 [v1.70 独立入口准备](./C02-staging-undelivered-preparation.md)，本轮没有修改运行时代码、财务规则、SQL 草案、生产配置或依赖。

## 已发布的隔离候选

先验证冻结源码、候选配置、既有云端版本、绑定、Access、全 schema/表计数和生产只读设置摘要，再仅发布既有 staging Gateway：

- Gateway：10155c73-f327-4711-bb40-db4c2b49b6db；入口为 packages/proxy/scripts/staging/images-undelivered-gateway.ts。
- 消费者：e386f210-43a8-4b03-b91e-f179cadf8354，未重新发布。
- 控制端：e3a1830b-cb71-4256-bffe-55d263cf75c9，未重新发布。
- 私有模拟上游：e9bb6c18-d99b-40ba-8b34-62fc95f598f6，未重新发布。

实际上传 3715.08 KiB / gzip 669.62 KiB，平台报告启动时间 46 ms；这不是内存或生产 SLO 测量。Gateway 的 9 项绑定及完整设置摘要在部署前后保持相同，仍只有独立 staging D1、私有模拟上游等既有能力；未新增恢复 RPC、真实模型或 KMS binding。消费者仅沿用先前精确核验的 triggered_by 元数据差异，不使用广泛忽略设置差异的方法。

候选按 v1.70 的固定机制持有原成功 Response：显式 before-abort / after-abort 探针匹配时，额外窗口固定为 10 秒，预期原生终止结束上下文；未终止则只返回带专用失败标记的 503。本轮没有触发该兜底，不能将兜底错误冒充平台终止。

## 四个实际请求

使用标准 5 模型合成租户，小 JSON / 小 multipart 输入与私有 small-generations / small-edits 上游。每项仅发一次 Images 请求，不调用外部模型、不以再次推理恢复记账、不伪造已接受快照或修改数据库时钟。

| 操作 / 原生终止点 | 客户端实际结果 | 终止后的耐久状态 | 独立恢复后 |
| --- | --- | --- | --- |
| generations / batch 提交前 | HTTP 500；无 X-Generation-Id；错误体 4,710 字节、EOF | leased / revision 1 / attempts 1；无回执 | committed / revision 3 / attempts 2；receipt lease_revision=2 |
| edits / batch 提交前 | 同上 | 同上 | 同上 |
| generations / batch 提交后 | 同上 | committed / revision 2 / attempts 1；已有回执 | 保持原提交；receipt lease_revision=1 |
| edits / batch 提交后 | 同上 | 同上 | 同上 |

四条 native tail 事件均为 outcome=exception / responseStatus=500，匹配新部署版本、精确探针与操作路径，包含 `Worker execution was aborted due to call to ctx.abort().`。同一事件可包含多条相同异常；这里是 **4 个请求事件**，不是按异常数组长度计算多次故障或推理。请求 ID 来自本轮拥有的耐久探针，而不是未交付的成功响应头。

HTTP 错误体仅保存长度、摘要及有界分类结果，不保存正文。错误码提取结果均为 null，因此不额外声称特定 1xxx 平台错误码。原生事件与耐久探针提供终止证据；单独 HTTP 500 不能证明原生终止。

提交前两条任务最后错误均为 null，仍为原生中止留下的 leased，而非普通 catch 路径的 pending / execution_error。5 秒实验租约自然到期：generations 的 expires=1788784379 / now=1788784408，edits 的 expires=1788784389 / now=1788784409。未人为缩短现存租约或回拨数据库时间；5 秒不是生产租约建议。

独立消费者第一次无参 RPC 返回 scanned=claimed=committed=2，其他计数均为 0，capacityLimited=false、admissionStopped=false。每个请求最终恰好一份日志、回执、attempt 与 usage_charge 审计；快照摘要和记录时间不变。快照实际为 7,700–7,762 字节，**不是 256 KiB 最大快照验收**。

合成账本从 spent=200,000 / reserved=200,000 变为 spent=400,000 / reserved=0 微美元。关闭 Gateway 并撤销测试 API key 后，第二次 RPC 所有计数为 0，12 组投影（含完整统计分片）与重复前完全相同。US$0.40 仅为合成账本数字，不是真实账单，也没有引入自动退款或客户端重试政策。

## 权限、防护与收尾

本轮实测 staging 发布、Access 应用/策略、临时服务令牌、限定 tail 与 staging D1 权限可用。**不据此推断 Google Cloud KMS 的密钥与 IAM 权限已通过真实调用验证。**

保护检查保留两个传播期 404：Gateway 与控制端各一次；随后无身份和错误服务令牌分别获得 401。404 不计作保护通过，只有两项身份拒绝成立后才发送业务请求。

部署阶段 2 项最终复核通过；实验阶段 10 项收尾全部通过：关闭两个入口、终止并删除 tail、禁用令牌、恢复两项 Access deny-all / service_auth_401_redirect=false、删除令牌、撤销测试 API key、确认无有效租约后精确清理本轮合成数据、复核所有基线及 Gateway 完整设置。清理移除了本轮临时测试记录和探针；原始合成观测保留在本报告，不涉及真实租户或生产数据。

最终四个 Worker 的 workers.dev 与 previews 均关闭，按 service 查询的自定义域名和 schedules 为空；不是整个 zone 的路由枚举。两项 Access 恢复 deny-all，临时服务令牌已删除，所有本轮观察查询为空，消费者暂停控制行不存在。295 个 schema 定义摘要仍为 1bc2f70306a5b464f789590e21445ddbb11372b3e2086ce95dcf626168e656f9，56 表计数恢复；其他 Access 应用和三项生产设置指纹未变。未重新应用三份既有 SQL 草案。

## 本地验证与费用

- 完整 staging 回归 **488/488**，无失败、跳过或取消；定向 staging 类型检查退出 0。新增 3 项仅验证操作工具的标准 5 模型种子/清理、恢复前后财务和租约约束；测试向量来自历史证据，不冒充本轮真实平台结果。
- Wrangler 4.127.1 与当前 Workers 类型 5.20260907.1 已核对，未升级依赖；沿用 v1.70 已核验的绑定类型和候选产物。运行时代码与已锁定的 98 个源码摘要保持不变。
- 本轮公开 HTTP **12**：防护检查 6、Images 4、恢复 RPC 2；首轮累计 **202**，预算不重置。
- 部署与实验共 183 次脚本管理请求（62 + 121）；REST SQL 40 次 / 236 条，rows_read=4,744、rows_written=193。Wrangler 内部管理请求与 Worker 内部 D1 操作未计入上述统计，不能将其作为全部计费请求数。
- 本轮 1 次 staging 部署，真实模型/KMS 调用与生产写入均为 0；没有升级、充值或支付交易。累计新增 **US$2** 上限继续有效，最终增量账单仍未核验。

按照 Workers 最佳实践与 Wrangler 技能，使用封闭独立候选、有界持有和观测、生成绑定类型及部署后完整核验；没有用 Node shim 替代原生执行结果。参考 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) 与 [Wrangler Workers 命令](https://developers.cloudflare.com/workers/wrangler/commands/workers/)。

## 结论边界与下一顺序

本轮证明“用量已经耐久保存、成功响应未交付时，真实执行上下文终止仍可按既有事实补账且不重复扣费”。客户端确实收到了 HTTP 500 响应头和错误体，不能表述为没有任何响应头，也没有实现端到端 exactly-once 推理。

下一步仍在 C02.B2.2：先补其他 host 中断与故障组合的可重复证据，再补最大结算快照与跨消费者完整物理工作集。整实例回收、所有断网时序、SSE/Audio/Admin/Realtime 等其他消费者、生产容量/SLO 与 C01.6/C05 的请求幂等/退款政策仍未验收。无快照不重建用量，不按 TTL 自动退款，未启用生产容量，C02.G 保持开放。
