# C02 v286：累计预算保守计算与未证明上界

2026-09-21，Checklist v1.183。**预算计算合同 LOCAL_PASS；成本上界、持久化预留与完整准入仍未完成。** 本轮没有部署或调用 Cloudflare 管理接口；没有重复 v285 的路由 403 查询。

## 完成的实现

新增 `scripts/deploy/byok-d1-budget-assessment.mjs` 及其测试，提供两个纯计算接口：

- `priceByokD1UsageUpperBound`：对已给定的最大用量，按本次核对的 Standard Workers / D1 价格计算微美元上界。使用十进制整数字符串及 BigInt，每一费用项向上取整；不扣除可能被同账户其他项目消耗的免费额度，不抵销退款或信用额。
- `assessByokD1Budget`：绑定 run / candidate / prior manifest / observer scope，合并历史已发生费用上界、其他未结预留，以及本次 execution / containment / retention 三阶段的费用。未知金额显式为 null，不缺省成零；缺少证据引用也明确列为未完成。

主计算为：`max(US$1.20 历史预留, 历史已发生费用上界) + 其他未结预留 + 执行上界 + 失败收尾上界 + 保留期上界`，与累计 US$2 比较。历史费用上界未知时，整个计算仍为未知；不会仅凭 US$1.20 预留就认为它足够覆盖历史费用。历史预留不能被零账单释放，`capReset` 必须为 false。

日志、模型、KMS、其他云服务及新增订阅独立列项，不能因为五类基础单价已计算就被遗漏。新增订阅金额字段只是费用检查，不提供购买授权。其他 run 的未结预留不能重复列出，也不能与当前 run 混淆。

这是计算组件，**不是预算账户、证明验证器或预算预留服务**。摘要只标识待验证证据，不证明真实性 / 新鲜度 / 完整性；返回的 `costBoundsVerified`、`reservationCreated`、`cumulativeBudgetReserved`、`fullPreflightPassed`、`mayDeploy` 和 `actualBalanceVerified` 始终为 false。即便结果为 `CALCULATED_REQUIRES_PROOF_AND_RESERVATION`，也只是所给数字算术上不超额，不能生成完整预检回执或直接部署。

## 本轮核对的官方计费口径

Cloudflare 技能用于检查计费边界；Firecrawl 技能用于抓取、保存并检查两页官方文档，未向抓取服务发送项目代码、账户资料或 Cloudflare 凭据。

| 用量项 | 本次使用的 Standard / Paid 价格 | 微美元计算 |
| --- | --- | --- |
| Workers 请求 | US$0.30 / 百万 | `ceil(requests × 3 / 10)` |
| Workers CPU | US$0.02 / 百万 CPU ms | `ceil(cpuMs / 50)` |
| D1 读行 | US$0.001 / 百万行 | `ceil(rowsRead / 1000)` |
| D1 写行 | US$1 / 百万行 | `rowsWritten` |
| D1 存储 | US$0.75 / GB-month | `ceil(microGbMonths × 3 / 4)` |

价格依据：[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)、[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)。费率卡版本为 `cloudflare-standard-workers-d1-2026-09-21`；它不核验账户当前合同或未来价格。Service Binding 不另收请求费，但下游 CPU 仍计入总 CPU；不能仅统计入口 Worker 的 CPU。D1 的 SELECT / DDL / 索引更新也可能计费，存储包含表和索引；不根据返回行数推断扫描行数。以上价格不包含日志、模型、KMS 或其他产品，它们必须另外给出有依据的费用上界。

本地保存的页面：`.firecrawl/cloudflare-workers-pricing-v286.md`、`.firecrawl/cloudflare-d1-pricing-v286.md`，摘要纳入机器证据。两次公开文档抓取使用现有 Firecrawl 服务，未核对其实际信用点扣减或费用，不将其表述为“零外部调用”。

## 新确认的准入缺口

1. `byok-d1-management.mjs` 的 `meta.rows_read` / `meta.rows_written` 上限在收到响应后检查。它能拒绝异常结果，但不是请求发出前的扫描 / 写入费用限制；SQL 返回 `LIMIT` 也不能直接充当扫描上界。
2. 旧的可见 Workers / D1 账单零值不是首轮所有收费来源的完整账务事实；US$1.20 / US$0.80 是历史预留，不是余额。本轮只读取历史证据文件，未刷新账单。
3. 未知或失败用例按既有安全合同保留现场，不能为了减少存储成本而擅自删除。尚无有依据的保留期存储上界，不能把无限期保留写成零存储费用。
4. 尚无覆盖其他未結预留的完整账本、当前费率 / 套餐 / 用量上界证明，也没有按同一次候选原子占用预算的持久化实现。本计算模块不冒充这些实现。

把 v271 的真实历史预留记录与 v284 的**合成候选身份**交给本次打包组件，仅用于离线缺口评估：所有未证明上界保留 null，共列出 36 个未完成输入，结果为 `INCOMPLETE_BUDGET_INPUTS`，`arithmeticFits=null`。没有虚构新的费用、余额、线上候选或预算预留。

## 验证

| 最终验证项 | 通过数 |
| --- | ---: |
| 新预算组件源码 | 83 |
| 同组测试对真实 ESM bundle 重跑 | 83 |
| 既有完整操作器回归 | 73 |
| 既有套餐组件回归 | 71 |
| **执行合计** | **310** |

新独立用例为 83 个，不声称新增 310 个用例。包含各项未知费用、缺少证据引用、历史高于预留、其他待结预留、超额 1 微美元、异常精度 / 币种 / 额度重置、缺失收尾或保留期、输入 / 输出隔离。

预算足额、超额和不完整三个结果均交给真实操作器源码：全部停在 preflight，`assertReady` 未调用，外部请求 0。源码与打包测试各产生三份独立 fixture 日志，共六份、18 条哈希链记录；只用过期公开合成 grant 和临时 workspace，不占用真实项目执行预约。

33 项直接产物摘要、本轮日志与 v284 的 767 项直接产物均核对，八个维护守卫保持不变；未递归重跑整个历史证据树。未重跑完整业务 suite / TypeScript、Node 22 或原生 Workers。本机打包目标不是原生运行验收。

## 边界与下一步

本轮 Cloudflare 管理 API、云写入、部署、D1 SQL、公开 Worker、模型与 KMS 调用均为 0。累计 US$2 不重置，未刷新账单，5/10/15 秒原生维护限制不变。

接下来需要把预算证明落实到实际操作边界：

1. 依据冻结 SQL / schema / 索引 / 有界基线，建立发送前 D1 扫描和写入上界；覆盖成功、失败收尾及管理 SELECT，不能使用仅在收到响应后检查的限额。
2. 补 Workers 全调用链 CPU / 日志、失败保留期及其他产品成本依据，复核首轮历史费用与其他未结预留的完整覆盖；未知继续阻断。
3. 在可信证据和排他所有权成立后，接同次候选的持久预算预留及完整 preflight / 同步 assertReady；纯计算结果和哈希都不能替代这些步骤。

11 个 Zone 的 403、Pages / Dispatch、排他所有权和原生时序仍需补齐；v285 权限复核结果不变，无新事实不重复失败请求。C02.B2.2 仍 DOING，C02.G / C01 及后续依赖保持未通过。

[机器证据](./C02-byok-d1-budget-assessment-v286-results.json)
