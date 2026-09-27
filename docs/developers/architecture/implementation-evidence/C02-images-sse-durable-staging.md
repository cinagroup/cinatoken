# C02 — 耐久 SSE 真实 Workers / D1 staging 闭环

2026-09-08；Checklist v1.90。状态：STAGING_SUBSET_PASS，九类真实 Workers / D1 用例与完整收尾通过；C02.G 不关闭。

## 实际发布与隔离

承接 [v1.89 冻结候选](./C02-images-sse-durable-candidate.md)。只读预检重新验证四个 staging Worker、三个生产配置指纹、两个 Access 应用、已回收令牌及独立 D1：295 个 schema 对象、56 张表计数与 v1.86 收尾基线相同。预检 D1 读取 672 行、写入零行。

仅更新 `cinatoken-proxy-staging`，100% 版本为 `93ca506d-15ee-47e8-a162-dd16f0a4a3de`。冻结 JS SHA-256 为 `2715bba5398d42743c2faa830d55d6ed6e48be7f347029bf7e920f882f8df261`，云端 content/v2 回读匹配。使用 no-bundle 发布，禁止自动配置和资源创建；CLI 发布、源码回读及隔离核验均通过。私有上游、恢复消费者和控制器未重新部署，绑定及 CPU 1000 ms 上限未改变；生产资源与数据库 schema 未写入。

本候选显式启用 `streaming:true`，并非更改生产默认值。Wrangler 技能用于冻结包发布与实际版本回读；Workers best-practices 技能用于保留私有 service binding、流式交付、真实计时及独立后台结算边界。参考 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)；本地测试和 dry-run 不替代线上证据。

## 验证范围与结果

九类固定用例均通过：success、provider-error、partial-provider-error、invalid-json、early-eof、usage-limit、property-limit、cancel、deadline。每次推理仅调用私有合成上游，不调用真实付费模型或 KMS。Access 无身份/错误身份/有效身份检查独立于九次推理记录。

每个用例核对真实 SSE 帧、可信 request_id、一次出站、上游终态、日志状态与费用、预算余额，以及累计出站意图/快照/已 committed 恢复任务和本次提交回执。capacity 拒绝的日志费用为零，预留保守消费另行核对。deadline 必须实际等待 295–325 秒并观察约定错误；不是注入时钟或任意超时都算成功。

deadline 实际耗时 **302,668 ms**，约定的 server_error 和超时消息匹配，私有上游终态为 request_abort。九类成功/错误/取消/超时请求各有一份日志和已 committed 恢复任务。三项 Access 检查分别为 401 / 401 / 200，九项 SSE 检查与四项收尾/隔离/源码检查全部通过。本轮原始运行结果 PASS，独立只读 artifact 校验器也通过，无推理重跑。

机器证据见 [结果清单](./C02-images-sse-durable-staging-results.json)。保留 v1.89 的 776 项本地测试证据并重新核对其全部源码摘要，本轮没有重新跑这 776 项；也没有新的 Node 22 或远程 CI 验收结果。

## 真实远端收尾

使用 v1.89 已测试的 `reconcileDurableSseStagingRun`：先关闭 gateway，按真实状态撤销/删除本轮精确命名令牌，关闭 service-auth redirect 后恢复 deny-all，再撤销 fixture key 并等待有界在途执行结束。测试请求时间、headers 时间和完成时间共同决定清理最早时间，不以“已读完响应”替代静默期。

六类耐久记录必须齐全且已结算，观察结果须先写入本轮证据文件，再执行具有逐行条件断言的原子 D1 batch。调用方设置最多 256 条语句、每条最多 100 个绑定参数/100 KB SQL、整批请求不超过 1 MiB；不拆分原子清理事务，不重放推理。最后核对全表基线、三个生产指纹和全部测试 Worker 的入口、域名、Cron 与版本。

真实远端收尾通过：出站意图、快照、恢复任务、回执、日志、预留六类记录各九条先保存观察，再删除本轮精确测试记录及 fixture；56 张表计数恢复原基线，295 个 schema 对象摘要不变。本轮测试账号的 100,000 micros 成功费用及两次各 100,000 micros 的保守预算消费仅是合成账务值，不是模型或 Cloudflare 实际支出。

临时令牌已删除，gateway Access 恢复 deny-all / redirect off；四个测试 Worker 的 workers.dev/preview 均关闭，无自定义域名或 Cron，三个生产配置摘要未变。Access 更新时间变化导致其新摘要为 `57ee3e11516d948fedebb808eba9789ed6749d9c00f7ca7dc835beb33eed5bb0`，去除 API 记账时间后完整业务配置与运行前一致。所有清理前的账务观察保留在本地原始证据中；未删除任何生产数据。

## 费用边界

最新可见 Workers/D1 账务条目的 ContractedCost 均为零，但数据按账期/日期延迟呈现，不能证明本轮最终增量费用为零。没有新套餐、订阅、充值或密钥操作。沿用首轮累计 US$2 限额；本轮操作预留将既往/延迟费用预留从 US$1 延续为 US$1.05，另为本轮合成试验预留 US$0.05，未分配预留 US$0.90。这些是操作预算，不是实测花费或可支配余额证明。

D1 按行读写计费：本轮编排管理 API 记录 2,388 行读 / 248 行写，加预检 672 行读，合计已观察 3,060 行读 / 248 行写；不包括 Worker 内部查询及 Wrangler 内部操作，不能充当整轮总计。[D1 价格与计量说明](https://developers.cloudflare.com/d1/platform/pricing/)、[Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)用于预算检查。公开测试 HTTP 新增 12 次，首轮累计 **287 次**；付费模型 / KMS 累计仍为零，最终增量账单未核验。

## 下一步仍有实质门禁

1. 真实客户端在成功 DONE 后立即取消/abort，与仅 completed 尚未 DONE 的对照；当前 cancel 用例只覆盖 partial 后取消，不能拿它证明 DONE 后竞争已验收。
2. 在真实 D1 快照/任务接受前后设置严格绑定测试身份的暂停和丢确认探针，观察 DONE 是否被持久化确认约束及 15 秒未确认错误。既有 storage-fault 仅拦截日志 batch，不能用于证明快照独立 INSERT 的故障边界。
3. 使用原生平台终止及独立恢复消费者验收 SSE 的补账和去重。普通 Images 的既有平台终止结果不能自动扩展为 SSE 通过；本轮快速路径 committed 也不证明消费者恢复经历过故障。
4. 只有 intent、没有快照时保留不明结果和预算，不自动重放、编造精确费用或删除记录。继续补对账来源，再完成实例物理容量及其他 C02.G 项，最后评估生产启用。

九类基础云端闭环即使通过，也只能标记 STAGING_SUBSET_PASS，不能标记完整 SSE 恢复、物理容量或生产可发布。
