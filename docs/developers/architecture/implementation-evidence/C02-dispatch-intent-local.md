# C02.B2.2：耐久出站意图与一次性认领（本地基础）

2026-09-07，子集 LOCAL_PASS；C02 DOING、C02.G / 完整恢复未通过。执行与自检：Codex；独立 Reviewer 未指定。本轮无 Cloudflare 管理操作、发布、远端迁移或模型/KMS 调用。上一轮 [5 次成功仅 4 条用量日志](./C02-staging-image-storage.md) 的线上缺口尚未修复。

## 1. 实际交付

[D1 仓储](../../../../packages/core/src/storage/recovery/dispatch-intent-d1.ts) 为后续恢复链提供可持久化身份，不因零价没有 reservation 而缺席。身份沿用 request/generation id，并加 attempt_index、user/key/workspace、Images operation 与调度上下文摘要；不是新资金账本，也不生成供应商凭据。尚未接入任何生产 factory、route、dispatcher 或 Core 公共出口。

[SQL 草案](../../../../packages/core/migrations-proposals/d1/request-dispatch-intents.sql) 位于 **migrations-proposals**，不进入自动迁移目录、不改变已有 68 份正式迁移。测试在完整旧 schema 上应用一张新表、索引及前向状态 trigger。上云或正式 schema 冻结仍须 C03 门禁，不能直接把此草案复制到生产执行。

| 操作 | 实际合同 | 不能推导 |
| --- | --- | --- |
| prepare | 验证 Key/User/Workspace 归属，保存不可变身份和 deadline；相同身份/期限可回查确认；跨异步等待复制必要标量 | 存在 intent 即有发送权；摘要即完整报价快照 |
| claim | 单条原子 CAS，从 prepared 到 dispatch_claimed；只有本次收到 changes=1 返回 granted | 回查相同 claim id 可以再次获得发送权；认领等于供应商已接受 |
| claim 报错 | 返回明确的确认不确定错误；不读回并重新授予发送权 | 错误表示未提交或允许重试推理 |
| listOverdue | 显式 user/workspace 范围、索引和稳定排序，单批 1–50 条 | 已实现跨租户调度、恢复 SLO 或完整消费者 |
| classifyOverdue | CAS revision 匹配才将 prepared 分类为 expired_before_dispatch、claimed 分类为 outcome_unknown | TTL 证明零成本；预算可释放、供应商停止执行或收益可提现 |

SQL 约束拒绝 NULL claim、非整数 revision、身份/期限修改、旧状态重新开放、换绑 claim 和非前向转换。准备阶段的确认丢失可以回查：意图存在本身没有发送副作用；认领阶段则必须保守处理，不能用同样的回查规则重新发许可。没有财务写入、重推理、队列或后台循环。

这里的 request id 长度、attempt_index 1–32 和单批 50 是**未启用草案的技术边界**，不是新的公开 API 限额，也不是批准 32 次推理的策略。未来接入仍需现有真实 dispatch 预算、权限/撤权、计费准入、deadline 复验和 C01 的发行参数；不能单凭 granted 发送。context_sha256 当前由内部调用方提供，规范化算法及完整快照另需实现，测试摘要不是生产证明。

## 2. 本地验证与失败保留

新增 [19 项测试](../../../../packages/core/src/storage/recovery/dispatch-intent.d1.test.mjs)，命令 `npm run test:dispatch-intent -w @octafuse/core`，19/19、exit 0、无跳过；已纳入 Core pretest:unit 链，但本轮未声称运行整个 Core unit suite。

- 完整 68 迁移后 expand、外键启用/零违规、quick_check=ok，正式迁移清单不变。
- 精确重放、上下文/租户/期限冲突、无效运行时类型、无界批量拒绝；20 个同进程并发调用只获得一次 grant。它不是多实例 Cloudflare 压力验收。
- intent 写前失败、写后丢 ACK、回查也失败；claim 写前失败与写后丢 ACK；恢复分类确认丢失、stale revision、期限边界、相同 claim 跨 attempt 冲突。
- 身份/期限不可变、SQL NULL/整数约束、状态不可倒退；后台等待期间调用方修改输入对象也不能改变回查身份。
- 三项真实子进程退出实验：intent 提交后、claim 提交前、claim 提交后使用 process.exit(73)，由另一进程重新打开同一临时 SQLite 文件核验。提交后的 claim 不再获得发送权，过期分类保留 unknown。没有通过内存 Map 重建记录；没有实际供应商调用。这不是 workerd/isolate 强制终止或 Cloudflare 重启实验。

第一次 15 项执行为 **10 PASS / 5 FAIL**：两项输入/SQL 合同失败，三项为清理空目录时 rmSync 返回 EISDIR。修复严格字符串类型、SQL NULL/整数约束并改用仅删除空目录的 rmdirSync 后 15/15；后续补状态约束与确认丢失至 18/18。新增异步身份所有权测试曾独立失败，再补标量副本后最终 19/19。没有将失败结果重写为成功。

[SQLite 测试适配器](../../../../packages/proxy/src/test-support/sqlite-d1.ts) 增加显式测试文件路径/跳过重复迁移参数，默认仍为内存库；始终启用外键。子进程用 test-owned 临时目录，只清理固定 SQLite 文件名和空目录；第一轮遗留的三个空目录也已核验后移除。测试数据可重新生成，不删除仓库/生产数据。

本轮重新运行 Images staging 专项 **42/42**，确认适配器改动没有破坏原故障/完整链路测试。`typecheck:dispatch-intent` 与 `typecheck:images:staging` 均 exit 0，`git diff --check` 通过。

**完整 Core 类型检查仍 FAIL：32 条诊断。** 在同一当前工作树排除新增模块后，诊断内容/位置/数量完全相同。主要为其他测试的 vitest 缺失、URL 类型差异及既有测试类型问题；未添加 unsafe cast、安装依赖或修改这些测试来隐藏失败。定向通过不替代全包通过。[结构化证据](./C02-dispatch-intent-local-results.json) 保存诊断与源码摘要。

## 3. Workers 与部署边界

按 Workers 最佳实践使用 D1 binding、参数化 SQL、显式 awaited I/O、请求所有的标量身份；不使用全局请求状态、REST 管理 API 或未持有 Promise。主库路径依据 [D1 数据库 API](https://developers.cloudflare.com/d1/worker-api/d1-database/) 与 [Sessions / 读一致性](https://developers.cloudflare.com/d1/best-practices/read-replication/)，没有使用参考资料中不存在的 session.close/timeout 参数。

最新类型版本通过 npm 官方 registry 只读确认为 5.20260907.1，并核对已缓存的相同版本 D1 定义；项目安装仍为 5.20260829.1，无升级。默认 npmmirror 查询曾 EACCES，未修改全局权限/registry；随后仅本次命令指定官方 registry 和工作区缓存。

本轮不操作云端。最后一次已验证的 staging 关闭状态和 Gateway `96f7e314-cf14-4cd7-9e12-14bdefd19b18` 仍引用上一轮收尾记录，不冒充本轮重新查询；首轮已记录 HTTP 仍 98 次，模型/KMS 调用不增加，US$2 不重置。最终云账单仍未核验。

## 4. 下一步与未完成

继续 C02.B2.2：实现**有界、不可变的完整结算输入与原子提交回执**，复用现有 critical write，使零价/正数 reservation 均能在失败后识别同一经济事件。随后补独立恢复执行、路由接入与真实 Workers 故障验证，不将目前的意图身份当作可重建用量的完整载荷。

该仓储没有存报价、actual usage 或 critical-write 输入，没有 ready/committed 结算阶段、outbox、收益消费者、跨后端实现、支付/退款政策或远端迁移。outcome_unknown 是执行证据分类，不是资金终态。C03/C04/C05 相关依赖尚未冻结/验收，生产容量池继续关闭；SSE、其他模态、平台期限、同实例完整工作集和混合并发仍待验收。
