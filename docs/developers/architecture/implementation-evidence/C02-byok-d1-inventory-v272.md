# C02 v272：staging 调用关系清点与路由权限缺口

2026-09-21，Checklist v1.171。**LOCAL_PASS / CLOUD_INVENTORY_PARTIAL**。当前 Worker / Pages 配置、Queue 和 Workflow 子集已取得真实只读证据；Zone 路由权限阻止完整清点。`allInvocationPathsInventoried`、完整预检、C02.G 和 C01 均未通过。没有部署、开放入口、执行 D1 SQL 或调用模型 / KMS。

## 已实现及验证范围

新增 `scripts/deploy/byok-d1-inventory.mjs`：固定既有账户、四台 staging Worker 和 staging D1，识别服务 / RPC、Tail、Durable Object 引用、直接 D1、Pages 两环境服务 / D1、Zone 路由、Queue 消费者和 Workflow 目标。非默认 Worker 环境会单独读取，不仅检查默认环境。

- GET-only，无重试，无任意 URL / 云写入 / SQL。最多 400 次请求，四通道并发，总时限 120 秒，单次 20 秒，解码后正文最多 2 MiB / 4096 次读取。
- 按官方 API 语义区分单页和分页；校验页号、总数、页大小、重复 ID、账户归属以及跨页总数漂移。部分 Queue 消费者、缺失或冲突目标字段均拒绝，不能当作没有调用来源。
- 调用前 `PENDING` 刷盘，响应仅存摘要和结构化 staging 相关关系；不保存完整配置、环境变量值、凭据或原始错误正文。失败停止新请求，保留已有证据，不自动继续执行部署。
- 独立目录一次性占位，日志摘要链、真实路径检查、外部取消和迟到响应保护。不是实际 BYOK 执行占位，也没有接成自动放行的预检证明提供器。
- 即使读完支持的接口，也只报告当前配置子集；历史部署 / 版本特定绑定、令牌资源可见范围、未清点入口和在途 SQL 仍须单独证明，不声称原子快照。

最终本地报告 `.wrangler/staging/byok-inventory-v272-local/result.json`：**269 项通过，0 失败**，包含清点器源码 / 打包各 37、已有读取器 47、关闭观察 32、旧代码归档 22、主机编排 71、字节解码 23；staging 类型检查通过。测试包括最后一页才出现目标、非默认环境、恶意资源名、字段缺失 / 冲突、分页漂移、响应长度 / UTF-8、取消、迟到回执、旧目录与链接保护。仅是本地合成 API 与相关回归；没有重跑 v271 全部 690 项，也不代表原生 Workers / D1 验收。

## 真实读取结果

读取了 **69 台 Worker 的 service 环境目录及 settings**；本次每台只有一个默认环境。四台 staging 的 settings 摘要及三台指定生产 Worker 的 settings 摘要均与既有基线匹配。独立后照的完整 Workers 目录 HTTP 正文与初始目录摘要相同；不把该一致性扩大为各类配置的原子快照。

当前读取范围中，只有以下五条相关关系：

| 来源 | 关系 | 目标 |
| --- | --- | --- |
| proxy-staging | `IMAGE_UPSTREAM` service binding | staging-images-upstream |
| staging-recovery-control | `USAGE_RECOVERY` / `UsageRecovery` RPC | staging-usage-recovery |
| proxy-staging | `DB` D1 binding | staging D1 |
| staging-images-upstream | `PROBE_DB` D1 binding | staging D1 |
| staging-usage-recovery | `RECOVERY_DB` D1 binding | staging D1 |

表中简称均属于既有 `cinatoken-` 前缀 Worker。**在所读取的当前配置中**未发现其他 Worker 的 service / Tail / DO 目标指向这四台 Worker，也未发现其他 Worker 的直接 staging D1 绑定。特别注意 upstream 仍可直接接触 staging D1：只替换 gateway / controller / receiver，并不等价于证明所有数据库写入来源已停止。

其他目录：

- Pages 初始 `per_page=100` 返回 HTTP 400 / 8000024，未据此推断缺少权限。省略此参数后返回默认每页 10 项、共 19 项 / 两页；最终两页均读取，production / preview 项目配置未发现目标 service 或 staging D1 绑定。该结果不覆盖仍可能存在的历史 deployment URL。
- 15 个 Queue、共 8 个 Worker 消费者，均不指向四台目标；Workflow 目录为 0。Queue 实际消费者字段是 `script`，不能只检查文档中的 `script_name`；实现也支持已知 `service` 形式并拒绝冲突值。
- 17 个 Zone 目录可见，但第一批四个路由读取中，一项收到 HTTP 403 后触发停止，另外三项本地取消、无已记录响应状态；不声称它们未到服务端。独立单次诊断完整读取到 `No access to the specified resource.`，未继续扫描其余 Zone，也未绕过该门禁。
- Dispatch namespace 请求返回 403 / 10121，服务端明确提示没有产品访问权限并指向购买入口。记录为 **不可访问**，不是空目录；未购买产品、升级套餐或授予新权限。

用户随后明确回复“路由只读权限已补齐”。据此在新目录重新执行一次完整清点，仍为 **146 次请求 / 142 ACK，首个路由 403、三个并行请求取消**，57.701 秒结束；没有改写第一次失败，也没有第三次全账户重扫。首个被拒绝的 Zone 是 `china-electric.com`（`17048cde4ec237a83fe2926e7947d366`）。后续只读自检确认当前 Token 为 active，但读取它自身权限详情返回 403 / 9109，无法直接核验策略。仅布尔比较确认进程、用户和系统持久环境中的 Token 值一致，未输出 Token 或其摘要；因此不能简单归因于进程还持有不同旧值，也尚不能确认究竟是权限名称、Zone 资源范围还是其他资源访问限制。已请用户核对当前 Token 和 Zone Resources，或提供脱敏权限截图；无需增加 Token 管理权限。

## 失败保留与计量

| 阶段 | 管理 GET | 结果 |
| --- | ---: | --- |
| 首轮目录探针 | 6 | 4 个 200；Pages 400、Dispatch 403，均完整收到正文 |
| 字段 / 默认分页 / 错误诊断 | 4 | 3 个 200；Dispatch 403，均完整收到正文 |
| 清点器正式只读执行 | 146 | 142 ACK；1 个 403 仅响应头；3 个取消无已记录响应状态；57.405 秒，FAILED_RETAINED |
| 路由错误与独立目录后照 | 4 | 3 个 200；路由 403，均完整收到正文 |
| 用户确认补权后的新一轮清点 | 146 | 142 ACK；1 个 403 仅响应头；3 个取消无已记录响应状态；57.701 秒，FAILED_RETAINED |
| 当前 Token 自检 | 2 | verify 200 / active；自身策略详情 403 / 9109，均完整收到正文 |

总计 **308 次管理 GET 尝试**：295 个成功 HTTP 200，1 个 HTTP 400，6 个 HTTP 403，6 个未记录响应状态；300 个完整正文。独立后照补充证据，不改写两次正式清点器的失败结论，不构成自动恢复 / 重放。

证据目录为 `.wrangler/staging/byok-inventory-v272-{catalog-probe,shape-probe,local,cloud,diagnostic,cloud-authorized,token-scope}`，由[机器证据](./C02-byok-d1-inventory-v272-results.json)记录摘要。此前 v271 的 26,010 条历史记录和 23 个链接目标已核验且未改写。初始手动 37 项冒烟不是上述最终 269 项之外的独立验收。

本轮云写入、部署、公开 Worker 请求、D1 SQL、模型、KMS、生产写入均为 0。第一轮累计 **US$2 不重置**；US$1.20 历史 / 延迟预留与 US$0.80 未分配额度保持原口径，不是已核实剩余余额。本轮未刷新账单、D1 数据基线或 Access / workers.dev 关闭状态；不能用本次配置读取替代 v270 的入口关闭观察。

## 下一步的有限顺序

1. 核对当前 CLI Token 的 **Zone → Workers Routes → Read** 与 Zone Resources，包含 `china-electric.com` 及此账户其余 Zone。用户已确认补权，但实际 403 仍存在；无需 Write / API Tokens 管理权限，也不要在聊天中粘贴 Token。待资源访问差异解决后，先对一个被拒绝 Zone 做小范围只读验证，再完成路由清点，避免直接重扫所有 Worker。
2. 处理版本特定 / 预览版本、Pages 历史部署和可见范围等剩余覆盖项；Dispatch 的产品不可访问状态不能直接变成“零资源”断言。明确哪些入口由现有关闭检查与目标代码鉴权封闭，哪些仍缺证据；不要求枚举所有可能 HTTP 客户端，也不把外部 D1 管理访问误当成 Worker 调用。
3. 将有来源约束的清点、完整旧代码 / 套餐、当次预算与数据库基线接入完整预检；保持 `allInvocationPathsInventoried=false`，直到覆盖定义和相应证据齐备。
4. 完成维护激活时序资格与独占结束后的受控恢复，再冻结新候选并进行原生 BYOK 验收。不得放宽原时限、跳过关闭围栏、删除未知样本或自动恢复旧实验。

## 接口依据

遵循 Cloudflare 技能，先以官方资料核对接口，再用实际响应验证字段；这避免了把首屏或缺字段误判为空清单。[Workers 单页目录](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/list/)、[Pages 分页目录](https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/list/)、[Zone 目录](https://developers.cloudflare.com/api/resources/zones/methods/list/)、[路由只读权限](https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/list/)、[Queue 目录](https://developers.cloudflare.com/api/resources/queues/methods/list/)、[Workflow 目录](https://developers.cloudflare.com/api/resources/workflows/methods/list/)和 [Dispatch 目录](https://developers.cloudflare.com/api/resources/workers_for_platforms/subresources/dispatch/subresources/namespaces/methods/list/)。Worker service 环境读取路径及 Queue `script` / `service` 字段另核对本地官方 Wrangler 实现。
