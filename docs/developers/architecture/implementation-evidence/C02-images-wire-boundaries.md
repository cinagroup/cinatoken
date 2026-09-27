# C02 — Images 入口与上游 usage 边界

日期：2026-09-08；Checklist v1.81；状态：LOCAL_WIRE_BOUNDARIES_PASS_WITH_PUBLIC_METADATA_GAP。本地 36 项矩阵与 4 项账务诊断通过；完整版本化 staging 本地回归本轮 656/656、退出码 0，无失败/取消/跳过。发现公开结果不明元数据缺口，C02.B2.2 / C02.G 不关闭。

[机器结果及摘要](./C02-images-wire-boundaries-results.json)冻结 127 个源码、142 个操作 artifact、13 个证据依赖，共 282 个 SHA-256，发布前逐一核验。

接续 [v1.80 持久化交接](./C02-producer-persistence-boundaries.md)。新增有界 wire fixture 与矩阵测试；真实 Worker handler、鉴权、公开 Images 路由、预算、耐久 producer/recovery，存储为内存 SQLite、上游为合成 JSON。没有修改产品运行时、配置、迁移、依赖或部署。

## 已验证的分路径合同

| 路径 / 对象 | 边界与覆盖 | 结果 |
| --- | --- | --- |
| JSON 原生控制 | model 256、n 32、size/quality/background/service_tier 64 个解码 UTF-16 单元，trim 前计数 | 超一单元返回 400、无派发/预留/快照；有效控制的填充边界通过 |
| JSON quality 编码 | UTF-16 多单元字符、引号/反斜杠 | 64 单元与 65 单元分开；不把 UTF-8 或转义后的字节数当长度 |
| JSON 属性名 | ASCII、Unicode、转义字符的 256 / 257 解码单元 | 边界接受，超限 413；被后续重复值覆盖的长属性名仍拒绝 |
| JSON 重复控制键 | 转义键名、末次合法/超长值 | 使用最后一个控制值；不错误沿用早期值 |
| JSON provider | 紧凑 JSON 16,384 / 16,385 UTF-8 字节，ASCII/Unicode/转义空白 | 边界可经合法 ignore selector 路由；超限 400 |
| multipart envelope | 单字段 65,536 字节；累计字段 131,072 字节（含 model/prompt）；总 part 数 64（含文件） | 精确边界通过；各自 +1 返回 413、无派发 |
| multipart provider | 原始 JSON 字段 16,384 / 16,385 解码字符，ASCII/Unicode | 边界通过；超限 400。Unicode JSON 的字节数可大于 JSON 入口 16 KiB，但仍受 multipart 单字段字节限额 |
| multipart 属性名 | 257 字符、合法 envelope | 可以通过；没有把 JSON 属性名上限错误套到 multipart |
| 两条 Images 上游 usage | ASCII、Unicode、密集转义、输入/输出别名，规范化后 65,536 / 65,537 UTF-8 字节 | 前者 200、计数投影入快照；后者 502、耐久错误结算 |
| 两条 Images 上游属性名 | 三类编码，256 / 257 解码单元 | 前者 200，后者 502、耐久错误结算 |

`service_tier` 的 64 单元样本只证明长度准入后进入语义校验：该填充值仍返回枚举错误、无派发。不是声称 Images 支持 service tier。即使合法的非空 tier 也由现有路由限制在文本操作，未改变此能力边界。

usage 的精确字节由独立别名展开构造计算，并经实际 normalization/parser 对照；完整公开路由验证接受/拒绝和持久化结果。所有上游候选在派发前都有 durable claim，每个 fixture 最多一次合成出站。成功快照只保留六个 usage 计数，不保留 opaque 内容或原始 prompt。

## 请求费用不等于预算消耗

初版断言混淆了两者。独立四项诊断直接读取快照、请求日志、reservation、job，并调用 repository 的已提交回执核验；当前观察为：

| 合成上游结果 | 请求 `charged_cost` / 日志 `budget_charged_micros` | 用户预算已消耗 / 预留 | reservation / job |
| --- | --- | --- | --- |
| 有效成功 | 0.1 / 100,000 | 100,000 / 0 | settled，结算 100,000 / committed |
| 2xx 但 usage 或属性名超限，结果不明 | 0 / 0 | 100,000 / 0 | expired，按原预留结算 100,000 / committed |
| 入口超限，未出站 | 无请求费用日志 | 0 / 0 | 无 reservation / 无 job |

未知结果的快照 `shouldChargeBudget=false`、`userBudgetSettlement.mode=reserved`、reason=`usage_unavailable_after_dispatch`、rawUsage=null。critical write 按 reservation ceiling 消耗限额，而不是把名义请求费用改成 0.1；请求日志和回执保持零名义费用一致。不能把该预算限额消耗称为已确认的真实模型账单、买家扣款或已实现的余额/退款服务。

成功/错误结算均核对八表各一条，日统计 success/error 分类、原 snapshot JSON/SHA、日志审计一致；重复扫描全零，直接 repository.commit 返回 committed，无新增账务变化或推理。入口拒绝则八表、预留和恢复工作均为零。

## 新发现：公开结果不明提示缺失

四项诊断的当前公开响应均为：

```json
{"error":{"code":502,"message":"Upstream provider is unavailable","metadata":{"error_type":"provider_unavailable"}},"code":"upstream.server_error"}
```

内部已识别结果不明、禁止自动 failover，并执行预留限额结算；但公开 metadata 没有 `outcome_unknown` 或 `retry_safe`。**当前测试通过不代表客户端重试合同已完成。** 保留通用错误信息有助于不泄露内部详情，但不能替代明确的重试安全标志。

优先修补：在有确切证据的 Images 出站后结果不明分支增加 `outcome_unknown=true`、`retry_safe=false`，保留现有错误皮肤和兼容 code；明确拒绝的 4xx 不应被误标为未知。补成功、确定失败、超限、持久化未确认以及取消/流式边界的合同测试，再继续 staging。

## 执行记录

第一、第二次各 22/36 通过、14 个上游超限用例失败：首次错把预算消耗当名义请求费用；第二次错把内部 driver 限额文本当成公开错误文本。源码快照与失败记录均保留，修正只在测试 oracle，没有修改产品来使测试通过。

随后四项独立诊断通过；最终组合专项 40/40、退出码 0，无跳过/取消。完整回归执行 v1.80 已有 616 项及新增 40 项；最终 oracle 在旧回归第六组完成、最后一组尚未加载前锁定，既有运行时/测试依赖未改变，源摘要和顺序证据保留。不覆盖旧结果，也不把专项与完整重跑相加成测试总数。

可独立复测：

```powershell
node node_modules/tsx/dist/cli.mjs --test packages/proxy/scripts/staging/images-wire-boundary.test.mjs .wrangler/staging/images-wire-observe-v181.test.mjs
```

完整记录脚本为 `.wrangler/staging/staging-regression-v181.mjs`，使用排他结果文件；复跑需新文件名。遵循 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)：合成 wire/响应都有限额，网络禁止，等待登记使用正确 context；Node/SQLite 逻辑证据不替代真实 Workers、D1 分布式一致性或物理容量证据。

## 资源及未完成项

本轮新增工作按固定矩阵含失败/专项/完整重跑共 204 次本地合成派发；旧回归的合成派发未汇总。云调用、公开测试 HTTP、付费模型、KMS、生产写入、部署均为 0。首轮累计公开 HTTP 263、累计新增 US$2 上限不重置，最终增量云账单仍未核验。最近远端验证仍为 [v1.77](./C02-staging-claim-delay-backlog.md)，本轮未复核实时远端权限或资源。

下一步先处理公开未知结果元数据缺口；再完成明确上游 4xx/流式错误的账务对照、真实 staging wire/交付/持久化样本，继续混合消费者物理容量、全局可达上界、生产 SLO、KMS/IAM、客户端幂等和退款政策。完整共享平台工作包未完成，不能以这批逻辑边界测试关闭总目标。
