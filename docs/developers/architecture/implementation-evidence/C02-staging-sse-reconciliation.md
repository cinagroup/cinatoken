# C02 — SSE staging 可恢复收尾合同

2026-09-08；Checklist v1.87。状态：**LOCAL_PASS**。承接 v1.86 的超时断言、Access 恢复顺序和预算行残留问题，新增操作侧模块及回归；未改生产运行时、冻结云端脚本、金额政策或已发布 Worker。

## 实现

`scripts/deploy/staging-sse-reconciliation.mjs` 提供共享入口 `reconcileSseStagingRun`，组合 Access 收尾与精确数据清理；同时导出 deadline 断言、终态预算/探针清理规划和最早清理时间计算。它不读取凭据、不联网、不创建计时器、不重放推理。调用者传入有界、无写入自动重试的账号级管理适配器，以及绑定已核验 staging D1 的原子 batch 适配器。

Access 按当前状态推进：关闭指定网关 ingress → 精确名称/ID 查找并禁用本轮 token → 关闭 service_auth_401_redirect → 恢复唯一 denyEveryone → 删除 token → 重新核对关闭状态。固定核对 app/domain/audience/destinations/policy，遇到其他身份、额外策略、重名 token 等漂移停止。即使推理 request_id 尚未记录，关闭入口仍可执行；缺少身份归属证据不猜测或删除别人的 token。

顺序依据 [Access service-auth 401 设置](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/)及 v1.86 已记录的 12130/12139 实际反馈。写操作返回不明后，重新调用会先读取真实当前状态，而非依赖“已完成”内存标记；中间检查点不包含 client_secret。已完成的 Access 收尾再次调用仅做读取。

数据清理先核验固定 staging D1、关闭入口和 deny-all，再撤销精确合成 Key。最早清理时刻取已记录请求开始/响应头后 350 秒、响应完成后 30 秒的最大值；未到时返回带 resumeAtMs 的待清理错误，不阻塞等待，也不删数据。未知请求身份、非终态探针或预留继续保留，不能靠时间到期推断成功或退款。

预算记录只允许本轮已知请求：普通结果须为 settled / request_usage_settled，两个容量错误须为 expired / usage_unavailable_after_dispatch；验证对应金额、用户、Key、epoch、终态时间后才生成 SQL。探针须精确匹配 key/description/runId/probeId/mode，且为 armed 或 terminal。观察结果必须先交给调用者持久化，之后才可删除。

每个删除附带事务内完整观察值守卫；观察后金额、状态或更新时间变化会让整个 batch 失败，而不是静默跳过一行后继续删除归属记录。后续 fixture 清理批次再次检查没有新预留、未释放预算、耐久意图/快照/恢复任务及用户身份漂移。不会执行日志文件内提供的 SQL，只复用已固定的 fixture 构造器；探针与模型/供应商/Workspace/Key/User 等清理后再次核对存在性。

原子性依赖适配器遵守 [D1 batch 事务合同](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)。局部提交后丢确认通过下一次读取继续处理，不重新推理。本模块没有新增接受任意 SQL 的公网端点，也没有把 D1 权限交给租户。

deadline oracle 直接复核冻结的真实 301.099 秒证据：精确 partial/error/DONE、server_error 加超时消息、可信 request_id、对应 run/probe、一次日志、完整已知请求集合、累计合成预算与零预留。拒绝错误码猜测、重复结束事件、其他探针、兜底 expiry、错误累计预算及隐藏畸形帧。它是本次合成合同断言，不是通用 SSE 解析器。

## 验证

最终 **115/115**，失败/取消/跳过均零：

- 新增 62 项操作专项：每个 Access 写入前失败/提交后丢 ACK、五个检查点中断、重复收尾、token-create 确认丢失、资源/身份漂移，以及真实 SQLite 的事务回滚、提交后丢 ACK、观察持久化失败、晚到预留、耐久意图阻挡、错误数据库和用户归属变化。
- 新增 9 项公开 handler → 私有上游 → SQLite → 新收尾模块完整链测试，覆盖全部既有 SSE 模式。每例清理及重复清理后，全部业务表计数回到种子前基线，包含之前遗漏的预算预留与探针。
- 既有 SSE 探针/链路 41 项、普通 fixture 3 项复测通过。历史 795/795 与 508/508 全集合没有本轮重跑；不冒充新的完整回归。

首轮专项 55 项中 22 项失败，原因均在测试夹具：两个租户复用唯一 key_hash、错误期待第六个检查点、模拟后端路由随 journal 的 tokenId 删除而变化。使用独立合成哈希、精确五个检查点和固定后端身份后修正，初始输出保留。没有为通过测试放宽运行时金额或清理归属要求。

[机器结果](./C02-staging-sse-reconciliation-results.json)记录 150 个源码/配置、241 个操作 artifact、19 个证据依赖，共 410 项主清单及原 779 个 bundle 输入摘要。v1.86 的 402 项主清单及 bundle 输入全部按当前字节复核；没有原地改写冻结历史。

## 使用边界与下一顺序

下一版云端操作脚本应调用共享入口，并提供持久化 journal（runId、合成 Key 哈希/到期时间、已发送请求的 ID/模式/时刻、探针列表、临时 token 名称/ID）。API 和 batch 适配器仍须限定账号、目标 D1、响应大小、请求次数和费用；SQL batch 必须是原子事务。尚未安装独立无人值守 CLI，也没有用新模块再次在线清理，不能宣称无人值守生产收尾已验收。

外层操作器仍负责当前部署/源码摘要、全部资源入口、所有表计数、schema、生产指纹和累计费用复核；该模块不取代这些门禁。没有永久后台监控或自动重试授权。

本轮未部署、未调用 Cloudflare 管理 API、模型或 KMS。最近云端证据仍为 v1.86；首轮公开 HTTP 累计 **275**，累计新增 **US$2** 上限不重置，最终增量账单未核验。云端关闭状态作为历史证据继承，不声称本轮重新读取。

下一实施顺序：先补 SSE 完成图片、DONE、取消与结算前终止的本地故障合同；涉及金额政策变化先确认。再实现 SSE 耐久意图/快照/原子回执与恢复消费者，将本收尾模块接入新版本操作器，在相同隔离与预算下做云端故障验收。之后继续物理容量/并发、其它模态、Node 22、Google Cloud KMS 等未完成门禁。

C00 LOCAL_PASS；C01 DOING；C02 DOING；C03–C20 TODO。C02.B2.2 / C02.G 保持开放。
