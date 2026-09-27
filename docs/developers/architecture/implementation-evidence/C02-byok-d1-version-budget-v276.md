# C02 v276：版本绑定覆盖完成，发现预算与维护新鲜度分离

2026-09-21，Checklist v1.174。**VERSION_BINDINGS_OBSERVED_GAPS_RETAINED**。在不修改云资源的前提下，完成当前账户可见的 **69/69 台 Worker 默认环境、403 个所需版本详情**的读取及前后核对。真实 **879/879 次管理 GET 成功，耗时 333014 ms**。这解决 v275 的版本清点截断问题，不代表所有调用路径、完整预检或原生 BYOK 验收通过。

## 修改及依据

v275 在 300 秒时仍缺 14 个版本详情及结束复核；当时 4 路请求已接近满载，仅调整任务顺序不能保证完成。此次只将 GET-only 发现收集器的默认 / 最大总时间从 **300000 ms 改为 600000 ms**，并在结果中明确记录发现预算。

以下限制全部保持：最多 **1000 次 GET、4 路并发、单请求 20 秒、响应 2 MiB**；版本数、分页、结构校验、漂移检查、超时与取消处理不变。仍可显式选择更短期限，无自动重试或从旧失败目录续跑。

发现是只读目录核查，不是维护许可。主机准入、许可签发和原生 D1 检查的 **5/10/15 秒**新鲜度要求完全未改。八个编排 / 原生维护文件与 v273 证据摘要一致，包括 operator、management、maintenance-dispatch、ingress-closure、cleanup、maintenance-contract、maintenance-host、maintenance-worker。未修改 Worker 业务源码、SQL 围栏或清理流程。

Cloudflare 技能指导本轮继续区分“发现覆盖”与“执行准入”；此前官方 API 依据继续适用，没有通过修改读取集合、忽略旧版本或取消结束核对来适应时间限制。

## 验证

最终 **183 PASS / 0 FAIL**：清点器源码 47、打包 47、已有当前配置清点 37、已有读取传输 52。新增测试确认：

- 明确的十分钟发现预算与其他限制一致；仍可配置五分钟，完整预检标志仍为 false。
- 延迟请求的同时在途数量仍为四。
- 大版本集合在第 **1000 次 GET**后停止，产生 2002 条保留日志，不因总时间增加而允许无限请求。

既有小期限超时 / 用户取消 / 非协作请求 / 迟到响应测试继续通过。仅本地验证，不替代原生 Workers/D1 行为验收。

## 真实只读结果

观察窗口：**2026-09-21 04:13:31.532–04:19:04.544 UTC**。

| 项目 | 结果 |
| --- | --- |
| 可见 Worker 默认环境 | 69，全部完成前后核对 |
| 当前部署内版本 | 69 |
| Preview URLs 开启的 Worker | 29 |
| 所需版本详情 | 403，全部读取 |
| cinashop-api 历史版本 | 168/168，结束核对通过 |
| 管理 GET | 879 次，全部 200 / ACK |
| 完整根目录结束核对 | 通过 |
| 刷盘哈希链 | 1760 条，全部复核 |
| 自动重试 / 云写入 | 0 / 0 |

本次实际当前部署均为单版本 100% 流量；0% 版本纳入规则由本地测试覆盖，并非声称新建或执行过真实零流量部署。预览开关关闭时只记录关闭条件，不声称其全部历史版本已删除或已逐个读取；开关开启时读取全部已列版本，不以缺失的 `hasPreview` 字段缩小范围。

全部已选版本中仍只观察到此前五条 staging 关系：两条内部服务绑定（gateway → upstream、controller → receiver）及三个 staging D1 绑定（gateway、upstream、receiver）。没有发现新的上述目标绑定。此结论仅限本次默认环境 API 可见的所需版本集合，不覆盖任意应用代码中的 HTTP 调用、不可见资源或其他未清点入口。

`callableDefaultVersionBindingsObserved=true`，但 `snapshotIsAtomic=false`、`visibilityScopeVerified=false`、`allInvocationPathsInventoried=false`、`fullPreflightPassed=false`。长时间只读观察不能冒充一份刚刚完成的入口关闭或数据库静默证明。

## 下一项：Pages 历史部署

等待清点时通过 Firecrawl 获取并检查了官方 [部署列表](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/list/)和[部署详情](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/get/)文档，保存在 `.firecrawl/cloudflare-pages-deployments-list-v276.md` 与 `cloudflare-pages-deployments-get-v276.md`。

文档提供 production / preview 过滤与分页，部署模型列出 `env_vars`、`uses_functions`，但未列明 `services` / `d1_databases` 历史绑定字段。因此下一步应先做有界的真实响应结构探测，确认可支持的历史绑定来源；不得把字段缺失当作空绑定，也不得用项目当前配置替代旧部署配置。这只是接口准备，**本轮 Pages 账户管理请求为 0，历史绑定仍未覆盖**。未向 Firecrawl 发送项目配置、Token 或私有数据。

## 证据与未完成项

v275 的 35 项增量证据在修改前已核验；两个被改动文件的原字节归档到 `.wrangler/staging/byok-version-v276-prior/`，新清单保留映射，不覆写旧结果。发布时重新验证这 35 项、八个未变维护文件、20 项本轮文件及全部 1760 条真实日志。未重新验证 v273 的整个历史依赖树，未借用历史测试数量作为本轮结果。

本轮部署 / SQL / 公开 Worker / 模型 / KMS 调用均为 0；仍受首轮 US$2 累计上限约束，不重置预算，未刷新实际账单。实际 BYOK 执行保留目录仍不存在。

仍待完成：Pages 历史绑定、11 个 Zone 的路由只读权限缺口、Dispatch / 资源可见性与其他调用来源、完整预检接线、独占 / 新鲜关闭 / 数据库与预算基线、原生维护时序和 BYOK 验收。C02.G / C01 不勾选通过。

[机器证据](./C02-byok-d1-version-budget-v276-results.json)
