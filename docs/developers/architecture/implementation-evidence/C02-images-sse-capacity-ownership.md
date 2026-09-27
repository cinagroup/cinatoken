# C02 — Workers 耐久 Images SSE 容量持有期

2026-09-08；Checklist v1.104。状态：**LOCAL_PASS**。此轮为本地实现与验证，未部署，不能沿用 v1.103 的 native matrix 证明新组合已经过 Workers 验收。C02.G、生产容量和完整恢复门禁保持开放。

## 实现与边界

实际 `createWorkerApp` 工厂漏掉了已有 `httpCapacity` 选项转发。本轮将其纳入 `WorkerAppOptions` 并传给 `createProxyApp`；新 staging 组合复用真实 `createWorkerHandler`、真实鉴权/存储/维护模式和耐久 Images SSE。生产入口仍未传入容量策略，不设置默认预留，不从环境变量或请求头自动启用。

用户确认的成功点不变：网关验证有效 completed 图片和真实上游 `[DONE]` 后，后续取消不能撤销成功费用。耐久路径仍先确认快照及恢复任务，再交付成功 DONE；财务提交可晚于响应。容量池只记录数值，由调用方为所选实例共享；测试中的 1 请求 / 1,024 字节是任意逻辑额度，不是推荐的内存预算。

本轮按 Workers 最佳实践技能检查显式组合、背压、独立 `waitUntil` 持有与无请求级全局缓存。复核最新发布 Workers 类型 5.20260908.1 的 `ExecutionContext` / `ExportedHandler` 签名，没有升级项目依赖或更改绑定。参见 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)、[waitUntil](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)、[isolate 内存限额](https://developers.cloudflare.com/workers/platform/limits/#memory)。

## 新增 16 项本地测试

使用真实 Node SQLite、全部迁移及三份恢复草案；模拟的只是上游 SSE 和数据库传输等待/ACK，不伪造 SQL 成功结果。测试禁止外部 fetch，凭据为合成值。

| 窗口 | 取消后、原任务未结束 | 原任务结束后 |
| --- | --- | --- |
| 成功事实已确认、快照 INSERT 尚未执行 | 仍占用容量；没有快照或账单 | INSERT 成功则结算一次；明确失败则保留 dispatch_claimed / dispatched，未决金额不补造、不自动退款 |
| 快照 INSERT 已提交、ACK 未返回 | 仍占用容量；存在快照，尚无财务回执 | ACK 返回或丢失后通过精确回读，仍只结算一次 |
| 财务事务已提交、ACK 未返回 | 即使客户端取消或响应 EOF，也不能释放容量 | ACK Promise 返回或拒绝，全部持有者结束后容量归零 |

上述三个窗口各覆盖 reader.cancel / Request.signal.abort，以及原等待成功 / 拒绝，共 12 项。另 4 项覆盖：

- 独立恢复完成和重复恢复均不能释放原请求仍未结束的快照 ACK 持有；原等待终结后才归零。
- 完整响应 EOF 不能释放仍在等待财务 ACK 的持有。
- 已读 completed、但剩余响应未读时，即使后台账务完成仍持有容量；取消剩余响应后释放。没有声称完全未读响应会无视背压处理全部上游。
- 显式容量组合拒绝 Upgrade；未配置容量的旧组合仍执行维护合同，环境变量/请求头不能自动启用。

所有占用窗口都从另一个共享同池的真实 Worker handler 发起请求，确认在数据库语句、鉴权、body pull 和上游发送之前返回 capacity_unavailable 503；原请求释放后再用维护请求验证容量可重新使用。账务成功检查唯一快照、唯一提交回执、唯一日志、0.1 合成费用、100,000 micros 已消费及零预留，重复恢复无新增提交。这里的 0.1 是测试数据库账目，不是真实服务费用。

## 验证记录

新增 Node 22/24 CI 定义，但本轮只在 Windows / Node 24.14.1 实测；Node 22、远程 CI 和新组合的原生 Workers 验证未执行。Proxy 与 staging 两项 TypeScript 检查退出码均为 0。

首次专项运行 6/12 通过、6 项超时：测试 SQL 匹配未处理换行，另误以为完全未读流会主动推进至 DONE。修正测试夹具后 12/12 通过。扩展 INSERT 前窗口时，两项断言误写状态名 claimed；按实际合同改为 dispatch_claimed，并补验预算 dispatched，不改运行时算法。

完整回归首轮 1,493 项中 1,490 通过、3 项取消、0 断言失败，原报告保留 FAIL。三项均为既有 monotonic cleanup after-hold 案例的 10 秒超时；同文件独立复测 34/34 通过。不能据此断言超时根因已确定。随后限制测试文件并发为 2、保持相同源码与全部断言，全集 **1,493/1,493 通过，失败/取消/跳过均为 0**；总数为既有 1,415 + 新增 16 + 补入既有容量回归 62。没有延长单项超时或覆盖首轮报告。详见 [v1.104 结果清单](./C02-images-sse-capacity-ownership-results.json)。

## 历史证据与云端范围

旧 Workers 工厂源文件已逐字节归档至 `source-snapshots/v1.103/workers.ts`，SHA-256 为 `cd7d4881447b1ff4d5a78b19290b4948aeb509a031e0de4f51549082da2c92c1`。新校验器只将历史清单中该路径和该摘要的记录解析到归档，同时独立验证当前源文件。旧清单和云端失败/成功报告不改写；旧操作脚本应保持冻结，不直接拿其历史源文件假设部署当前代码。

本轮无 Cloudflare 管理/测试 HTTP、无部署或生产写入、无模型或 KMS 调用。首轮测试 HTTP 累计仍为 366、真实模型/KMS 累计 0；US$2 上限不重置，最终增量账单仍未核验。云端最后隔离状态仅引用 v1.103 的 2026-09-08T11:23:20.520Z 只读补核，不声称本轮重新观测。

## 后续有限顺序

1. 为隔离 staging 冻结新的容量组合、同 isolate 身份和纯数值观测合同，核对实际触发器/绑定/Access 及累计预算后，再做原生持有期实验。
2. 特别验证平台终止 `waitUntil` 后、同一 isolate 后续请求的容量状态。本地 Promise 拒绝不代表原生平台取消一定运行 finally；不能添加任意 TTL 强制释放来掩盖仍持有的工作。
3. 完成最大输入/输出、慢读/不读、混合模态和其他消费者的物理工作集验收，再决定生产预留与启用。scheduled / Queue 路径仍不经过 HTTP 池，不能仅凭 BATCH_API_ENABLED=false 排除消费者。
4. intent-only/unknown 的客户展示、期限、幂等与人工调整策略继续开放；不得重放未知推理、补造用量或据此自动退款。

本轮关闭的是工厂接线和本地持有期覆盖缺口，不是上述发行门禁。
