# C02 v271：完整旧代码归档与实际套餐取证

2026-09-21，Checklist v1.170。PRIOR_CODE_CLOUD_PASS / PAID_PLAN_OBSERVED / STAGING_PARTIAL。取得现有三台待替换 staging Worker 的完整模块、下载前后版本/配置一致性以及现有 Workers Paid 订阅证据。完整预检收集器尚未接通，未部署或执行原生 BYOK 用例，C02.G / C01 保持开放。

## 解决的问题

v264 的 `/content/v2` 读取在 60 秒及独立 120 秒尝试中均只收到部分正文，不能用本地历史哈希代替当前完整代码。本轮没有继续增加超时，先查询官方接口文档及本地 Wrangler 下载实现，再使用官方 [Download Worker Script](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/get/) 的 `GET /accounts/{account_id}/workers/scripts/{script_name}`。

第一次只读取证共 5 个 GET，账户设置/订阅及 gateway 配置/版本均成功；原始脚本在 **4,405 ms** 内收到完整 **3,834,765 字节** HTTP 正文。然而操作脚本将 multipart 部分一律当 File，语义解析失败，未到达下载后的版本核对，报告为 PARTIAL。该记录保留于 `.wrangler/staging/byok-preflight-v271-cloud-probe/result.json`，不改判完整预检通过。

另一次单 GET 首部诊断确认：响应为 multipart/form-data，入口为 `images-sse-capacity-peer-diagnostic-gateway.js`，部分的 Content-Disposition 只有 `name`、没有 `filename`。通用 `Response.formData()` 会将此部分作为字符串；将它当 File 会错误拒绝，解码再编码也不适合作为任意模块的精确字节验证。诊断在取得 1,363 字节后主动取消，不声明正文完整；原始代码没有进入日志。

这解释了本轮 raw 下载的解析失败；**没有证明 v264 旧接口慢下载的根因**。新的官方读取方式通过了本轮完整验证，旧失败材料继续保留。

## 实现

新增 `scripts/deploy/byok-worker-content.mjs`。直接以字节解析 name-only 字段和 filename 文件部分，不把源码或二进制模块转换成表单字符串，不导入/执行下载内容：

- 核验完整开头/结束 boundary、每部分头部与边界；拒绝截断、重复模块、未知传输编码、尾随正文、前导正文、非法路径和未知入口。
- 保留每个模块的原始字节及 SHA-256，不只寻找一个匹配入口就忽略其他模块。
- 限制总正文 12 MiB、最多 32 个模块、名称 256 字符、部分头部 4096 字节；支持受限 JavaScript 单模块原始正文。
- CRLF、无效 UTF-8 和二进制字节都按原始字节处理；模块名不作为本地文件路径。

新增 `scripts/deploy/byok-d1-prior-code.mjs`，仅针对现有 gateway、recovery-control 和 usage-recovery 三台 staging Worker。每台固定流程为 settings → deployments → 完整脚本 → settings → deployments，总计 **15 个 GET**。前后要求与冻结的版本及 settings 摘要一致；gateway 的入口还须匹配原始历史 SHA-256。其他两个 Worker 的完整模块按已知部署版本建立当前只读归档，不假装它们之前已有完整模块摘要。

三目标并行、每目标顺序固定；整体最多 60 秒，元数据单次最多 20 秒、代码最多 60 秒，正文读取和字节数有界。失败停止新准入，外部取消/迟到响应不能修改已结束证据。各物理请求先刷盘 PENDING，再网络读取；日志为有界摘要链，源码与凭据不写入日志。

归档位于调用工作区内一次性 `byok-d1-prior-code-reservation`；不复用、不重开、不自动清除失败样本。检查父目录真实路径，模块文件只使用固定 Worker 名加整数序号，`wx` 创建、刷盘并重新读回核对摘要；结果也单独刷盘。模块只作为数据保存，不执行、不自动恢复旧实验。

同时修正 `byok-d1-deployment.mjs` 的部署后代码验证：改用上述官方 raw 下载接口及同一精确字节解析器，仍要求唯一模块、预期入口、名称和代码摘要全部匹配，未扩大候选模块或上传范围。否则真实部署后的 name-only 响应仍会被旧验证器错误拒绝。测试不再仅构造带 filename 的理想化响应。

## 本地验证

最终报告：`.wrangler/staging/byok-preflight-v271-local-final/result.json`。**690 PASS / 0 FAIL**，含打包复测，不宣称场景互不重叠：

| 范围 | 通过数 |
| --- | ---: |
| 字节解析器源码 / 打包版 | 23 / 23 |
| 三目标旧代码归档器源码 / 打包版 | 22 / 22 |
| 只读传输源码 / 打包版 | 47 / 47 |
| 完整主机编排源码 / 打包版 | 71 / 71 |
| 部署 / Access / 操作日志 | 58 / 59 / 18 |
| 安装 / 管理 / 用例 / 维护调用 | 52 / 40 / 42 / 22 |
| 关闭观察 / Images SSE 成功边界 | 32 / 41 |

staging TypeScript 通过。新增测试覆盖 name-only 部分、二进制/无效 UTF-8、完整模块集合、重复/缺失/截断/路径错误、下载前后配置或版本漂移、历史入口不符、HTTP 和正文边界、取消/迟到、不可重开、链接父目录拒绝和现有文件不覆盖。

部署/操作器仍在合成云 API 和本地 SQLite 上测试，不是一次真实部署。运行时 Windows Node 24.14.1；没有执行 Node 22、远端 CI、完整 npm hook 链或原生 Workers/D1/Access 验收。Worker 源码、配置及不可逆 Images SSE 结算点不变，本轮不重复 Worker dry-run。

v267 安装异常与 v270 首轮 closure-after 未解释异常仍保留；当前测试通过不表示已修复其未确认根因。首轮 raw 下载的不同格式错误已由诊断定位并覆盖，不能混同这三类问题。

## 真实代码归档结果

`.wrangler/staging/byok-preflight-v271-cloud-archive/result.json`：**15 GET / 15 ACK，10,432 ms，PASS**。每台前后版本及 settings 匹配冻结基线：

| 现有 Worker | 完整模块 | 模块字节数 |
| --- | --- | ---: |
| cinatoken-proxy-staging | images-sse-capacity-peer-diagnostic-gateway.js | 3,834,544 |
| cinatoken-staging-recovery-control | usage-recovery-control-worker.js | 7,142 |
| cinatoken-staging-usage-recovery | usage-recovery-claim-delay-worker.js | 357,529 |

三个 Worker 均为单模块，本地完整归档共 4,199,215 字节。报告记录各模块摘要、固定归档文件名和版本；发布证据再次读取归档校验所有字节。gateway 入口摘要与 v257/v270 继承值一致。

这里证明的是“观测时点三台现有待替换 Worker 的完整代码已取得且前后版本/配置一致”，不是云端原子锁或以后仍然未变。归档仍是旧 Images 实验代码，不是新的 BYOK 候选；不得把归档当作已授权恢复命令。未改旧部署、未启动独占 BYOK 阶段。

## 实际套餐及费用边界

本轮对固定账户的 [Workers account-settings](https://developers.cloudflare.com/api/resources/workers/subresources/account_settings/methods/get/) 与 [subscriptions](https://developers.cloudflare.com/api/resources/accounts/subresources/subscriptions/methods/get/) 成功取证，观察时点 **2026-09-21T02:21:41.062Z**：

- default_usage_model 为 `standard`；此字段单独不构成付费证明。
- 存在账户级 `workers_paid` / `Workers Paid` 订阅，state 为 `Paid`，期间为 2026-08-29 至 2026-09-29，币种 USD、价格字段为 5。
- 其他免费产品也能有 `Paid` 状态，不能只检查 state 或价格非空；本轮明确核对产品 ID、account scope、状态和有效期间。
- 这是已有订阅，不是本轮创建的订阅，也不表示本轮测试新增费用为 US$5。

现行 [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) 列出的每次 Worker 调用查询上限为 Workers Paid 1000、Free 50。已有本地用例最高 125、完整清理路径 190 次 SQL 的数量不再因“尚不知是否 Free”而无法判断，但实际执行时长、其他资源限制和原生事务行为仍未验收。套餐证据需由完整预检在实际执行前重新取得，不能把本轮历史快照直接当下一轮准入许可。

本轮 Cloudflare 管理请求共 **21 个 GET**：第一次取证 5 个完整 HTTP 响应但代码语义未通过；一个主动截断的封装诊断；最终三目标归档 15 个完整 ACK。无自动重试，主动截断不伪装为完整代码证据。

云写入、部署、D1 SQL、公开 Worker、模型/KMS、生产写入均为 **0**。公开 HTTP 累计仍 422；首轮累计 **US$2 不重置**。US$1.20 历史/延迟预留与 US$0.80 未分配预留不变，不是余额；未刷新实际增量账单，未新订阅或升级。最后已知入口双轮关闭证据仍为 v270，数据库完整基线仍未在本轮重读。

## 发布与下一步

[机器证据](./C02-byok-d1-preflight-code-v271-results.json)保留原失败取证、格式诊断、最终归档、对应源码及全部测试材料。继承的 **24,080** 条普通摘要与原有链接目标再次校验，旧 manifest 不改写。实际项目执行占位 `.wrangler/staging/byok-d1-execution-reservation` 未创建。

Cloudflare 技能要求先核对实际接口和限制；Firecrawl 技能用于只读取官方文档并隔离保存抓取结果。其作用是采用有文档的 raw 下载接口、按真实 name-only 响应修正验证，并将账户配置、订阅产品和账单分别处理；没有向第三方发送项目代码或凭据。

下一步顺序不变，但证据缺口已缩小：

1. 将三目标旧代码收集、当前套餐、来源冻结、预算/完整数据库基线和全部调用路径清点接入真正的只读预检收集器；布尔断言和历史快照不能冒充当次证明。
2. 核验关闭观察后的完整维护激活路径满足现有主机 10 秒 / 原生 15 秒窗口，不放宽窗口迁就网络耗时。
3. 冻结实际候选并取得完整当次预检后，才进行已获授权的独占 staging 原生 BYOK 验收。保留未知样本、关闭围栏和维护回执；不自动恢复旧实验。

完整预检、C02.G、C01 及后续工作包仍未完成。
