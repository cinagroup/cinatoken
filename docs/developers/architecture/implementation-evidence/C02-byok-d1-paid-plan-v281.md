# C02 v281：实际付费套餐的只读预检组件

2026-09-21，Checklist v1.179。**PAID_PLAN_COMPONENT_LOCAL_AND_CLOUD_PASS_PREFLIGHT_PENDING**。新增可复用的固定账户套餐收集器，216 项源码 / 打包 / 相关回归通过，真实四次管理 GET 全部成功。完成的是套餐观察组件，不是完整预检提供器，也未执行原生 BYOK 验收。

## 实现与边界

新增 `scripts/deploy/byok-d1-paid-plan.mjs` 及对应测试。Cloudflare 技能要求核对实际接口契约；本轮复用同日抓取的官方 [Workers account-settings](https://developers.cloudflare.com/api/resources/workers/subresources/account_settings/methods/get/) / [account subscriptions](https://developers.cloudflare.com/api/resources/accounts/subresources/subscriptions/methods/get/) 文档，并核对已安装官方 SDK 的单页订阅语义。没有再次搜索相同资料，也没有修改现有关闭观察传输的路径白名单。

读取范围固定为既有账户 `7ea8e46d8210bad342fa7595f7935fea` 的以下顺序：

`account-settings → subscriptions → account-settings → subscriptions`

最多四次 GET，无重试、任意 URL / account 选择、创建或更新订阅、发票 / 支付方式查询、SQL 或部署接口。单请求最多 20 秒，观察网络链整体最多 60 秒；同步文件操作无法被 JavaScript 定时器抢占，组件在新请求和阶段准入处检查时间，不能据此声称任意主机文件系统操作都可强制取消。正文解码后最多 2 MiB、4096 次读取；拒绝错误状态、错误正文、非法 UTF-8、超限、截断和不支持的编码。压缩 Content-Length 不与已解压正文长度错误比较。

订阅接口按官方 SDK `SubscriptionsSinglePage` 使用，不猜测分页参数；若返回分页信息，则校验 count / total_count、page、total_pages、per_page 和后续 cursor，拒绝已知的非完整单页结果。最多检查 1000 条订阅、16 条目标产品记录；不是只取首个匹配项。

仅精确的 `workers_paid` 产品、`account` 作用域、`Paid` 状态和当前有效期间能够形成候选，必须恰有一个符合项。其他产品即使 state=Paid，也不证明 Workers Paid；default_usage_model 只是配置记录。价格不硬编码为 5，不以价格为零否定合法折扣，也不从价格推算余额或测试开销。

校验真实日历和 UTC 时间，保留至纳秒的小数精度比较，使用开始包含 / 结束排除区间；当前有效期间必须覆盖整段观察。拒绝缺失、未来、到期、重叠和前后漂移的套餐证据。主机墙钟倒退或与单调时间明显分离时失败关闭。

两轮仅对相关 Workers Paid 投影及默认 usage model 做一致性核对，不保留其他产品订阅、付款资料或 API 原始正文。无关产品的变化不被误判成 Workers 套餐变化。保留目标订阅 ID、产品 / 状态 / 有效期 / 币种 / 价格及响应摘要；不保存 Token 或环境变量值。

## 留证与失败行为

导入 / 构造不创建目录或发请求；`run()` 在独立 `byok-d1-paid-plan-reservation` 中一次性保留日志与结果。父目录真实路径和链接检查、`wx` 创建、短写补全及 fsync；请求前刷盘 PENDING。相同对象不重放，新对象不能接管既有目录，失败样本不覆盖。

取消、超时、日志 / 结果落盘失败均不能返回可用的套餐观察。迟到的 fetch 或正文不会改变已结束结果 / 日志；不声称本机放弃等待等于远端已停止。文件系统故障只暴露固定错误，不输出底层错误正文或凭据。

成功仅返回 `paidPlanObserved=true` 的时间点证据以及证据摘要；`fullPreflightPassed=false`、`budgetVerified=false`、`subscriptionCreated=false`、`snapshotIsAtomic=false` 始终保留。该报告不能直接作为任意未来执行的 `actualPaidPlanVerified`，更不能替代其他六项准入证明。完整 `byok-d1-operator` 预检提供器仍未接通，原有操作器与八个维护守卫没有改动。

## 本地验证

报告：`.wrangler/staging/byok-paid-plan-v281-local/result.json`。**216 PASS / 0 FAIL**：

| 范围 | 通过数 |
| --- | ---: |
| 新套餐组件源码 | 71 |
| 新套餐组件 Node ESM 打包产物 | 71 |
| 现有固定只读传输 | 52 |
| 现有三目标旧代码归档 | 22 |

覆盖付费产品误判、免费 / 其他 Workers 产品、有效期和亚毫秒边界、重复 / 重叠订阅、前后漂移、部分分页、正文 / 编码 / 大小限制、取消 / 迟到、旧目录、父目录链接、PENDING / 最终日志 / 结果文件失败、关闭失败和部分写入。打包复测不算互不重叠的新业务场景。

这是主机组件与相关回归，未重跑全部项目测试、TypeScript、Wrangler dry-run、Node 22 或原生 Workers / D1 用例。没有 Worker 或业务结算源码变化，不继承历史测试数量冒充本轮结果。

## 真实只读验证

窗口 **2026-09-21 06:03:27.788–06:03:34.777 UTC**，耗时 **6,989 ms**。4/4 GET 成功，10 条刷盘日志哈希链校验通过，两轮投影一致：

- default_usage_model：`standard`。
- 产品 ID / 名称 / 作用域：`workers_paid` / `Workers Paid` / `account`。
- 状态：`Paid`；期间为 **2026-08-29 至 2026-09-29 UTC**。
- 币种 USD、订阅价格字段 5；这是已有订阅，不是新建订阅或本轮新增 US$5 费用。

本轮没有读取累计测试使用量、发票或可用余额，因此 `billingUsageRefreshed=false`。首轮累计 **US$2 上限不重置**；历史 US$1.20 / US$0.80 预留仍不能当作已核实余额。

发布时核对 v280 的 11 项文件与八个维护守卫，以及本轮 20 项材料；没有声称重新验证更早全部依赖树。实际 BYOK 执行保留目录仍不存在。云写入、部署、D1 SQL、公开 Worker、模型及 KMS 调用均为 0。

## 下一步

外部权限 / Pages 契约问题仍约束真实部署分支；没有新回复时不重复查询既有 403 / 404。同一 C02 内可以继续完成无云写入的预检组件，不能将组件通过升级为完整许可：

1. 补候选及证据来源冻结、完整预检的来源绑定与失效检查；把本组件和已有旧代码归档接入可信收集路径。
2. 取得 11 个 Zone 路由访问、Pages 身份 / 404、Dispatch 可见性及实际独占 / 外部 D1 写入来源证明；预算与数据库基线另行取证。
3. 当次完整预检和真实维护时序满足后，再执行已授权的现有 staging 原生 BYOK 验收。5/10/15 秒、数据库围栏和未知不重放规则不变。

C02.G / C01 与后续依赖继续未通过。不得因为当前已有付费套餐而跳过原生查询资源 / 时长限制验证或自动部署。

[机器证据](./C02-byok-d1-paid-plan-v281-results.json) · [外部事实与准入矩阵](./C02-byok-d1-pages-targeted-v280.md) · [未外发的支持草稿](./C02-pages-provider-questions-v280.md)
