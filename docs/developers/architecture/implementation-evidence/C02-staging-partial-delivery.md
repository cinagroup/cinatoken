# C02.B2.2 — 部分响应断线与原生终止后的账务恢复

2026-09-07；Checklist v1.69。**真实 staging 上的 4 个普通 Images 请求均收到 HTTP 200，客户端各读取 16 KiB 后主动取消，未读取完整响应。** 提交前原生终止的两笔用量经独立消费者补齐；提交后原生终止的两笔没有重复扣费。重复恢复后 12 组账务投影完全不变。本子集为 STAGING_PASS，C02.G 与完整物理容量仍未通过。

完整脱敏观测及 93 个源文件、操作产物摘要见 [JSON 证据](./C02-staging-partial-delivery-results.json)。前序 [严格租约隔离](./C02-staging-strict-fencing.md) 与 [原生终止恢复](./C02-staging-native-abort-recovery.md) 保留。本轮仅增加操作者测试工具和证据；没有修改运行时代码、生产配置、财务规则、SQL 草案或依赖，也没有重新部署。

## 场景与实际观测

使用既有私有模拟上游：原始成功 JSON 为 32 MiB，规范化响应预期长度为 33,554,490 字节。请求输入仍是小 JSON / 小 multipart；不是 50 MiB 上传实验。新合成租户包含 6 个模型，覆盖 limit-generations 与 limit-edits。未调用外部推理服务。

| 操作 / 原生终止点 | 客户端读取 | 原生终止后 | 恢复后 |
| --- | --- | --- | --- |
| generations / batch 提交前 | 200；16,384 字节；未读 EOF；主动取消 | leased / revision 1 / attempts 1；无回执 | committed / revision 3 / attempts 2；receipt lease_revision=2 |
| edits / batch 提交前 | 同上 | 同上 | 同上 |
| generations / batch 提交后 | 同上 | committed / revision 2 / attempts 1；已有回执 | 保持原提交；receipt lease_revision=1 |
| edits / batch 提交后 | 同上 | 同上 | 保持原提交；receipt lease_revision=1 |

客户端只调用一次 reader.read()，随后等待 reader.cancel() 完成，不解析完整 JSON，也不自动重新发送 Images 请求。4 个请求的真实 tail 事件均匹配部署版本、探针和操作路径，包含原生 ctx.abort 终止异常；事件 outcome 为 ok、responseStatus 为 200，不能只按 outcome 判断是否终止。

每个请求提交前，网关已经耐久保存结算快照。对每步真实 D1 投影核对账户、意图、快照、任务、预算预留、回执、日志、attempt、费用审计和聚合统计；重复恢复还比较包括完整统计分片在内的全部 12 组投影。未通过测试脚本伪造已接受快照、日志、租约状态或数据库时钟。

两条未提交任务使用既有实验生产者 5 秒租约，查询时已经自然到期；分别观察到 expires=1788782173 / now=1788782209 与 expires=1788782184 / now=1788782210。独立消费者无参 RPC 返回 scanned=claimed=committed=2，其余计数为 0，capacityLimited=false、admissionStopped=false。快照摘要与记录时间保持；最终每个请求只有一份日志、回执、attempt 和费用审计。

合成账本从 spent=200,000 / reserved=200,000 变为 spent=400,000 / reserved=0 微美元。这是测试账本的 US$0.40，不是真实费用。重复 RPC 全部计数为 0，账务投影完全不变，未产生再次推理或再次收费。

## 权限、隔离与收尾

本轮实际成功操作既有 staging Access 应用/策略、临时服务令牌、staging D1 夹具和限定 tail 会话，因此这些接口的权限已实测可用；不据此声称所有部署权限或 Google Cloud KMS 的密钥/IAM 权限均已验证。

沿用前序固定版本：

- Gateway：2f3d3d28-08aa-4a5f-a84d-5f3e5001a4a1。
- 恢复消费者：e386f210-43a8-4b03-b91e-f179cadf8354。
- 控制端：e3a1830b-cb71-4256-bffe-55d263cf75c9。
- 私有上游：e9bb6c18-d99b-40ba-8b34-62fc95f598f6。

运行前核验 v1.68 的 91 个原源码摘要与 19 个操作产物，并检查云端绑定、版本、Access 闭合状态、全 schema 和表计数。消费者设置沿用已精确核验的 version_upload 标记差异。本轮不使用消费者暂停控制行；运行前、逐请求及清理后均确认它不存在。

Access 检查保留网关一次传播期 404，随后无凭据和错误令牌均得到 401；控制端两项检查也为 401。只有保护检查通过后才调用业务入口，未将 404 算作授权防护通过。

9 项收尾全部通过：关闭两个临时公开入口，关闭/删除 tail 会话，禁用令牌，将两项 Access 应用恢复 deny-all / service_auth_401_redirect=false，删除令牌，撤销测试 API key，等待持有窗口并确认无有效租约，精确清理本轮合成样本，最后复核全部状态。没有删除真实租户、共享统计或生产数据。

最终四个 Worker 的 workers.dev/previews 均关闭，按 service 查询的自定义域名和 schedules 为空；不是全 zone 路由枚举。295 个 schema 定义 SHA-256 保持为 1bc2f70306a5b464f789590e21445ddbb11372b3e2086ce95dcf626168e656f9，56 表计数恢复，其他 Access 应用摘要、三项生产设置指纹保持。所有本轮合成查询为空。

## 本地验证与费用记录

- 新增操作者测试 5 项：6 模型查询/清理、单块取消、空 EOF/超大首块/取消失败拒绝、恢复前后财务与租约漂移拒绝。初次 4/5：测试数据库未应用三份既有草案；仅补本地建表步骤后 5/5，没有重新执行远端迁移。
- 完整既有 staging 链 465 项，加新增 5 项，共 470/470；定向 staging 类型检查退出码 0。新测试显式追加到本轮回归命令，未修改 package.json。
- 新工具只扩展自身 6 模型统计查询的占位符；旧 5 模型观察器及生产逻辑均不变。Node 测试只验证测试工具，不替代上述真实 Workers 证据。
- 本轮公开 HTTP 11：保护检查 5、Images 4、恢复 RPC 2。首轮累计 190，不重置。
- 脚本管理请求 124；REST SQL 38 次 / 243 条，rows_read=2,784、rows_written=212。Worker 内部 D1 操作未计入 REST 统计。
- 本轮及历史记录中的外部模型/KMS 调用仍为 0；无部署、生产写入、升级或充值。首轮累计新增 US$2 上限继续有效；最终增量账单仍未核验，不能把合成金额或调用计数当作实际账单。

采用 Workers 最佳实践和 Wrangler 技能，限制请求/响应观测、使用独立服务绑定、保留请求所有权与真实耐久事实，完整撤销临时访问。核对当前 Workers 类型 5.20260907.1（ExecutionContext.abort）与已安装 Wrangler 4.127.1，未升级依赖；参考 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。

## 不扩大结论 / 下一步

本轮证明的是：**客户端应用未读完整响应，同时网关已经保存用量事实；原生终止后仍可只记账一次。** 它不能证明边缘或网络栈从未缓冲完整响应，不能确定客户端取消与原生终止的精确先后，也不是由客户端取消必然触发 ctx.abort 的证明。原生终止是实验探针独立注入。

仍未覆盖未收到响应头、请求级幂等/重试政策、整实例回收、所有故障并发排列、最大 256 KiB 结算快照、跨消费者完整物理内存工作集或生产 SLO。不能因响应带有 32 MiB 合成元数据就认定这些容量门禁已过。后续继续未收响应头/其他 host 中断边界，再补最大快照与跨消费者容量；C01.6/C05 的财务和幂等决策不在本轮变更，不按 TTL 自动退款、不靠再次推理补账。C02.G 保持开放。
