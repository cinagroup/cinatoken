# C02 — SSE 快照首次线上故障测试与平台差异

2026-09-08；Checklist v1.95。状态：STAGING_PARTIAL；六类矩阵结果 FAIL，不能关闭 C02.G。最终本地 935/935 通过，线上仅 `before-fail` 已按预期验证；其余场景继续待验收。

## 发布与隔离

使用 Wrangler 技能复核当前安装版本/schema、冻结输入及离线发布，再发布已准备的独立 staging gateway。版本 `811db92e-5a07-437a-ab41-79ee35275975`；云端 JavaScript SHA-256 与冻结候选一致：`19eaaa96fa23ea7714239e978d59704f2021dc6ce37e14751a0bce8d010dfcba`。发布前后 settings 指纹完全相同，未改绑定、CPU 配置、生产默认入口、生产账务、数据库结构、上游 Worker 或真实密钥。

按 Workers 最佳实践保持私有 service binding、原始请求流与 receiver-bound waitUntil。正式测试前核验四个 staging Worker 的版本/settings、关闭入口、空 custom domains/crons，两个 Access app、三份生产 settings 指纹，以及 D1 的 295 个 schema 对象与 56 张表基线；没有重放已应用迁移。两个临时 Access 策略均以指定服务令牌保护，缺失/错误令牌被拒绝；控制入口有效令牌但无 command header 时返回 400，未调用恢复消费者。

## 两次实测及原因

| 尝试 | 已观测事实 | 结论与处理 |
| --- | --- | --- |
| 第一次：7 次 HTTP | 首个 before-fail 请求为 503；快照探针 failed-before-insert，上游探针仍 armed；一份意图和 dispatched 预算，零 snapshot/job/receipt/log | 测试脚本以 runId/mode/probeId 顺序序列化，而上游重新解析后以 runId/probeId/mode 构造字节级 CAS 初始值。完整本地网关/SQLite 复现相同 503。修正操作器序列化，不改已部署上游或账务算法 |
| 第二次：9 次 HTTP | 新身份的 before-fail 返回 completed、结算未确认 error、唯一 DONE；上游 completed/DONE 各一次，随后 request_abort；一份未知预算保留 | 此场景通过。DONE 是协议结束符；有结算未确认错误时不代表客户端已获成功结算确认，也不得自动重试 |
| 第二次的 after-ack-loss | 客户端正常 completed/DONE；数据库实际存在 snapshot、committed job、receipt 和一条 0.1 合成计费日志；探针却是 insert-not-applied | 预期故障标记未命中，停止剩余四类，不能记作 after-ack-loss 场景通过。真实快照/摘要/回执/日志/预算通过既有耐久财务 oracle；没有退款或重放推理 |

第二次暴露的探针假设是 `result.meta.changes === 1`。Cloudflare 对 `changes` 的说明使用 SQLite `sqlite3_total_changes()`，该计数包含触发器变化。用本项目全部迁移、真实保存的合成意图/快照，在本地执行同一独立 INSERT：直接 changes 为 1，total_changes 增量为 2，恰好生成一条 snapshot 和一条触发器 job。[Cloudflare 字段说明](https://developers.cloudflare.com/api/typescript/resources/d1/)、[SQLite total_changes](https://www.sqlite.org/c3ref/total_changes.html)。

**本次未保存原生 D1 返回对象中的具体 changes 值**，不能把本地的 2 写成已直接观测的云端值。代码、真实已提交事实、官方语义及本项目 SQL 实验共同说明“固定等于 1”不能作为单条 snapshot 是否插入的证明。该 Worker 探针尚未修正；下一候选需记录有界原生结果元数据，并以真实持久化身份/摘要与触发器事实验证，不能仅删除断言后宣称通过。

## 新增实现与本地验证

- [操作器夹具合同](../../../../scripts/deploy/staging-sse-operator-fixture.mjs)：通过与 Worker 相同的 prompt parser 构造 canonical row，六种对象字段顺序产生完全相同的初始 CAS 字节，非合同字段不进入行值；同时提供只适用于一条 before-fail/armed 上游的失败测试精确收尾计划。
- 13 项专项涵盖真实 503 复现、canonical 修正后 SSE completed/error/DONE、未知测试记录原子收尾及守卫竞态。初始 13 项中有两项测试夹具错误：错误地在已脱敏日志中寻找异常原文、复用唯一 dispatch_claim_id。分别改为检查后台拒绝原因与独立 claim ID，没有放宽日志脱敏或数据库约束。
- [平衡式完整行守卫](../../../../scripts/deploy/staging-sql-row-guard.mjs)：完整保留观察字段与参数顺序，避免把 76 个谓词连接成过深的左结合树；新增 9 项检查覆盖 1/2/14/76/100 列、标识符拒绝、变更行拒绝及事务回滚。
- 最终 22 项新增 + 既有 913 项 = 935/935；另有本项目触发器行数实验通过。Node 24.14.1 实跑；新增 CI 配置 Node 22/24，但 Node 22/远程 CI 未运行。本轮没有修改 Workers 源文件，候选类型检查沿用 v1.94 冻结证据，而非重复宣称新类型检查。

## 收尾完整性

两次操作器均先关闭网关与恢复控制 ingress、禁用令牌、关闭 redirect、解除两边策略引用后删除令牌，再撤销合成 API key并等待固定安全窗口。原通用收尾器分别拒绝 armed 上游及 insert-not-applied 标记；保留失败，没有篡改探针 phase 来让它通过。

随后使用两份固定 run ID 的受限收尾脚本，先保存完整观察、单独验证 intent-only 或真实已结算财务事实，再用数量/所有行值守卫在单一原子 batch 删除自有 fixture。未知预算连同合成账户被删除，**不是退款**；真实成功日志和回执在删除前保留证据，不补造用量。

第二份收尾第一次被 D1 HTTP 400 拒绝。只读重查确认所有观察行未变；仅执行 SELECT 守卫复现 `Expression tree is too large (maximum depth 100)`。原因是临时收尾脚本对完整 76 列日志构建了过深谓词，而非账务记录不一致。改为平衡表达式后，22 条完整守卫先通过真实 D1 只读检查，再执行同一语义的原子清理；没有删减字段校验或拆分事务。最终两组 fixture 均删除、56 表恢复原基线、两个 Access 为 deny-all 且入口关闭、临时令牌缺席、生产指纹不变。原始失败、SQL 拒绝和修复后的观察均保留在[机器证据](./C02-images-sse-snapshot-staging-results.json)。

## 下一步与费用

下一项仍为 C02.B2.2：先修正快照探针的 D1 changes 假设及本地元数据模拟，使用新冻结 gateway 候选；继续使用 canonical 夹具和有界错误响应诊断。重新核验隔离与预算后，以新的测试身份完成六类线上矩阵及 15 秒交付确认，再运行独立消费者恢复/去重。当前两次均未调用恢复消费者，不能从既有 committed 快照推断该独立路径已于本轮验证。

本轮两次共新增 16 次公开测试 HTTP，首轮累计 308；包括三次合成推理尝试，真实付费模型/KMS 累计仍为零。一次 staging gateway 发布；管理 REST 调用及成功返回的 D1 行计数见机器证据，Wrangler 内部 API 调用数未被推断为零。首轮累计 US$2 不重置；保守预算预留不是实际支出，账户级可见账单有延迟，最终项目增量账单仍未核验。

提交中的客户端取消、原生平台终止、完整恢复/幂等接口、真实客户 intent-only 策略、完整跨消费者物理容量与 C02.G 保持开放。用户确认的“有效 completed + 实际上游 DONE”为不可逆成功结算点的政策不变。
