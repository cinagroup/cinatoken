# C02 — SSE 快照探针入口与混合结果测试收尾

2026-09-08；Checklist v1.93。状态：LOCAL_PASS。专项 42/42、与既有 827 项合并的 869/869 及 staging 类型检查通过；失败/取消/跳过均零。不是新的云端验收，C02.G 保持开放。

## 新增实现

[独立 staging 入口](../../../../packages/proxy/scripts/staging/images-sse-snapshot-gateway.ts)组合现有耐久 SSE gateway、私有 service-binding transport 和 v1.92 快照探针。没有修改生产默认入口或旧候选入口。

`x-c02-sse-snapshot` 只选择固定故障，不是授权：有 header 时只接受精确 `/v1/images/generations` POST、JSON content type、无 query/hash 和 D1 绑定；文法拒绝额外时长/任意模式。随后仍经过真实 API-key 鉴权、模型/预算/租户检查。探针 header 在进入共同 handler 前删除，原始 body 流和 signal 保留，没有第二个 JSON 消费者。无 header 时仍走原耐久 SSE 行为；其他合成租户的 header 不能消费当前请求的探针。绑定类型复用已有 Wrangler 生成的 `ImagesStagingEnv`，未新增绑定。

[测试收尾模块](../../../../scripts/deploy/staging-sse-snapshot-reconciliation.mjs)支持同一合成 fixture 最多六类不重复的 profile。每个请求、快照探针与私有上游 success 探针都必须具有唯一精确身份；使用当前 completed-window 上游的 completed/DONE/terminal 观察，而不是用普通 EOF 推断成功。

收尾顺序如下：

1. 根据实时状态关闭 staging Access / 入口并回收指定临时令牌；即使请求日志元数据不完整，也先完成这项防护。
2. 验证固定 staging D1 UUID / 名称，撤销精确 fixture key；不接受生产目标或自选数据库。
3. 对每条请求复用现有安全窗口：started/headers 后 350 秒、finished 后 30 秒的最大值。模块不自行睡眠，不把超时当作结算证据。
4. 读取六类耐久事实、两类探针及用户/key；有快照的请求必须已经 committed，并通过既有完整摘要、金额、回执、lease、日志和终态预算 oracle。pending、blocked、缺失回执均阻止清理，先交给独立消费者恢复。
5. `before-fail` 的 failed-before-insert 与 `before-hold` 的 release-timeout 才允许成为 intent-only：恰好一个意图和 dispatched 预算记录，零 snapshot/job/receipt/log。不允许推断一个成功金额、零费用日志或退款。
6. 持久保存完整观察后，在一个 SQL batch 中执行全局数量守卫、精确行值守卫、探针守卫和 fixture 删除；最多 256 statements、每条 100 参数、SQL 100 KB、整个 batch 1 MiB。超过限额直接停止，不拆分事务。
7. 核验精确对象全部消失；提交确认丢失后再次运行，空状态只核验、不重放推理或账务。

未知预算不会先改成 settled/released。只删除明确属于测试 fixture 的 reservation 和整个合成账户，放在同一事务中；没有真实用户的余额更新、退款、账单补造或生产清理规则。保留原始观察是数据删除的前置条件。该规则不适用于真实客户 intent-only 对账。

## 测试证据

新增 42 项检查，真实共同 gateway → 当前私有 upstream → SQLite 68 份正式迁移及三份恢复草案 → 独立消费者 → 精确清理。外部 fetch 禁止，Access/D1 管理 API 用固定关闭状态适配器；不是 Cloudflare REST 实跑。

- 六类故障同批：before-fail、before-hold 不释放形成 2 个 intent-only；其余 4 个成功结算。清理前六表数量依次为 `[6,4,4,4,4,6]`，保存未知预算 200,000 micros 的原始事实，然后原子清理并重复清理。
- 两个 hold 正常释放均被识别为已结算；job-read-fail 的 pending job 在独立恢复前阻止删除，恢复后只产生一次费用。
- 观察保存失败、删除中途失败、删除提交后丢 ACK、行值/探针变化、观察后新增意图、错误数据库、未到安全窗口及缺失请求身份均受保护。
- 11 种混合事实污染被拒绝，包括错误租户、未知预算被伪造为终态、pending job、错误金额/摘要、缺失回执、多余意图和非终态探针。
- 入口拒绝错误 method/path/query/type/header/driver；有效探针 header 不绕过缺失/错误 API-key。无 header 和跨租户 header 保持原始业务路径；额外 journal 文法/身份错误拒绝进入数据清理。
- 清理后所有本地表计数恢复基线；另一个完整合成 fixture 的用户、workspace、key、模型、provider、路由和 endpoint 行逐字段未变。

首轮 33 项开发检查有一项测试夹具失败：试图直接插入 dispatched reservation，被真实初始状态/准入触发器拒绝，未形成预期“晚到记录”。后改为数据库允许的晚到意图，专门验证观察后的数量守卫；没有删除、改写或关闭触发器。随后 9 项收尾故障重跑通过，完整新增 42/42 通过。测试记录保留本地与真实平台的区别，不把手工 SQL 竞态注入称为真实平台故障。

[机器证据](./C02-images-sse-snapshot-reconciliation-results.json)保存专项、合并回归、类型检查和源码摘要。CI 配置 Node 22/24，但本机实跑 Node 24.14.1；Node 22、远程 CI、Workers 线上探针均未运行。本轮按 Workers best-practices 技能保留 body 流、原始 signal、receiver-bound waitUntil 与私有 transport，不使用全局请求状态或随请求指定的任意故障；参考 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。

## 下一步与费用

下一步准备独立 gateway 发布包和新版本有界操作器，复核冻结输入、Access、staging/生产隔离、恢复消费者调用路径及累计费用，然后执行云端六类快照接受故障矩阵。必须在 finally 中使用本模块关闭/收尾，不能继续用仅接受已结算任务的旧清理器；所有独立消费者操作只处理已存在快照，禁止重新调用模型补账。

本轮没有创建/部署/迁移/删除云资源，没有管理 API、公开推理、模型或 KMS 调用；没有重新核验云端实时状态。最近真实 staging 仍为 v1.91，首轮公开 HTTP 累计 292、模型/KMS 累计 0；US$2 上限不重置，最终增量账单未核验。

线上 INSERT 确认故障、15 秒 Workers 交付确认、账务提交中取消、原生平台终止与独立恢复/去重、完整物理容量仍待验收。真实用户未知结算策略、完整 C02.G 与 C03–C20 不关闭。
