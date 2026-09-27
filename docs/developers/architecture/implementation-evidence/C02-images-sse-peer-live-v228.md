# C02.B2.2 — V3 真实 Workers 试验与关闭读回

日期：2026-09-09；Checklist v1.127。状态：STAGING_PARTIAL。V3 已封闭部署并完成一次真实试验；同实例观察未建立，试验结果保持 FAILED，安全收尾与最终只读复核通过。

## 实际结果

| 验收项 | 结果与边界 |
| --- | --- |
| 封闭部署 | PASS。版本 `d203f9b2-95c6-4ffe-8776-bdb5d021433c`，V3 内容 SHA-256 `2eb7b4674960421df41fb85a70b3f4d90b8b33a35d16b0781ee07712aefdb77d`；配置摘要未变。 |
| 唯一推理及观察发现 | 推理一次，返回真实 200 / SSE / generation ID / primary identity。8 次 Upgrade 均为完整 78 字节的明确 409 mismatch；10,993 ms 后耗尽次数上限，未建立观察连接，零样本、零阶段标记。 |
| 原生取消与账务 | 原 tail collector 捕获真实 `native-wait-until-task-cancellation`，与原时钟、取消行和 held 快照通过冻结 oracle。失败收尾仅执行一次恢复，committed=1；没有推理重放或第二次去重 RPC。 |
| 关闭及清理 | 原 monotonic 350 秒安全期后，完整六表 / probe / ownership 校验与原子清理完成。最终 56 表计数回到基线，双 Access deny-all，四个 staging Worker 入口关闭，自有 token / tail 不存在，生产配置未漂移。 |

该笔为合成 fixture 的一张图片，`image_per_image` 账务值 0.1 合成美元、预算 100,000 micros；不是实际模型费用。文本计费列为 0，脱敏 raw_usage 中 text_tokens=3、image_output_tokens=7、total_tokens=10。恢复前后完整财务行保存在原日志，并由既有严格清理 oracle 再验证；清理仅移除合成测试数据，不是退款。

本次没有读取下游成功 DONE：观察发现发生在获取原 reader 后、读取 completed 之前。不能把原生取消 / 恢复成功表述成完整成功交付、去重、容量释放或 isolate 驱逐验收。C02 总门禁不变。

## 失败结论与下一实施方向

8 个完整拒绝均声明 `peer_not_active_here`。该分支同时覆盖实例身份 / eligible epoch 不匹配；现有证据不能区分具体分支，不能声称发现了八个不同实例，也不能仅据此认定请求仍占用容量。候选源码确认实例 UUID 和 epoch 持有在模块组合中，而非逐请求重新初始化。

Cloudflare 明确不保证两个请求被路由到同一 Worker 实例。因此，仅依赖重复 Upgrade 发现同实例不能成为确定性验收保证；这项平台约束与本次失败一致，但不是具体路由原因的完整诊断。[官方运行模型](https://developers.cloudflare.com/workers/reference/how-workers-works/)

下一步先补有限的实例 / epoch 拒绝分类与链路定位证据，评估同实例观察的可靠取得方式；不增加推理重放，不放宽身份 / native / 财务校验，不用另一个实例的空闲样本替代原请求实例。需要新增资源或改变正式运行时的方案另行确认。v227 的 deploy / run 尝试目录均已消费，不得删除目录或重放命令。

## 关闭摘要变化与独立复核

第一次最终只读前检在 Access 完整摘要处失败，保留原回执：全部操作均成功返回，staging D1 读取 674 行、写入 0。随后仅 GET 两个 Access 应用，确认唯一差异是应用及其策略的 `updated_at`，其余字段逐字段完全相同。第二次独立只读前检使用经验证的当前完整摘要，没有删除字段后直接放行、修改配置或重放试验；43 个管理请求及额外表计数检查全部通过。

离线证据校验器开发中也保留两次失败源码：一次错误地把 image raw_usage 单位当成文本计费列；一次错误地要求 token 创建返回 200，而实际为 201 Created。纠正的是校验器的预期，原始云端回执和冻结财务 oracle 均未修改。最终证据校验 PASS，见[回执](../../../../.wrangler/staging/peer-v228-live-verification-result.json)和[机器清单](./C02-images-sse-peer-live-v228-results.json)。

## 验证与费用范围

本轮没有修改业务 / Worker 源码、重建候选或重新运行全部单测；历史 2,274/2,274 回归及类型检查仍为 v227 证据。本轮实际执行 Wrangler 4.127.1 dry-run / 上传、完整性核验、线上前后检、真实试验及原 native / 财务纯校验。既有 1,898 条摘要全部不变；新清单归档 1,918 条摘要。Node 22 和远端 CI 未新增验证。

显式关闭 `workers_dev` 和 preview、固定现有资源 ID、禁用自动 provisioning / autoconfig，避免发布时扩展资源或意外开放入口；这些边界依据 Cloudflare / Wrangler 技能、[发布命令文档](https://developers.cloudflare.com/workers/wrangler/commands/workers/)和[workers.dev 配置文档](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)核对。

本轮 311 次已计数管理 HTTP（不包含 Wrangler 内部请求）、16 次公开请求：6 次鉴权、1 次合成推理、8 次明确不匹配 Upgrade、1 次恢复。管理 D1 读取 3,774 行、写入 160 行，含 seed / 撤销 / 严格清理；Worker 内部 D1 操作不在此统计内。公开 HTTP 累计 406，实际模型 / KMS 仍 0/0，生产写入 0。首轮累计 US$2 不重置；已报告 Workers / D1 费用为 0 但有延迟，最终增量账单未核实。

最后关闭读回时间 2026-09-09T05:41:52.641Z。完整物理 / 跨消费者容量、unknown / 幂等、C02.G、C01 和 C03–C20 继续开放。
