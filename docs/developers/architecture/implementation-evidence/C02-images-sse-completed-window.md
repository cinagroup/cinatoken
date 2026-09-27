# C02 — completed / DONE 取消窗口的真实对照

2026-09-08；Checklist v1.91。状态：STAGING_SUBSET_PASS。两条真实云端对照、完整收尾及独立证据核验通过；C02.G 保持开放。

## 需要证明的区别

用户已确认：有效 completed 图片及真实上游 DONE 构成不可逆成功；之后客户端取消不得撤销费用。仅 completed、没有 DONE 时保留旧规则。v1.90 的取消用例只发送 partial，不能代替 completed-only 对照；普通 EOF 也不能证明取消发生在仍打开的流中。

本轮新增独立 staging 上游入口，不修改网关、收费算法、生产入口或 schema。`images-sse-window-probe.ts` 保留原有精确身份、单次 CAS 和固定 315 秒上限：

| 私有 profile | 上游输出后保持打开 | 客户端动作 | 账务预期 |
| --- | --- | --- | --- |
| completed-and-done（success） | completed + DONE；不自行 EOF | 读到完整 DONE 后取消并 abort | 成功、0.1 合成费用 |
| completed-without-done（hold） | 仅 completed；永不主动发送 DONE | 读到 completed 后取消并 abort | 错误、0 费用 |

复用原有有界 prompt 身份和清理模式；观察记录新增明确 windowProfile、completed-enqueued / done-enqueued 阶段，最多五个事件。持久化的 enqueue 不是客户端收讫证明：客户端 wire、动作时间与数据库结果分别记录。除 success/hold 外的旧 SSE 模式和普通 Images 路径继续使用旧实现；必须根据发布版本、源码摘要和 windowProfile 识别此实验，不能仅凭模式名猜测语义。

## 本地与候选验证

新增 25 项测试通过：14 项真实共同 handler → 耐久结算 → 精确清理，包括 DONE 后立即/下一事件循环 cancel/abort、completed-only cancel/abort/deadline 及旧错误模式；另 11 项验证原始流不自动 EOF、取消/abort/固定上限、重复调用与状态归属拒绝、prefix CAS 期间取消不继续入队。

与既有 776 项合并运行，**801/801 通过**，失败/取消/跳过均零。deadline 本地用例含模拟时钟，不作为真实平台计时证明。独立 CI 配置包含 Node 22/24，但本机实跑 Node 24.14.1，远程 CI 和 Node 22 未运行。

Wrangler 4.127.1 类型生成、类型一致性检查、staging 类型检查和离线 dry-run 均通过，七个真实文件构建输入与输出已记录摘要。仅将冻结 upstream 配置的 main 指向新入口，绑定仍为独立 staging D1 的 PROBE_DB；入口关闭、空域名/Cron、CPU 1000 ms 上限不变。

Workers best-practices 技能用于区分 enqueue、客户端读取和结算，并约束流/后台任务所有权；Wrangler 技能用于独立配置、类型生成及冻结包发布/回读。参见 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。

## 实际云端执行

预检已重新验证四个 staging Worker、三个生产配置、Access 关闭状态，以及 295 个 schema 对象 / 56 张表计数基线，D1 管理查询读取 672 行、零行写入。

只发布私有 `cinatoken-staging-images-upstream`，100% 版本 `c6939802-a8a9-4f09-9d51-4a772cbce8b2`；JS SHA-256 `06ce7cafdde2c802b225a8f87cb66219448d22f62c6c204ad2945b826cba7178` 经云端 content/v2 回读匹配。网关保持 v1.90 的 `93ca506d-15ee-47e8-a162-dd16f0a4a3de`，其余消费者、控制器及生产未部署。

两条真实请求的 wire 和账务对照已通过：completed + DONE 后取消的日志为 success / 0.1；completed-only 后取消为 error / 0。两次客户端均在识别目标帧后 2 毫秒内取消并 abort。两条上游均观察到 request_abort、单次出站及单次 terminal；只有前者包含 done-enqueued。

操作器已正常退出，完整收尾通过：先关闭 Access、回收临时令牌并撤销精确测试 key，等待固定安全窗口，再保存六类耐久表各两条终态记录并原子清理。两个恢复任务均 committed、两个回执精确对应；56 张表计数恢复基线，295 个 schema 对象不变，四个 staging Worker 入口关闭，三个生产配置指纹未变。删除的是合成 fixture 及其测试账务数据；数据库原行不保留，终态观察证据已保存。

独立无云调用核验器验证了 wire、取消时间、单次终态、费用、清理窗口及完整表基线。汇总见[机器证据](./C02-images-sse-completed-window-results.json)；原始操作记录 `.wrangler/staging/sse-window-v191-run-result.json` 与独立核验 `.wrangler/staging/sse-window-v191-cloud-verification.json` 的摘要纳入汇总。

## 费用与证据边界

无真实付费模型/KMS、充值、订阅、真实密钥或生产数据操作。合成费用仅为测试数据库的计价值。首轮累计 US$2 不重置；继续保留既往/延迟费用 US$1.10、本轮操作预留 US$0.05、未分配预留 US$0.85，均非实测账单或可支配余额证明。可见 Workers/D1 ContractedCost 为零仍存在日期延迟，最终增量账单未核验。

公开 HTTP 原累计 287，本轮新增 5 次（3 次 Access 检查、2 次合成推理），首轮累计 292。执行阶段 D1 管理查询读取 1,652 行、写入 166 行；连同预检共读取 2,324 行、写入 166 行，不包括 Worker 内部查询；管理调用计数另不包括 Wrangler 内部操作。模型/KMS 累计调用仍为 0。

## 后续门禁

真实客户端在 DONE 后主动取消并保留成功费用，只证明该可观察行为。driver 正常终态清理也可能先取消上游，因此上游 request_abort / response_cancel 不能单独证明客户端取消命中了仍在执行的数据库提交；本轮不人为保持网关响应 EOF 或改写收费路径来制造竞态。

下一步仍需针对真正的快照 INSERT / 原子恢复任务接受和账务 batch 边界增加有界、精确归属的故障探针，验证 DONE 前确认、15 秒未确认错误、确认丢失及原生平台终止后的独立消费者补账/去重。只有 intent 无快照时继续保留不明结果和预算，不重放、不编造费用。物理容量与完整 C02.G 不因本子集通过而关闭。

本轮只读源码核对进一步明确下一探针的实际边界：`usage-settlement-d1.ts` 对快照采用独立 prepared statement `.run()`，随后按完整身份与摘要 load；异常会先读回确认，不自动重新推理。`request_usage_recovery_enqueue` 在同一 SQLite INSERT 事务中创建 pending job，不存在独立队列双写。随后 `image-usage-recovery.ts` 还会 inspect job 才确认接受。因此下一轮应分别覆盖 INSERT 前、真实 INSERT 提交后丢确认、快照读回失败、job inspect 失败，以及后续结算 batch；不能只拦截 batch 或人为拆开 trigger 来伪造真实接受故障。此次仅据代码明确顺序，没有新增云端触发器、重跑迁移或实现这些故障探针。
