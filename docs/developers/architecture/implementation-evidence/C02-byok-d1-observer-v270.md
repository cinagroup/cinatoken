# C02 v270：有界只读传输、并行关闭观察与真实响应兼容

2026-09-21，Checklist v1.169。OBSERVER_LOCAL_PASS / KNOWN_INGRESS_CLOUD_PASS / STAGING_PARTIAL。已将固定 GET-only 传输接入统一主机编排，并通过一次修复后的真实双轮关闭观察；未部署、未执行原生 BYOK 用例，C02.G / C01 保持开放。

## 本轮交付

新增 `scripts/deploy/byok-d1-read-transport.mjs`，替代主机编排要求外部注入的 `readApi`。仅可读取固定 staging D1 身份、四个 staging Worker 的配置/版本/入口/定时任务、两个 Access 应用、令牌清单、gateway tails，以及三个生产 Worker 的 settings。不能读取 SQL、代码正文、账单或任意 URL；没有写入、重试、续跑或资源创建能力。生产范围仅用于配置摘要比对。

每个物理 GET 先在独立 observation 日志刷盘 PENDING，再发送；完整 HTTP 200、JSON、UTF-8、正文结束和响应格式验证后记录 ACK。日志只保存固定路径、状态、字节数、摘要和时序，不保存原始响应、凭据或 token 名称。日志与操作日志分开，避免消耗后者用于失败收尾的保留容量。

- 并发最多 4，物理请求最多 320，单次 HTTP 最多 20 秒，单逻辑读取最多 60 秒。
- 响应最多 2 MiB / 4096 次正文读取；日志最多 1024 条 / 1 MiB，单条最多 4096 字节。
- Access service-token 分页最多 20 页 / 20,000 项，逐页核对分页总数、计数及重复 ID；仅向调用方投影 ID。缺少充分分页证据时拒绝，不将第一页当完整缺席证明。
- 任一失败终止后续准入并中止其他逻辑读取；迟到响应不能更改已关闭证据。不声称远端读取已经停止。
- PENDING/ACK 刷盘后重新检查单调时限；落盘延迟超限不能让陈旧响应进入关闭证明。ACK 只记录已收到有效 HTTP 响应，不自行授予准入资格。

`byok-d1-ingress-closure.mjs` 保留 D1 身份先读、两轮完整检查和原有 60 秒期限。每轮的 11 个目标任务使用最多四条并行通道，同一 Worker 的五项读取保持顺序，两轮之间有完整屏障；失败后不准入下一目标。每次成功仍为 **55 个逻辑读取**。虚拟每次 1.5 秒 RTT 的测试从顺序估算 82.5 秒降到 22.5 秒；这不替代真实时序证据。

统一编排连接具体读取器并在退出前等待逻辑读取收尾、关闭 observation 日志。模拟完整流程三次关闭观察为 165 个 GET / 331 条 observation 日志，操作日志仍为 93 条。公开接口不再要求调用方提供读传输；真实 `preflight` / `assertReady` 证据收集器仍未交付。

## 线上发现的格式问题与修复

首个独立云观察 `.wrangler/staging/byok-observer-v270-cloud-once/result.json` 为 **FAIL**：17 次 GET 尝试、13 个有效 ACK；gateway 域名接口返回 HTTP 200 / 171 字节，但在解析阶段失败，另三个并行读取被停止。未完成首轮，不构成完整关闭证明。此目录、执行日志与 runner 均保留，不重用、不覆盖。

另外一次固定 endpoint 的只读诊断记录在 `.wrangler/staging/byok-observer-v270-envelope-diagnostic/result.json`。只保存固定字段的类型/计数/布尔值及正文 SHA-256，不保存原始正文。实际响应为 `success: true, errors: null, messages: null, result: []`，空域名列表的 `result_info` 为 page 1、per_page 0、count 0、total_count 0。

读取器原先仅允许省略 `errors` 或空数组，因而拒绝这个实际成功响应。兼容 `null` 后，集成测试又发现部署适配器的相同域名读取也有同一问题：源码及打包版均 **20 PASS / 51 FAIL**，首个非注入失败停在模拟 deploy-receiver，未上传。该失败记录 `.wrangler/staging/byok-observer-v270-local-envelope/result.json` 保留。

最终同时修正只读传输和部署适配器：只将 absence / null / [] 视为无错误，仍严格要求 `success === true` 和存在 `result`；false、空字符串、对象、含 null 的数组及非空错误数组均拒绝。域名非空仍阻止部署。主机集成与部署测试使用线上观察到的 null-envelope，而非继续只使用理想化空数组。没有扩大目标范围、取消期限或绕过入口校验。

## 验证

最终本地报告：`.wrangler/staging/byok-observer-v270-local-fixed/result.json`，**600 PASS / 0 FAIL**，包括打包复测（不宣称 600 个互不重叠的独立场景）：

| 范围 | 通过数 |
| --- | ---: |
| 只读传输源码 / Node ESM 打包版 | 47 / 47 |
| 统一主机编排源码 / Node ESM 打包版 | 71 / 71 |
| 并行关闭观察 | 32 |
| 部署 / Access / 操作日志 | 58 / 59 / 18 |
| 安装 / D1 管理 / 用例调用 / 维护调用 | 52 / 40 / 42 / 22 |
| Images SSE 不可逆成功边界 | 41 |

staging TypeScript 通过。测试覆盖四并发上限、两轮屏障、失败与取消停止准入、不合作 fetch 的迟到响应、完整分页与计数漂移、重复 ID、响应格式与字节/块边界、日志不可重开、物理请求上限、刷盘超时以及完整主机流程。测试云 API、Access/service binding 为合成实现，数据库为本地 SQLite。

保留另一项不同的未解释异常：最初 `local-first` 的 operator-source 为 70 PASS / 1 FAIL；预期最终 receipt 漂移失败，实际提前在 closure-after 失败，三个很小的 HTTP 200 响应未被接受，持续约 32.1 秒。同轮打包版 71 项通过。旧日志没有足够时序诊断，原因仍未确认，不能将本次 null-envelope 修复或后续绿色复测当作该异常根因已修复。之后补充阶段/时序诊断，并用可控单调时钟单独验证刷盘超时拒绝；`local-verified` 的 581 项通过证据也保留。v267 安装回归未复现异常继续保留其原限制。

运行时为 Windows Node 24.14.1；没有声称 Node 22、远端 CI、完整 npm hook 链、原生 Workers/D1/Access、MySQL/PG/Hyperdrive 或实际容量验收通过。Worker 源码、绑定、配置与 Images 成功结算点未改，本轮不重复 Worker dry-run。

## 修复后的真实云观察

独立 runner `.wrangler/staging/observe-byok-ingress-envelope-v270.mjs` 在最终本地 PASS 后运行一次；输出 `.wrangler/staging/byok-observer-v270-cloud-envelope/result.json`。

- **55 次尝试 / 55 ACK，两轮完成，21,028 ms，峰值并发 4**。
- 固定 D1 身份匹配；四个 staging Worker 的 settings/版本匹配，workers.dev / previews 关闭，检查到的域名和定时任务为空。
- 两个 Access 应用摘要与 deny-all 策略匹配；被跟踪的旧令牌缺席、gateway tails 为空；三个生产 settings 摘要未变。
- 这只是已检查入口的非原子观察：`allInvocationPathsClosed=false`、`databaseQuiescenceProved=false`、`cleanupAuthorized=false`。没有证明所有 zone routes / incoming service bindings 已清点，没有 SQL 数据基线、完整旧代码或实际维护激活时序资格。

本轮全部 Cloudflare 管理请求：**73 次**（原失败观察 17 + 独立结构诊断 1 + 修复后观察 55），其中 **68 个传输 ACK + 1 个诊断完成**，70 次收到 HTTP 状态；四个初次失败/未确认读取不抹除，不计成成功。没有自动重试。

云写入、部署、公开 Worker 请求、凭证创建、D1 SQL/行写入、模型/KMS 调用和生产写入均为 **0**。公开 HTTP 累计仍为 422。首轮累计 **US$2 不重置**；US$1.20 历史/延迟费用预留、US$0.80 未分配预留不变，不视为实际剩余余额。没有重新核验实际套餐或最终增量账单。

最后完整数据库/旧代码基线仍不能由本轮替代；v257 完整数据库观察和 v264 完整预检失败的历史结论保留。修复后关闭观察成功不意味着独占 BYOK 部署阶段已执行，真实项目执行占位仍未创建。

## 证据、技能与下一步

[机器证据](./C02-byok-d1-observer-v270-results.json)保留所有本地阶段、失败材料、诊断、云观察和对应源码归档；旧 manifest 不改写。修改前及最终发布均校验继承的 18,405 条普通摘要及原有链接目标。复制归档只用于保持旧测试对应的源码，不覆盖当前用户改动。

Cloudflare 技能促使本轮以实际 API 响应和完整分页证据校验合同，区分管理面读取、已知入口关闭与原生 D1 安全性；Firecrawl 技能用于取得官方 service-token 分页文档，结果留在忽略目录 `.firecrawl/cloudflare-service-tokens-v270.md`。线上 null-envelope 结论来自受限直接诊断，不是从文档猜测。

后续有限顺序：

1. 接通具体只读预检收集器：冻结当前源码/候选、完整旧代码与版本、全调用路径、独占归属、实际套餐、累计预算证据；不可用合成布尔声明替代。
2. 验证“新鲜关闭观察 → 维护许可 → Access/controller 激活 → 一次清理”的完整真实时序能满足既有主机 10 秒 / 原生 15 秒新鲜度边界。本轮 21 秒关闭观察解决的是观察自身 60 秒预算，不证明之后的激活窗口。
3. 完整预检通过后，才执行已获授权的现有 staging 独占原生验收；未知样本不重放/删除，默认保留关闭围栏与维护回执，不自动恢复旧实验。

C02.G、C01 以及后续 Checklist 工作包均未宣告完成。
