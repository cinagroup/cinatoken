# C02 — Images SSE 真实 Workers staging 子集

2026-09-08；Checklist v1.86。结论：**STAGING_SUBSET_PASS，经独立只读复核及收尾修正**。原始运行结果仍为 FAIL，不改写为一次全绿；C02.B2.2 / C02.G 保持开放。

## 本轮交付

仅发布 v1.85 已冻结的两个独立 staging Worker，未修改生产运行时、金额政策或生产资源。无重新迁移、付费模型、KMS、套餐订阅或充值操作。

| Worker | 当前 100% 版本 | 冻结 JS SHA-256 |
| --- | --- | --- |
| cinatoken-proxy-staging | 6e75bd07-ad88-4ca8-bc8c-1c400fe5f570 | 28109a8326580b5ef56f3136dbf62d4c6294673c290029312c54ab2e40d334e8 |
| cinatoken-staging-images-upstream | b453653b-aa7f-4cb5-8eb3-afdafd2694c4 | 4135c45c50ad3f403d152ef04d0f81349df202107fe6e2b90ccd634c094f0ac7 |

上传使用冻结 JS 的 no-bundle 路径，禁止自动创建资源与自动配置；CPU 上限各 1000 ms。两份云端源码通过 [script content API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/content/methods/get/) 回读并逐字节摘要匹配，不以 CLI 成功代替源码核对。保持独立 D1、私有服务绑定与入口关闭，按 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)开展短时受保护测试。

恢复消费者 b45d752e-361e-45d8-aca7-f24feca4afec、控制器 e3a1830b-cb71-4256-bffe-55d263cf75c9 未重新部署。三个生产 Worker 的 settings 摘要保持原基线。

## 实际请求与账务观察

本轮仅 12 次公开测试 HTTP：无 Access 身份 401、错误身份 401、有效身份 200，以及以下 9 次 Images generations SSE。所有推理仅走合成私有上游，每个用例只有一次出站，没有重放。

| 用例 | 客户端耗时 ms | 名义 charged_cost | 本用例预算消费 micros | 证据结论 |
| --- | ---: | ---: | ---: | --- |
| success | 3446 | 0.1 | 100000 | 原脚本 PASS |
| provider-error | 4010 | 0 | 0 | 原脚本 PASS |
| partial-provider-error | 3902 | 0 | 0 | 原脚本 PASS |
| invalid-json | 3904 | 0 | 0 | 原脚本 PASS |
| early-eof | 4086 | 0 | 0 | 原脚本 PASS |
| usage-limit | 2996 | 0 | 100000 | 原脚本 PASS |
| property-limit | 3881 | 0 | 100000 | 原脚本 PASS |
| cancel | 4667 | 0 | 0 | 原脚本 PASS；首个 partial 后取消，上游 request_abort |
| deadline | 301099 | 0 | 0 | 原脚本错误码断言 FAIL；同一请求独立 wire / D1 复核 PASS |

每个非取消响应只有一组结束事件；错误响应只包含一个 error，公开元数据包含 retry_safe=false 和可信网关 request_id。图片输出前的 provider-error 不声明 outcome_unknown；其它错误声明 true。客户端和供应商伪造元数据未泄露。

deadline 未注入停止信号，也没有把探针 315 秒兜底当成网关 deadline。实际耗时 301.099 秒，得到 server_error 与明确的超时消息、单个 DONE；上游终态 reason=request_abort。独立查询确认第九条日志仅一次、零名义费、零新增预算消费。取消同样有真实上游终态及预算释放证据。

累计合成预算消费 300000 micros，最终预留为零；它是测试账本断言，**不是实际外部服务费用**。两个容量错误的名义费用为零，却保守消费预留；对应预留行终态是 expired / usage_unavailable_after_dispatch。其余七行为 settled / request_usage_settled。保留原政策，不把不同口径混同为“全都没有收费”。

SSE dispatch intent、settlement snapshot、recovery job 数量仍显式为零；这说明本次没有验证 SSE 耐久恢复，不能将成功落库外推为宕机后可恢复。探针 body-prefix CAS 发生在 enqueue 前，不证明客户端收妥，终态观察也不替代账务提交证据。

## 保留的失败与纠正

1. 首次只读预检的表名正则遗漏数字，拒绝 d1_migrations；修正检查器后通过，没有数据库写入。
2. 上游部署成功后，错误的 GET /content 路径返回 405；改用 /content/v2 只读核对。网关部署成功后，30 秒源码回读超时；新只读脚本以有界 90 秒期限完成核对。没有重复部署。
3. 本地复测最初误用 Node strip-only，无法处理参数属性；使用既有 tsx 启动器后 9 项通过，随后完整探针子集 41/41 通过。没有因此修改运行时代码。
4. 云端 deadline 操作脚本错误要求 code 包含 timeout。冻结 driver 实际使用 server_error 加超时消息，原有本地测试也未规定 timeout code。保留原 FAIL；新增只读观察器对同一 request_id 完成精确消息、wire、实际耗时、上游终态、日志和预算复核，没有重发请求。观察器首个本地清单查找错误在联网前停止，新脚本从 bundleInputs 验证当前 driver 摘要。
5. 原清理先恢复 deny 策略、后关闭 service_auth_401_redirect，返回 400/12130；令牌仍被策略引用，删除返回 400/12139。入口已先关闭、令牌已先禁用。按设置的逆序先关闭跳转，再恢复 deny-all，随后删除令牌，均已复核成功。
6. 旧 fixture 清理未覆盖无级联外键的 user_budget_reservations，留下九条终态行。首次收尾校验停止，之后针对精确 request/user/key/epoch/state/amount/updated_at 清理。中间脚本只允许 settled/released，发现两个容量错误采用 expired 后再次停止；独立只读确认其语义，再按用例严格匹配状态和金额删除。未用 TTL 退款，也未删除任何在途预留。

原始失败记录与各次后续脚本分别留档；不能直接重跑旧脚本、覆盖结果或将其作为无人值守流程。

## 最终清理、验证与费用

四个 staging Worker 的 workers.dev、preview、custom domains、cron 均关闭。网关 Access 恢复唯一 denyEveryone，短时令牌已删除；独立恢复控制器 Access 未变。生产配置及 staging 的 D1 / 服务绑定、实际部署版本均核验。

测试用户、Key、Workspace、模型、供应商、日志、探针及九条终态预算记录已清理；清理前的合成数据观察保留在机器结果中。最终 56 张表计数与原基线一致：业务行均零，只有 admin_api_keys=1、d1_migrations=68、model_endpoint_backfill_database_identity=1、system_config=12。schema 仍为 295 对象，摘要 1bc2f70306a5b464f789590e21445ddbb11372b3e2086ce95dcf626168e656f9。

本轮完整探针子集复测 41/41；v1.85 的 staging 795/795、driver/生命周期 508/508 及类型检查作为历史证据继承，**本轮没有再次重跑整个集合**。147 个源码/配置、237 个操作 artifact、18 个证据依赖共 402 项主清单及 779 个 bundle 输入摘要均已核对；摘要证明一致性，不等于独立生产签核。

首轮累计公开测试 HTTP **275**（原 263 + 本轮 12），模型/KMS **0**；累计新增 **US$2** 上限不重置。已读取的账期中 Workers/D1 按量费用报告为零，但数据有延迟，最终增量账单未核验。1 USD 既往/延迟预留、0.05 USD 本轮测试预留、0.95 USD 未分配余量只是操作预算，不是实测费用或平台美元硬停保证。没有新增订阅。

[机器结果](./C02-images-sse-staging-runtime-results.json)包含冻结摘要、原始运行 FAIL、独立 deadline PASS、最终清理 PASS、本地复测及费用口径。最终收尾为 `.wrangler/staging/images-sse-v186-cleanup-final-result.json`；不要只看较早失败的 cleanup 文件判断当前状态。

## 后续有限顺序

1. 先固化并本地测试操作侧收尾合同：正确 SSE timeout oracle、Access 逆序恢复、精确终态预算清理（包括保守消费的 expired）、部分执行后的幂等只读对账。冻结历史脚本不原地修改；尚未具备无人值守收尾门禁。
2. 明确 SSE 成功 DONE、客户端实际收妥、结算事实和耐久快照的边界；补完成图片后取消、DONE 后旧结算前终止等故障用例。涉及金额政策变化时先确认，不顺手改为自动退款或自动重放。
3. 接入 SSE 出站意图、可恢复结算输入与原子回执/消费者，再按相同隔离规则验收提交前失败、提交后丢 ACK、原生终止、重复恢复和一次性计费。
4. 之后继续完整并发/物理内存容量、其它模态与 Node 22 备选 host；Google Cloud KMS 和平台其余工作包维持独立门禁。

C00 LOCAL_PASS；C01 DOING；C02 DOING；C03–C20 TODO。不凭本次九个合成 SSE 用例关闭整体生产门禁。
