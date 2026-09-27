# C02.B2.2：真实 Workers 在途取消与后台记账子集

2026-09-07。**最终 9/9 项检查通过**：5 个 Images 用例与 4 项 Access / 健康 / 鉴权目录检查。三次云端尝试依次暴露、修复两项实际缺陷；前两次仍记为 FAIL，不改写历史。**C02.G 未通过，生产容量池未启用。** 首轮累计新增费用上限 US$2 不重置。

## 1. 结果与修复过程

| 尝试 | Gateway 版本 | 用量日志 / 尝试事实 | 结论 |
| --- | --- | --- | --- |
| 1 | `61a59281-5b1e-47ec-9b34-7f30a3a75d92` | 2/4；事实查询未执行 | FAIL：两次在途取消已到达上游，但取消用量日志缺失 |
| 2 | `1f3ece9f-9882-4ae7-b7dd-0366e38d53d4` | 4/4、3/4 | FAIL：入口生命周期修复生效；响应头前取消仍漏尝试事实，正文中取消被记作 available |
| 3 | `6a32bee7-b025-48f8-9452-7a48adace8f0` | 4/4、4/4，分类逐条匹配 | PASS：成功两条、取消两条；每条仅一次尝试，取消均 excluded/client_cancelled |

[脱敏结果与 13 个源码摘要](./C02-staging-image-cancellation-results.json) 保存三个尝试的请求、上游观察、实际日志、部署及收尾结果。前一批 [大包 / 交付证据](./C02-staging-image-large.md) 仍是对应旧版本的历史快照，不替换其源文件散列。

第一项修复在 [共同 Worker handler](../../../../packages/proxy/src/runtime/worker-handler.ts)：进入 app 前同步注册 `waitUntil`，保留请求控制流，允许断连后的路由取消处理继续登记自己的后台记账任务。此前只在路由后段登记，线上两条日志缺失；本地新增“入口必须立即持有”的两项回归先失败、修复后通过。该 Promise 不预读 / drain 响应正文，不替代后台任务的独立持有。

第二项修复在 [Images driver](../../../../packages/proxy/src/services/egress/openai-images-driver.ts) 和 [尝试计时器](../../../../packages/proxy/src/services/request-timing.ts)：普通生成 / 编辑把取消转换为 Response 返回，未进入 dispatcher 的 thrown-error 分支，导致缺少或错误分类尝试事实。现在只对**已 dispatch、未收到明确非 2xx 拒绝的客户端取消**写入 excluded/client_cancelled；保留已收到的真实 HTTP 状态。发送前取消不伪造 I/O，已收到的 400 拒绝不被覆盖。扩展后的两项真实 SQL 链路断言再次先失败后通过；另补生成 / 编辑各四项边界测试。没有新增推理、改变收费规则或把取消当成供应商未执行证明。

## 2. 独立上游观察方法

私有上游 `cinatoken-staging-images-upstream` 当前版本 `e9bb6c18-d99b-40ba-8b34-62fc95f598f6`，部署 `0f240c24-30b0-437c-ad7d-04658f7115ca`（02:41:47 UTC）。本批增加唯一数据绑定 `PROBE_DB`，只指向现有 staging D1 `6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1`；因此前一批“无数据绑定”描述仅对旧版本成立。没有新库、表或迁移，没有外网 / 模型 / KMS 调用。公网、预览、路由、Cron 始终关闭，CPU 上限仍为 1,000 ms。

[探针合同](../../../../packages/proxy/scripts/staging/images-probe-contract.ts) 只接受固定格式 run UUID / probe UUID 和三种模式，不接受 URL、任意延迟或秘密。上游只对完整且不超过 1 KiB 的 JSON 捕获 prompt；普通大包仍增量散列，不缓存完整正文。

[观察实现](../../../../packages/proxy/scripts/staging/images-probe.ts) 只更新由编排预先创建的五个 `system_config` 临时键，按 key + ownership description + 旧 value 做 CAS；未 armed、重复调用或状态变化时失败关闭。每次最多三个事件、15 秒持有，release 对照为 250 ms。headers/release 各两次状态更新，body 最多三次；无匹配行时不插入。初始观察和终态写入均显式受私有 Worker 的 `waitUntil` 保护。

客户端通过独立 D1 查询**确认 started 或 body-prefix 已提交后**才 abort，不靠固定睡眠猜测上游开始。两次取消最终均记录 request_abort 且 signalAborted=true；不是单凭客户端 AbortError 判通过。观察器保持合成上游存活仅为记录终态，不能据此推断真实供应商停止生成或退款。

Gateway 最终部署 `4d8bd847-d759-4d16-a171-91bf90ee86be`（03:06:42 UTC），仅 staging 发布，保持九项绑定、独立限流、正文日志 off、无 Cron/Queue/R2/Hyperdrive。Gateway 构建中没有探针处理代码或 PROBE_DB 绑定；两个 Worker 不能因此被假定为物理工作集完全隔离。

## 3. 最终云端样本

最终编排 03:07:28–03:10:17 UTC，串行执行；均为小型合成 JSON，图片字段 AQID，不是真实图片质量测试。

| 用例 | 输入与观察点 | 结果 |
| --- | --- | --- |
| 慢上传完成 | 590 字节；先生成 64 字节并暂停，观察 armed，再每 100 ms 生成最多 32 字节 | 200、133 字节响应；一条成功日志 |
| 上游响应头前取消 | 590 字节；确认 started 后取消，客户端尚无结果 | 上游 request_abort；一条取消日志，尝试 HTTP 状态 NULL |
| 上游正文中取消 | 593 字节；确认已输出 JSON 前缀后取消 | 上游 request_abort；一条取消日志，保留上游 HTTP 200 |
| 上传未完成即取消 | 原计划 4,301 字节，只生成 1,024 字节 | 取消前后探针仍 armed；3 秒后复核未启动，该模型无用量日志 |
| 取消后的成功对照 | 590 字节，正常完成 | 200、133 字节响应；另一条独立成功日志 |

取消客户端结果为 AbortError；日志里的 499 是网关内部取消归类，不冒充客户端收到的 HTTP 响应。两次成功响应均携带 total_tokens=10。两次成功与两次取消的 charged / metered / standard / budget_charged_micros 均为零，每条 upstream_attempt_count=1；请求与上游正文日志均 NULL。raw_usage 为 94 / 135 字符，pricing_audit 为 757–2,943 字符。用户预算 / 已花费 / 预留均零；三条被使用 provider 的 marker 升级到 enc:v2:，不是 KMS 接入证明。

四项访问检查全部通过：测试前后无 Access 凭据均 401，授权健康 200，哈希 Gateway Key 返回本轮五模型目录。最终首个 readiness 即 401；第一轮曾出现的暂态 404 只计 HTTP 尝试，不计功能通过。第三轮未降低四条日志 / 四条事实要求，并增加逐条 outcome/reason/http_status 匹配。

第一轮本地墙钟出现倒退，authorized-health 的原始耗时为 -7,262 ms，原值保留。第二、三轮耗时改用 performance.now；程序等待顺序与 D1 状态交接用于因果核验，不比较两端 UTC 推导延迟。任何耗时均不作为 Worker CPU、TTFT 或发行 SLO 证据。

## 4. 本地验证与收尾

- staging 专项 **32/32**，调度安全 **2,686/2,686**，针对两个修复及计时合同的定点 **75/75** 通过；计数有重叠，不相加。
- Proxy、dispatch-safety、images-staging 三套类型检查通过；Gateway 与私有上游 dry-run 通过。Node 24.14.1 / Wrangler 4.127.1，无依赖升级。绑定声明由 Wrangler 生成；本机回归不替代云端结果。
- 三次尝试均关闭 Gateway 公网 / 预览，禁用并删除临时 Access Token、撤销 Gateway Key、恢复 Access deny-all。每次待后台窗口后按精确 run ownership 清理 **27 条种子 + 5 个探针键及其关联测试日志**。
- 52 张非内部表计数均恢复，外键无违规、quick_check=ok。保留的非空数据仍为 revoked 演示管理员 Key 1、迁移 68、库标识 1、system_config 12。合成数据可用 fixture 重建；正常运维日志与 D1 历史恢复数据未删除。
- 私有上游保持关闭、版本不变；每次生产 Proxy / Admin / Chain 设置指纹均与前置基线相同。没有生产发布，也未开启容量池。

## 5. 费用与未完成项

本批三次尝试为 10 + 9 + 9 = **28 次 HTTP**，首轮累计已记录 **89 次**；这是测试编排请求数，不是账号总请求或账单计费请求。三次编排 D1 API 合计 4,687 行读 / 479 行写，三次发布预检另各 82 行读 / 0 写；管理 API 387 次，另发布编排各 23 次。不含 Worker 内部 D1 查询及 Wrangler 内部请求。

付费模型 / KMS 调用仍为 0，没有新增套餐、充值或追加预算。最终 Cloudflare 增量账单未核验，不能报告实际 US$0 或剩余完整 US$2。

按照 Workers 最佳实践提前登记生命周期持有，但 `waitUntil` 在响应结束 / 客户端断开后只有共享的最多 30 秒窗口，超时任务可能被取消；本修复不是持久化恢复保证。[官方生命周期说明](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)。请求取消信号仍依赖 enable_request_signal 配置。[官方 Request 合同](https://developers.cloudflare.com/workers/runtime-apis/request/)。

继续唯一工作包 **C02.B2.2**：

1. 后台延迟、提交确认丢失和平台期限 / 重启恢复；不以 TTL 或重复推理补账。先补受控故障证据与恢复边界，再决定需要的持久化机制。
2. 补剩余取消 / 超时矩阵：大输入仍在途、Images edits / SSE、deadline 和明确上游拒绝。小 JSON 顺序样本不能覆盖这些情况。
3. 完整图像工作集、同配置重复测量、并发与混合消费者，包含 host / DB / GC 余量；小包慢上传并非大包慢上传或反压上界证明。
4. 结合 C01.9 / C01.10 冻结的发行参数计算容量；通过门禁后才讨论启用。真实模型 / OAuth / KMS 使用专用身份和小样本，不发送压力请求。

没有把取消后的独立成功对照称为进程重启 / 持久化恢复，没有把零价日志称为付费退款、卖家结算或 Credential Vault 验收。
